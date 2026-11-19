// github-forge app: one node:http server wiring REST v3, GraphQL v4, MCP and
// git smart HTTP onto the shared in-memory store.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY = 64 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  // With no token configured (local testing) any non-empty bearer is accepted.
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp() {
  return createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Health check: no auth.
  if (path === '/healthz' && method === 'GET') {
    json(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP.
  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch) {
    if (!authorized(req)) {
      json(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = gitMatch[1]!;
    const repo = gitMatch[2]!;
    const service = gitMatch[3]!;
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const result = handleGit(method, owner, repo, service, url.searchParams, req.headers, body);
    res.writeHead(result.status, {
      'content-type': result.contentType,
      'x-github-request-id': requestId(),
    });
    res.end(result.body);
    return;
  }

  // Everything below requires auth (except /healthz handled above).
  if (!authorized(req)) {
    json(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      json(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const runOne = (op: unknown): unknown => {
      if (op === null || typeof op !== 'object') return { data: null, errors: [{ message: 'Invalid GraphQL request body' }] };
      const record = op as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables !== null && typeof record.variables === 'object' ? (record.variables as Record<string, unknown>) : {}) as Record<string, unknown>;
      const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
      return executeGraphQL(query, variables, operationName);
    };
    if (Array.isArray(parsed.value)) {
      json(res, 200, parsed.value.map(runOne));
    } else {
      json(res, 200, runOne(parsed.value));
    }
    return;
  }

  if (path === '/mcp' && method === 'POST') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const outcome = handleMcp(parsed.value, raw.toString('utf8'));
    if (outcome.body === null) {
      res.writeHead(outcome.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    json(res, outcome.status, outcome.body);
    return;
  }

  if (path.startsWith('/api/v3')) {
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let body: unknown = undefined;
    if (raw.length > 0) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        json(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      body = parsed.value;
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
    const result = handleRest(method, segments, url.searchParams, body, `http://${req.headers.host ?? '127.0.0.1'}`);
    if (result === null) {
      json(res, 404, { message: 'Not Found' });
      return;
    }
    json(res, result.status, result.body, result.headers ?? {});
    return;
  }

  json(res, 404, { message: 'Not Found' });
}
