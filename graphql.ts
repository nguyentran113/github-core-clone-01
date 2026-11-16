// A small GraphQL executor for the v4 surface the suite drives: the documents gh and
// github-mcp-server send (viewer, repository fields, __type probes, issue/pull reads, the create /
// close / merge mutations, addComment, node(id:), cursor pagination and batched operations).
// It parses the GraphQL language subset those documents use — operations with variable
// definitions, aliases, arguments with list/object/enum values, inline and named fragments —
// and resolves them against the forge store. Unknown fields answer HTTP 200 with an errors
// array, the way the real API reports them.

import {
  ForgeStore,
  mergePull,
  pullChangedFiles,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '$', '!', '=', '@', '|', '&']);

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ',' || /\s/.test(char)) { index += 1; continue; }
    if (char === '#') { while (index < source.length && source[index] !== '\n') index += 1; continue; }
    if (source.startsWith('...', index)) { tokens.push('...'); index += 3; continue; }
    if (PUNCT.has(char)) { tokens.push(char); index += 1; continue; }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        tokens.push(`"${source.slice(index + 3, end < 0 ? source.length : end)}"`);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) { value += source[end + 1]; end += 2; }
        else { value += source[end]; end += 1; }
      }
      tokens.push(`"${value}"`);
      index = end + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(index));
    if (match === null) throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
    tokens.push(match[0]);
    index += match[0].length;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private index = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.index];
  }

  private next(): string {
    const token = this.tokens[this.index];
    this.index += 1;
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    return token;
  }

  private expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new Error(`expected ${token}, found ${actual}`);
  }

  private skipDirectivesAndVariables(): void {
    // Variable definitions and directives are parenthesised / @-prefixed runs after a name.
    for (;;) {
      const token = this.peek();
      if (token === '(') {
        let depth = 0;
        do {
          const inner = this.next();
          if (inner === '(' || inner === '[' || inner === '{') depth += 1;
          if (inner === ')' || inner === ']' || inner === '}') depth -= 1;
        } while (depth > 0);
        continue;
      }
      if (token === '@') {
        this.next();
        this.next(); // directive name
        if (this.peek() === '(') this.skipDirectivesAndVariables();
        continue;
      }
      break;
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.index < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const kind = this.next();
        let name: string | null = null;
        if (this.peek() !== '{' && this.peek() !== '(' && this.peek() !== '@') name = this.next();
        this.skipDirectivesAndVariables();
        operations.push({
          type: kind === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
        });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectivesAndVariables();
        fragments.set(name, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectivesAndVariables();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: FieldNode['args'] = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.next();
      }
      // Directives on a field are skipped.
      while (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') {
          let depth = 0;
          do {
            const inner = this.next();
            if (inner === '(') depth += 1;
            if (inner === ')') depth -= 1;
          } while (depth > 0);
        }
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    this.next();
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------------------------------------
// schema: the field lists introspection reports (and the executor accepts)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'repositories', 'issues', 'pullRequests'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'pushedAt',
    'url', 'sshUrl', 'homepageUrl', 'stargazerCount', 'forkCount', 'labels', 'milestones',
    'primaryLanguage', 'licenseInfo', 'watchers', 'viewerCanAdminister', 'isArchived', 'isEmpty',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'createdAt', 'updatedAt',
    'author', 'editor', 'labels', 'comments', 'url', 'repository', 'closed', 'closedAt',
    'milestone', 'assignees', 'participants', 'reactions', 'viewerCanUpdate',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'comments',
    'createdAt', 'updatedAt', 'author', 'url', 'repository', 'mergeCommit', 'additions',
    'deletions', 'changedFiles', 'closed', 'closedAt', 'isDraft', 'labels', 'reviewRequests',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committedDate', 'tree'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', 'actor'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  State: ['OPEN', 'CLOSED'],
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name];
    case 'string': return value.value;
    case 'int': return value.value;
    case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

export function repoGlobalId(repo: RepoRecord): string {
  return `R_${repo.id}`;
}

export function issueGlobalId(issue: IssueRecord): string {
  return `I_${issue.id}`;
}

export function pullGlobalId(pull: PullRecord): string {
  return `PR_${pull.id}`;
}

function userObject(store: ForgeStore): GqlObject {
  return { __type: 'User', id: 'U_1000', login: store.viewerLogin, name: store.viewerLogin, databaseId: 1000 };
}

function repoObject(store: ForgeStore, repo: RepoRecord): GqlObject {
  return {
    __type: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${store.viewerLogin}/${repo.name}`,
    ownerLogin: store.viewerLogin,
    repoName: repo.name,
  };
}

function issueObject(repo: RepoRecord, issue: IssueRecord): GqlObject {
  return {
    __type: 'Issue',
    id: issueGlobalId(issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    repoName: repo.name,
    issueNumber: issue.number,
  };
}

function pullObject(store: ForgeStore, repo: RepoRecord, pull: PullRecord): GqlObject {
  return {
    __type: 'PullRequest',
    id: pullGlobalId(pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    repoName: repo.name,
    pullNumber: pull.number,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1], 10);
  } catch {
    return null;
  }
}

/** Order and filter a repo's issues for a connection field, then page by cursor. */
function issueConnection(
  ctx: ExecContext,
  repo: RepoRecord,
  args: Record<string, unknown>,
): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  return paginate(ctx, issues.map((issue) => issueObject(repo, issue)), args, (node) => (node as GqlObject).number as number);
}

function paginate(
  ctx: ExecContext,
  nodes: GqlObject[],
  args: Record<string, unknown>,
  numberOf: (node: GqlObject) => number,
): GqlObject {
  let start = 0;
  const after = args.after as string | null | undefined;
  if (typeof after === 'string' && after !== '') {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = nodes.findIndex((node) => numberOf(node) === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = nodes.slice(start, start + first);
  const hasNextPage = start + page.length < nodes.length;
  void ctx;
  return {
    __type: nodes[0]?.__type === 'PullRequest' ? 'PullRequestConnection' : 'IssueConnection',
    nodes: page,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(numberOf(page[0])) : null,
      endCursor: page.length > 0 ? cursorFor(numberOf(page[page.length - 1])) : null,
    },
    totalCount: nodes.length,
    edges: page.map((node) => ({ __type: 'Edge', node, cursor: cursorFor(numberOf(node)) })),
  };
}

/** Compute a pull request's mergeable state by attempting the three-way merge on paper. */
function mergeableOf(store: ForgeStore, repo: RepoRecord, pull: PullRecord): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = store.branchTip(repo, pull.baseRef);
  const headTip = store.branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const base = store.mergeBase(repo, baseTip, headTip);
  const baseFiles = store.flattenTree(repo, base);
  const currentFiles = store.flattenTree(repo, baseTip);
  const headFiles = store.flattenTree(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...currentFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.oid;
    const atCurrent = currentFiles.get(path)?.oid;
    const atHead = headFiles.get(path)?.oid;
    if (atHead === atBase || atHead === atCurrent || atCurrent === atBase) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function findRepoByGlobalId(store: ForgeStore, id: unknown): RepoRecord | null {
  if (typeof id !== 'string') return null;
  const match = /^R_(\d+)$/.exec(id);
  if (match === null) return null;
  const wanted = parseInt(match[1], 10);
  for (const repo of store.repos.values()) if (repo.id === wanted) return repo;
  return null;
}

function findIssueByGlobalId(store: ForgeStore, id: unknown): { repo: RepoRecord; issue: IssueRecord } | null {
  if (typeof id !== 'string') return null;
  const match = /^I_(\d+)$/.exec(id);
  if (match === null) return null;
  const wanted = parseInt(match[1], 10);
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === wanted) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(store: ForgeStore, id: unknown): { repo: RepoRecord; pull: PullRecord } | null {
  if (typeof id !== 'string') return null;
  const match = /^PR_(\d+)$/.exec(id);
  if (match === null) return null;
  const wanted = parseInt(match[1], 10);
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === wanted) return { repo, pull };
  }
  return null;
}

/** Create an issue record (shared by the GraphQL mutation; REST has its own path in app.ts). */
export function createIssueRecord(store: ForgeStore, repo: RepoRecord, title: string, body: string, labels: string[]): IssueRecord {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRecord = {
    id: store.nextGlobalId(),
    number,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdSeq: store.tick(),
  };
  repo.issues.set(number, issue);
  return issue;
}

/** Create a pull request record from branch names (shared by GraphQL; REST mirrors it in app.ts). */
export function createPullRecord(
  store: ForgeStore,
  repo: RepoRecord,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): PullRecord | null {
  const headSha = store.branchTip(repo, headRef);
  const baseSha = store.branchTip(repo, baseRef);
  if (headSha === null || baseSha === null) return null;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRecord = {
    id: store.nextGlobalId(),
    number,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergeCommitSha: null,
    mergedSeq: null,
    createdSeq: store.tick(),
  };
  repo.pulls.set(number, pull);
  return pull;
}

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

function resolveField(ctx: ExecContext, type: string, object: GqlObject | null, field: FieldNode): unknown {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  const name = field.name;

  if (name === '__type') {
    const typeName = String(args.name ?? '');
    if (TYPE_FIELDS[typeName] !== undefined) {
      return {
        __type: '__Type',
        name: typeName,
        kind: 'OBJECT',
        fields: TYPE_FIELDS[typeName].map((fieldName) => ({ __type: '__Field', name: fieldName })),
        enumValues: null,
      };
    }
    if (ENUM_VALUES[typeName] !== undefined) {
      return {
        __type: '__Type',
        name: typeName,
        kind: 'ENUM',
        fields: null,
        enumValues: ENUM_VALUES[typeName].map((value) => ({ __type: '__EnumValue', name: value })),
      };
    }
    return null;
  }
  if (name === '__schema') {
    return { __type: '__Schema', queryType: { __type: '__Type', name: 'Query' }, mutationType: { __type: '__Type', name: 'Mutation' } };
  }

  switch (type) {
    case 'Query': {
      if (name === 'viewer') return userObject(store);
      if (name === 'repository') {
        const owner = String(args.owner ?? '');
        const repoName = String(args.name ?? '');
        store.adoptLogin(owner);
        if (owner !== store.viewerLogin) return null;
        const repo = store.getRepo(repoName);
        return repo === undefined ? null : repoObject(store, repo);
      }
      if (name === 'node') {
        const id = String(args.id ?? '');
        const repo = findRepoByGlobalId(store, id);
        if (repo !== null) return repoObject(store, repo);
        const issueHit = findIssueByGlobalId(store, id);
        if (issueHit !== null) return issueObject(issueHit.repo, issueHit.issue);
        const pullHit = findPullByGlobalId(store, id);
        if (pullHit !== null) return pullObject(store, pullHit.repo, pullHit.pull);
        if (id === 'U_1000') return userObject(store);
        return null;
      }
      if (name === 'user') return userObject(store);
      if (name === 'rateLimit') return { __type: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, resetAt: store.nowIso(), nodeCount: 0 };
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, input.repositoryId);
        if (repo === null) { ctx.errors.push({ message: 'repository not found' }); return null; }
        const issue = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findIssueByGlobalId(store, input.issueId);
        if (hit === null) { ctx.errors.push({ message: 'issue not found' }); return null; }
        hit.issue.state = 'closed';
        return { __type: 'CloseIssuePayload', issue: issueObject(hit.repo, hit.issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGlobalId(store, input.repositoryId);
        if (repo === null) { ctx.errors.push({ message: 'repository not found' }); return null; }
        const headRef = String(input.headRefName ?? '').replace(/^refs\/heads\//, '');
        const baseRef = String(input.baseRefName ?? '').replace(/^refs\/heads\//, '');
        const pull = createPullRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef);
        if (pull === null) { ctx.errors.push({ message: 'head or base branch not found' }); return null; }
        return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(store, repo, pull), clientMutationId: input.clientMutationId ?? null };
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findPullByGlobalId(store, input.pullRequestId);
        if (hit === null) { ctx.errors.push({ message: 'pull request not found' }); return null; }
        if (hit.pull.state === 'open') {
          const outcome = mergePull(store, hit.repo, hit.pull);
          if (!outcome.ok) ctx.errors.push({ message: outcome.reason ?? 'merge failed' });
        }
        return { __type: 'MergePullRequestPayload', pullRequest: pullObject(store, hit.repo, hit.pull), clientMutationId: input.clientMutationId ?? null };
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const issueHit = findIssueByGlobalId(store, input.subjectId);
        const pullHit = issueHit === null ? findPullByGlobalId(store, input.subjectId) : null;
        const repo = issueHit?.repo ?? pullHit?.repo;
        const number = issueHit?.issue.number ?? pullHit?.pull.number;
        if (repo === undefined || number === undefined) { ctx.errors.push({ message: 'subject not found' }); return null; }
        const comment = { id: store.nextGlobalId(), body: String(input.body ?? ''), createdSeq: store.tick() };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        const node = { __type: 'IssueComment', id: `C_${comment.id}`, databaseId: comment.id, body: comment.body };
        return {
          __type: 'AddCommentPayload',
          commentEdge: { __type: 'CommentEdge', node, cursor: cursorFor(comment.id) },
          clientMutationId: input.clientMutationId ?? null,
        };
      }
      return undefined;
    }
    case 'User': {
      if (object === null) return undefined;
      if (name === 'id' || name === 'login' || name === 'name' || name === 'databaseId') return object[name];
      if (name === 'email') return `${store.viewerLogin}@example.invalid`;
      if (name === 'url') return `https://make.fun/${store.viewerLogin}`;
      if (name === 'avatarUrl') return '';
      return undefined;
    }
    case 'Repository': {
      if (object === null) return undefined;
      const repo = store.getRepo(String(object.repoName));
      if (repo === undefined) return null;
      switch (name) {
        case 'id': return object.id;
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.viewerLogin}/${repo.name}`;
        case 'owner': return userObject(store);
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'isEmpty': return repo.refs.size === 0;
        case 'defaultBranchRef': {
          const tip = store.branchTip(repo, repo.defaultBranch);
          return { __type: 'Ref', name: repo.defaultBranch, target: tip };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'createdAt': case 'updatedAt': case 'pushedAt': return store.nowIso();
        case 'url': return `https://make.fun/${store.viewerLogin}/${repo.name}`;
        case 'sshUrl': return '';
        case 'homepageUrl': return '';
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'viewerCanAdminister': return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObject(repo, issue);
        }
        case 'issues': return issueConnection(ctx, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObject(store, repo, pull);
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()]
            .filter((pull) => pull.state === 'open' || pull.merged)
            .sort((a, b) => a.number - b.number)
            .map((pull) => pullObject(store, repo, pull));
          return paginate(ctx, pulls, args, (node) => (node as GqlObject).number as number);
        }
        default: return undefined;
      }
    }
    case 'Issue': {
      if (object === null) return undefined;
      const repo = store.getRepo(String(object.repoName));
      const issue = repo?.issues.get(Number(object.issueNumber));
      switch (name) {
        case 'id': return object.id;
        case 'databaseId': return object.databaseId;
        case 'number': return object.number;
        case 'title': return object.title;
        case 'state': return object.state;
        case 'body': case 'bodyText': return object.body;
        case 'createdAt': case 'updatedAt': return store.isoAt(issue?.createdSeq ?? 0);
        case 'closed': return object.state === 'CLOSED';
        case 'closedAt': return object.state === 'CLOSED' ? store.nowIso() : null;
        case 'author': return userObject(store);
        case 'url': return '';
        case 'repository': return repo === undefined ? null : repoObject(store, repo);
        case 'labels': {
          const labels = (issue?.labels ?? []).map((labelName) => ({ __type: 'Label', name: labelName, color: repo?.labels.get(labelName)?.color ?? 'ededed', description: '' }));
          return { __type: 'LabelConnection', nodes: labels, edges: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: labels.length };
        }
        case 'comments': {
          const comments = (repo?.comments.get(Number(object.issueNumber)) ?? []).map((comment) => ({
            __type: 'IssueComment', id: `C_${comment.id}`, databaseId: comment.id, body: comment.body,
          }));
          return { __type: 'IssueCommentConnection', nodes: comments, edges: [], pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: comments.length };
        }
        default: return undefined;
      }
    }
    case 'PullRequest': {
      if (object === null) return undefined;
      const repo = store.getRepo(String(object.repoName));
      const pull = repo?.pulls.get(Number(object.pullNumber));
      switch (name) {
        case 'id': return object.id;
        case 'databaseId': return object.databaseId;
        case 'number': return object.number;
        case 'title': return object.title;
        case 'body': return object.body;
        case 'state': return object.state;
        case 'merged': return object.merged;
        case 'mergedAt': return pull?.mergedSeq != null ? store.isoAt(pull.mergedSeq) : null;
        case 'mergeable': return repo !== undefined && pull !== undefined ? mergeableOf(store, repo, pull) : 'UNKNOWN';
        case 'headRefName': return object.headRefName;
        case 'baseRefName': return object.baseRefName;
        case 'createdAt': case 'updatedAt': return store.isoAt(pull?.createdSeq ?? 0);
        case 'closed': return object.state !== 'OPEN';
        case 'closedAt': return object.state !== 'OPEN' ? store.nowIso() : null;
        case 'isDraft': return false;
        case 'author': return userObject(store);
        case 'url': return '';
        case 'repository': return repo === undefined ? null : repoObject(store, repo);
        case 'mergeCommit': return pull?.mergeCommitSha != null ? { __type: 'Commit', oid: pull.mergeCommitSha, id: `CM_${pull.mergeCommitSha}` } : null;
        case 'files': {
          if (repo === undefined || pull === undefined) return { __type: 'PullRequestChangedFileConnection', nodes: [], totalCount: 0 };
          const files = pullChangedFiles(store, repo, pull).map((file) => ({
            __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase(),
          }));
          const first = typeof args.first === 'number' ? args.first : 30;
          return { __type: 'PullRequestChangedFileConnection', nodes: files.slice(0, first), totalCount: files.length };
        }
        case 'additions': case 'deletions': case 'changedFiles': {
          if (repo === undefined || pull === undefined) return 0;
          const files = pullChangedFiles(store, repo, pull);
          if (name === 'changedFiles') return files.length;
          return files.reduce((sum, file) => sum + (name === 'additions' ? file.additions : file.deletions), 0);
        }
        default: return undefined;
      }
    }
    case '__Type': {
      if (object === null) return undefined;
      if (name === 'name' || name === 'kind' || name === 'fields' || name === 'enumValues') return object[name] ?? null;
      if (name === 'description') return null;
      if (name === 'possibleTypes' || name === 'inputFields') return null;
      if (name === 'ofType') return null;
      return undefined;
    }
    case '__Field': case '__EnumValue': {
      if (object === null) return undefined;
      if (name === 'name') return object.name;
      return undefined;
    }
    case '__Schema': {
      if (name === 'queryType' || name === 'mutationType') return object[name];
      return undefined;
    }
    default: {
      if (object === null) return undefined;
      // Payloads, connections, edges, comments and other leaf objects carry their fields directly.
      if (name in object) return object[name];
      return undefined;
    }
  }
}

