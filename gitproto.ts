// gitproto.ts — git smart HTTP.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   v2 or v0 advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  v0 advertisement
//   POST /{owner}/{repo}.git/git-upload-pack                     v2 ls-refs / fetch, v0 fetch
//   POST /{owner}/{repo}.git/git-receive-pack                    v0 push with report-status
//
// Protocol v2 is advertised for upload-pack when the client asks for it
// (Git-Protocol: version=2); receive-pack is v0 only, as the rules settle.
// Ref updates must fast-forward; a refused ref is reported per ref and the
// others still apply.

import type { ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendJson, sendRaw } from './app.ts';
import type { Repo } from './store.ts';
import {
  ZERO_SHA,
  closureOfCommit,
  closureOfTree,
  isAncestor,
  parseCommit,
  readPack,
  walkCommits,
  writePack,
} from './git.ts';

const AGENT = 'forge/1.0';

// ------------------------------------------------------------ pkt-lines

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode as many complete packets as the buffer holds; returns them and the byte count consumed. */
export function decodePackets(buf: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const lenText = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      off += 4;
      continue; // response-end: treat as a separator
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
    // A flush terminates a pkt-line stream segment.
    if (packets[packets.length - 1].kind === 'flush') break;
  }
  return { packets, next: off };
}

function packetLines(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
}

// ------------------------------------------------------------ ref listing

interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headTarget);
  if (headTip) out.push({ oid: headTip, name: 'HEAD', symrefTarget: headTarget });
  else out.push({ oid: ZERO_SHA, name: 'HEAD', symrefTarget: headTarget, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const obj = repo.store.get(oid);
    if (obj && obj.type === 'tag') {
      // Peel annotated tags to the commit they name.
      let target = obj;
      let guard = 0;
      while (target.type === 'tag' && guard < 10) {
        const m = /^object ([0-9a-f]{40})/m.exec(target.body.toString('utf8'));
        if (!m) break;
        const next = repo.store.get(m[1]);
        if (!next) break;
        if (next.type === 'commit') line.peeled = m[1];
        target = next;
        guard += 1;
      }
    }
    out.push(line);
  }
  return out;
}

// ------------------------------------------------------------ advertisements

