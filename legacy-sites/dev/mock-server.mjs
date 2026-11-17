import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTechTree } from '../functions/tech.mjs';
import { createFakeDb } from './fake-db.mjs';

class BackendError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const requireUser = (ctx) => {
  if (!ctx.user) throw new BackendError('login_required', 401);
  return ctx.user;
};

const handle = createTechTree({ db: createFakeDb(), requireUser, BackendError });

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.argv[2] || 4174);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (url.pathname === '/functions/v1/app') {
    const body = await readBody(req);
    const request = new Request(url, {
      method: req.method,
      headers: new Headers(req.headers),
      body: body.length && !['GET', 'HEAD'].includes(req.method) ? body : undefined,
    });
    const response = await handle({ request, user: { id: 'local-user', name: '本地预览' } });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = normalize(join(root, requested));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`local mock site: http://127.0.0.1:${port}/`);
});
