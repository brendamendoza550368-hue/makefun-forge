// graphql.ts — the GraphQL v4 surface at POST /api/graphql.
//
// A small purpose-built engine: a lexer/parser for the documents gh and
// github-mcp-server send (fields, aliases, arguments with inline enums,
// lists and input objects, variables, fragments, operation names, batched
// documents), a resolver layer over the shared store, and introspection
// for the types those clients probe.

import type { ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendJson, nodeId } from './app.ts';
import { Forge, Repo, diffFiles, pullMergeability, type IssueRec, type PullRec } from './store.ts';
import { buildCommit, mergeBase, parseCommit } from './git.ts';

// ------------------------------------------------------------ lexer

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { toks.push({ kind: 'spread' }); i += 3; continue; }
    if ('{}()[]:=@$!|&'.includes(c)) { toks.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push({ kind: 'string', value: src.slice(i + 3, end === -1 ? src.length : end) });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      if (text.includes('.') || text.includes('e') || text.includes('E')) toks.push({ kind: 'float', value: Number(text) });
      else toks.push({ kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  toks.push({ kind: 'eof' });
  return toks;
}

// ------------------------------------------------------------ parser

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> }
  | { kind: 'var'; name: string };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] };

interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  readonly fragments = new Map<string, SelectionNode[]>();
  readonly operations: Operation[] = [];
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok { return this.toks[this.pos]; }
  private next(): Tok { return this.toks[this.pos++]; }
  private atPunct(v: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === v;
  }
  private eatPunct(v: string): void {
    if (this.atPunct(v)) this.pos += 1;
  }

  parseDocument(): void {
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        this.operations.push({ opType: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = (this.next() as { value: string }).value;
        if (this.atPunct('(')) this.skipBalanced(); // variable definitions
        // Directives on the operation: skip any @name(args) groups.
        while (this.atPunct('@')) { this.next(); this.next(); if (this.atPunct('(')) this.skipBalanced(); }
        this.operations.push({ opType: t.value === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = (this.next() as { value: string }).value;
        this.next(); // 'on'
        this.next(); // type condition
        this.fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      this.next();
    }
  }

  private skipBalanced(): void {
    let depth = 0;
    for (;;) {
      const t = this.next();
      if (t.kind === 'eof') return;
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) depth += 1;
      if (t.kind === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}')) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    const out: SelectionNode[] = [];
    this.eatPunct('{');
    while (!this.atPunct('}') && this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'spread') {
        this.next();
        const nt = this.peek();
        if (nt.kind === 'name' && nt.value === 'on') {
          this.next();
          const typeName = (this.next() as { value: string }).value;
          out.push({ kind: 'inline', typeCondition: typeName, selection: this.parseSelectionSet() });
        } else {
          const name = (this.next() as { value: string }).value;
          out.push({ kind: 'spread', name });
        }
        continue;
      }
      // A field: [alias:] name [(args)] [directives] [selection]
      let name = (this.next() as { value: string }).value;
      let alias: string | null = null;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = (this.next() as { value: string }).value;
      }
      const args = new Map<string, Value>();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')') && this.peek().kind !== 'eof') {
          const argName = (this.next() as { value: string }).value;
          this.eatPunct(':');
          args.set(argName, this.parseValue());
        }
        this.eatPunct(')');
      }
      while (this.atPunct('@')) { this.next(); this.next(); if (this.atPunct('(')) this.skipBalanced(); }
      let selection: SelectionNode[] | null = null;
      if (this.atPunct('{')) selection = this.parseSelectionSet();
      out.push({ kind: 'field', alias, name, args, selection });
    }
    this.eatPunct('}');
    return out;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'punct' && t.value === '$') {
      const name = (this.next() as { value: string }).value;
      return { kind: 'var', name };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.eatPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const key = (this.next() as { value: string }).value;
        this.eatPunct(':');
        fields.set(key, this.parseValue());
      }
      this.eatPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    return { kind: 'null' };
  }
}

// ------------------------------------------------------------ values

type Vars = Record<string, unknown>;

function resolveValue(v: Value, vars: Vars): unknown {
  switch (v.kind) {
    case 'string': return v.value;
    case 'int': return v.value;
    case 'float': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'var': return vars[v.name] ?? null;
    case 'list': return v.items.map((i) => resolveValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = resolveValue(val, vars);
      return out;
    }
  }
}