function executeSelectionSet(
  ctx: ExecContext,
  type: string,
  object: GqlObject | null,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === type) {
        Object.assign(out, executeSelectionSet(ctx, type, object, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === type) {
        Object.assign(out, executeSelectionSet(ctx, type, object, fragment.selection));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = type;
      continue;
    }
    const known = TYPE_FIELDS[type];
    const isIntrospection = field.name === '__type' || field.name === '__schema';
    if (!isIntrospection && known !== undefined && !known.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    const value = resolveField(ctx, type, object, field);
    if (value === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, field));
  if (typeof value === 'object') {
    const object = value as GqlObject;
    if (typeof object.__type === 'string' && field.selection !== null) {
      return executeSelectionSet(ctx, object.__type, object, field.selection);
    }
    return value;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLRequest {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one GraphQL operation document; returns the {data} / {data, errors} body. */
export function executeGraphQL(store: ForgeStore, request: GraphQLRequest): Record<string, unknown> {
  const ctx: ExecContext = {
    store,
    variables: request.variables ?? {},
    fragments: new Map(),
    errors: [],
  };
  try {
    const document = new Parser(String(request.query ?? '')).parseDocument();
    ctx.fragments = document.fragments;
    const operation = request.operationName !== undefined && request.operationName !== null
      ? document.operations.find((entry) => entry.name === request.operationName) ?? document.operations[0]
      : document.operations[0];
    if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelectionSet(ctx, rootType, { __type: rootType }, operation.selection);
    const body: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) body.errors = ctx.errors;
    return body;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
