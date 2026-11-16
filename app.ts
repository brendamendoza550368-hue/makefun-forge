// app.ts — the forge's HTTP surface: REST v3 (this file), git smart HTTP
// (gitproto.ts), GraphQL v4 (graphql.ts) and MCP (mcp.ts), all over the
// one store in store.ts.
//
// Protocol rules the suite checks everywhere: every reply is JSON (never
// HTML) with a non-empty X-GitHub-Request-Id, an unknown route is a JSON
// 404, a malformed JSON body is a 400, and a request without the trial's
// bearer token is a 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, Repo, diffFiles, pullMergeability, type IssueRec, type PullRec } from './store.ts';
import { ZERO_SHA, buildCommit, mergeBase, parseCommit, walkCommits } from './git.ts';
import { handleGit } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  body: Buffer;
  json: Record<string, unknown> | null;
  query: URLSearchParams;
}

let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${requestSeq.toString(36).toUpperCase()}`,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, data: Buffer, contentType: string): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'x-github-request-id': `FORGE-${requestSeq.toString(36).toUpperCase()}`,
  });
  res.end(data);
}

const notFound = (res: ServerResponse): void => sendJson(res, 404, { message: 'Not Found' });
const badRequest = (res: ServerResponse, message: string): void => sendJson(res, 400, { message });

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

// ---------------------------------------------------------------- shapes

export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.ownerLogin();
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, node_id: nodeId('User', 1), type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.isoOf(repo.seq),
    updated_at: forge.isoOf(repo.seq),
    pushed_at: forge.isoOf(repo.seq),
    html_url: '',
    git_url: '',
    clone_url: '',
    ssh_url: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.numbered.values()].filter((n) => n.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    fork: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(forge: Forge, repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: nodeId('Label', label?.id ?? 0),
    name,
    color: label?.color ?? 'ededed',
    description: '',
    default: false,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(forge, repo, name)),
    user: { login: forge.ownerLogin(), id: 1, node_id: nodeId('User', 1), type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.seq),
    updated_at: forge.isoOf(issue.seq),
    closed_at: issue.state === 'closed' ? forge.isoOf(issue.seq) : null,
    html_url: '',
    url: '',
    repository_url: '',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  const owner = forge.ownerLogin();
  const headSha = repo.tip(pull.headRef);
  const baseSha = repo.tip(pull.baseRef);
  const { mergeable } = pull.state === 'open' ? pullMergeability(repo, pull) : { mergeable: pull.merged };
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: owner, id: 1, node_id: nodeId('User', 1), type: 'User' },
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha ?? ZERO_SHA },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha ?? ZERO_SHA },
    merged: pull.merged,
    merged_at: pull.merged ? forge.isoOf(pull.seq) : null,
    merge_commit_sha: pull.mergedSha ?? null,
    mergeable,
    mergeable_state: pull.merged ? 'clean' : mergeable ? 'clean' : 'dirty',
    draft: false,
    created_at: forge.isoOf(pull.seq),
    updated_at: forge.isoOf(pull.seq),
    closed_at: pull.state === 'closed' ? forge.isoOf(pull.seq) : null,
    html_url: '',
    url: '',
  };
}

function commentJson(forge: Forge, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: { login: forge.ownerLogin(), id: 1, node_id: nodeId('User', 1), type: 'User' },
    created_at: forge.isoOf(comment.seq),
    updated_at: forge.isoOf(comment.seq),
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------- helpers

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function resolveCommit(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.tip(repo.defaultBranch);
  const byBranch = repo.tip(ref);
  if (byBranch !== null) return byBranch;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.store.has(ref.toLowerCase())) return ref.toLowerCase();
  return null;
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.store.get(sha);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.body) : { tree: ZERO_SHA, parents: [], message: '' };
  return {
    sha,
    node_id: nodeId('Commit', 0),
    commit: {
      author: { name: 'Forge Bot', email: 'forge@localhost', date: '2026-01-01T00:00:00Z' },
      committer: { name: 'Forge Bot', email: 'forge@localhost', date: '2026-01-01T00:00:00Z' },
      message: info.message,
      tree: { sha: info.tree },
    },
    parents: info.parents.map((p) => ({ sha: p })),
  };
}

// ---------------------------------------------------------------- REST

function handleRest(ctx: Ctx, res: ServerResponse, segments: string[]): void {
  const { forge } = ctx;
  const method = ctx.req.method ?? 'GET';
  const json = ctx.json ?? {};
  // segments[0] === 'api', [1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') return notFound(res);
    requestSeq += 1;
    const text = `${JSON.stringify({ current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' })}\n`;
    res.writeHead(200, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': `FORGE-${requestSeq.toString(36).toUpperCase()}`,
      'x-oauth-scopes': 'repo, read:org',
    });
    res.end(text);
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { installed_version: 'forge-1.0.0' });
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    return sendJson(res, 200, { login: forge.ownerLogin(), id: 1, node_id: nodeId('User', 1), type: 'User' });
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const name = str(json.name);
      if (name === '') return badRequest(res, 'name is required');
      if (forge.repos.has(name)) return sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      const repo = forge.createRepo(name);
      repo.isPrivate = json.private === true;
      repo.description = str(json.description);
      if (typeof json.default_branch === 'string' && json.default_branch !== '') repo.defaultBranch = json.default_branch;
      return sendJson(res, 201, repoJson(forge, repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const host = ctx.req.headers.host ?? 'localhost';
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", <http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}>; rel="last"`;
      }
      const text = `${JSON.stringify(slice.map((r) => repoJson(forge, r)))}\n`;
      requestSeq += 1;
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': `FORGE-${requestSeq.toString(36).toUpperCase()}`, ...headers });
      res.end(text);
      return;
    }
    return notFound(res);
  }

  if (rest[0] !== 'repos' || rest.length < 3) return notFound(res);
  const repo = forge.repoFor(rest[1], rest[2]);
  if (!repo) return notFound(res);
  const sub = rest.slice(3);

  if (sub.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(forge, repo));
    if (method === 'PATCH') {
      if (typeof json.description === 'string') repo.description = json.description;
      if (typeof json.private === 'boolean') repo.isPrivate = json.private;
      if (typeof json.default_branch === 'string' && json.default_branch !== '') repo.defaultBranch = json.default_branch;
      return sendJson(res, 200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      return sendJson(res, 204, undefined);
    }
    return notFound(res);
  }

  // ---- git refs / branches / commits
  if (sub[0] === 'git' && sub[1] === 'refs' && sub.length === 2 && method === 'POST') {
    const ref = str(json.ref);
    const sha = str(json.sha).toLowerCase();
    const obj = repo.store.get(sha);
    if (!ref.startsWith('refs/') || !obj || obj.type !== 'commit') return sendJson(res, 422, { message: 'Invalid ref or sha' });
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, node_id: nodeId('Ref', 0), object: { sha, type: 'commit' } });
  }

  if (sub[0] === 'branches' && sub.length === 1 && method === 'GET') {
    const out = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    return sendJson(res, 200, out);
  }

  if (sub[0] === 'commits' && sub.length === 1 && method === 'GET') {
    const tip = resolveCommit(repo, ctx.query.get('sha'));
    if (tip === null) return sendJson(res, 200, []);
    return sendJson(res, 200, walkCommits(repo.store, tip).map((sha) => commitJson(repo, sha)));
  }

  // ---- contents
  if (sub[0] === 'contents') {
    const path = sub.slice(1).join('/');
    const branch = (typeof json.branch === 'string' && json.branch !== '' ? json.branch : null) ?? ctx.query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const commitSha = resolveCommit(repo, ctx.query.get('ref'));
      if (commitSha === null) return notFound(res);
      const files = repo.filesAt(commitSha);
      if (path !== '' && files.has(path)) {
        const blobSha = files.get(path) as string;
        const blob = repo.store.get(blobSha);
        const content = blob ? blob.body : Buffer.alloc(0);
        return sendJson(res, 200, {
          name: path.split('/').pop(),
          path,
          sha: blobSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
        });
      }
      // directory listing ('' is the root)
      const prefix = path === '' ? '' : `${path}/`;
      const entries = new Map<string, { sha: string; type: string; size: number }>();
      for (const [filePath, sha] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const tail = filePath.slice(prefix.length);
        const slash = tail.indexOf('/');
        if (slash === -1) {
          entries.set(tail, { sha, type: 'file', size: repo.store.get(sha)?.body.length ?? 0 });
        } else {
          const dir = tail.slice(0, slash);
          if (!entries.has(dir)) entries.set(dir, { sha: ZERO_SHA, type: 'dir', size: 0 });
        }
      }
      if (path !== '' && entries.size === 0) return notFound(res);
      const out = [...entries.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, e]) => ({ name, path: prefix + name, sha: e.sha, size: e.size, type: e.type }));
      return sendJson(res, 200, out);
    }
    if (method === 'PUT') {
      const contentB64 = str(json.content);
      const message = str(json.message, 'Update file');
      const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const files = repo.filesAt(repo.tip(branch));
      const existing = files.get(path);
      if (existing !== undefined && typeof json.sha === 'string' && json.sha.toLowerCase() !== existing) {
        return sendJson(res, 409, { message: `${path} has changed since you last read it` });
      }
      const blobSha = repo.store.put('blob', data);
      files.set(path, blobSha);
      const commitSha = repo.commitOn(branch, files, message, forge.timeOf(forge.tick()));
      return sendJson(res, existing === undefined ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: data.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const message = str(json.message, 'Delete file');
      const files = repo.filesAt(repo.tip(branch));
      const existing = files.get(path);
      if (existing === undefined) return notFound(res);
      if (typeof json.sha === 'string' && json.sha.toLowerCase() !== existing) {
        return sendJson(res, 409, { message: `${path} has changed since you last read it` });
      }
      files.delete(path);
      const commitSha = repo.commitOn(branch, files, message, forge.timeOf(forge.tick()));
      return sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
    }
    return notFound(res);
  }

  // ---- labels
  if (sub[0] === 'labels' && sub.length === 1) {
    if (method === 'POST') {
      const name = str(json.name);
      if (name === '') return badRequest(res, 'name is required');
      if (repo.labels.has(name)) return sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
      const label = { id: forge.nextId(), name, color: str(json.color, 'ededed') };
      repo.labels.set(name, label);
      return sendJson(res, 201, labelJson(forge, repo, name));
    }
    if (method === 'GET') return sendJson(res, 200, [...repo.labels.keys()].map((n) => labelJson(forge, repo, n)));
    return notFound(res);
  }

  // ---- issues + comments
  if (sub[0] === 'issues') {
    if (sub.length === 1) {
      if (method === 'POST') {
        const title = str(json.title);
        const labelNames = Array.isArray(json.labels) ? json.labels.map((l) => str(typeof l === 'object' && l !== null ? (l as Record<string, unknown>).name : l)) : [];
        for (const name of labelNames) {
          if (!repo.labels.has(name)) return sendJson(res, 422, { message: `Label '${name}' does not exist` });
        }
        const issue: IssueRec = {
          kind: 'issue',
          id: forge.nextId(),
          number: repo.nextNumber++,
          title,
          body: str(json.body),
          state: 'open',
          labels: labelNames,
          comments: [],
          seq: forge.tick(),
        };
        repo.numbered.set(issue.number, issue);
        return sendJson(res, 201, issueJson(forge, repo, issue));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.numbered.values()].filter((n): n is IssueRec => n.kind === 'issue');
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const labelFilter = ctx.query.get('labels');
        if (labelFilter) {
          const wanted = labelFilter.split(',');
          list = list.filter((i) => wanted.every((w) => i.labels.includes(w)));
        }
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        return sendJson(res, 200, list.map((i) => issueJson(forge, repo, i)));
      }
      return notFound(res);
    }
    const num = Number(sub[1]);
    const rec = repo.numbered.get(num);
    if (sub.length === 2) {
      if (!rec || rec.kind !== 'issue') return notFound(res);
      if (method === 'GET') return sendJson(res, 200, issueJson(forge, repo, rec));
      if (method === 'PATCH') {
        if (json.state === 'open' || json.state === 'closed') rec.state = json.state;
        if (typeof json.title === 'string') rec.title = json.title;
        if (typeof json.body === 'string') rec.body = json.body;
        if (Array.isArray(json.labels)) {
          const names = json.labels.map((l) => str(typeof l === 'object' && l !== null ? (l as Record<string, unknown>).name : l));
          for (const name of names) if (!repo.labels.has(name)) return sendJson(res, 422, { message: `Label '${name}' does not exist` });
          rec.labels = names;
        }
        return sendJson(res, 200, issueJson(forge, repo, rec));
      }
      return notFound(res);
    }
    if (sub.length === 3 && sub[2] === 'comments') {
      if (!rec) return notFound(res);
      if (method === 'POST') {
        const comment = { id: forge.nextId(), body: str(json.body), seq: forge.tick() };
        rec.comments.push(comment);
        return sendJson(res, 201, commentJson(forge, comment));
      }
      if (method === 'GET') {
        return sendJson(res, 200, rec.comments.map((c) => commentJson(forge, c)));
      }
      return notFound(res);
    }
    return notFound(res);
  }

  // ---- pulls
  if (sub[0] === 'pulls') {
    if (sub.length === 1) {
      if (method === 'POST') {
        const cleanRef = (v: unknown): string => {
          const s = str(v);
          const colon = s.lastIndexOf(':');
          return colon === -1 ? s : s.slice(colon + 1);
        };
        const headRef = cleanRef(json.head);
        const baseRef = cleanRef(json.base);
        if (repo.tip(headRef) === null || repo.tip(baseRef) === null) {
          return sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head' }] });
        }
        const pull: PullRec = {
          kind: 'pull',
          id: forge.nextId(),
          number: repo.nextNumber++,
          title: str(json.title),
          body: str(json.body),
          state: 'open',
          headRef,
          baseRef,
          merged: false,
          mergedSha: null,
          comments: [],
          seq: forge.tick(),
        };
        repo.numbered.set(pull.number, pull);
        return sendJson(res, 201, pullJson(forge, repo, pull));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.numbered.values()].filter((n): n is PullRec => n.kind === 'pull');
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        return sendJson(res, 200, list.map((p) => pullJson(forge, repo, p)));
      }
      return notFound(res);
    }
    const num = Number(sub[1]);
    const rec = repo.numbered.get(num);
    if (!rec || rec.kind !== 'pull') return notFound(res);
    if (sub.length === 2 && method === 'GET') return sendJson(res, 200, pullJson(forge, repo, rec));
    if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
      const headFiles = repo.filesAt(repo.tip(rec.headRef));
      const baseTip = repo.tip(rec.baseRef);
      const headTip = repo.tip(rec.headRef);
      const mb = baseTip !== null && headTip !== null ? mergeBase(repo.store, baseTip, headTip) : null;
      const from = repo.filesAt(mb);
      const changes = diffFiles(repo.store, from, headFiles);
      return sendJson(res, 200, changes.map((c) => ({
        filename: c.filename,
        status: c.status,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.additions + c.deletions,
        sha: headFiles.get(c.filename) ?? from.get(c.filename) ?? ZERO_SHA,
      })));
    }
    if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
      if (rec.state !== 'open') return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      const { mergeable, baseSha, headSha } = pullMergeability(repo, rec);
      if (!mergeable || baseSha === null || headSha === null) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      const headObj = repo.store.get(headSha);
      if (!headObj || headObj.type !== 'commit') return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      const tree = parseCommit(headObj.body).tree;
      const title = str(json.commit_title, `${rec.title} (#${rec.number})`);
      const extra = str(json.commit_message);
      const message = extra === '' ? title : `${title}\n\n${extra}`;
      const sha = repo.store.put('commit', buildCommit(tree, [baseSha], message, forge.timeOf(forge.tick())));
      repo.setTip(rec.baseRef, sha);
      rec.state = 'closed';
      rec.merged = true;
      rec.mergedSha = sha;
      return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound(res);
  }

  return notFound(res);
}

