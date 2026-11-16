// The forge's HTTP surface: git smart HTTP (/{owner}/{repo}.git), REST v3 (/api/v3), GraphQL
// (/api/graphql) and MCP (/mcp), all over one store. app.ts is the server; main.ts owns the
// entry <-> env lifecycle and should stay as the starter ships it.
//
// Wire rules the suite checks closely: every REST reply is application/json (never HTML) with a
// non-empty X-GitHub-Request-Id header; errors are JSON with a string message; a request without
// the trial's bearer token is 401; a repository under another owner is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  SIDE_BAND_CHUNK,
  ZERO_OID,
  commitClosure,
  decodePktLines,
  encodePktLine,
  hashObject,
  isAncestor,
  packetLines,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import {
  ForgeStore,
  mergePull,
  pullChangedFiles,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_VERSION = 'makefun-forge/1.0';
const MAX_BODY_BYTES = 96 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

function errorReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

function sendReply(res: ServerResponse, reply: Reply): void {
  if (reply.status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...reply.headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(reply.body)}\n`;
  res.writeHead(reply.status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...reply.headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, bytes: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
  res.end(bytes);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

function repoJson(store: ForgeStore, repo: RepoRecord): Record<string, unknown> {
  const iso = store.nowIso();
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${store.viewerLogin}/${repo.name}`,
    owner: { login: store.viewerLogin, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: iso,
    updated_at: iso,
    pushed_at: iso,
    default_branch: repo.defaultBranch,
    html_url: '',
    url: '',
    git_url: '',
    ssh_url: '',
    clone_url: '',
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(repo: RepoRecord, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: name.length,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
  };
}

function issueJson(store: ForgeStore, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: store.viewerLogin, id: 1000, type: 'User' },
    author_association: 'OWNER',
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: store.isoAt(issue.createdSeq),
    updated_at: store.isoAt(issue.createdSeq),
    closed_at: null,
    html_url: '',
    url: '',
    repository_url: '',
  };
}

function pullJson(store: ForgeStore, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSeq !== null ? store.isoAt(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: store.branchTip(repo, pull.headRef) ?? pull.headSha,
      label: `${store.viewerLogin}:${pull.headRef}`,
      user: { login: store.viewerLogin, id: 1000 },
      repo: repoJson(store, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: store.branchTip(repo, pull.baseRef) ?? pull.baseSha,
      label: `${store.viewerLogin}:${pull.baseRef}`,
      user: { login: store.viewerLogin, id: 1000 },
      repo: repoJson(store, repo),
    },
    user: { login: store.viewerLogin, id: 1000, type: 'User' },
    author_association: 'OWNER',
    draft: false,
    created_at: store.isoAt(pull.createdSeq),
    updated_at: store.isoAt(pull.createdSeq),
    closed_at: pull.state === 'closed' ? store.nowIso() : null,
    html_url: '',
    url: '',
    diff_url: '',
    patch_url: '',
    commits_url: '',
    comments_url: '',
    statuses_url: '',
  };
}

function commentJson(store: ForgeStore, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: store.viewerLogin, id: 1000, type: 'User' },
    author_association: 'OWNER',
    created_at: store.isoAt(comment.createdSeq),
    updated_at: store.isoAt(comment.createdSeq),
    html_url: '',
    url: '',
    issue_url: '',
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(parseInt(match[3], 10) * 1000).toISOString() };
}

