import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ApiError, Store } from './store.ts';
import { advertise, receive, upload } from './git.ts';
import { graphql } from './graphql.ts';
import { mcp, rpcError } from './mcp.ts';

function send(res: ServerResponse, status: number, value: any, headers: Record<string, string> = {}): void {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': status === 204 ? 0 : body.length, ...headers });
  res.end(status === 204 ? undefined : body);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) { reject(new ApiError(413, 'Request body too large')); req.resume(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export function createApp() {
  const store = new Store();
  const token = Buffer.from(`Bearer ${process.env.MAKEFUN_SHOP_TOKEN ?? ''}`);
  let requestId = 0;
  return createServer({ keepAliveTimeout: 60_000, requestTimeout: 30_000 }, async (req, res) => {
    res.setHeader('X-GitHub-Request-Id', (++requestId).toString(16).padStart(12, '0'));
    try {
      const origin = `http://${req.headers.host ?? 'localhost'}`, url = new URL(req.url ?? '/', origin);
      const method = req.method ?? 'GET', path = url.pathname;
      if (path === '/healthz' && method === 'GET') { send(res, 200, { ok: true }); return; }
      const authorization = Buffer.from(req.headers.authorization ?? '');
      if (!process.env.MAKEFUN_SHOP_TOKEN || authorization.length !== token.length || !timingSafeEqual(authorization, token)) { req.resume(); send(res, 401, { message: 'Bad credentials' }); return; }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      let bytes = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 });
      if (gitMatch) {
        const repo = store.repo(decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]));
        const v2 = String(req.headers['git-protocol'] ?? '').split(':').includes('version=2');
        let body: Buffer, type: string;
        if (method === 'GET' && gitMatch[3] === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
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
        const reply = store.rest(method, path, url.searchParams, input, origin);
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
}
