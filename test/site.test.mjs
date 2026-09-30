
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'public');
const appPath = path.join(root, 'src', 'app.js');
const read = (f) => fs.readFileSync(path.join(site, f), 'utf8');

test('every page shell has a real title, viewport meta, local assets and Powered by Panta', () => {
  for (const f of ['shells/index.html', 'shells/market.html', 'shells/wallet.html', 'shells/ask.html', 'shells/api.html', 'shells/about.html']) {
    const h = read(f);
    assert.match(h, /<title>[^<]+<\/title>/, f + ' title');
    assert.match(h, /name="viewport" content="width=device-width, initial-scale=1"/, f + ' viewport');
    assert.match(h, /href="\/assets\/app.css"/, f + ' css');
    assert.match(h, /src="\/assets\/app.js"/, f + ' js');
    assert.match(h, /Powered by Panta/, f + ' attribution');
    assert.match(h, /href="https:\/\/panta.market"/, f + ' attribution link');
    assert.doesNotMatch(h, /lorem ipsum|TODO|placeholder text/i, f + ' no placeholders');
  }
  for (const f of ['assets/app.css', 'assets/app.js', 'assets/logo.svg', 'shells/404.html']) assert.ok(fs.existsSync(path.join(site, f)), f + ' exists');
  for (const f of ['src/app.js', 'src/titles-seed.json', 'api/index.js', 'vercel.json']) assert.ok(fs.existsSync(path.join(root, f)), f + ' exists');
});

test('app has no secrets; vercel routes everything to the function', () => {
  const w = fs.readFileSync(appPath, 'utf8');
  assert.doesNotMatch(w, /pk_live_[A-Za-z0-9]{8,}/, 'no Panta live key');
  assert.doesNotMatch(w, /AIza[0-9A-Za-z_-]{20,}/, 'no Google key');
  assert.doesNotMatch(w, /gsk_[A-Za-z0-9]{20,}/, 'no Groq key');
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(v.rewrites[0].destination, '/api/index');
});

test('app routes and helpers behave (offline)', async () => {
  const mod = await import(appPath);
  const worker = mod.default;
  const kv = new Map();
  const env = {
    CACHE: { async get(k, t) { const v = kv.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); }, async list() { return { keys: [], list_complete: true }; } },
    ASSETS: { async fetch(req) { const p = new URL(req.url).pathname; const f = path.join(site, p); return fs.existsSync(f) ? new Response(fs.readFileSync(f), { headers: { 'content-type': 'text/html' } }) : new Response('nf', { status: 404 }); } },
  };
  const ctx = { waitUntil() {} };
  const health = await (await worker.fetch(new Request('http://x/api/health'), env, ctx)).json();
  assert.equal(health.ok, true); assert.equal(health.panta, false); assert.equal(health.poweredBy, 'Panta');
  const disabled = await worker.fetch(new Request('http://x/admin/config', { method: 'POST', headers: { 'x-admin-token': 'wrong' }, body: '{}' }), env, ctx);
  assert.equal(disabled.status, 404, 'admin disabled without ADMIN_TOKEN_SHA256');
  const forbidden = await worker.fetch(new Request('http://x/admin/config', { method: 'POST', headers: { 'x-admin-token': 'wrong' }, body: '{}' }), { ...env, ADMIN_TOKEN_SHA256: 'a'.repeat(64) }, ctx);
  assert.equal(forbidden.status, 403);
  const noKey = await (await worker.fetch(new Request('http://x/api/pulse'), env, ctx)).json();
  assert.match(noKey.detail || noKey.error, /NO_API_KEY|Panta/);
  const bad = await worker.fetch(new Request('http://x/api/market/not-a-pubkey'), env, ctx);
  assert.equal(bad.status, 404);
  const ask = await worker.fetch(new Request('http://x/api/ask?q=hi'), env, ctx);
  assert.equal(ask.status, 400);
  const home = await worker.fetch(new Request('http://x/'), env, ctx);
  const homeHtml = await home.text();
  assert.match(homeHtml, /<title>OddsMind — what do the markets think\?<\/title>/);
  assert.doesNotMatch(homeHtml, /\{\{TITLE\}\}/, 'template vars replaced');
});

test('tape statistics reconstruct prices from fills', async () => {
  const src = fs.readFileSync(appPath, 'utf8');
  // pull tapeStats out of the module source without exporting internals
  const fnSrc = src.slice(src.indexOf('function tapeStats'), src.indexOf('const getTape'));
  const helpers = "const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v)); const nowSec = () => Math.floor(Date.now() / 1000);";
  const tapeStats = new Function(helpers + fnSrc + '; return tapeStats;')();
  const now = Math.floor(Date.now() / 1000);
  const s = tapeStats([
    { wallet: 'A', side: 'yes', shares: '20', amountUsdc: '10', blockTime: now - 7200, isPrimary: true },
    { wallet: 'B', side: 'no', shares: '10', amountUsdc: '4', blockTime: now - 3600, isPrimary: true },
    { wallet: 'A', side: 'yes', shares: '5', amountUsdc: null, blockTime: now - 60, isPrimary: true },
  ]);
  assert.equal(s.trades, 3); assert.equal(s.uniqueWallets, 2); assert.equal(s.pricedTrades, 2);
  assert.equal(s.series[0].p, 0.5); assert.equal(s.series[1].p, 0.6); // NO at 0.40 → YES 0.60
  assert.equal(s.lastPriceYes, 0.6); assert.equal(s.volumeUsdc, 14);
  assert.equal(s.holders[0].wallet, 'A');
});
