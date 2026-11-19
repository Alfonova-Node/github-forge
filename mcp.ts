// github-forge MCP: Model Context Protocol over streamable HTTP (JSON-RPC 2.0).
// Speaks the modern 2026-07-28 revision (server/discover, no handshake) and
// the legacy handshake era (initialize + notifications/initialized) so either
// client negotiates. Tools act on the same store as REST.

import {
  FIXED_ISO,
  VIEWER_LOGIN,
  filesAtCommit,
  mintCommit,
  store,
  treeFromFiles,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { issueJson, mergeableOf, pullJson, repoJson } from './rest.ts';

export const MCP_SERVER_NAME = 'github-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Pull request state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
];

function toolsList(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, required: t.required },
  }));
}

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function getRepoFor(owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo) ?? null;
}

function splitFullName(args: Record<string, unknown>): void {
  if (typeof args.full_name === 'string' && !args.repo) {
    const [owner, repo] = args.full_name.split('/');
    if (owner && repo) {
      args.owner = owner;
      args.repo = repo;
    }
  }
}

function callTool(name: string, args: Record<string, unknown>): { result: Record<string, unknown> } | { rpcError: { code: number; message: string } } {
  splitFullName(args);
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
  for (const req of def.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return { rpcError: { code: -32602, message: `Invalid params: missing required argument "${req}"` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return { result: toolError(`Invalid repository name: ${repoName}`) };
      const existing = store.getRepo(VIEWER_LOGIN, repoName);
      if (existing) return { result: toolResult(repoJson(existing)) };
      const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = getRepoFor(args.owner, args.repo);
      if (!repo) return { result: toolError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = getRepoFor(args.owner, args.repo);
      if (!repo) return { result: toolError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      store.seq += 1;
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: store.seq,
        closedAt: null,
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = getRepoFor(args.owner, args.repo);
      if (!repo) return { result: toolError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueJson(repo, i));
      return { result: toolResult({ issues: list }) };
    }
    case 'get_issue': {
      const repo = getRepoFor(args.owner, args.repo);
      if (!repo) return { result: toolError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
      if (!issue) return { result: toolError(`Issue not found: #${String(args.issue_number)}`) };
      return { result: toolResult(issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = getRepoFor(args.owner, args.repo);
      if (!repo) return { result: toolError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { result: toolError(`Head or base branch does not exist: ${head} / ${base}`) };
      store.seq += 1;
      const pull: Pull = {
        id: store.nextIssueId(),
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
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
      return { result: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = getRepoFor(args.owner, args.repo);
      if (!repo) return { result: toolError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return { result: toolError(`Pull request not found: #${String(args.pull_number)}`) };
      if (pull.merged) return { result: toolResult({ number: pull.number, merged: true, sha: pull.mergeCommitSha, state: 'closed' }) };
      if (mergeableOf(repo, pull) === 'CONFLICTING') return { result: toolError('Pull request cannot be merged: merge conflict') };
      const headFiles = filesAtCommit(repo, pull.headSha);
      const fileMap = new Map<string, string>();
      for (const [p, entry] of headFiles) fileMap.set(p, entry.oid);
      const treeOid = treeFromFiles(repo, fileMap);
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const mergeSha = mintCommit(repo, treeOid, baseTip ? [baseTip] : [], `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`);
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = FIXED_ISO;
      pull.mergeCommitSha = mergeSha;
      return { result: toolResult({ number: pull.number, merged: true, sha: mergeSha, state: 'closed' }) };
    }
    case 'list_pull_requests': {
      const repo = getRepoFor(args.owner, args.repo);
      if (!repo) return { result: toolError(`Repository not found: ${String(args.owner)}/${String(args.repo)}`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state).map((p) => pullJson(repo, p));
      return { result: toolResult({ pull_requests: list }) };
    }
    default:
      return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
  }
}

export interface McpOutcome {
  status: number;
  body: unknown;
}

/** Handle one POST /mcp JSON-RPC request. `body` is the already-parsed JSON (or null when unparsable). */
export function handleMcp(body: unknown, rawText: string): McpOutcome {
  if (body === null && rawText.trim() !== '') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {}) as Record<string, unknown>;

  // Notifications (no id) are acknowledged with an empty 202.
  if (req.id === undefined) {
    return { status: 202, body: null };
  }

  const result = (value: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string, data?: unknown): McpOutcome => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: MCP_REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      protocolVersion: '2026-07-28',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const negotiated = MCP_REVISIONS.includes(requested) ? requested : '2026-07-28';
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/list') {
    return result({ tools: toolsList() });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}) as Record<string, unknown>;
    const outcome = callTool(name, args);
    if ('rpcError' in outcome) return error(outcome.rpcError.code, outcome.rpcError.message);
    return result(outcome.result);
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  return error(-32601, `Method not found: ${method}`);
}
