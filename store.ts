// store.ts — the forge's state: repositories (each with its own git object
// store), issues, pull requests, labels and comments, plus the operations
// the REST, GraphQL and MCP surfaces share.
//
// There is exactly one authenticated user per trial (the bearer token's
// owner). The trial never tells the forge that user's login up front, so
// the login is bound lazily: the first owner-named path that reaches an
// existing repository fixes it, and every other owner is a 404 from then
// on — the same answer GitHub gives for a repository you cannot see.

import {
  ObjectStore,
  ZERO_SHA,
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  walkCommits,
} from './git.ts';

export interface LabelRec {
  id: number;
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedSha: string | null;
  comments: CommentRec[];
  seq: number;
}

export type NumberedRec = IssueRec | PullRec;

export class Repo {
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly numbered = new Map<number, NumberedRec>();
  nextNumber = 1;
  description = '';
  isPrivate = false;
  defaultBranch = 'main';
  readonly id: number;
  readonly name: string;
  readonly seq: number;

  constructor(id: number, name: string, seq: number) {
    this.id = id;
    this.name = name;
    this.seq = seq;
  }

  tip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setTip(branch: string, sha: string): void {
    this.refs.set(`refs/heads/${branch}`, sha);
  }

  /** path -> blob sha at a commit (empty map for an unborn branch). */
  filesAt(commitSha: string | null): Map<string, string> {
    if (commitSha === null) return new Map();
    const obj = this.store.get(commitSha);
    if (!obj || obj.type !== 'commit') return new Map();
    const flat = flattenTree(this.store, parseCommit(obj.body).tree);
    const out = new Map<string, string>();
    for (const [path, entry] of flat) out.set(path, entry.sha);
    return out;
  }

  commitOn(branch: string, files: Map<string, string>, message: string, time: number): string {
    const tree = buildTreeFromFiles(this.store, files);
    const parent = this.tip(branch);
    const body = buildCommit(tree, parent === null ? [] : [parent], message, time);
    const sha = this.store.put('commit', body);
    this.setTip(branch, sha);
    return sha;
  }
}

const TIME_BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

export class Forge {
  readonly repos = new Map<string, Repo>();
  /** The token owner's login, once an owner-named path has bound it. */
  boundLogin: string | null = null;
  private repoSeq = 0;
  private idSeq = 1000;
  private clockSeq = 0;

  /** Deterministic logical clock: one second per event. */
  tick(): number {
    this.clockSeq += 1;
    return this.clockSeq;
  }

  timeOf(seq: number): number {
    return Math.floor(TIME_BASE / 1000) + seq;
  }

  isoOf(seq: number): string {
    return new Date(TIME_BASE + seq * 1000).toISOString();
  }

  nextId(): number {
    this.idSeq += 1;
    return this.idSeq;
  }

  createRepo(name: string): Repo {
    const repo = new Repo((this.repoSeq += 1), name, this.tick());
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Look a repository up by owner + name. An owner that is not the bound
   * login sees nothing; the first owner to reach an existing repository
   * becomes the bound login.
   */
  repoFor(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.boundLogin === null) {
      this.boundLogin = owner;
      return repo;
    }
    return this.boundLogin === owner ? repo : null;
  }

  /** The login to print as a repository's owner right now. */
  ownerLogin(): string {
    return this.boundLogin ?? 'forge';
  }
}

// ------------------------------------------------------------ file diffs

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** Line counts for a blob pair (0 for the missing side). */
function lineDelta(store: ObjectStore, oldSha: string | null, newSha: string | null): { additions: number; deletions: number } {
  const text = (sha: string | null): string[] => {
    if (sha === null) return [];
    const obj = store.get(sha);
    if (!obj) return [];
    const s = obj.body.toString('utf8');
    if (s === '') return [];
    const parts = s.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const a = text(oldSha);
  const b = text(newSha);
  if (a.length > 4000 || b.length > 4000) return { additions: b.length, deletions: a.length };
  // LCS length over lines.
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** Changes between two file maps (path -> blob sha). */
export function diffFiles(store: ObjectStore, from: Map<string, string>, to: Map<string, string>): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const oldSha = from.get(path) ?? null;
    const newSha = to.get(path) ?? null;
    if (oldSha === newSha) continue;
    const { additions, deletions } = lineDelta(store, oldSha, newSha);
    out.push({
      filename: path,
      status: oldSha === null ? 'added' : newSha === null ? 'removed' : 'modified',
      additions,
      deletions,
    });
  }
  return out;
}

/** Would merging head into base conflict? Compares both sides against the merge base. */
export function pullMergeability(repo: Repo, pull: PullRec): { mergeable: boolean; baseSha: string | null; headSha: string | null } {
  const baseSha = repo.tip(pull.baseRef);
  const headSha = repo.tip(pull.headRef);
  if (baseSha === null || headSha === null) return { mergeable: false, baseSha, headSha };
  if (isAncestor(repo.store, headSha, baseSha)) return { mergeable: false, baseSha, headSha }; // nothing to merge
  const mb = mergeBase(repo.store, baseSha, headSha);
  if (mb === null) return { mergeable: false, baseSha, headSha };
  const atBase = repo.filesAt(mb);
  const headChanges = diffFiles(repo.store, atBase, repo.filesAt(headSha));
  const baseChanges = diffFiles(repo.store, atBase, repo.filesAt(baseSha));
  const headByPath = new Map(headChanges.map((c) => [c.filename, c]));
  const headFiles = repo.filesAt(headSha);
  const baseFiles = repo.filesAt(baseSha);
  for (const change of baseChanges) {
    if (!headByPath.has(change.filename)) continue;
    if ((headFiles.get(change.filename) ?? null) !== (baseFiles.get(change.filename) ?? null)) {
      return { mergeable: false, baseSha, headSha };
    }
  }
  return { mergeable: true, baseSha, headSha };
}

export { ZERO_SHA, isAncestor, parseCommit, walkCommits };
