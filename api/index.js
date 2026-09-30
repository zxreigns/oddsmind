// Vercel Node.js function adapter: turns the platform request into a Web Request,
// runs the portable app (src/app.js) and streams the Response back.
import app from '../src/app.js';
import titlesSeed from '../src/titles-seed.json' with { type: 'json' };

const mem = new Map();
// Minimal KV-shaped store (per warm instance). The CDN cache headers on responses do the heavy lifting on Vercel.
const CACHE = {
  async get(k, type) { const v = mem.get(k); if (v === undefined) return null; if (v.exp && v.exp < Date.now()) { mem.delete(k); return null; } return type === 'json' ? JSON.parse(v.val) : v.val; },
  async put(k, val, opts = {}) { mem.set(k, { val, exp: opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 }); if (mem.size > 5000) mem.delete(mem.keys().next().value); },
  async delete(k) { mem.delete(k); },
  async list({ prefix = '' } = {}) { return { keys: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${proto}://${host}`;
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(origin + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const ASSETS = { async fetch(r) { const u = new URL(typeof r === 'string' ? r : r.url); return fetch(`${origin}${u.pathname}`, { headers: { 'x-oddsmind-internal': '1' } }); } };
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
