
// Local dev server: runs src/app.js with a Map-backed KV and a static ASSETS fetcher over public/.
// Usage: PANTA_API_KEY=... GEMINI_API_KEY=... node dev/local-server.mjs [port]
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(here, '..', 'public');
const worker = (await import(path.join(here, '..', 'src', 'app.js'))).default;
const titlesSeed = JSON.parse(await fs.readFile(path.join(here, '..', 'src', 'titles-seed.json'), 'utf8'));
const port = +(process.argv[2] || 8787);

const kv = new Map();
const CACHE = {
  async get(k, type) { const v = kv.get(k); if (v === undefined) return null; if (v.exp && v.exp < Date.now()) { kv.delete(k); return null; } return type === 'json' ? JSON.parse(v.val) : v.val; },
  async put(k, val, opts = {}) { kv.set(k, { val, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 }); },
  async delete(k) { kv.delete(k); },
  async list({ prefix = '' } = {}) { return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url); let p = decodeURIComponent(u.pathname);
    let file = path.join(siteDir, p);
    if (!file.startsWith(siteDir)) return new Response('not found', { status: 404 });
    try { let st = await fs.stat(file).catch(() => null); if (!st && !path.extname(file)) { file += '.html'; st = await fs.stat(file).catch(() => null); } if (!st) return new Response('not found', { status: 404 }); const body = await fs.readFile(file); return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } }); }
    catch (e) { return new Response('not found', { status: 404 }); }
  },
};
const env = { CACHE, ASSETS, TITLES_SEED: titlesSeed, PANTA_API_KEY: process.env.PANTA_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL, GROQ_API_KEY: process.env.GROQ_API_KEY, GROQ_MODEL: process.env.GROQ_MODEL, ADMIN_TOKEN_SHA256: process.env.ADMIN_TOKEN_SHA256 };
const pending = new Set();
const ctx = { waitUntil(p) { pending.add(p); p.finally(() => pending.delete(p)); }, passThroughOnException() {} };

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  try {
    const r = await worker.fetch(request, env, ctx);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('dev server error: ' + (e.stack || e)); }
}).listen(port, () => console.log(`OddsMind dev server on http://localhost:${port}`));