function uploadAdvertisement(repo: Repo, version2: boolean): Buffer {
  if (version2) {
    return Buffer.concat([
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow wait-for-done\n'),
      pkt('object-format=sha1\n'),
      FLUSH,
    ]);
  }
  const caps = [
    'multi_ack_detailed',
    'no-done',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'deepen-since',
    'deepen-not',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
  const parts: Buffer[] = [pkt('# service=git-upload-pack\n'), FLUSH];
  const refs = listRefs(repo);
  refs.forEach((ref, i) => {
    if (ref.unborn) {
      if (i === 0) parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
      return;
    }
    const suffix = i === 0 ? `\0${caps}` : '';
    parts.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
  });
  if (refs.every((r) => r.unborn)) {
    // Empty repository: only the capabilities pseudo-ref was emitted above.
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function receiveAdvertisement(repo: Repo): Buffer {
  const caps = ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', `agent=${AGENT}`].join(' ');
  const parts: Buffer[] = [pkt('# service=git-receive-pack\n'), FLUSH];
  const refs = listRefs(repo).filter((r) => r.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      parts.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ fetch core

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  deepen?: number;
  deepenSince?: number;
  done: boolean;
  noProgress: boolean;
}

function commitTime(repo: Repo, sha: string): number {
  const obj = repo.store.get(sha);
  if (!obj || obj.type !== 'commit') return 0;
  const m = /committer [^>]*> (\d+) /.exec(obj.body.toString('utf8'));
  return m ? Number(m[1]) : 0;
}

/**
 * The object set for a fetch: commits selected from the wants (bounded by
 * depth / deepen-since), their trees and blobs, plus any tag objects the
 * wants name, minus everything the client already has. A have the client
 * marks shallow excludes only itself and its trees, never its ancestors.
 * Returns the pack, the new shallow boundary and the commits that stopped
 * being shallow.
 */
function computeFetch(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[]; objectCount: number } {
  // Peel tag wants down to commits, keeping the tag objects for the pack.
  const tagObjects = new Set<string>();
  const commitWants: string[] = [];
  for (const want of args.wants) {
    let sha = want;
    let guard = 0;
    while (guard < 10) {
      const obj = repo.store.get(sha);
      if (!obj || obj.type !== 'tag') break;
      tagObjects.add(sha);
      const m = /^object ([0-9a-f]{40})/m.exec(obj.body.toString('utf8'));
      if (!m) break;
      sha = m[1];
      guard += 1;
    }
    if (repo.store.has(sha) && repo.store.get(sha)?.type === 'commit') commitWants.push(sha);
    else if (repo.store.has(want)) tagObjects.add(want);
  }

  // Select commits.
  const selected = new Set<string>();
  const shallow = new Set<string>();
  if (args.deepen !== undefined) {
    let frontier = commitWants;
    for (let level = 0; level < args.deepen; level += 1) {
      const next: string[] = [];
      for (const sha of frontier) {
        if (selected.has(sha)) continue;
        selected.add(sha);
        const obj = repo.store.get(sha);
        if (!obj || obj.type !== 'commit') continue;
        const parents = parseCommit(obj.body).parents;
        if (level === args.deepen - 1) {
          if (parents.length > 0) shallow.add(sha);
        } else {
          next.push(...parents);
        }
      }
      frontier = next;
    }
  } else if (args.deepenSince !== undefined) {
    const since = args.deepenSince;
    const queue = [...commitWants];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (selected.has(sha) || !repo.store.has(sha)) continue;
      const obj = repo.store.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      selected.add(sha);
      const parents = parseCommit(obj.body).parents;
      if (commitTime(repo, sha) >= since) queue.push(...parents);
      else if (parents.length > 0) shallow.add(sha);
    }
  } else {
    for (const want of commitWants) {
      for (const sha of walkCommits(repo.store, want)) selected.add(sha);
    }
  }

  // What the client already has. Shallow haves stop at their boundary.
  const clientShallow = new Set(args.clientShallow);
  const excluded = new Set<string>();
  const excludeFrom = (tip: string): void => {
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (excluded.has(sha) || !repo.store.has(sha)) continue;
      const obj = repo.store.get(sha);
      if (!obj || obj.type !== 'commit') {
        excluded.add(sha);
        continue;
      }
      excluded.add(sha);
      closureOfTree(repo.store, parseCommit(obj.body).tree, excluded);
      if (clientShallow.has(sha)) continue; // the client holds nothing below its boundary
      queue.push(...parseCommit(obj.body).parents);
    }
  };
  for (const have of args.haves) {
    if (repo.store.has(have)) excludeFrom(have);
  }

  const objects = new Set<string>();
  for (const sha of tagObjects) {
    if (!excluded.has(sha)) objects.add(sha);
  }
  for (const sha of selected) {
    if (excluded.has(sha)) continue; // the client already holds this commit
    // Only the selected commits themselves plus their own trees and blobs:
    // following parents here would undo the depth bound.
    objects.add(sha);
    const obj = repo.store.get(sha);
    if (obj && obj.type === 'commit') closureOfTree(repo.store, parseCommit(obj.body).tree, objects);
  }
  for (const sha of [...objects]) {
    if (excluded.has(sha)) objects.delete(sha);
  }
  // Shallow boundaries name selected commits whose parents were cut.
  const boundary = [...shallow].filter((s) => selected.has(s));
  const boundarySet = new Set(boundary);
  const unshallow = args.clientShallow.filter((s) => selected.has(s) && !boundarySet.has(s));
  const pack = writePack(repo.store, [...objects]);
  return { pack, shallow: boundary, unshallow, objectCount: objects.size };
}

function sidebandPackets(data: Buffer, progress?: string): Buffer[] {
  const out: Buffer[] = [];
  if (progress) {
    out.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  }
  const CHUNK = 32768;
  for (let i = 0; i < data.length; i += CHUNK) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(i, i + CHUNK)])));
  }
  if (data.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}

// ------------------------------------------------------------ handlers

function handleLsRefs(repo: Repo, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  for (const ref of listRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.unborn) {
      if (unborn) parts.push(pkt(`unborn ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      else if (ref.name === 'HEAD') parts.push(pkt(`${ZERO_SHA} ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], done: false, noProgress: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13));
    else if (line === 'done') args.done = true;
    else if (line === 'no-progress') args.noProgress = true;
  }
  return args;
}