function argStr(field: FieldNode, name: string, vars: Vars): string | null {
  const v = field.args.get(name);
  if (!v) return null;
  const r = resolveValue(v, vars);
  return typeof r === 'string' ? r : r === null ? null : String(r);
}

function argInt(field: FieldNode, name: string, vars: Vars): number | null {
  const v = field.args.get(name);
  if (!v) return null;
  const r = resolveValue(v, vars);
  return typeof r === 'number' ? r : null;
}

// ------------------------------------------------------------ schema (for introspection)

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const SCALAR = (name: string): TypeDef => ({ kind: 'SCALAR' });
const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'repository'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'additions', 'deletions', 'changedFiles'],
  },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'committedDate'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['clientMutationId', 'issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['clientMutationId', 'issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['clientMutationId', 'pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['clientMutationId', 'pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['clientMutationId', 'commentEdge', 'subject'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  SearchResultItemConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'issueCount', 'repositoryCount', 'userCount', 'discussionCount'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: { kind: 'ENUM', enumValues: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  IssueClosedStateReason: { kind: 'ENUM', enumValues: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'] },
  String: SCALAR('String'),
  Int: SCALAR('Int'),
  ID: SCALAR('ID'),
  Boolean: SCALAR('Boolean'),
  DateTime: SCALAR('DateTime'),
  URI: SCALAR('URI'),
  GitObjectID: SCALAR('GitObjectID'),
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'] },
};

function typeIntro(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (!def) return null;
  return {
    name,
    kind: def.kind,
    description: null,
    fields: (def.fields ?? []).map((f) => ({
      name: f,
      description: null,
      args: [],
      type: { name: 'String', kind: 'SCALAR' },
      isDeprecated: false,
      deprecationReason: null,
    })),
    enumValues: (def.enumValues ?? []).map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })),
    inputFields: [],
    interfaces: [],
    possibleTypes: null,
    ofType: null,
  };
}

// ------------------------------------------------------------ execution

interface GqlError {
  message: string;
}

type Obj = Record<string, unknown> & { __type: string };

function viewerObj(forge: Forge): Obj {
  return { __type: 'User', id: nodeId('User', 1), login: forge.ownerLogin(), name: forge.ownerLogin(), email: null, url: '', avatarUrl: '' };
}

function repoObj(forge: Forge, repo: Repo): Obj {
  return { __type: 'Repository', __repo: repo.name };
}

function issueObj(rec: IssueRec): Obj {
  return { __type: 'Issue', __number: rec.number };
}

function pullObj(rec: PullRec): Obj {
  return { __type: 'PullRequest', __number: rec.number };
}

interface ExecState {
  forge: Forge;
  errors: GqlError[];
  fragments: Map<string, SelectionNode[]>;
}

function decodeNodeId(id: string): { kind: string; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.lastIndexOf(':');
    if (colon === -1) return null;
    const num = Number(text.slice(colon + 1));
    if (!Number.isFinite(num)) return null;
    return { kind: text.slice(0, colon), num };
  } catch {
    return null;
  }
}

function findRepoById(forge: Forge, idNum: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === idNum) return repo;
  return null;
}

function findNumbered(forge: Forge, kind: string, idNum: number): { repo: Repo; rec: IssueRec | PullRec } | null {
  for (const repo of forge.repos.values()) {
    for (const rec of repo.numbered.values()) {
      if (rec.id === idNum && ((kind === 'Issue' && rec.kind === 'issue') || (kind === 'PullRequest' && rec.kind === 'pull'))) {
        return { repo, rec };
      }
    }
  }
  return null;
}