function commitJson(store: ForgeStore, repo: RepoRecord, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const view = object !== undefined && object.type === 'commit'
    ? parseCommit(object.data)
    : { tree: ZERO_OID, parents: [], author: '', committer: '', message: '' };
  return {
    sha: oid,
    node_id: `CM_${oid}`,
    commit: {
      author: parseIdentity(view.author),
      committer: parseIdentity(view.committer),
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    author: { login: store.viewerLogin, id: 1000, type: 'User' },
    committer: { login: store.viewerLogin, id: 1000, type: 'User' },
    parents: view.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
    url: '',
    html_url: '',
    comments_url: '',
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function pageOf(url: URL): Page {
  const perPageRaw = parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const pageRaw = parseInt(url.searchParams.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

function paginate<T>(items: readonly T[], page: Page, req: IncomingMessage, url: URL): { slice: T[]; headers: Record<string, string> } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const headers: Record<string, string> = {};
  if (start + page.perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(page.perPage));
    next.searchParams.set('page', String(page.page + 1));
    const lastPage = Math.ceil(items.length / page.perPage);
    const last = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(page.perPage));
    last.searchParams.set('page', String(lastPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { slice, headers };
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

type RestResult = Reply;

function repoForPath(store: ForgeStore, owner: string, name: string): RepoRecord | null {
  store.adoptLogin(owner);
  if (owner !== store.viewerLogin) return null;
  return store.getRepo(name) ?? null;
}

/** Resolve a ref parameter (branch name, full ref, or commit sha) to a commit oid. */
function resolveRef(repo: RepoRecord, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (branch !== undefined) return branch;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  if (object !== undefined && object.type === 'tag') return peelToCommit((oid) => repo.objects.get(oid), ref);
  return null;
}

function handleRest(store: ForgeStore, req: IncomingMessage, url: URL, body: Buffer): RestResult {
  const segments = url.pathname.split('/').filter((part) => part !== '').slice(2); // after /api/v3
  const method = req.method ?? 'GET';

  const parseJsonBody = (): Record<string, unknown> | null => {
    if (body.length === 0) return {};
    try {
      const parsed = JSON.parse(body.toString('utf8')) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return null;
    }
  };

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return json(200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
      emojis_url: '/api/v3/emojis',
      issue_search_url: '/api/v3/search/issues?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org, write:org, admin:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return json(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '3.99.0-makefun',
      is_connected_to_internet: false,
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return json(200, { login: store.viewerLogin, id: 1000, type: 'User', site_admin: false });
  }

  // The viewer's repositories.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paginate(store.listRepos(), pageOf(url), req, url);
      return json(200, slice.map((repo) => repoJson(store, repo)), headers);
    }
    if (method === 'POST') {
      const data = parseJsonBody();
      if (data === null) return errorReply(400, 'Problems parsing JSON');
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') return errorReply(422, 'Repository creation failed: name is required');
      if (store.getRepo(name) !== undefined) {
        return errorReply(422, 'Repository creation failed: name already exists on this account');
      }
      const repo = store.createRepo(
        name,
        typeof data.description === 'string' ? data.description : '',
        typeof data.private === 'boolean' ? data.private : false,
      );
      return json(201, repoJson(store, repo));
    }
    return errorReply(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return errorReply(404, 'Not Found');
  const owner = decodeURIComponent(segments[1]);
  const repoName = decodeURIComponent(segments[2]);
  const repo = repoForPath(store, owner, repoName);
  if (repo === null) return errorReply(404, 'Not Found');
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const data = parseJsonBody();
      if (data === null) return errorReply(400, 'Problems parsing JSON');
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.private === 'boolean') repo.private = data.private;
      if (typeof data.name === 'string' && data.name !== '' && data.name !== repo.name) {
        store.repos.delete(repo.name);
        repo.name = data.name;
        store.repos.set(repo.name, repo);
      }
      if (typeof data.default_branch === 'string' && data.default_branch !== '') repo.defaultBranch = data.default_branch;
      return json(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      return { status: 204, body: null };
    }
    return errorReply(404, 'Not Found');
  }

  // Branches.
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const { slice, headers } = paginate(branches, pageOf(url), req, url);
    return json(200, slice, headers);
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, url.searchParams.get('sha'));
    if (tip === null) return json(200, []);
    const ordered: string[] = [];
    const seen = new Set<string>();
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return;
      ordered.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(tip);
    const { slice, headers } = paginate(ordered, pageOf(url), req, url);
    return json(200, slice.map((oid) => commitJson(store, repo, oid)), headers);
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const object = repo.objects.get(rest[1]);
    if (object === undefined || object.type !== 'commit') return errorReply(404, 'Not Found');
    return json(200, commitJson(store, repo, rest[1]));
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    const data = parseJsonBody();
    if (data === null) return errorReply(400, 'Problems parsing JSON');
    const ref = typeof data.ref === 'string' ? data.ref : '';
    const sha = typeof data.sha === 'string' ? data.sha : '';
    const target = repo.objects.get(sha);
    if (!ref.startsWith('refs/') || target === undefined) return errorReply(422, 'Invalid ref or sha');
    if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return json(201, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: target.type, url: '' } });
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length >= 3 && method === 'GET') {
    const ref = rest.slice(2).join('/');
    const oid = repo.refs.get(ref) ?? repo.refs.get(`refs/${ref}`);
    if (oid === undefined) return errorReply(404, 'Not Found');
    const target = repo.objects.get(oid);
    return json(200, { ref: repo.refs.has(ref) ? ref : `refs/${ref}`, object: { sha: oid, type: target?.type ?? 'commit', url: '' } });
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    return handleContents(store, repo, method, path, url, parseJsonBody);
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].map((label) => labelJson(repo, label.name));
      const { slice, headers } = paginate(labels, pageOf(url), req, url);
      return json(200, slice, headers);
    }
    if (method === 'POST') {
      const data = parseJsonBody();
      if (data === null) return errorReply(400, 'Problems parsing JSON');
      const name = typeof data.name === 'string' ? data.name : '';
      if (name === '') return errorReply(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return errorReply(422, 'Validation Failed: name has already been taken');
      repo.labels.set(name, {
        name,
        color: typeof data.color === 'string' ? data.color : 'ededed',
        description: typeof data.description === 'string' ? data.description : '',
      });
      return json(201, labelJson(repo, name));
    }
    return errorReply(404, 'Not Found');
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    return handleIssues(store, repo, method, rest.slice(1), url, parseJsonBody, req);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(store, repo, method, rest.slice(1), url, parseJsonBody, req);
  }

  return errorReply(404, 'Not Found');
}

