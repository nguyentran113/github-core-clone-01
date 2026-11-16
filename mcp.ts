// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP. It speaks the 2026-07-28 revision through
// server/discover (supportedVersions, capabilities, serverInfo in one answer) and the handshake
// revisions through initialize + notifications/initialized. The six tools act on the same store
// as REST, so an object created here reads back over /api/v3 unchanged.

import {
  ForgeStore,
  mergePull,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { createIssueRecord } from './graphql.ts';

export const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: true };
}

const OWNER = { type: 'string', description: 'The repository owner login.' };
const REPO = { type: 'string', description: 'The repository name.' };

/** The tool list, built once so two tools/list calls answer byte for byte. */
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: schema(
      {
        name: { type: 'string', description: 'The repository name.' },
        owner: OWNER,
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: OWNER, repo: REPO, full_name: { type: 'string', description: 'The full name, owner/repo.' } }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: schema(
      {
        owner: OWNER,
        repo: REPO,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: schema(
      {
        owner: OWNER,
        repo: REPO,
        state: { type: 'string', description: 'open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema(
      {
        owner: OWNER,
        repo: REPO,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: schema(
      {
        owner: OWNER,
        repo: REPO,
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

export function repoJson(store: ForgeStore, repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${store.viewerLogin}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: store.viewerLogin, id: 1000 },
  };
}

export function issueJson(store: ForgeStore, repo: RepoRecord, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  void store;
  void repo;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

export function pullJson(store: ForgeStore, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  void store;
  void repo;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

interface ToolOutcome {
  result?: unknown;
  errorText?: string;
}

function resolveRepo(store: ForgeStore, args: Record<string, unknown>): RepoRecord | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  if (owner !== '') store.adoptLogin(owner);
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (name === '' && typeof args.full_name === 'string') name = args.full_name.split('/')[1] ?? '';
  if (owner !== '' && owner !== store.viewerLogin) return null;
  return store.getRepo(name) ?? null;
}

function runTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return { errorText: 'create_repo requires a name' };
      if (typeof args.owner === 'string' && args.owner !== '') store.adoptLogin(args.owner);
      const existing = store.getRepo(repoName);
      if (existing !== undefined) return { result: repoJson(store, existing) };
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return { result: repoJson(store, repo) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { errorText: 'repository not found' };
      return { result: repoJson(store, repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { errorText: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { errorText: 'create_issue requires a title' };
      const issue = createIssueRecord(store, repo, title, typeof args.body === 'string' ? args.body : '', []);
      return { result: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { errorText: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(store, repo, issue));
      return { result: issues };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { errorText: 'repository not found' };
      const head = typeof args.head === 'string' ? args.head.replace(/^refs\/heads\//, '') : '';
      const base = typeof args.base === 'string' ? args.base.replace(/^refs\/heads\//, '') : '';
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null || baseSha === null) return { errorText: 'head or base branch not found' };
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRecord = {
        id: store.nextGlobalId(),
        number,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergeCommitSha: null,
        mergedSeq: null,
        createdSeq: store.tick(),
      };
      repo.pulls.set(number, pull);
      return { result: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return { errorText: 'repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { errorText: 'pull request not found' };
      if (pull.state === 'open') {
        const outcome = mergePull(store, repo, pull);
        if (!outcome.ok) return { errorText: outcome.reason ?? 'merge failed' };
      }
      return { result: pullJson(store, repo, pull) };
    }
    default:
      return { errorText: `unknown tool ${name}` };
  }
}

function toolResult(payload: unknown, isError: boolean): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    isError,
  };
  if (!isError && payload !== null && typeof payload === 'object') result.structuredContent = payload;
  return result;
}

export interface McpResponse {
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * Handle one POST /mcp body. `rawBody` is the unparsed request bytes: a body that is not JSON is a
 * JSON-RPC parse error (HTTP 400, -32700). A notification (no id) answers 202 with no body.
 */
export function handleMcpRequest(store: ForgeStore, rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    // A batch: answer each request in order (the suite sends single requests; this is a courtesy).
    const results: unknown[] = [];
    for (const entry of parsed) {
      const single = handleOne(store, entry);
      if (single !== null) results.push(single);
    }
    return { status: 200, body: results as unknown as Record<string, unknown> };
  }
  const body = handleOne(store, parsed);
  if (body === null) return { status: 202, body: null };
  return { status: 200, body };
}

function handleOne(store: ForgeStore, entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const request = entry as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const hasId = 'id' in request && request.id !== undefined;
  const id = hasId ? request.id : null;
  const params = (request.params ?? {}) as Record<string, unknown>;

  const respond = (result: unknown): Record<string, unknown> | null =>
    hasId ? { jsonrpc: '2.0', id, result } : null;
  const respondError = (code: number, message: string): Record<string, unknown> | null =>
    hasId ? { jsonrpc: '2.0', id, error: { code, message } } : null;

  switch (method) {
    case 'server/discover':
      return respond({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return respond({
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = MCP_TOOLS.find((entry2) => entry2.name === toolName)
        ?? MCP_TOOLS.find((entry2) => toolName.toLowerCase().endsWith(entry2.name.toLowerCase()));
      if (tool === undefined) return respondError(-32602, `unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return respond(toolResult(`missing required argument(s): ${missing.join(', ')}`, true));
      }
      const outcome = runTool(store, tool.name, args);
      if (outcome.errorText !== undefined) return respond(toolResult(outcome.errorText, true));
      return respond(toolResult(outcome.result, false));
    }
    default:
      return respondError(-32601, `method not found: ${method}`);
  }
}