function handleFetchV2(repo: Repo, argLines: string[]): Buffer {
  const args = parseFetchArgs(argLines);
  const parts: Buffer[] = [];
  const common = args.haves.filter((h) => repo.store.has(h) && repo.store.get(h)?.type === 'commit');
  if (!args.done) {
    // Negotiation round: acknowledgments only, no pack yet.
    parts.push(pkt('acknowledgments\n'));
    if (common.length === 0) parts.push(pkt('NAK\n'));
    else for (const sha of common) parts.push(pkt(`ACK ${sha}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // With 'done' the answer is the pack at once (shallow-info first when the
  // fetch is depth-bounded), exactly as git's upload-pack answers.

  const { pack, shallow, unshallow, objectCount } = computeFetch(repo, args);
  if (args.deepen !== undefined || args.deepenSince !== undefined || args.clientShallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandPackets(pack, args.noProgress ? undefined : `Counting objects: ${objectCount}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  // First want line may carry capabilities after a NUL.
  const cleaned = lines.map((line, i) => (i === 0 ? line.split('\0')[0] : line));
  const args = parseFetchArgs(cleaned);
  const { pack, shallow, unshallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(pkt('NAK\n'));
    return Buffer.concat(parts);
  }
  for (const sha of shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  parts.push(pkt('NAK\n'));
  parts.push(...sidebandPackets(pack, args.noProgress ? undefined : ''));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, next } = decodePackets(body, 0);
  const lines = packetLines(packets);
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.split('\0')[0];
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
  }
  const packBuf = body.subarray(next);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBuf.length > 0 && packBuf.toString('utf8', 0, 4) === 'PACK') {
    try {
      readPack(repo.store, packBuf, 0);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  } else if (commands.some((c) => c.newSha !== ZERO_SHA)) {
    // An update with no pack at all: git accepts an empty pack only when it
    // is actually sent; a missing pack for new objects is an unpack error.
    const missing = commands.some((c) => c.newSha !== ZERO_SHA && !repo.store.has(c.newSha));
    if (missing) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    }
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? ZERO_SHA;
    if (cmd.oldSha !== current) {
      report.push(`ng ${cmd.ref} stale info\n`);
      continue;
    }
    if (cmd.newSha === ZERO_SHA) {
      // Delete.
      if (cmd.ref === `refs/heads/${repo.defaultBranch}`) {
        report.push(`ng ${cmd.ref} deletion of the current branch prohibited\n`);
        continue;
      }
      repo.refs.delete(cmd.ref);
      report.push(`ok ${cmd.ref}\n`);
      continue;
    }
    const newObj = repo.store.get(cmd.newSha);
    if (!newObj) {
      report.push(`ng ${cmd.ref} unknown object\n`);
      continue;
    }
    if (current !== ZERO_SHA && newObj.type === 'commit') {
      const curObj = repo.store.get(current);
      if (curObj && curObj.type === 'commit' && !isAncestor(repo.store, current, cmd.newSha)) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newSha);
    report.push(`ok ${cmd.ref}\n`);
  }

  const stream = Buffer.concat([...report.map((l) => pkt(l)), FLUSH]);
  // The client asked for side-band-64k in its capabilities (the suite always
  // does when advertised): wrap the report stream in band-1 packets.
  const wantsSideband = lines.length > 0 && (lines[0].includes('side-band-64k') || body.toString('latin1').includes('side-band-64k'));
  if (!wantsSideband) return stream;
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < stream.length; i += CHUNK) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), stream.subarray(i, i + CHUNK)])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

export function handleGit(ctx: Ctx, res: ServerResponse, segments: string[], url: URL): void {
  const forge = ctx.forge;
  const owner = segments[0];
  const repoName = segments[1].replace(/\.git$/, '');
  const repo = forge.repoFor(owner, repoName);
  const tail = segments.slice(2).join('/');
  const method = ctx.req.method ?? 'GET';

  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (method === 'GET' && tail === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const protocol = ctx.req.headers['git-protocol'] ?? '';
      sendRaw(res, 200, uploadAdvertisement(repo, protocol.includes('version=2')), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, receiveAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 403, { message: 'Unsupported service' });
    return;
  }

  if (method === 'POST' && tail === 'git-upload-pack') {
    const protocol = ctx.req.headers['git-protocol'] ?? '';
    if (protocol.includes('version=2')) {
      const { packets } = decodePackets(ctx.body, 0);
      const lines = packetLines(packets);
      const command = lines[0] ?? '';
      const argLines = lines.slice(1);
      if (command === 'command=ls-refs') {
        sendRaw(res, 200, handleLsRefs(repo, argLines), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'command=fetch') {
        sendRaw(res, 200, handleFetchV2(repo, argLines), 'application/x-git-upload-pack-result');
        return;
      }
      sendJson(res, 400, { message: 'Unknown command' });
      return;
    }
    const { packets } = decodePackets(ctx.body, 0);
    sendRaw(res, 200, handleFetchV0(repo, packetLines(packets)), 'application/x-git-upload-pack-result');
    return;
  }

  if (method === 'POST' && tail === 'git-receive-pack') {
    sendRaw(res, 200, handleReceivePack(repo, ctx.body), 'application/x-git-receive-pack-result');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