function handleContents(
  store: ForgeStore,
  repo: RepoRecord,
  method: string,
  path: string,
  url: URL,
  parseJsonBody: () => Record<string, unknown> | null,
): RestResult {
  if (method === 'GET') {
    const commit = resolveRef(repo, url.searchParams.get('ref'));
    if (commit === null) return errorReply(404, 'Not Found');
    const commitObject = repo.objects.get(commit);
    if (commitObject === undefined || commitObject.type !== 'commit') return errorReply(404, 'Not Found');
    let treeOid = parseCommit(commitObject.data).tree;
    if (path === '') {
      return json(200, treeListing(repo, treeOid, ''));
    }
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return errorReply(404, 'Not Found');
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return errorReply(404, 'Not Found');
      if (index === segments.length - 1) {
        if (entry.mode === '40000') return json(200, treeListing(repo, entry.oid, path));
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) return errorReply(404, 'Not Found');
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: entry.name,
          path,
          sha: entry.oid,
          content: blob.data.toString('base64'),
          url: '',
          git_url: '',
          html_url: '',
          download_url: '',
        });
      }
      if (entry.mode !== '40000') return errorReply(404, 'Not Found');
      treeOid = entry.oid;
    }
    return errorReply(404, 'Not Found');
  }

  if (method === 'PUT' || method === 'DELETE') {
    const data = parseJsonBody();
    if (data === null) return errorReply(400, 'Problems parsing JSON');
    const branch = typeof data.branch === 'string' && data.branch !== '' ? data.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    if (tip === null && !(repo.refs.size === 0 && branch === repo.defaultBranch)) {
      return errorReply(422, `Validation Failed: branch ${branch} does not exist`);
    }
    const files = store.flattenTree(repo, tip);
    const existing = files.get(path);
    const message = typeof data.message === 'string' ? data.message : '';

    if (method === 'PUT') {
      const content = typeof data.content === 'string' ? Buffer.from(data.content, 'base64') : Buffer.alloc(0);
      if (existing !== undefined && typeof data.sha === 'string' && data.sha !== existing.oid) {
        return errorReply(409, `${path} does not match the sha ${data.sha}`);
      }
      const blobOid = store.putObject(repo, 'blob', content);
      files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
      const commit = store.commitFiles(repo, files, tip, message);
      repo.refs.set(refName, commit);
      return json(existing !== undefined ? 200 : 201, {
        content: {
          type: 'file',
          encoding: 'base64',
          size: content.length,
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          url: '',
          git_url: '',
          html_url: '',
          download_url: '',
        },
        commit: {
          sha: commit,
          message,
          author: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: store.nowIso() },
          committer: { name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, date: store.nowIso() },
          tree: { sha: '', url: '' },
          url: '',
          html_url: '',
          parents: tip === null ? [] : [{ sha: tip, url: '', html_url: '' }],
        },
      });
    }

    // DELETE
    if (existing === undefined) return errorReply(404, 'Not Found');
    if (typeof data.sha === 'string' && data.sha !== existing.oid) {
      return errorReply(409, `${path} does not match the sha ${data.sha}`);
    }
    files.delete(path);
    const commit = store.commitFiles(repo, files, tip, message);
    repo.refs.set(refName, commit);
    return json(200, { content: null, commit: { sha: commit, message, url: '', html_url: '' } });
  }

  return errorReply(404, 'Not Found');
}

