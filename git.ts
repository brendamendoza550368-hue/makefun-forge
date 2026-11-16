// git.ts — the git object layer: a sha1-addressed in-memory object store,
// tree/commit construction and parsing, and packfile read/write (with delta
// application on read; packs we write carry plain objects only).
//
// Everything is synchronous and in memory: the forge holds small repositories
// and speed comes from never touching a disk or a subprocess.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObj {
  readonly type: ObjType;
  readonly body: Buffer;
}

export const ZERO_SHA = '0000000000000000000000000000000000000000';
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export class ObjectStore {
  readonly map = new Map<string, GitObj>();

  put(type: ObjType, body: Buffer): string {
    const head = Buffer.from(`${type} ${body.length}\0`, 'utf8');
    const sha = sha1Hex(Buffer.concat([head, body]));
    if (!this.map.has(sha)) this.map.set(sha, { type, body });
    return sha;
  }

  get(sha: string): GitObj | undefined {
    return this.map.get(sha);
  }

  has(sha: string): boolean {
    return this.map.has(sha);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "40000"
  name: string;
  sha: string;
}

export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const mode = body.toString('utf8', i, sp);
    const nul = body.indexOf(0x00, sp + 1);
    const name = body.toString('utf8', sp + 1, nul);
    const sha = body.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

/** Git's tree order: bytewise by name, directories as if suffixed with '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file under a tree, recursively: path -> {sha, mode}. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = store.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.body)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(store, e.sha, path, out);
    else out.set(path, { sha: e.sha, mode: e.mode });
  }
  return out;
}

/** Build nested trees from a flat path -> blobSha map; returns the root tree sha. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], sha);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: emit(sub) });
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_SHA;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

const IDENT = 'Forge Bot <forge@localhost>';

export function buildCommit(tree: string, parents: string[], message: string, time: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${IDENT} ${time} +0000`);
  lines.push(`committer ${IDENT} ${time} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** All commits reachable from `tip`, newest first (BFS by generation). */
export function walkCommits(store: ObjectStore, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (sha === ZERO_SHA || seen.has(sha)) continue;
    const obj = store.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(sha);
    order.push(sha);
    for (const p of parseCommit(obj.body).parents) queue.push(p);
  }
  return order;
}

export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === ZERO_SHA) return true;
  return walkCommits(store, tip).includes(ancestor);
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set(walkCommits(store, a));
  for (const candidate of walkCommits(store, b)) {
    if (ancestorsOfA.has(candidate)) return candidate;
  }
  return null;
}

/** Every object reachable from a commit: the commit, its trees and blobs. */
export function closureOfCommit(store: ObjectStore, tip: string, into = new Set<string>()): Set<string> {
  const obj = store.get(tip);
  if (!obj || obj.type !== 'commit' || into.has(tip)) return into;
  into.add(tip);
  const info = parseCommit(obj.body);
  closureOfTree(store, info.tree, into);
  for ( const p of info.parents) closureOfCommit(store, p, into);
  return into;
}

export function closureOfTree(store: ObjectStore, treeSha: string, into = new Set<string>()): Set<string> {
  if (into.has(treeSha)) return into;
  const obj = store.get(treeSha);
  if (!obj || obj.type !== 'tree') return into;
  into.add(treeSha);
  for (const e of parseTree(obj.body)) {
    if (e.mode === '40000') closureOfTree(store, e.sha, into);
    else into.add(e.sha);
  }
  return into;
}

// ---------------------------------------------------------------- packs

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** A complete packfile holding the given objects as plain (undeltified) entries. */
export function writePack(store: ObjectStore, shas: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), u32(2), u32(shas.length)];
  for (const sha of shas) {
    const obj = store.get(sha);
    if (!obj) continue;
    parts.push(packObjectHeader(obj.type, obj.body.length));
    parts.push(deflateSync(obj.body));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/**
 * Inflate the zlib stream starting at `offset`; returns the data and the
 * offset just past the stream. inflateSync tolerates trailing bytes and
 * throws on truncation, so an exponential probe + binary search finds the
 * exact end.
 */
export function inflateAt(buf: Buffer, offset: number, hint: number): { data: Buffer; next: number } {
  let hi = Math.min(buf.length, offset + Math.max(64, hint * 2 + 64));
  const ok = (end: number): boolean => {
    try {
      inflateSync(buf.subarray(offset, end));
      return true;
    } catch {
      return false;
    }
  };
  while (!ok(hi)) {
    if (hi >= buf.length) throw new Error('pack: truncated zlib stream');
    hi = Math.min(buf.length, offset + (hi - offset) * 2);
  }
  let lo = offset + 1;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    if (ok(mid)) high = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(buf.subarray(offset, lo)), next: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i];
      i += 1;
      n |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return n;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('pack: delta base size mismatch');
  const dstSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) { off = delta[i]; i += 1; }
      if (op & 0x02) { off |= delta[i] << 8; i += 1; }
      if (op & 0x04) { off |= delta[i] << 16; i += 1; }
      if (op & 0x08) { off |= delta[i] << 24; i += 1; }
      if (op & 0x10) { size = delta[i]; i += 1; }
      if (op & 0x20) { size |= delta[i] << 8; i += 1; }
      if (op & 0x40) { size |= delta[i] << 16; i += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(off, off + size));
      produced += size;
    } else if (op > 0) {
      parts.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('pack: delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== dstSize || out.length !== dstSize) throw new Error('pack: delta size mismatch');
  return out;
}

/**
 * Read a packfile into the store. Returns the number of objects stored.
 * Delta bases may live in the same pack or already in the store.
 */
export function readPack(store: ObjectStore, buf: Buffer, start = 0): number {
  if (buf.toString('utf8', start, start + 4) !== 'PACK') throw new Error('pack: bad signature');
  const count = buf.readUInt32BE(start + 8);
  let off = start + 12;
  const pending: { type: ObjType; body: Buffer }[] = [];
  const local = new Map<number, string>(); // pack offset -> sha, for ofs-delta
  const bySha = new Map<string, Buffer>(); // sha -> body for entries in this pack
  const storeEntry = (type: ObjType, body: Buffer, at: number): string => {
    const sha = store.put(type, body);
    local.set(at, sha);
    bySha.set(sha, body);
    pending.push({ type, body });
    return sha;
  };
  let read = 0;
  while (read < count) {
    const entryAt = off;
    let b = buf[off];
    off += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: negative offset varint
      let byte = buf[off];
      off += 1;
      let baseOff = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[off];
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (byte & 0x7f);
      }
      const baseAt = entryAt - baseOff;
      const { data, next } = inflateAt(buf, off, size);
      off = next;
      const baseSha = local.get(baseAt);
      if (baseSha === undefined) throw new Error('pack: ofs-delta base missing');
      const baseObj = store.get(baseSha);
      if (!baseObj) throw new Error('pack: ofs-delta base not stored');
      storeEntry(baseObj.type, applyDelta(baseObj.body, data), entryAt);
    } else if (typeCode === 7) {
      // ref-delta: 20-byte base sha
      const baseSha = buf.toString('hex', off, off + 20);
      off += 20;
      const { data, next } = inflateAt(buf, off, size);
      off = next;
      const baseObj = store.get(baseSha);
      if (!baseObj) throw new Error('pack: ref-delta base not in store');
      storeEntry(baseObj.type, applyDelta(baseObj.body, data), entryAt);
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`pack: unknown type code ${typeCode}`);
      const { data, next } = inflateAt(buf, off, size);
      off = next;
      storeEntry(type, data, entryAt);
    }
    read += 1;
  }
  return read;
}
