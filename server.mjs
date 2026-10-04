import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import health from './api/health.mjs';
import {createApplication} from './lib/application.mjs';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const securityHeaders = Object.fromEntries(JSON.parse(await readFile(new URL('./vercel.json', import.meta.url), 'utf8')).headers[0].headers.map(({key, value}) => [key, value]));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json'
};

export async function handleRequest(req, res, application = createApplication()) {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) {
      const headers = new Headers(req.headers || {});
      const host = headers.get('host') || 'localhost:5173';
      const request = new Request('http://' + host + req.url, {method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method) && req[Symbol.asyncIterator] ? {body: req, duplex: 'half'} : {})});
      const response = pathname === '/api/health' ? await health.fetch(request) : await application.fetch(request);
      const replyHeaders = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) replyHeaders['set-cookie'] = cookies;
      res.writeHead(response.status, replyHeaders);
      res.end(req.method === 'HEAD' ? undefined : await response.text());
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, {Allow: 'GET, HEAD'});
      res.end('Method not allowed');
      return;
    }
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error();
    const content = await readFile(target);
    res.writeHead(200, {...securityHeaders, 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404);
    res.end(req.method === 'HEAD' ? undefined : 'Not found');
  }
}

export const createAppServer = ({application = createApplication()} = {}) => http.createServer((req, res) => handleRequest(req, res, application));

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createAppServer().listen(5173, '127.0.0.1', () => console.log('Local: http://localhost:5173/'));
}