function cursorOf(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function pullState(rec: PullRec): string {
  if (rec.merged) return 'MERGED';
  return rec.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function resolveField(state: ExecState, obj: Obj, field: FieldNode, vars: Vars): unknown {
  const { forge } = state;
  const type = obj.__type;
  const name = field.name;

  if (name === '__typename') return type;

  // ----- Query root
  if (type === 'Query') {
    if (name === 'viewer') return viewerObj(forge);
    if (name === 'repository') {
      const owner = argStr(field, 'owner', vars) ?? '';
      const repoName = argStr(field, 'name', vars) ?? '';
      const repo = forge.repoFor(owner, repoName);
      return repo ? repoObj(forge, repo) : null;
    }
    if (name === 'node') {
      const id = argStr(field, 'id', vars) ?? '';
      const decoded = decodeNodeId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(forge, decoded.num);
        return repo ? repoObj(forge, repo) : null;
      }
      const found = findNumbered(forge, decoded.kind, decoded.num);
      if (!found) return null;
      return found.rec.kind === 'issue' ? { ...issueObj(found.rec), __repo: found.repo.name } : { ...pullObj(found.rec), __repo: found.repo.name };
    }
    if (name === '__type') {
      const typeName = argStr(field, 'name', vars) ?? '';
      const intro = typeIntro(typeName);
      if (!intro) return null;
      return { __type: '__Type', __intro: intro };
    }
    if (name === '__schema') {
      return { __type: '__Schema' };
    }
    state.errors.push({ message: `Field '${name}' doesn't exist on type 'Query'` });
    return null;
  }

  // ----- Mutation root
  if (type === 'Mutation') {
    return resolveMutation(state, field, vars);
  }

  // ----- Introspection wrappers: resolve by copying the described shape
  if (type === '__Type' || type === '__Field' || type === '__EnumValue' || type === '__InputValue') {
    const raw = (obj as unknown as { __intro?: Record<string, unknown> }).__intro ?? obj;
    const value = (raw as Record<string, unknown>)[name];
    if (name === 'fields' || name === 'enumValues' || name === 'inputFields') {
      const list = Array.isArray(value) ? value : [];
      const kind = name === 'fields' ? '__Field' : name === 'enumValues' ? '__EnumValue' : '__InputValue';
      return list.map((entry) => ({ __type: kind, __intro: entry as Record<string, unknown>, ...(entry as Record<string, unknown>) }));
    }
    return value ?? null;
  }
  if (type === '__Schema') {
    if (name === 'types') return Object.keys(SCHEMA).map((t) => ({ __type: '__Type', __intro: typeIntro(t) }));
    if (name === 'queryType') return { __type: '__Type', __intro: typeIntro('Query') };
    if (name === 'mutationType') return { __type: '__Type', __intro: typeIntro('Mutation') };
    return null;
  }

  // ----- Repository
  if (type === 'Repository') {
    const repo = forge.repos.get(obj.__repo as string);
    if (!repo) return null;
    switch (name) {
      case 'id': return nodeId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${forge.ownerLogin()}/${repo.name}`;
      case 'owner': return viewerObj(forge);
      case 'defaultBranchRef': {
        const tip = repo.tip(repo.defaultBranch);
        if (tip === null) return null;
        return { __type: 'Ref', __refName: repo.defaultBranch, __oid: tip };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'hasProjectsEnabled': return true;
      case 'hasWikiEnabled': return true;
      case 'isPrivate': return repo.isPrivate;
      case 'description': return repo.description;
      case 'url': return '';
      case 'createdAt': return forge.isoOf(repo.seq);
      case 'updatedAt': return forge.isoOf(repo.seq);
      case 'stargazerCount': return 0;
      case 'forkCount': return 0;
      case 'issue': {
        const num = argInt(field, 'number', vars);
        const rec = num !== null ? repo.numbered.get(num) : undefined;
        return rec && rec.kind === 'issue' ? { ...issueObj(rec), __repo: repo.name } : null;
      }
      case 'pullRequest': {
        const num = argInt(field, 'number', vars);
        const rec = num !== null ? repo.numbered.get(num) : undefined;
        return rec && rec.kind === 'pull' ? { ...pullObj(rec), __repo: repo.name } : null;
      }
      case 'issues': return issuesConnection(state, repo, field, vars);
      case 'pullRequests': return pullsConnection(state, repo, field, vars);
      default:
        state.errors.push({ message: `Field '${name}' doesn't exist on type 'Repository'` });
        return null;
    }
  }

  // ----- Ref
  if (type === 'Ref') {
    if (name === 'name') return obj.__refName;
    if (name === 'prefix') return 'refs/heads/';
    if (name === 'id') return nodeId('Ref', 0);
    if (name === 'target') return { __type: 'Commit', __oid: obj.__oid };
    state.errors.push({ message: `Field '${name}' doesn't exist on type 'Ref'` });
    return null;
  }
  if (type === 'Commit') {
    if (name === 'oid' || name === 'id') return obj.__oid;
    return null;
  }

  // ----- Issue
  if (type === 'Issue' || type === 'PullRequest') {
    const found = findRecForObj(forge, obj);
    if (!found) return null;
    const { repo: owner, rec } = found;
    if (type === 'Issue') {
      const issue = rec as IssueRec;
      switch (name) {
        case 'id': return nodeId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return viewerObj(forge);
        case 'url': return '';
        case 'createdAt': return forge.isoOf(issue.seq);
        case 'updatedAt': return forge.isoOf(issue.seq);
        case 'closedAt': return issue.state === 'closed' ? forge.isoOf(issue.seq) : null;
        case 'repository': return repoObj(forge, owner);
        case 'labels': return { __type: 'LabelConnection', __labels: issue.labels.map((n) => ({ repo: owner, name: n })) };
        case 'comments': return { __type: 'IssueCommentConnection', __comments: issue.comments };
        default:
          state.errors.push({ message: `Field '${name}' doesn't exist on type 'Issue'` });
          return null;
      }
    }
    const pull = rec as PullRec;
    switch (name) {
      case 'id': return nodeId('PullRequest', pull.id);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pullState(pull);
      case 'merged': return pull.merged;
      case 'mergeable': {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        return pullMergeability(owner, pull).mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'author': return viewerObj(forge);
      case 'url': return '';
      case 'createdAt': return forge.isoOf(pull.seq);
      case 'updatedAt': return forge.isoOf(pull.seq);
      case 'mergedAt': return pull.merged ? forge.isoOf(pull.seq) : null;
      case 'repository': return repoObj(forge, owner);
      case 'files': return filesConnection(state, owner, pull, field, vars);
      case 'additions': case 'deletions': case 'changedFiles': {
        const changes = prChanges(owner, pull);
        if (name === 'changedFiles') return changes.length;
        return changes.reduce((sum, c) => sum + (name === 'additions' ? c.additions : c.deletions), 0);
      }
      default:
        state.errors.push({ message: `Field '${name}' doesn't exist on type 'PullRequest'` });
        return null;
    }
  }

  // ----- Connections and misc wrappers
  if (type === 'LabelConnection') {
    if (name === 'nodes') return (obj.__labels as { repo: Repo; name: string }[]).map((l) => ({ __type: 'Label', __repoName: l.repo.name, __labelName: l.name }));
    if (name === 'totalCount') return (obj.__labels as unknown[]).length;
    return null;
  }
  if (type === 'Label') {
    const repo = forge.repos.get(obj.__repoName as string);
    const label = repo?.labels.get(obj.__labelName as string);
    if (name === 'id') return nodeId('Label', label?.id ?? 0);
    if (name === 'name') return obj.__labelName;
    if (name === 'color') return label?.color ?? 'ededed';
    if (name === 'description') return '';
    return null;
  }
  if (type === 'IssueCommentConnection') {
    const comments = obj.__comments as { id: number; body: string; seq: number }[];
    if (name === 'nodes') return comments.map((c) => ({ __type: 'IssueComment', __comment: c }));
    if (name === 'totalCount') return comments.length;
    if (name === 'pageInfo') return { __type: 'PageInfo', __hasNext: false, __end: comments.length ? cursorOf(comments[comments.length - 1].id) : null };
    return null;
  }
  if (type === 'IssueComment') {
    const c = obj.__comment as { id: number; body: string; seq: number };
    if (name === 'id') return nodeId('IssueComment', c.id);
    if (name === 'databaseId') return c.id;
    if (name === 'body') return c.body;
    if (name === 'author') return viewerObj(forge);
    if (name === 'createdAt' || name === 'updatedAt') return forge.isoOf(c.seq);
    if (name === 'url') return '';
    return null;
  }
  if (type === 'PageInfo') {
    if (name === 'hasNextPage') return obj.__hasNext ?? false;
    if (name === 'hasPreviousPage') return false;
    if (name === 'endCursor') return obj.__end ?? null;
    if (name === 'startCursor') return obj.__start ?? null;
    return null;
  }
  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestChangedFileConnection') {
    const items = obj.__items as Obj[];
    if (name === 'nodes') return items;
    if (name === 'totalCount') return obj.__total ?? items.length;
    if (name === 'pageInfo') return { __type: 'PageInfo', __hasNext: obj.__hasNext ?? false, __end: obj.__end ?? null, __start: obj.__start ?? null };
    if (name === 'edges') return items.map((item) => ({ __type: type === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge', __node: item, __cursor: cursorOf((item.__number as number) ?? 0) }));
    return null;
  }
  if (type === 'IssueEdge' || type === 'PullRequestEdge') {
    if (name === 'node') return obj.__node;
    if (name === 'cursor') return obj.__cursor;
    return null;
  }
  if (type === 'PullRequestChangedFile') {
    if (name === 'path') return obj.__path;
    if (name === 'additions') return obj.__additions;
    if (name === 'deletions') return obj.__deletions;
    if (name === 'changeType') return obj.__changeType;
    return null;
  }
  if (type === 'User') {
    const value = (obj as Record<string, unknown>)[name];
    if (value !== undefined) return value;
    state.errors.push({ message: `Field '${name}' doesn't exist on type 'User'` });
    return null;
  }
  if (type.endsWith('Payload')) {
    if (name === 'clientMutationId') return obj.__clientMutationId ?? null;
    const value = (obj as Record<string, unknown>)[name];
    return value ?? null;
  }
  if (type === 'IssueCommentEdge') {
    if (name === 'node') return obj.__node;
    if (name === 'cursor') return obj.__cursor;
    return null;
  }

  state.errors.push({ message: `Field '${name}' doesn't exist on type '${type}'` });
  return null;
}

function findRepoHolding(forge: Forge, number: number, kind: 'issue' | 'pull'): Repo | null {
  for (const repo of forge.repos.values()) {
    const rec = repo.numbered.get(number);
    if (rec && rec.kind === kind) return repo;
  }
  return null;
}

/** Issue/Pull objects carry their repo name when known, else find the holder. */
function findRecForObj(forge: Forge, obj: Obj): { repo: Repo; rec: IssueRec | PullRec } | null {
  const kind = obj.__type === 'Issue' ? 'issue' : 'pull';
  const named = typeof obj.__repo === 'string' ? forge.repos.get(obj.__repo) : undefined;
  const repo = named ?? findRepoHolding(forge, obj.__number as number, kind);
  if (!repo) return null;
  const rec = repo.numbered.get(obj.__number as number);
  return rec && rec.kind === kind ? { repo, rec } : null;
}

function prChanges(repo: Repo, pull: PullRec) {
  const baseTip = repo.tip(pull.baseRef);
  const headTip = repo.tip(pull.headRef);
  const mb = baseTip !== null && headTip !== null ? mergeBase(repo.store, baseTip, headTip) : null;
  return diffFiles(repo.store, repo.filesAt(mb), repo.filesAt(headTip));
}

function filesConnection(state: ExecState, repo: Repo, pull: PullRec, field: FieldNode, vars: Vars): Obj {
  void state;
  void vars;
  const first = argInt(field, 'first', vars) ?? 100;
  const changes = prChanges(repo, pull);
  const items = changes.slice(0, first).map((c) => ({
    __type: 'PullRequestChangedFile',
    __path: c.filename,
    __additions: c.additions,
    __deletions: c.deletions,
    __changeType: c.status === 'added' ? 'ADDED' : c.status === 'removed' ? 'DELETED' : 'MODIFIED',
  })) as Obj[];
  return { __type: 'PullRequestChangedFileConnection', __items: items, __total: changes.length, __hasNext: changes.length > first, __end: null, __start: null };
}

function issuesConnection(state: ExecState, repo: Repo, field: FieldNode, vars: Vars): Obj {
  void state;
  const first = argInt(field, 'first', vars) ?? 10;
  const statesRaw = field.args.get('states');
  const states = statesRaw ? (resolveValue(statesRaw, vars) as string[]) : null;
  const orderRaw = field.args.get('orderBy');
  const order = orderRaw ? (resolveValue(orderRaw, vars) as { field?: string; direction?: string }) : null;
  const direction = order?.direction ?? 'DESC';
  const afterRaw = argStr(field, 'after', vars);
  let list = [...repo.numbered.values()].filter((n): n is IssueRec => n.kind === 'issue');
  if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
  list.sort((a, b) => {
    const key = order?.field === 'COMMENTS' ? (x: IssueRec) => x.comments.length : (x: IssueRec) => x.seq;
    return direction === 'ASC' ? key(a) - key(b) : key(b) - key(a);
  });
  if (afterRaw) {
    const decoded = Buffer.from(afterRaw, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    if (m) {
      const idx = list.findIndex((i) => i.number === Number(m[1]));
      if (idx !== -1) list = list.slice(idx + 1);
    }
  }
  const page = list.slice(0, first);
  const items = page.map((rec) => ({ ...issueObj(rec), __repo: repo.name })) as Obj[];
  return {
    __type: 'IssueConnection',
    __items: items,
    __total: list.length,
    __hasNext: list.length > first,
    __end: page.length ? cursorOf(page[page.length - 1].number) : null,
    __start: page.length ? cursorOf(page[0].number) : null,
  };
}

function pullsConnection(state: ExecState, repo: Repo, field: FieldNode, vars: Vars): Obj {
  void state;
  const first = argInt(field, 'first', vars) ?? 10;
  const statesRaw = field.args.get('states');
  const states = statesRaw ? (resolveValue(statesRaw, vars) as string[]) : null;
  let list = [...repo.numbered.values()].filter((n): n is PullRec => n.kind === 'pull');
  if (states) list = list.filter((p) => states.includes(pullState(p)));
  list.sort((a, b) => b.seq - a.seq);
  const page = list.slice(0, first);
  const items = page.map((rec) => ({ ...pullObj(rec), __repo: repo.name })) as Obj[];
  return {
    __type: 'PullRequestConnection',
    __items: items,
    __total: list.length,
    __hasNext: list.length > first,
    __end: page.length ? cursorOf(page[page.length - 1].number) : null,
    __start: page.length ? cursorOf(page[0].number) : null,
  };
}

// ------------------------------------------------------------ mutations

function resolveMutation(state: ExecState, field: FieldNode, vars: Vars): unknown {
  const { forge } = state;
  const name = field.name;
  const inputRaw = field.args.get('input');
  const input = (inputRaw ? resolveValue(inputRaw, vars) : {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;

  const payload = (type: string, extra: Record<string, unknown>): Obj => ({ __type: type, __clientMutationId: clientMutationId, ...extra } as Obj);

  if (name === 'createIssue') {
    const decoded = decodeNodeId(String(input.repositoryId ?? ''));
    const repo = decoded ? findRepoById(forge, decoded.num) : null;
    if (!repo) {
      state.errors.push({ message: 'Repository not found' });
      return payload('CreateIssuePayload', { issue: null });
    }
    const issue: IssueRec = {
      kind: 'issue',
      id: forge.nextId(),
      number: repo.nextNumber++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      comments: [],
      seq: forge.tick(),
    };
    repo.numbered.set(issue.number, issue);
    return payload('CreateIssuePayload', { issue: { ...issueObj(issue), __repo: repo.name } });
  }

  if (name === 'closeIssue') {
    const found = findNumbered(forge, 'Issue', decodeNodeId(String(input.issueId ?? ''))?.num ?? -1);
    if (!found || found.rec.kind !== 'issue') {
      state.errors.push({ message: 'Issue not found' });
      return payload('CloseIssuePayload', { issue: null });
    }
    found.rec.state = 'closed';
    return payload('CloseIssuePayload', { issue: { ...issueObj(found.rec), __repo: found.repo.name } });
  }

  if (name === 'createPullRequest') {
    const decoded = decodeNodeId(String(input.repositoryId ?? ''));
    const repo = decoded ? findRepoById(forge, decoded.num) : null;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    if (!repo || repo.tip(headRef) === null || repo.tip(baseRef) === null) {
      state.errors.push({ message: 'Invalid head or base ref' });
      return payload('CreatePullRequestPayload', { pullRequest: null });
    }
    const pull: PullRec = {
      kind: 'pull',
      id: forge.nextId(),
      number: repo.nextNumber++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedSha: null,
      comments: [],
      seq: forge.tick(),
    };
    repo.numbered.set(pull.number, pull);
    return payload('CreatePullRequestPayload', { pullRequest: { ...pullObj(pull), __repo: repo.name } });
  }

  if (name === 'mergePullRequest') {
    const found = findNumbered(forge, 'PullRequest', decodeNodeId(String(input.pullRequestId ?? ''))?.num ?? -1);
    if (!found || found.rec.kind !== 'pull') {
      state.errors.push({ message: 'Pull request not found' });
      return payload('MergePullRequestPayload', { pullRequest: null });
    }
    const repo = found.repo;
    const pull = found.rec;
    const method = String(input.mergeMethod ?? 'MERGE');
    if (pull.state === 'open') {
      const { mergeable } = pullMergeability(repo, pull);
      if (mergeable) {
        const sha = mergeViaRest(repo, pull, method, forge);
        if (sha !== null) {
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedSha = sha;
        }
      }
    }
    return payload('MergePullRequestPayload', { pullRequest: { ...pullObj(pull), __repo: repo.name } });
  }

  if (name === 'addComment') {
    const decoded = decodeNodeId(String(input.subjectId ?? ''));
    const found = decoded ? findNumbered(forge, decoded.kind, decoded.num) : null;
    if (!found) {
      state.errors.push({ message: 'Subject not found' });
      return payload('AddCommentPayload', { commentEdge: null });
    }
    const comment = { id: forge.nextId(), body: String(input.body ?? ''), seq: forge.tick() };
    found.rec.comments.push(comment);
    const node = { __type: 'IssueComment', __comment: comment } as Obj;
    return payload('AddCommentPayload', {
      commentEdge: { __type: 'IssueCommentEdge', __node: node, __cursor: cursorOf(comment.id) },
      subject: found.rec.kind === 'issue' ? { ...issueObj(found.rec), __repo: found.repo.name } : { ...pullObj(found.rec as PullRec), __repo: found.repo.name },
    });
  }

  state.errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
  return null;
}

/** Merge a pull request (squash or two-parent merge); returns the new base tip. */
function mergeViaRest(repo: Repo, pull: PullRec, method: string, forge: Forge): string | null {
  const baseSha = repo.tip(pull.baseRef);
  const headSha = repo.tip(pull.headRef);
  if (baseSha === null || headSha === null) return null;
  const headObj = repo.store.get(headSha);
  if (!headObj || headObj.type !== 'commit') return null;
  const tree = parseCommit(headObj.body).tree;
  const parents = method === 'MERGE' ? [baseSha, headSha] : [baseSha];
  const message = method === 'MERGE' ? `Merge pull request #${pull.number} from ${pull.headRef}` : `${pull.title} (#${pull.number})`;
  const sha = repo.store.put('commit', buildCommit(tree, parents, message, forge.timeOf(forge.tick())));
  repo.setTip(pull.baseRef, sha);
  return sha;
}

// ------------------------------------------------------------ selection execution

function executeSelection(state: ExecState, obj: Obj, selection: SelectionNode[], vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'spread') {
      const frag = state.fragments.get(node.name);
      if (frag) Object.assign(out, executeSelection(state, obj, frag, vars));
      continue;
    }
    if (node.kind === 'inline') {
      if (node.typeCondition === null || node.typeCondition === obj.__type || node.typeCondition === 'Node') {
        Object.assign(out, executeSelection(state, obj, node.selection, vars));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    const raw = resolveField(state, obj, node, vars);
    out[key] = completeValue(state, raw, node, vars);
  }
  return out;
}

function completeValue(state: ExecState, raw: unknown, field: FieldNode, vars: Vars): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(state, item, field, vars));
  if (typeof raw === 'object') {
    const obj = raw as Obj;
    if (typeof obj.__type === 'string' && field.selection) {
      return executeSelection(state, obj, field.selection, vars);
    }
    if (typeof obj.__type === 'string' && !field.selection) return obj;
    return raw;
  }
  return raw;
}

// ------------------------------------------------------------ handler

export function handleGraphQL(ctx: Ctx, res: ServerResponse): void {
  const forge = ctx.forge;
  const bodyText = ctx.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    return;
  }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  const results = docs.map((doc) => runDocument(forge, doc as Record<string, unknown>));
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
}

function runDocument(forge: Forge, doc: Record<string, unknown>): Record<string, unknown> {
  const query = typeof doc.query === 'string' ? doc.query : '';
  const vars = (typeof doc.variables === 'object' && doc.variables !== null ? doc.variables : {}) as Vars;
  const parser = new Parser(lex(query));
  parser.parseDocument();
  const opName = typeof doc.operationName === 'string' ? doc.operationName : null;
  const op = parser.operations.find((o) => opName === null || o.name === opName) ?? parser.operations[0];
  if (!op) return { data: null, errors: [{ message: 'No operation found' }] };
  const state: ExecState = { forge, errors: [], fragments: parser.fragments };
  const root: Obj = { __type: op.opType === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(state, root, op.selection, vars);
  const out: Record<string, unknown> = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}
