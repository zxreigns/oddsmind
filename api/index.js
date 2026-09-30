// Vercel Node.js function adapter: turns the platform request into a Web Request,
// runs the portable app (src/app.js) and streams the Response back.
import app from '../src/app.js';
import titlesSeed from '../src/titles-seed.json' with { type: 'json' };
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.ico': 'image/x-icon', '.webp': 'image/webp' };

const mem = new Map();
// Cache store. With Upstash Redis attached (KV_REST_API_URL / KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_*), the cache is
// shared across instances and deploys; otherwise a per-instance Map plus the CDN cache headers on responses.
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(cmd) {
  const r = await fetch(REST_URL, { method: 'POST', headers: { authorization: 'Bearer ' + REST_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json(); if (d.error) throw new Error(d.error); return d.result;
}
const UPSTASH = REST_URL && REST_TOKEN ? {
  async get(k, type) { try { const v = await redis(['GET', k]); if (v === null || v === undefined) return null; return type === 'json' ? JSON.parse(v) : v; } catch (e) { return null; } },
  async put(k, val, opts = {}) { try { await redis(opts.expirationTtl ? ['SET', k, val, 'EX', String(opts.expirationTtl)] : ['SET', k, val]); } catch (e) {} },
  async delete(k) { try { await redis(['DEL', k]); } catch (e) {} },
  async list({ prefix = '' } = {}) { try { const keys = await redis(['KEYS', prefix + '*']); return { keys: keys.map((name) => ({ name })), list_complete: true }; } catch (e) { return { keys: [], list_complete: true }; } },
} : null;
const MEMKV = {
  async get(k, type) { const v = mem.get(k); if (v === undefined) return null; if (v.exp && v.exp < Date.now()) { mem.delete(k); return null; } return type === 'json' ? JSON.parse(v.val) : v.val; },
  async put(k, val, opts = {}) { mem.set(k, { val, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 }); if (mem.size > 5000) mem.delete(mem.keys().next().value); },
  async delete(k) { mem.delete(k); },
  async list({ prefix = '' } = {}) { return { keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const CACHE = UPSTASH ? { ...UPSTASH, kind: 'upstash-redis' } : { ...MEMKV, kind: 'memory' };

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${proto}://${host}`;
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(origin + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const ASSETS = {
    // Static files ship inside the function bundle (vercel.json includeFiles); fall back to the CDN copy if a file is missing.
    async fetch(r) {
      const u = new URL(typeof r === 'string' ? r : r.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const file = path.join(PUBLIC_DIR, rel);
      if (file.startsWith(PUBLIC_DIR) && rel) {
        try { const body = await fs.readFile(file); return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } }); } catch (e) {}
      }
      try { return await fetch(`${origin}${u.pathname}`, { headers: { 'x-oddsmind-internal': '1' } }); } catch (e) { return new Response('not found', { status: 404 }); }
    },
  };
  const env = { CACHE, ASSETS, TITLES_SEED: titlesSeed, PANTA_API_KEY: process.env.PANTA_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL, GROQ_API_KEY: process.env.GROQ_API_KEY, GROQ_MODEL: process.env.GROQ_MODEL, ADMIN_TOKEN_SHA256: process.env.ADMIN_TOKEN_SHA256 };
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p.catch(() => {})); }, passThroughOnException() {} };
  const response = await app.fetch(request, env, ctx);
  res.statusCode = response.status;
  response.headers.forEach((v, k) => { if (k.toLowerCase() !== 'content-encoding') res.setHeader(k, v); });
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
  await Promise.allSettled(pending);
}
