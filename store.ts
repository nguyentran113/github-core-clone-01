// The forge's store: one tenant (the login the bearer token names) holding repositories, and inside
// each repository a git object store with refs plus the issue / label / pull-request records the
// REST, GraphQL and MCP surfaces all share. Everything lives in memory in this one process.
//
// Determinism: ids come from counters and timestamps from a logical clock that starts at a fixed
// epoch and advances one second per mutation, so two runs that take the same requests produce the
// same bytes — nothing here reads the wall clock.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git.ts';

/** The fixed epoch the logical clock starts from (2025-01-01T00:00:00Z, the scenario's day one). */
const CLOCK_START = 1_735_689_600;

export interface RepoRecord {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  nextNumber: number;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  comments: Map<number, CommentRecord[]>;
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdSeq: number;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  createdSeq: number;
}

export class ForgeStore {
  /** The token owner's login once any request has named it; null until then. */
  adoptedLogin: string | null = null;
  /** Fallback login (the contest scenario's fixed viewer) before any request names one. */
  readonly fallbackLogin = 'adaiversen';
  readonly repos = new Map<string, RepoRecord>();
  private repoIdCounter = 1000;
  private globalIdCounter = 1;
  private clock = CLOCK_START;
  private seq = 0;

  /** The login every surface treats as the token's owner. */
  get viewerLogin(): string {
    return this.adoptedLogin ?? this.fallbackLogin;
  }

  /** Learn the token owner's login from the first owner a request names; later names never move it. */
  adoptLogin(owner: string): void {
    if (this.adoptedLogin === null && owner !== '') this.adoptedLogin = owner;
  }

  /** A fresh logical timestamp (seconds), advancing the clock. */
  tick(): number {
    this.clock += 1;
    this.seq += 1;
    return this.clock;
  }

  /** The current logical time as an ISO string, without advancing the clock. */
  nowIso(): string {
    return new Date(this.clock * 1000).toISOString();
  }

  /** An ISO timestamp for a logical-clock second. */
  isoAt(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
  }

  /** A globally unique, stable numeric id for issues, pulls and comments. */
  nextGlobalId(): number {
    const id = this.globalIdCounter;
    this.globalIdCounter += 1;
    return id;
  }

  /** A git author/committer line for commits the forge itself makes (contents API, merges). */
  identity(atSeconds: number): string {
    const login = this.viewerLogin;
    return `${login} <${login}@example.invalid> ${atSeconds} +0000`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): RepoRecord {
    this.repoIdCounter += 1;
    const repo: RepoRecord = {
      id: this.repoIdCounter,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      nextNumber: 1,
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): RepoRecord | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** Repositories in creation order (the map preserves insertion order). */
  listRepos(): RepoRecord[] {
    return [...this.repos.values()];
  }

  /** Store an object in a repo, returning its id. */
  putObject(repo: RepoRecord, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  /** The commit oid a branch ref names, or null when the branch is unborn or missing. */
  branchTip(repo: RepoRecord, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /**
   * Flatten a commit's tree into a path -> {oid, mode} map (files only), following subtrees.
   * A null commit (unborn branch) flattens to the empty map.
   */
  flattenTree(repo: RepoRecord, commitOid: string | null): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    if (commitOid === null) return files;
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return files;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else files.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return files;
  }

  /** Rebuild nested trees from a flat path -> entry map; returns the root tree oid. */
  buildTreeFromFiles(repo: RepoRecord, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (!node.dirs.has(segment)) node.dirs.set(segment, make());
        node = node.dirs.get(segment)!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Commit a flat file map on top of `parent` (null for a root commit); returns the commit oid. */
  commitFiles(
    repo: RepoRecord,
    files: Map<string, { oid: string; mode: string }>,
    parent: string | null,
    message: string,
  ): string {
    const tree = this.buildTreeFromFiles(repo, files);
    const at = this.tick();
    const identity = this.identity(at);
    const data = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      author: identity,
      committer: identity,
      message,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The merge base of two commits: a common ancestor with no common-ancestor descendant. */
  mergeBase(repo: RepoRecord, a: string, b: string): string | null {
    const lookup = this.lookup(repo);
    const ancestorsOf = (tip: string): Set<string> => {
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = lookup(oid);
        if (object === undefined || object.type !== 'commit') continue;
        queue.push(...parseCommit(object.data).parents);
      }
      return seen;
    };
    const ancestorsA = ancestorsOf(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      queue.push(...parseCommit(object.data).parents);
    }
    return null;
  }
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count added/deleted lines between two texts with a simple longest-common-subsequence diff. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // LCS over lines; the files the suite diffs are small, so the quadratic table is fine.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

/**
 * The files a pull request changes: the diff between the merge base's tree and the head's tree,
 * as GitHub reports it. When there is no merge base the base tip's tree stands in for it.
 */
export function pullChangedFiles(store: ForgeStore, repo: RepoRecord, pull: PullRecord): ChangedFile[] {
  const base = store.mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
  const baseFiles = store.flattenTree(repo, base);
  const headFiles = store.flattenTree(repo, pull.headSha);
  const changed: ChangedFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before === undefined ? '' : (repo.objects.get(before.oid)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (repo.objects.get(after.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    changed.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changed;
}

export interface MergeOutcome {
  ok: boolean;
  sha?: string;
  reason?: string;
}

/**
 * Squash-merge a pull request: a three-way tree merge of head into base at file granularity.
 * Both sides changing the same file differently from the merge base is a conflict (405 upstream).
 * On success a single squash commit lands on the base branch and the pull closes as merged.
 */
export function mergePull(store: ForgeStore, repo: RepoRecord, pull: PullRecord): MergeOutcome {
  const lookup = store.lookup(repo);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (baseTip === null) return { ok: false, reason: 'base branch is missing' };
  const headTip = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const base = store.mergeBase(repo, baseTip, headTip);
  const baseFiles = store.flattenTree(repo, base);
  const currentFiles = store.flattenTree(repo, baseTip);
  const headFiles = store.flattenTree(repo, headTip);

  const merged = new Map(currentFiles);
  const paths = new Set([...baseFiles.keys(), ...currentFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.oid;
    const atCurrent = currentFiles.get(path)?.oid;
    const atHead = headFiles.get(path)?.oid;
    if (atHead === atBase || atHead === atCurrent) continue; // head changed nothing here, or both agree
    if (atCurrent === atBase) {
      // Only the head moved: take its version (or its deletion).
      if (atHead === undefined) merged.delete(path);
      else merged.set(path, headFiles.get(path)!);
      continue;
    }
    return { ok: false, reason: `merge conflict in ${path}` };
  }

  const sha = store.commitFiles(repo, merged, baseTip, `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedSeq = store.tick();
  void lookup;
  void isAncestor;
  return { ok: true, sha };
}

export { ZERO_OID };