// ---------------------------------------------------------------- server

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
        const body = await readBody(req);

        if ((req.method ?? 'GET') === 'GET' && url.pathname === '/healthz') {
          return sendJson(res, 200, { ok: true });
        }

        // Everything else needs the trial's bearer token.
        if (!authorized(req)) return sendJson(res, 401, { message: 'Bad credentials' });

        let json: Record<string, unknown> | null = null;
        const wantsJson = segments[0] === 'api' || segments[0] === 'mcp';
        if (wantsJson && body.length > 0) {
          try {
            const parsed: unknown = JSON.parse(body.toString('utf8'));
            json = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
            if (json === null && segments[0] === 'api') return badRequest(res, 'Invalid JSON');
          } catch {
            if (segments[0] === 'mcp') {
              // MCP answers a parse error in-band (handled in mcp.ts via raw body).
              json = null;
            } else {
              return badRequest(res, 'Problems parsing JSON');
            }
          }
        }

        const ctx: Ctx = { forge, req, body, json, query: url.searchParams };

        if (segments[0] === 'api' && segments[1] === 'v3') return handleRest(ctx, res, segments);
        if (segments[0] === 'api' && segments[1] === 'graphql') return handleGraphQL(ctx, res);
        if (segments[0] === 'mcp') return handleMcp(ctx, res);
        if (segments.length >= 2 && segments[1].endsWith('.git')) return handleGit(ctx, res, segments, url);

        return notFound(res);
      } catch {
        return sendJson(res, 500, { message: 'Internal Server Error' });
      }
    })();
  });
}

export { sendJson, sendRaw };
