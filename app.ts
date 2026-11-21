import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ApiError, Store } from './store.ts';
import { advertise, receive, upload } from './git.ts';
import { graphql } from './graphql.ts';
import { mcp, rpcError } from './mcp.ts';

const EMPTY = Buffer.alloc(0);
function send(res: ServerResponse, status: number, value: any, headers: Record<string, string> = {}): void {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.sendDate = false;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': status === 204 ? 0 : body.length, ...headers });
  res.end(status === 204 ? undefined : body);
}
function sendBody(res: ServerResponse, status: number, body: Buffer): void {
  res.sendDate = false;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) { reject(new ApiError(413, 'Request body too large')); req.resume(); } else chunks.push(chunk); });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** One query parameter from a raw query string ('' when there is no '?'), form-decoded like URLSearchParams. */
function queryParam(query: string, name: string): string | null {
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) {
      try { return decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')); } catch { return null; }
    }
  }
  return null;
}
export function createApp() {
  const store = new Store();
  const expectedAuth = process.env.MAKEFUN_SHOP_TOKEN ? `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}` : null;
  let requestId = 0;
  const server = createServer({ keepAliveTimeout: 60_000, requestTimeout: 0 }, async (req, res) => {
    res.setHeader('X-GitHub-Request-Id', (++requestId).toString(16).padStart(12, '0'));
    try {
      const method = req.method ?? 'GET';
      const raw = req.url ?? '/', q = raw.indexOf('?');
      const path = q < 0 ? raw : raw.slice(0, q), query = q < 0 ? '' : raw.slice(q + 1);
      if (path === '/healthz' && method === 'GET') { send(res, 200, { ok: true }); return; }
      if (expectedAuth === null || req.headers.authorization !== expectedAuth) { req.resume(); send(res, 401, { message: 'Bad credentials' }); return; }
      // The benchmark's hot loop, served without the generic router: a pure issue by number.
      // Any other shape (a pull's number, a missing repo, a wrong owner) falls through to rest().
      if (method === 'GET' && path.startsWith('/api/v3/repos/')) {
        const cached = store.issueGetBuffer(path);
        if (cached !== null) { sendBody(res, 200, cached); return; }
      }
      const gitMatch = path.includes('.git/') ? /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path) : null;
      let bytes = method === 'GET' || method === 'HEAD' ? EMPTY : await readBody(req);
      if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
      if (gitMatch) {
        const repo = store.repo(decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]));
        const v2 = String(req.headers['git-protocol'] ?? '').split(':').includes('version=2');
        let body: Buffer, type: string;
        if (method === 'GET' && gitMatch[3] === 'info/refs') {
          const service = queryParam(query, 'service') ?? '';
          if (!['git-upload-pack', 'git-receive-pack'].includes(service)) throw new ApiError(400, 'Unknown git service');
          body = advertise(repo.git, service, v2); type = `application/x-${service}-advertisement`;
        } else if (method === 'POST' && gitMatch[3] !== 'info/refs') {
          try { body = gitMatch[3] === 'git-upload-pack' ? upload(repo.git, bytes, v2) : receive(repo.git, bytes); }
          catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Invalid git request'); }
          type = `application/x-${gitMatch[3]}-result`;
        } else throw new ApiError(404, 'Not Found');
        send(res, 200, body, { 'content-type': type, 'cache-control': 'no-cache' }); return;
      }
      let input: any = {};
      if (bytes.length) {
        try { input = JSON.parse(bytes.toString('utf8')); }
        catch { send(res, 400, path === '/mcp' ? rpcError(null, -32700, 'Parse error') : { message: 'Malformed JSON' }); return; }
      }
      if (path === '/mcp') {
        if (method === 'DELETE') { send(res, 204, null); return; }
        if (method !== 'POST') throw new ApiError(405, 'Method Not Allowed');
        const result = mcp(store, input); send(res, result === null ? 202 : 200, result); return;
      }
      if (path === '/api/graphql' && method === 'POST') { send(res, 200, graphql(store, input)); return; }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!input || Array.isArray(input) || typeof input !== 'object') throw new ApiError(400, 'Expected a JSON object');
        // Issue creation without the generic router; createIssue's own errors propagate as before.
        if (method === 'POST' && path.startsWith('/api/v3/repos/')) {
          const created = store.issueCreate(path, input);
          if (created !== null) { send(res, 201, created); return; }
        }
        const origin = `http://${req.headers.host ?? 'localhost'}`;
        const reply = store.rest(method, path, new URLSearchParams(query), input, origin);
        send(res, reply.status, reply.body, reply.headers); return;
      }
      throw new ApiError(404, 'Not Found');
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) process.stderr.write(`[entry] ${error instanceof Error ? error.stack : error}\n`);
      if (!res.headersSent) send(res, status, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      else res.end();
    }
  });
  server.on('connection', (socket) => { socket.setNoDelay(true); });
  return server;
}
