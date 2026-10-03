import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import health from './api/health.mjs';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json'
};

export async function handleRequest(req, res) {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/health') {
      const response = await health.fetch(new Request('http://localhost/api/health', {method: req.method}));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
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
    res.writeHead(200, {'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404);
    res.end(req.method === 'HEAD' ? undefined : 'Not found');
  }
}

export const createAppServer = () => http.createServer(handleRequest);

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  createAppServer().listen(5173, '127.0.0.1', () => console.log('Local: http://localhost:5173/'));
}
