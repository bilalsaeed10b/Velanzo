// Minimal zero-dependency static file server for the Luna storefront.
// Usage: node server.mjs  (serves the current folder on http://localhost:4321)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
};

// Per-IP rate limit: 300 requests / minute (fixed window).
const RL_MAX = 300, RL_WINDOW = 60_000;
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > RL_WINDOW) hits.delete(k); }, RL_WINDOW).unref();
function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.start > RL_WINDOW) { h = { start: now, n: 0 }; hits.set(ip, h); }
  return ++h.n > RL_MAX;
}

const server = createServer(async (req, res) => {
  if (limited(req)) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
    res.end('Too many requests');
    return;
  }
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    // Prevent path traversal.
    const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = join(ROOT, safePath);

    let info;
    try {
      info = await stat(filePath);
    } catch {
      info = null;
    }
    // Extension-less route -> try .html
    if (!info && !extname(filePath)) {
      try {
        await stat(filePath + '.html');
        filePath += '.html';
        info = { isDirectory: () => false };
      } catch {}
    }
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 - Not found</h1>');
      return;
    }
    if (info.isDirectory && info.isDirectory()) filePath = join(filePath, 'index.html');

    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      // Always serve fresh files — heuristic caching otherwise lets the
      // browser show stale JS/CSS after an edit.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end('<h1>500 - Server error</h1>');
  }
});

server.listen(PORT, () => {
  console.log(`Luna storefront running at http://localhost:${PORT}`);
});