/** The direct children of a tree, as the contents API lists a directory. */
function treeListing(repo: RepoRecord, treeOid: string, prefix: string): Record<string, unknown>[] {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      encoding: isDir ? '' : 'base64',
      size: isDir ? 0 : (blob?.data.length ?? 0),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      url: '',
      git_url: '',
      html_url: '',
      download_url: '',
    };
  });
}

function handleIssues(
  store: ForgeStore,
  repo: RepoRecord,
  method: string,
  rest: string[],
  url: URL,
  parseJsonBody: () => Record<string, unknown> | null,
  req: IncomingMessage,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const labelFilter = url.searchParams.get('labels');
      if (labelFilter !== null && labelFilter !== '') {
        const wanted = labelFilter.split(',');
        issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
      }
      const { slice, headers } = paginate(issues, pageOf(url), req, url);
      return json(200, slice.map((issue) => issueJson(store, repo, issue)), headers);
    }
    if (method === 'POST') {
      const data = parseJsonBody();
      if (data === null) return errorReply(400, 'Problems parsing JSON');
      const labels = Array.isArray(data.labels) ? data.labels.map((entry) => String(entry)) : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return errorReply(422, `Validation Failed: label ${name} does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRecord = {
        id: store.nextGlobalId(),
        number,
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
        state: 'open',
        labels,
        createdSeq: store.tick(),
      };
      repo.issues.set(number, issue);
      return json(201, issueJson(store, repo, issue));
    }
    return errorReply(404, 'Not Found');
  }

  const number = parseInt(rest[0], 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (method === 'GET') return json(200, issueJson(store, repo, issue));
    if (method === 'PATCH') {
      const data = parseJsonBody();
      if (data === null) return errorReply(400, 'Problems parsing JSON');
      if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      if (Array.isArray(data.labels)) {
        const labels = data.labels.map((entry) => String(entry));
        for (const name of labels) {
          if (!repo.labels.has(name)) return errorReply(422, `Validation Failed: label ${name} does not exist`);
        }
        issue.labels = labels;
      }
      return json(200, issueJson(store, repo, issue));
    }
    return errorReply(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      return json(200, comments.map((comment) => commentJson(store, comment)));
    }
    if (method === 'POST') {
      const data = parseJsonBody();
      if (data === null) return errorReply(400, 'Problems parsing JSON');
      const comment = {
        id: store.nextGlobalId(),
        body: typeof data.body === 'string' ? data.body : '',
        createdSeq: store.tick(),
      };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return json(201, commentJson(store, comment));
    }
  }

  return errorReply(404, 'Not Found');
}

function handlePulls(
  store: ForgeStore,
  repo: RepoRecord,
  method: string,
  rest: string[],
  url: URL,
  parseJsonBody: () => Record<string, unknown> | null,
  req: IncomingMessage,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const { slice, headers } = paginate(pulls, pageOf(url), req, url);
      return json(200, slice.map((pull) => pullJson(store, repo, pull)), headers);
    }
    if (method === 'POST') {
      const data = parseJsonBody();
      if (data === null) return errorReply(400, 'Problems parsing JSON');
      const cleanRef = (value: unknown): string => {
        const text = typeof value === 'string' ? value : '';
        const afterColon = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
        return afterColon.replace(/^refs\/heads\//, '');
      };
      const headRef = cleanRef(data.head);
      const baseRef = cleanRef(data.base);
      const headSha = store.branchTip(repo, headRef);
      const baseSha = store.branchTip(repo, baseRef);
      if (headSha === null || baseSha === null) return errorReply(422, 'Validation Failed: head or base branch does not exist');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRecord = {
        id: store.nextGlobalId(),
        number,
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
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
      return json(201, pullJson(store, repo, pull));
    }
    return errorReply(404, 'Not Found');
  }

  const number = parseInt(rest[0], 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 1 && method === 'GET') {
    if (pull === undefined) return errorReply(404, 'Not Found');
    return json(200, pullJson(store, repo, pull));
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return errorReply(404, 'Not Found');
    const files = pullChangedFiles(store, repo, pull).map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status === 'removed' ? 'removed' : file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const { slice, headers } = paginate(files, pageOf(url), req, url);
    return json(200, slice, headers);
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return errorReply(404, 'Not Found');
    if (pull.state !== 'open') return errorReply(405, 'Pull Request is not open');
    const outcome = mergePull(store, repo, pull);
    if (!outcome.ok) return errorReply(405, outcome.reason ?? 'Merge conflict');
    return json(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged and squashed' });
  }

  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

type ObjectLookupFn = (oid: string) => GitObject | undefined;

function sortedRefs(repo: RepoRecord): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headRefOf(repo: RepoRecord): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 ref advertisement shared by upload-pack and receive-pack (only the capabilities differ). */
function advertiseV0(repo: RepoRecord, service: string): Buffer {
  const capabilities = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k ofs-delta deepen-since deepen-not symref=HEAD:${headRefOf(repo)} agent=${FORGE_VERSION}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${FORGE_VERSION}`;
  const lookup: ObjectLookupFn = (oid) => repo.objects.get(oid);
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = repo.refs.get(headRefOf(repo)) ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const [ref, oid] of refs) {
      parts.push(encodePktLine(`${oid} ${ref}\n`));
      const object = lookup(oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(encodePktLine(`${peelToCommit(lookup, oid)} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement for upload-pack. */
function advertiseV2(): Buffer {
  const lines = [
    'version 2',
    `agent=${FORGE_VERSION}`,
    'ls-refs=unborn',
    'fetch=shallow',
    'object-format=sha1',
  ];
  return Buffer.concat([...lines.map((line) => encodePktLine(`${line}\n`)), PKT_FLUSH]);
}

interface V2Request {
  command: string;
  args: Map<string, string[]>;
  flags: Set<string>;
}

/** Parse a protocol v2 request body: capability lines, a delim, then argument lines to the flush. */
function parseV2Request(body: Buffer): V2Request {
  const { packets } = decodePktLines(body);
  const args = new Map<string, string[]>();
  const flags = new Set<string>();
  let command = '';
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    const space = line.indexOf(' ');
    if (space < 0) {
      flags.add(line);
      continue;
    }
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args, flags };
}

function lsRefsV2(repo: RepoRecord, request: V2Request): Buffer {
  const prefixes = request.args.get('ref-prefix') ?? [];
  const wantSymrefs = request.flags.has('symrefs');
  const wantUnborn = request.flags.has('unborn');
  const wantPeel = request.flags.has('peel');
  const lookup: ObjectLookupFn = (oid) => repo.objects.get(oid);
  const lines: string[] = [];
  const headRef = headRefOf(repo);
  const showHead = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (showHead) {
    const headOid = repo.refs.get(headRef);
    const attrs = wantSymrefs ? ` symref-target:${headRef}` : '';
    if (headOid !== undefined) lines.push(`${headOid} HEAD${attrs}`);
    else if (wantUnborn) lines.push(`unborn HEAD${attrs}`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const object = lookup(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelToCommit(lookup, oid)}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => encodePktLine(`${line}\n`)), PKT_FLUSH]);
}

interface FetchPlan {
  sendOids: string[];
  shallowLines: string[];
  commonHaves: string[];
}

function planFetch(repo: RepoRecord, input: {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}): FetchPlan {
  const lookup: ObjectLookupFn = (oid) => repo.objects.get(oid);
  const has = commitClosure(lookup, input.haves, { cutAt: new Set(input.shallow) });
  let want;
  if (input.deepen !== null) want = commitClosure(lookup, input.wants, { maxDepth: input.deepen });
  else if (input.deepenSince !== null) want = commitClosure(lookup, input.wants, { minTimestamp: input.deepenSince });
  else if (input.deepenNot.length > 0) want = commitClosure(lookup, input.wants, { cutAt: new Set(input.deepenNot) });
  else want = commitClosure(lookup, input.wants, {});

  const sendOids = [...want.objects].filter((oid) => !has.objects.has(oid));
  const shallowLines: string[] = [];
  const deepenMode = input.deepen !== null || input.deepenSince !== null || input.deepenNot.length > 0;
  if (deepenMode) {
    for (const oid of want.boundary) shallowLines.push(`shallow ${oid}`);
    for (const oid of input.shallow) {
      if (want.generations.has(oid) && !want.boundary.has(oid)) shallowLines.push(`unshallow ${oid}`);
    }
  }
  const commonHaves = input.haves.filter((oid) => {
    const object = lookup(oid);
    return object !== undefined && object.type === 'commit';
  });
  return { sendOids, shallowLines, commonHaves };
}

function packSection(repo: RepoRecord, sendOids: string[]): Buffer[] {
  const objects: GitObject[] = [];
  for (const oid of sendOids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  if (objects.length === 0) return [];
  const pack = writePack(objects);
  const parts: Buffer[] = [encodePktLine('packfile\n')];
  for (let offset = 0; offset < pack.length; offset += SIDE_BAND_CHUNK) {
    const chunk = pack.subarray(offset, offset + SIDE_BAND_CHUNK);
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return parts;
}

function fetchV2(repo: RepoRecord, request: V2Request): Buffer {
  const deepenRaw = (request.args.get('deepen') ?? [])[0];
  const sinceRaw = (request.args.get('deepen-since') ?? [])[0];
  const plan = planFetch(repo, {
    wants: request.args.get('want') ?? [],
    haves: request.args.get('have') ?? [],
    shallow: request.args.get('shallow') ?? [],
    deepen: deepenRaw !== undefined ? parseInt(deepenRaw, 10) : null,
    deepenSince: sinceRaw !== undefined ? parseInt(sinceRaw, 10) : null,
    deepenNot: request.args.get('deepen-not') ?? [],
  });
  const parts: Buffer[] = [];
  if (request.flags.has('done')) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.commonHaves.length > 0) {
      parts.push(encodePktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]} common\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    if (plan.shallowLines.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const line of plan.shallowLines) parts.push(encodePktLine(`${line}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(...packSection(repo, plan.sendOids));
  } else {
    parts.push(encodePktLine('acknowledgments\n'));
    for (const oid of plan.commonHaves) parts.push(encodePktLine(`ACK ${oid} common\n`));
    if (plan.commonHaves.length === 0) parts.push(encodePktLine('NAK\n'));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRecord, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let capabilities = '';
  for (const line of packetLines(packets)) {
    let text = line;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
    else if (text.startsWith('deepen ')) deepen = parseInt(text.slice(7), 10);
  }
  const plan = planFetch(repo, { wants, haves, shallow: [], deepen, deepenSince: null, deepenNot: [] });
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  if (plan.sendOids.length > 0) {
    const objects: GitObject[] = [];
    for (const oid of plan.sendOids) {
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.push(object);
    }
    const pack = writePack(objects);
    if (capabilities.includes('side-band')) {
      for (let offset = 0; offset < pack.length; offset += SIDE_BAND_CHUNK) {
        const chunk = pack.subarray(offset, offset + SIDE_BAND_CHUNK);
        parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
      }
      parts.push(PKT_FLUSH);
    } else {
      parts.push(pack);
    }
  }
  return Buffer.concat(parts);
}

interface PushCommand {
  old: string;
  new: string;
  ref: string;
}

function receivePack(repo: RepoRecord, body: Buffer): Buffer {
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  const lines = packets
    .filter((packet) => packet.kind === 'data')
    .map((packet) => (packet as { payload: Buffer }).payload.toString('utf8'));
  lines.forEach((raw, index) => {
    let line = raw.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
  });

  let unpackError: string | null = null;
  const staged = new Map<string, GitObject>();
  if (rest.length > 0) {
    try {
      const parsed = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of parsed) staged.set(oid, object);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unknown error';
    }
  }
  const lookup: ObjectLookupFn = (oid) => repo.objects.get(oid) ?? staged.get(oid);

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (unpackError === null) {
    for (const [oid, object] of staged) repo.objects.set(oid, object);
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.old !== ZERO_OID && current !== command.old) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (command.new === ZERO_OID) {
        if (current === ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'reference not found' });
          continue;
        }
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
        continue;
      }
      const newObject = lookup(command.new);
      if (newObject === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'invalid object' });
        continue;
      }
      if (command.old === ZERO_OID) {
        if (current !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
          continue;
        }
        repo.refs.set(command.ref, command.new);
        results.push({ ref: command.ref, ok: true });
        continue;
      }
      if (command.ref.startsWith('refs/heads/')) {
        const newCommit = peelToCommit(lookup, command.new);
        const oldCommit = peelToCommit(lookup, command.old);
        const newView = lookup(newCommit);
        const oldView = lookup(oldCommit);
        if (
          newView === undefined || newView.type !== 'commit'
          || oldView === undefined || oldView.type !== 'commit'
          || !isAncestor(lookup, oldCommit, newCommit)
        ) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.new);
      results.push({ ref: command.ref, ok: true });
    }
  }

  const reportParts: Buffer[] = [encodePktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  if (unpackError === null) {
    for (const result of results) {
      reportParts.push(encodePktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
    }
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (capabilities.includes('side-band')) {
    const out: Buffer[] = [];
    for (let offset = 0; offset < report.length; offset += SIDE_BAND_CHUNK) {
      const chunk = report.subarray(offset, offset + SIDE_BAND_CHUNK);
      out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  return report;
}

function handleGitHttp(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  match: RegExpExecArray,
): void {
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const action = match[3];
  store.adoptLogin(owner);
  if (owner !== store.viewerLogin) {
    sendReply(res, errorReply(404, 'Not Found'));
    return;
  }
  const repo = store.getRepo(name);
  if (repo === undefined) {
    sendReply(res, errorReply(404, 'Not Found'));
    return;
  }
  if (action === 'info/refs' && req.method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
      sendBytes(res, 200, isV2 ? advertiseV2() : advertiseV0(repo, service), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, advertiseV0(repo, service), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendReply(res, errorReply(404, 'Not Found'));
    return;
  }
  if (action === 'git-upload-pack' && req.method === 'POST') {
    const protocol = req.headers['git-protocol'];
    const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
    if (isV2) {
      const request = parseV2Request(body);
      if (request.command === 'ls-refs') {
        sendBytes(res, 200, lsRefsV2(repo, request), 'application/x-git-upload-pack-result');
        return;
      }
      if (request.command === 'fetch') {
        sendBytes(res, 200, fetchV2(repo, request), 'application/x-git-upload-pack-result');
        return;
      }
      sendReply(res, errorReply(400, 'Bad Request'));
      return;
    }
    sendBytes(res, 200, fetchV0(repo, body), 'application/x-git-upload-pack-result');
    return;
  }
  if (action === 'git-receive-pack' && req.method === 'POST') {
    sendBytes(res, 200, receivePack(repo, body), 'application/x-git-receive-pack-result');
    return;
  }
  sendReply(res, errorReply(404, 'Not Found'));
}

// ---------------------------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const store = new ForgeStore();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        if (path === '/healthz') {
          sendBytes(res, 200, Buffer.from('{"ok":true}\n', 'utf8'), JSON_TYPE);
          return;
        }
        if (token !== '') {
          const auth = req.headers.authorization ?? '';
          if (auth !== `Bearer ${token}`) {
            sendReply(res, errorReply(401, 'Bad credentials'));
            return;
          }
        }
        const body = await readBody(req);
        if (path === '/mcp') {
          if (req.method !== 'POST') {
            sendReply(res, errorReply(404, 'Not Found'));
            return;
          }
          const result = handleMcpRequest(store, body);
          if (result.body === null) {
            res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendReply(res, { status: result.status, body: result.body });
          return;
        }
        if (path === '/api/graphql') {
          if (req.method !== 'POST') {
            sendReply(res, errorReply(404, 'Not Found'));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendReply(res, { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => executeGraphQL(store, entry as GraphQLRequest));
            sendReply(res, { status: 200, body: results });
            return;
          }
          const result = executeGraphQL(store, parsed as GraphQLRequest);
          sendReply(res, { status: 200, body: result });
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          sendReply(res, handleRest(store, req, url, body));
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          handleGitHttp(store, req, res, url, body, gitMatch);
          return;
        }
        sendReply(res, errorReply(404, 'Not Found'));
      } catch (error) {
        if (!res.headersSent) {
          sendReply(res, errorReply(500, error instanceof Error ? error.message : 'Internal Server Error'));
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}
