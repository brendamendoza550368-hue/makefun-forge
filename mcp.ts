// mcp.ts — the Model Context Protocol endpoint at POST /mcp: JSON-RPC 2.0
// over Streamable HTTP. Speaks the 2026-07-28 revision (server/discover)
// and the classic initialize handshake. The tools are thin wrappers over
// the same store REST and GraphQL use, so an object created here reads
// back identically on the other surfaces.

import type { ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { issueJson, pullJson, repoJson, sendJson, sendRaw } from './app.ts';
import { pullMergeability, type IssueRec, type PullRec } from './store.ts';
import { buildCommit, parseCommit } from './git.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: schema({ name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository by owner and name.',
    inputSchema: schema({ owner: { type: 'string' }, repo: { type: 'string' } }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: schema(
      { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: schema({ owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: schema(
      { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: schema({ owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, ['owner', 'repo', 'pull_number']),
  },
];

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function callTool(ctx: Ctx, rawName: string, args: Record<string, unknown>): Record<string, unknown> | { rpcErr: number; message: string } {
  const forge = ctx.forge;
  const name = rawName.toLowerCase().split('__').pop() ?? '';
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { rpcErr: -32602, message: `Unknown tool: ${rawName}` };
  for (const required of (def.inputSchema.required as string[]) ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { rpcErr: -32602, message: `Missing required argument: ${required}` };
    }
  }

  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name') as string;
      if (forge.repos.has(repoName)) return toolError(`Repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName);
      repo.isPrivate = args.private === true;
      if (typeof args.description === 'string') repo.description = args.description;
      return toolOk(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = forge.repoFor(strArg(args, 'owner') ?? '', strArg(args, 'repo') ?? '');
      if (!repo) return toolError('Repository not found');
      return toolOk(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = forge.repoFor(strArg(args, 'owner') ?? '', strArg(args, 'repo') ?? '');
      if (!repo) return toolError('Repository not found');
      const labelNames = Array.isArray(args.labels) ? args.labels.map((l) => String(l)) : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) repo.labels.set(labelName, { id: forge.nextId(), name: labelName, color: 'ededed' });
      }
      const issue: IssueRec = {
        kind: 'issue',
        id: forge.nextId(),
        number: repo.nextNumber++,
        title: strArg(args, 'title') as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: labelNames,
        comments: [],
        seq: forge.tick(),
      };
      repo.numbered.set(issue.number, issue);
      return toolOk(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = forge.repoFor(strArg(args, 'owner') ?? '', strArg(args, 'repo') ?? '');
      if (!repo) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.numbered.values()].filter((n): n is IssueRec => n.kind === 'issue');
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return toolOk(list.map((i) => issueJson(forge, repo, i)));
    }
    case 'create_pull_request': {
      const repo = forge.repoFor(strArg(args, 'owner') ?? '', strArg(args, 'repo') ?? '');
      if (!repo) return toolError('Repository not found');
      const head = strArg(args, 'head') as string;
      const base = strArg(args, 'base') as string;
      if (repo.tip(head) === null || repo.tip(base) === null) return toolError('Invalid head or base branch');
      const pull: PullRec = {
        kind: 'pull',
        id: forge.nextId(),
        number: repo.nextNumber++,
        title: strArg(args, 'title') as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedSha: null,
        comments: [],
        seq: forge.tick(),
      };
      repo.numbered.set(pull.number, pull);
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.repoFor(strArg(args, 'owner') ?? '', strArg(args, 'repo') ?? '');
      if (!repo) return toolError('Repository not found');
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const rec = repo.numbered.get(num);
      if (!rec || rec.kind !== 'pull') return toolError('Pull request not found');
      if (rec.state !== 'open') return toolError('Pull request is not open');
      const { mergeable, baseSha, headSha } = pullMergeability(repo, rec);
      if (!mergeable || baseSha === null || headSha === null) return toolError('Pull request is not mergeable');
      const headObj = repo.store.get(headSha);
      if (!headObj || headObj.type !== 'commit') return toolError('Pull request is not mergeable');
      const tree = parseCommit(headObj.body).tree;
      const sha = repo.store.put('commit', buildCommit(tree, [baseSha], `${rec.title} (#${rec.number})`, forge.timeOf(forge.tick())));
      repo.setTip(rec.baseRef, sha);
      rec.state = 'closed';
      rec.merged = true;
      rec.mergedSha = sha;
      return toolOk({ ...pullJson(forge, repo, rec), sha, merged: true });
    }
    default:
      return { rpcErr: -32602, message: `Unknown tool: ${rawName}` };
  }
}

function handleOne(ctx: Ctx, req: RpcRequest): Record<string, unknown> | null {
  const hasId = 'id' in req && req.id !== undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  if (!hasId) return null; // A notification: nothing to answer.

  switch (method) {
    case 'server/discover':
      return rpcResult(req.id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
      return rpcResult(req.id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(req.id, {});
    case 'tools/list':
      return rpcResult(req.id, { tools: TOOLS });
    case 'tools/call': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const out = callTool(ctx, toolName, args);
      if ('rpcErr' in out) return rpcError(req.id, out.rpcErr, out.message);
      return rpcResult(req.id, out);
    }
    default:
      return rpcError(req.id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(ctx: Ctx, res: ServerResponse): void {
  if ((ctx.req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const out = parsed.map((entry) => handleOne(ctx, entry as RpcRequest)).filter((r) => r !== null);
    sendJson(res, 200, out);
    return;
  }
  const result = handleOne(ctx, parsed as RpcRequest);
  if (result === null) {
    sendRaw(res, 202, Buffer.alloc(0), 'text/plain');
    return;
  }
  sendJson(res, 200, result);
}
