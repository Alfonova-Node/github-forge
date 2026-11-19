// github-forge REST v3: repositories, branches, commits, contents, issues,
// comments, labels and pull requests under /api/v3. Every handler returns a
// small {status, body, headers} record; app.ts serialises it.

import {
  FIXED_ISO,
  VIEWER_LOGIN,
  ZERO_OID,
  diffFiles,
  filesAtCommit,
  lineCounts,
  mergeBase,
  mintCommit,
  parseCommit,
  putObject,
  store,
  treeFromFiles,
  viewerUser,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const notFound = (what = 'Not Found'): RestResult => ok(404, { message: what });
const unprocessable = (message: string): RestResult => ok(422, { message });
const badRequest = (message: string): RestResult => ok(400, { message });

function userJson(): Record<string, unknown> {
  return viewerUser();
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: store.globalId('Repository', [repo.id]),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.priv,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    svn_url: `https://github.com/${repo.owner}/${repo.name}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.priv ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.find((l) => l.name === name);
  return {
    id: label?.id ?? 0,
    node_id: store.globalId('Label', [repo.id, name]),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? '',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.globalId('Issue', [repo.id, issue.number]),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    draft: false,
  };
}

function refJson(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseFiles = base ? filesAtCommit(repo, base) : new Map();
  const headFiles = filesAtCommit(repo, pull.headSha);
  const diffs = diffFiles(baseFiles, headFiles);
  let additions = 0;
  let deletions = 0;
  for (const d of diffs) {
    const oldData = d.oldOid ? repo.objects.get(d.oldOid)?.data ?? null : null;
    const newData = d.newOid ? repo.objects.get(d.newOid)?.data ?? null : null;
    const c = lineCounts(oldData, newData);
    additions += c.additions;
    deletions += c.deletions;
  }
  return {
    id: pull.id,
    node_id: store.globalId('PullRequest', [repo.id, pull.number]),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: refJson(repo, pull.head, pull.headSha),
    base: refJson(repo, pull.base, pull.baseSha),
    author_association: 'OWNER',
    draft: false,
    merged: pull.merged,
    mergeable: mergeableOf(repo, pull),
    mergeable_state: mergeableOf(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions,
    deletions,
    changed_files: diffs.length,
  };
}

/** MERGEABLE unless head and base both changed the same path differently since the merge-base. */
export function mergeableOf(repo: Repo, pull: Pull): string {
  const liveBaseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const base = mergeBase(repo, pull.headSha, liveBaseSha);
  if (base === null) return 'CONFLICTING';
  const baseFiles = filesAtCommit(repo, base);
  const headFiles = filesAtCommit(repo, pull.headSha);
  const baseTipFiles = filesAtCommit(repo, liveBaseSha);
  const headDiff = diffFiles(baseFiles, headFiles);
  const baseDiff = diffFiles(baseFiles, baseTipFiles);
  const baseChanged = new Map<string, string | null>();
  for (const d of baseDiff) baseChanged.set(d.path, d.newOid);
  for (const d of headDiff) {
    if (baseChanged.has(d.path) && baseChanged.get(d.path) !== d.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

function paginate<T>(items: T[], query: URLSearchParams, reqPath: string, baseUrl: string): { items: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const mk = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${baseUrl}${reqPath}?${q.toString()}>`;
  };
  if (page < totalPages) links.push(`${mk(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${mk(page - 1)}; rel="prev"`);
  if (totalPages > 1) {
    links.push(`${mk(1)}; rel="first"`);
    links.push(`${mk(totalPages)}; rel="last"`);
  }
  if (links.length > 0) headers.link = links.join(', ');
  return { items: slice, headers };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const c = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const author = c ? c.author : '';
  const name = author.slice(0, author.lastIndexOf('<')).trim() || VIEWER_LOGIN;
  const email = (author.match(/<([^>]*)>/) ?? [])[1] ?? '';
  return {
    sha: oid,
    node_id: store.globalId('Commit', [repo.id, oid]),
    commit: {
      author: { name, email, date: FIXED_ISO },
      committer: { name, email, date: FIXED_ISO },
      message: (c?.message ?? '').replace(/\n+$/, ''),
      tree: { sha: c?.tree ?? '', url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: '',
    author: userJson(),
    committer: userJson(),
    parents: (c?.parents ?? []).map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}

function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}

function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function contentsWrite(
  repo: Repo,
  branch: string | undefined,
  path: string,
  content: Buffer,
  message: string,
  sha: string | undefined,
  isDelete: boolean,
): { status: number; commitSha: string; contentSha: string } | RestResult {
  const branchName = branch ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branchName}`);
  if (tip === undefined && branch !== undefined) {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) {
      repo.refs.set(`refs/heads/${branchName}`, baseTip);
      tip = baseTip;
    }
  }
  const files = tip !== undefined ? filesAtCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
  const existing = files.get(path);
  if (isDelete) {
    if (!existing) return notFound('Not Found');
    if (sha !== undefined && sha !== existing.oid) return ok(409, { message: 'sha does not match' });
    files.delete(path);
  } else {
    if (existing) {
      if (sha === undefined) return ok(409, { message: 'sha is required to update a file' });
      if (sha !== existing.oid) return ok(409, { message: 'sha does not match the current blob' });
    }
    const blobOid = putObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
  }
  const fileMap = new Map<string, string>();
  for (const [p, entry] of files) fileMap.set(p, entry.oid);
  const treeOid = treeFromFiles(repo, fileMap);
  const parents = tip !== undefined ? [tip] : [];
  const commitSha = mintCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  const contentSha = isDelete ? '' : (files.get(path)?.oid ?? '');
  return { status: isDelete ? 200 : existing ? 200 : 201, commitSha, contentSha };
}

function isRestResult(v: unknown): v is RestResult {
  return typeof v === 'object' && v !== null && 'status' in v && 'body' in v;
}

function fileContentJson(repo: Repo, path: string, entry: { oid: string; mode: string }): Record<string, unknown> {
  const blob = repo.objects.get(entry.oid);
  const data = blob?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    _links: { git: '', html: '', self: '' },
  };
}

function dirEntryJson(repo: Repo, path: string, entry: { oid: string; mode: string }, isDir: boolean, size: number): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    _links: { git: '', html: '', self: '' },
  };
}

// -------------------------------------------------------------------------------------------
// Router
// -------------------------------------------------------------------------------------------

export function handleRest(method: string, segments: string[], query: URLSearchParams, body: unknown, baseUrl = ''): RestResult | null {
  // segments are the path parts after /api/v3 (already URL-decoded per segment).
  const b = (typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  // GET /api/v3/  (segments empty)
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/users/{user}/followers',
        following_url: '/api/v3/users/{user}/following{/other_user}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/users/{user}/keys',
        labels_url: '/api/v3/repos/{owner}/{repo}/labels{/name}',
        markdown_url: '/api/v3/markdown',
        notifications_url: '/api/v3/notifications{?since,all,participating}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_url: '/api/v3/orgs/{org}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/users/{user}/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise: false });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, { ...userJson(), followers: 0, following: 0, public_repos: store.viewerRepos().length, public_gists: 0 });
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const page = paginate(repos.map((r) => repoJson(r)), query, '/api/v3/user/repos', baseUrl);
      return ok(200, page.items, page.headers);
    }
    if (method === 'POST') {
      const name = str(b.name);
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable('Validation Failed: name is required');
      if (store.getRepo(VIEWER_LOGIN, name)) return unprocessable(`Repository ${VIEWER_LOGIN}/${name} already exists`);
      const repo = store.createRepo(name, b.private === true, str(b.description) ?? '');
      return ok(201, repoJson(repo));
    }
    return notFound();
  }

  if (segments[0] === 'rate_limit') {
    return ok(200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
  }

  if (segments[0] !== 'repos' || segments.length < 3) return null;
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const repo = getRepo(owner, repoName);
  const rest = segments.slice(3);

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (!repo) return notFound();
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (str(b.description) !== undefined) repo.description = str(b.description)!;
      if (typeof b.private === 'boolean') repo.priv = b.private;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return notFound();
  }
  if (!repo) return notFound();

  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }));
      const page = paginate(list, query, `${repoPath}/branches`, baseUrl);
      return ok(200, page.items, page.headers);
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!oid) return notFound();
      return ok(200, { name: rest[1], commit: { sha: oid, url: '' }, protected: false });
    }
    return notFound();
  }

  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const tip = resolveRefTip(repo, query.get('sha'));
      if (tip === null) return ok(200, []);
      const list = listCommits(repo, tip).map((oid) => commitJson(repo, oid));
      const page = paginate(list, query, `${repoPath}/commits`, baseUrl);
      return ok(200, page.items, page.headers);
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = resolveRefTip(repo, rest[1]);
      if (oid === null || !repo.objects.has(oid)) return notFound();
      return ok(200, commitJson(repo, oid));
    }
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(b.ref);
      const sha = str(b.sha);
      if (!ref || !sha) return unprocessable('Validation Failed: ref and sha are required');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      if (!repo.objects.has(sha)) return unprocessable('Object does not exist');
      repo.refs.set(ref, sha);
      return ok(201, { ref, node_id: store.globalId('Ref', [repo.id, ref]), url: `${repoPath}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: '' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const refName = rest.slice(2).join('/');
      const oid = repo.refs.get(refName) ?? repo.refs.get(`refs/${refName}`);
      if (!oid) return notFound();
      const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
      return ok(200, { ref: full, node_id: '', url: '', object: { sha: oid, type: 'commit', url: '' } });
    }
    return notFound();
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const tip = resolveRefTip(repo, query.get('ref'));
      if (tip === null) return notFound();
      const files = filesAtCommit(repo, tip);
      const exact = files.get(path);
      if (path === '' || path === '/') {
        const entries: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        for (const [p, entry] of files) {
          const first = p.split('/')[0]!;
          if (seen.has(first)) continue;
          seen.add(first);
          const isDir = ![...files.keys()].some((k) => k === first) && [...files.keys()].some((k) => k.startsWith(`${first}/`));
          if (isDir) entries.push(dirEntryJson(repo, first, { oid: '', mode: '40000' }, true, 0));
          else entries.push(dirEntryJson(repo, first, entry, false, repo.objects.get(entry.oid)?.data.length ?? 0));
        }
        entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return ok(200, entries);
      }
      if (exact) return ok(200, fileContentJson(repo, path, exact));
      // Directory listing.
      const prefix = `${path}/`;
      const children = new Map<string, { oid: string; mode: string; isDir: boolean; size: number }>();
      for (const [p, entry] of files) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const first = restPath.split('/')[0]!;
        const isDir = restPath.includes('/');
        if (!children.has(first)) {
          children.set(first, {
            oid: entry.oid,
            mode: isDir ? '40000' : entry.mode,
            isDir,
            size: isDir ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
          });
        }
      }
      if (children.size === 0) return notFound();
      const entries = [...children.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, entry]) => dirEntryJson(repo, `${path}/${name}`, entry, entry.isDir, entry.size));
      return ok(200, entries);
    }
    if (method === 'PUT') {
      const contentB64 = str(b.content);
      if (contentB64 === undefined) return badRequest('content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return badRequest('content is not valid base64');
      }
      const message = str(b.message) ?? 'Update file';
      const result = contentsWrite(repo, str(b.branch), path, content, message, str(b.sha), false);
      if (isRestResult(result)) return result;
      return ok(result.status, {
        content: { name: path.split('/').pop(), path, sha: result.contentSha, size: content.length, url: '', html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64' },
        commit: { sha: result.commitSha, node_id: '', message, url: '', author: userJson(), committer: userJson(), parents: [], tree: { sha: '', url: '' } },
      });
    }
    if (method === 'DELETE') {
      const result = contentsWrite(repo, str(b.branch), path, Buffer.alloc(0), str(b.message) ?? 'Delete file', str(b.sha), true);
      if (isRestResult(result)) return result;
      return ok(200, { commit: { sha: result.commitSha, node_id: '', message: str(b.message) ?? '', url: '' } });
    }
    return notFound();
  }

  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return ok(200, repo.labels.map((l) => labelJson(repo, l.name)));
    }
    if (method === 'POST' && rest.length === 1) {
      const name = str(b.name);
      if (!name) return unprocessable('Validation Failed: name is required');
      const existing = repo.labels.find((l) => l.name === name);
      if (existing) return ok(201, labelJson(repo, name));
      repo.nextLabelId += 1;
      repo.labels.push({ id: repo.nextLabelId, name, color: str(b.color) ?? 'ededed', description: str(b.description) ?? '' });
      return ok(201, labelJson(repo, name));
    }
    return notFound();
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'asc';
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'desc' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
        }
        const page = paginate(list.map((i) => issueJson(repo, i)), query, `${repoPath}/issues`, baseUrl);
        return ok(200, page.items, page.headers);
      }
      if (method === 'POST') {
        const title = str(b.title);
        if (!title) return unprocessable('Validation Failed: title is required');
        const labels = Array.isArray(b.labels) ? b.labels : [];
        for (const label of labels) {
          const name = typeof label === 'string' ? label : (label as Record<string, unknown>).name;
          if (typeof name === 'string' && !repo.labels.some((l) => l.name === name)) {
            return unprocessable(`Validation Failed: label "${name}" does not exist`);
          }
        }
        store.seq += 1;
        const issue: Issue = {
          id: store.nextIssueId(),
          number: repo.nextNumber,
          title,
          body: str(b.body) ?? '',
          state: 'open',
          labels: labels.map((l) => (typeof l === 'string' ? l : String((l as Record<string, unknown>).name ?? ''))).filter(Boolean),
          createdSeq: store.seq,
          closedAt: null,
        };
        repo.nextNumber += 1;
        repo.issues.push(issue);
        return ok(201, issueJson(repo, issue));
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return notFound();
    const issue = repo.issues.find((i) => i.number === number);
    if (rest.length === 2) {
      if (!issue) return notFound();
      if (method === 'GET') return ok(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        if (str(b.title) !== undefined) issue.title = str(b.title)!;
        if (str(b.body) !== undefined) issue.body = str(b.body)!;
        if (str(b.state) === 'closed') {
          issue.state = 'closed';
          issue.closedAt = FIXED_ISO;
        } else if (str(b.state) === 'open') {
          issue.state = 'open';
          issue.closedAt = null;
        }
        if (Array.isArray(b.labels)) {
          for (const label of b.labels as unknown[]) {
            const name = typeof label === 'string' ? label : String((label as Record<string, unknown>).name ?? '');
            if (name && !repo.labels.some((l) => l.name === name)) return unprocessable(`Validation Failed: label "${name}" does not exist`);
          }
          issue.labels = (b.labels as unknown[]).map((l) => (typeof l === 'string' ? l : String((l as Record<string, unknown>).name ?? ''))).filter(Boolean);
        }
        return ok(200, issueJson(repo, issue));
      }
      return notFound();
    }
    if (rest[2] === 'comments') {
      if (!issue) return notFound();
      if (method === 'GET') {
        const list = repo.comments.get(number) ?? [];
        const page = paginate(
          list.map((c) => ({
            id: c.id,
            node_id: store.globalId('IssueComment', [repo.id, number, c.id]),
            url: `${repoPath}/issues/${number}/comments/${c.id}`,
            html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${c.id}`,
            body: c.body,
            user: userJson(),
            created_at: FIXED_ISO,
            updated_at: FIXED_ISO,
            author_association: 'OWNER',
          })),
          query,
          `${repoPath}/issues/${number}/comments`,
          baseUrl,
        );
        return ok(200, page.items, page.headers);
      }
      if (method === 'POST') {
        const text = str(b.body);
        if (!text) return unprocessable('Validation Failed: body is required');
        store.seq += 1;
        const comment = { id: repo.nextCommentId, body: text, createdSeq: store.seq };
        repo.nextCommentId += 1;
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return ok(201, {
          id: comment.id,
          node_id: store.globalId('IssueComment', [repo.id, number, comment.id]),
          url: `${repoPath}/issues/${number}/comments/${comment.id}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
          body: text,
          user: userJson(),
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
          author_association: 'OWNER',
        });
      }
      return notFound();
    }
    return notFound();
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        list = [...list].sort((a, b) => b.createdSeq - a.createdSeq);
        const page = paginate(list.map((p) => pullJson(repo, p)), query, `${repoPath}/pulls`, baseUrl);
        return ok(200, page.items, page.headers);
      }
      if (method === 'POST') {
        const head = str(b.head);
        const base = str(b.base);
        const title = str(b.title);
        if (!head || !base || !title) return unprocessable('Validation Failed: head, base and title are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return unprocessable('Validation Failed: head or base branch does not exist');
        store.seq += 1;
        const pull: Pull = {
          id: store.nextIssueId(),
          number: repo.nextNumber,
          title,
          body: str(b.body) ?? '',
          state: 'open',
          head,
          base,
          headSha,
          baseSha,
          merged: false,
          mergeCommitSha: null,
          mergedAt: null,
          createdSeq: store.seq,
        };
        repo.nextNumber += 1;
        repo.pulls.push(pull);
        return ok(201, pullJson(repo, pull));
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.find((p) => p.number === number);
    if (rest.length === 2) {
      if (!pull) return notFound();
      if (method === 'GET') return ok(200, pullJson(repo, pull));
      if (method === 'PATCH') {
        if (str(b.title) !== undefined) pull.title = str(b.title)!;
        if (str(b.body) !== undefined) pull.body = str(b.body)!;
        if (str(b.state) === 'closed' && pull.state === 'open') pull.state = 'closed';
        return ok(200, pullJson(repo, pull));
      }
      return notFound();
    }
    if (rest[2] === 'files' && method === 'GET') {
      if (!pull) return notFound();
      const base = mergeBase(repo, pull.headSha, pull.baseSha);
      const baseFiles = base ? filesAtCommit(repo, base) : new Map();
      const headFiles = filesAtCommit(repo, pull.headSha);
      const diffs = diffFiles(baseFiles, headFiles);
      const files = diffs.map((d) => {
        const oldData = d.oldOid ? repo.objects.get(d.oldOid)?.data ?? null : null;
        const newData = d.newOid ? repo.objects.get(d.newOid)?.data ?? null : null;
        const counts = lineCounts(oldData, newData);
        return {
          sha: d.newOid ?? d.oldOid ?? '',
          filename: d.path,
          status: d.status,
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
          blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${d.path}`,
          raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${d.path}`,
          contents_url: `${repoPath}/contents/${d.path}?ref=${pull.headSha}`,
          patch: '',
        };
      });
      return ok(200, files);
    }
    if (rest[2] === 'merge') {
      if (!pull) return notFound();
      if (method === 'GET') {
        return pull.merged ? { status: 204, body: null } : notFound();
      }
      if (method === 'PUT') {
        if (pull.state === 'closed' && pull.merged) return ok(405, { message: 'Pull request is already merged' });
        if (mergeableOf(repo, pull) === 'CONFLICTING') return ok(405, { message: 'Merge conflict: the pull request cannot be merged' });
        const headFiles = filesAtCommit(repo, pull.headSha);
        const fileMap = new Map<string, string>();
        for (const [p, entry] of headFiles) fileMap.set(p, entry.oid);
        const treeOid = treeFromFiles(repo, fileMap);
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
        const mergeSha = mintCommit(repo, treeOid, baseTip ? [baseTip] : [], message);
        repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = mergeSha;
        return ok(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
      }
      return notFound();
    }
    return notFound();
  }

  return null;
}
