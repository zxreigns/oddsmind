
// OddsMind — research desk for Panta prediction markets.
// Portable Web-standard app: `export default { fetch(request, env, ctx) }`.
// Runs on Vercel (api/index.js adapter), Cloudflare Workers, or the local dev server unchanged.
// Public repo: secrets never live here. Keys come from env vars (PANTA_API_KEY, GEMINI_API_KEY, GROQ_API_KEY)
// or, on a KV-backed deployment, from the CACHE store bootstrapped once through /admin/config.

const PANTA = 'https://live-api.panta.market/api/v1';
const PANTA_APP = 'https://panta.market';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const VERSION = '0.1.0';
// sha256 of the admin token (the token itself is never in this repo)
// optional: sha256 of an admin token (env ADMIN_TOKEN_SHA256) enables /admin/* on KV-backed deployments; the token itself is never in this repo
const QUOTE_LADDER = ['10', '50', '250'];
const QUOTE_WALLET = 'DFhPycAfUvu238tfdAp2BXydzPhetFcVyE13GF1ev6GT'; // read-only quote simulation wallet; no transaction is ever built

const TTL = { catalog: 120, detail: 180, title: 7 * 86400, tape: 600, quotes: 300, brief: 1800, wallet: 180, ask: 600, news: 900 };
// Panta rate limits (docs): read 120/60s, positions 60/60s, quote 30/60s — the caches above and the refresh budget in getPulse keep a cold board under them.


const LLMS_TXT = `# OddsMind
> A research desk over Panta prediction markets (USDC markets on Solana). Live odds, trade flow, fill depth, wallets and AI briefs — as pages and as JSON. Powered by Panta.

## JSON API (no key; CORS open; cached briefly)
- {ORIGIN}/api/pulse — every market enriched (title, implied YES/NO + priceSource, trades, 24h volume, wallets, concentration, status)
- {ORIGIN}/api/markets?category=&phase=&q= — filtered subset
- {ORIGIN}/api/market/{marketId} — detail, price series, holders, live fill depth, last trades
- {ORIGIN}/api/market/{marketId}/brief — AI analyst brief (headline, read, flow, context + sources, catalysts, risks, confidence)
- {ORIGIN}/api/market/{marketId}/depth — fill ladder from Panta quotes (read-only)
- {ORIGIN}/api/wallet/{address}?ai=1 — positions with value/claimable, trade history, trader profile
- {ORIGIN}/api/ask?q=… — natural-language question → relevant markets + answer
- {ORIGIN}/api/digest — today's AI digest of the whole catalog
- {ORIGIN}/embed/{marketId} — embeddable live market card (iframe)

## Notes
- Prices state their source: Panta spot when available, else last trade on the tape, else "no price data". Nothing is simulated.
- AI output is a research summary, not financial advice. Data © Panta (https://panta.market), via the Panta API (https://docs.panta.market).
- Source: https://github.com/zxreigns/oddsmind
`;

// ---------- small utils ----------
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': status === 200 ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' : 'no-store', ...extra }
});
const html = (body, status = 200, extra = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const isPubkey = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
const nowSec = () => Math.floor(Date.now() / 1000);

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- config (keys) ----------
const memCfg = { t: 0, v: null };
async function getConfig(env) {
  if (memCfg.v && Date.now() - memCfg.t < 60000) return memCfg.v;
  let cfg = {};
  if (env.CACHE) {
    try { cfg = (await env.CACHE.get('cfg:v1', 'json')) || {}; } catch (e) { cfg = {}; }
  }
  const v = {
    pantaKey: env.PANTA_API_KEY || cfg.panta_key || null,
    geminiKey: env.GEMINI_API_KEY || cfg.gemini_key || null,
    geminiModel: env.GEMINI_MODEL || cfg.gemini_model || 'gemini-3.5-flash-lite',
    groqKey: env.GROQ_API_KEY || cfg.groq_key || null,
    groqModel: env.GROQ_MODEL || cfg.groq_model || 'openai/gpt-oss-120b',
  };
  memCfg.v = v; memCfg.t = Date.now();
  return v;
}

// ---------- cache (KV + isolate memory, stale-while-revalidate) ----------
const mem = new Map();
async function cached(env, ctx, key, ttl, fn, { swr = true, budget = null } = {}) {
  const now = Date.now();
  const m = mem.get(key);
  if (m && m.exp > now) return m.val;
  let kv = null;
  if (env.CACHE) { try { kv = await env.CACHE.get('c:' + key, 'json'); } catch (e) { kv = null; } }
  if (kv && kv.exp > now) { mem.set(key, kv); return kv.val; }
  const refresh = async () => {
    const val = await fn();
    const rec = { val, exp: Date.now() + ttl * 1000, at: Date.now() };
    mem.set(key, rec);
    if (env.CACHE) { try { await env.CACHE.put('c:' + key, JSON.stringify(rec), { expirationTtl: Math.max(60, ttl * 4) }); } catch (e) {} }
    return val;
  };
  if (kv && swr) { // stale copy exists: serve it, refresh in background (within the caller's refresh budget, if any)
    if (budget && budget.n <= 0) return kv.val;
    if (budget) budget.n--;
    if (ctx && ctx.waitUntil) ctx.waitUntil(refresh().catch(() => {}));
    return kv.val;
  }
  if (kv && budget && budget.n <= 0) return kv.val; // out of budget: stale beats a burst of upstream calls
  return refresh();
}

// ---------- Panta API client ----------
class PantaError extends Error { constructor(status, body) { super(`panta ${status}`); this.status = status; this.body = body; } }
async function panta(env, path, { method = 'GET', body, timeoutMs = 15000, retries = 1, retryOn400 = false } = {}) {
  const cfg = await getConfig(env);
  if (!cfg.pantaKey) throw new PantaError(503, { code: 'NO_API_KEY', message: 'Panta API key not configured' });
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(PANTA + path, {
        method, signal: ac.signal,
        headers: { 'X-Api-Key': cfg.pantaKey, 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'OddsMind/' + VERSION },
        body: body ? JSON.stringify(body) : undefined,
      });
      clearTimeout(t);
      const text = await r.text();
      let data = null; try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 200) }; }
      // Panta's indexer-backed routes (positions, quotes) intermittently answer 400 INVALID_MARKET_PARAMS for valid input; treat as transient when asked to.
      if (r.status === 429 || r.status >= 500 || (retryOn400 && r.status === 400 && data && data.code === 'INVALID_MARKET_PARAMS' && i < retries)) { lastErr = new PantaError(r.status, data); const ra = Math.min(4000, (parseFloat(r.headers.get('retry-after')) || 0) * 1000); await new Promise((res) => setTimeout(res, ra || 500 * (i + 1))); continue; }
      if (!r.ok) throw new PantaError(r.status, data);
      return data;
    } catch (e) {
      clearTimeout(t);
      if (e instanceof PantaError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new PantaError(502, { code: 'UPSTREAM', message: 'Panta API unreachable' });
}

// full catalog (all pages)
async function fetchCatalog(env) {
  const items = []; let cursor = null;
  for (let i = 0; i < 20; i++) {
    const data = await panta(env, `/markets/?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...(data.items || []));
    cursor = data.nextCursor; if (!cursor) break;
  }
  return items;
}
const getCatalog = (env, ctx) => cached(env, ctx, 'catalog', TTL.catalog, () => fetchCatalog(env));

// title resolver: the public catalog leaves `title` empty for markets created in the Panta app.
// Fallback: the market's own public page on panta.market carries the question as og:title.
async function resolveTitle(env, ctx, id, apiTitle) {
  if (apiTitle && apiTitle.trim()) return { title: apiTitle.replace(/[\u2060\u200b\u200c\u200d\ufeff]/g, '').trim(), source: 'api' };
  if (env.TITLES_SEED && env.TITLES_SEED[id]) return { title: env.TITLES_SEED[id], source: 'panta.market page (seeded)' };
  return cached(env, ctx, 'title:' + id, TTL.title, async () => {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(`${PANTA_APP}/market/${id}`, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 OddsMind/' + VERSION, accept: 'text/html' } });
      clearTimeout(t);
      const h = await r.text();
      const m = h.match(/property="og:image:alt"\s+content="([^"]+)"/) || h.match(/<title>([^<]+?)\s*\|\s*Panta Market<\/title>/) || h.match(/"og:title","content":"([^"]+?)(?: \| Panta Market)?"/);
      let title = m ? decodeEntities(m[1]).replace(/\s*\|\s*Panta Market\s*$/, '').replace(/[\u2060\u200b\u200c\u200d\ufeff]/g, '').trim() : '';
      if (!title || /^panta\.market/i.test(title)) return { title: '', source: 'none' };
      return { title, source: 'panta.market page' };
    } catch (e) { return { title: '', source: 'none' }; }
  }, { swr: false });
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/\u2060/g, '');
}

// trade tape → stats
function tapeStats(items) {
  const trades = (items || []).slice().sort((a, b) => a.blockTime - b.blockTime);
  const pts = []; let vol = 0, vol24 = 0, n24 = 0; const wallets = new Map();
  const cutoff = nowSec() - 86400;
  let yesShares = 0, noShares = 0;
  for (const t of trades) {
    const shares = num(t.shares) || 0; const amt = num(t.amountUsdc);
    const side = (t.side || '').toLowerCase();
    if (side === 'yes') yesShares += shares; else if (side === 'no') noShares += shares;
    let pYes = null;
    if (amt !== null && shares > 0) { const p = amt / shares; pYes = side === 'yes' ? p : 1 - p; if (pYes > 0 && pYes < 1) pts.push({ t: t.blockTime, p: +pYes.toFixed(4), side, usdc: amt, shares, wallet: t.wallet, primary: !!t.isPrimary }); }
    if (amt !== null) { vol += amt; if (t.blockTime >= cutoff) { vol24 += amt; } }
    if (t.blockTime >= cutoff) n24++;
    const w = wallets.get(t.wallet) || { wallet: t.wallet, trades: 0, shares: 0, usdc: 0, yes: 0, no: 0 };
    w.trades++; w.shares += shares; if (amt !== null) w.usdc += amt; if (side === 'yes') w.yes += shares; else w.no += shares;
    wallets.set(t.wallet, w);
  }
  const last = pts.length ? pts[pts.length - 1] : null;
  const first = pts.length ? pts[0] : null;
  const dayAgo = pts.filter((p) => p.t <= cutoff).pop() || first;
  const holders = [...wallets.values()].sort((a, b) => b.shares - a.shares);
  const totalShares = yesShares + noShares;
  return {
    trades: trades.length, trades24h: n24, uniqueWallets: wallets.size,
    volumeUsdc: +vol.toFixed(2), volume24hUsdc: +vol24.toFixed(2), pricedTrades: pts.length,
    yesShares: +yesShares.toFixed(2), noShares: +noShares.toFixed(2),
    yesShareOfFlow: totalShares ? +(yesShares / totalShares).toFixed(4) : null,
    lastPriceYes: last ? last.p : null, lastTradeAt: trades.length ? trades[trades.length - 1].blockTime : null, firstTradeAt: trades.length ? trades[0].blockTime : null,
    change24h: last && dayAgo && dayAgo !== last ? +(last.p - dayAgo.p).toFixed(4) : null,
    topHolderShare: totalShares && holders.length ? +(holders[0].shares / totalShares).toFixed(4) : null,
    top3Share: totalShares && holders.length ? +(holders.slice(0, 3).reduce((s, w) => s + w.shares, 0) / totalShares).toFixed(4) : null,
    series: pts.map(({ t, p, side, usdc }) => ({ t, p, side, usdc })),
    holders: holders.slice(0, 10).map((w) => ({ ...w, shares: +w.shares.toFixed(2), usdc: +w.usdc.toFixed(2), yes: +w.yes.toFixed(2), no: +w.no.toFixed(2) })),
  };
}
const getTape = (env, ctx, id, budget = null) => cached(env, ctx, 'tape:' + id, TTL.tape, async () => (await panta(env, `/markets/${id}/trades/?limit=200`)).items || [], { budget });

// depth ladder: read-only quote simulations (POST /primaryorderquote/ opens a quote session; no transaction is built or signed)
async function depthLadder(env, ctx, id) {
  return cached(env, ctx, 'quotes:' + id, TTL.quotes, async () => {
    const out = [];
    await Promise.all(['yes', 'no'].flatMap((side) => QUOTE_LADDER.map(async (amt) => {
      try {
        const q = await panta(env, '/primaryorderquote/', { method: 'POST', body: { wallet: QUOTE_WALLET, marketId: id, side, amountUsdc: amt + '.00', userId: 'oddsmind' }, retries: 2, retryOn400: true, timeoutMs: 12000 });
        out.push({ side, amountUsdc: +amt, shares: num(q.shares), avgPrice: num(q.avgPrice), feeUsdc: num(q.feeUsdc), expiresAt: q.expiresAt });
      } catch (e) { out.push({ side, amountUsdc: +amt, error: (e.body && e.body.code) || 'unavailable' }); }
    })));
    out.sort((a, b) => (a.side === b.side ? a.amountUsdc - b.amountUsdc : a.side === 'yes' ? -1 : 1));
    return out;
  }, { swr: false });
}

// outcome of a resolved market: the catalog has no outcome field, but GET /positions/ reports `outcome` per holding —
// so we read it from the top holders' positions (cached a week).
async function resolvedOutcome(env, ctx, id, holders) {
  return cached(env, ctx, 'outcome:' + id, 7 * 86400, async () => {
    for (const hld of (holders || []).slice(0, 3)) {
      try {
        const pos = await panta(env, `/positions/?wallet=${hld.wallet}`, { timeoutMs: 20000, retries: 2, retryOn400: true });
        const row = (pos.positions || []).find((p) => p.marketId === id && p.outcome);
        if (row) return { outcome: String(row.outcome).toLowerCase(), via: `positions of ${hld.wallet.slice(0, 4)}…${hld.wallet.slice(-4)}`, phase: row.phase || null };
      } catch (e) {}
    }
    return { outcome: null, via: null };
  }, { swr: false });
}

function derivePrice(detail, stats) {
  const y = num(detail.yesPrice) ?? num(detail.primaryYesPrice) ?? num(detail.secondaryYesPrice);
  if (y !== null && y > 0 && y < 1) return { yes: y, source: 'spot (Panta API)' };
  if (stats && stats.lastPriceYes !== null) return { yes: stats.lastPriceYes, source: 'last trade (Panta trade tape)' };
  return { yes: null, source: 'no price data' };
}

function summarizeMarket(m, title, stats, price) {
  const now = nowSec();
  return {
    marketId: m.marketId, title: title.title || '', titleSource: title.source, category: m.category, image: (m.images || [])[0] || null,
    phase: m.phase, status: m.status, marketType: m.marketType, resolved: !!m.resolved, region: m.region,
    startTime: m.startTime, endTime: m.endTime, resolutionTime: m.resolutionTime,
    secondsToEnd: m.endTime ? m.endTime - now : null, tradable: m.phase === 'primary' && !m.resolved && (!m.endTime || m.endTime > now),
    volumeUsdc: num(m.volumeUsdc) ?? num(m.totalVolumeUsdc) ?? (stats ? stats.volumeUsdc : null),
    yesPrice: price.yes, noPrice: price.yes !== null ? +(1 - price.yes).toFixed(4) : null, priceSource: price.source,
    oracle: m.oracle || null, creatorAddress: m.creatorAddress || null, createdByPartner: !!m.createdByPartner,
    stats: stats ? { trades: stats.trades, trades24h: stats.trades24h, uniqueWallets: stats.uniqueWallets, pricedVolumeUsdc: stats.volumeUsdc, pricedVolume24hUsdc: stats.volume24hUsdc, pricedTrades: stats.pricedTrades, change24h: stats.change24h, lastTradeAt: stats.lastTradeAt, yesShareOfFlow: stats.yesShareOfFlow, topHolderShare: stats.topHolderShare } : null,
    links: { panta: `${PANTA_APP}/market/${m.marketId}`, oddsmind: `/m/${m.marketId}` },
  };
}

// enriched catalog row (title + tape stats), cached per market
async function enrichRow(env, ctx, m, { tape = true, budget = null } = {}) {
  const live = m.phase === 'primary' && !m.resolved;
  const [title, tapeItems, detail] = await Promise.all([
    resolveTitle(env, ctx, m.marketId, m.title),
    tape ? getTape(env, ctx, m.marketId, budget).catch(() => null) : Promise.resolve(null),
    // list rows leave spot prices null; for the few live markets the detail row carries them
    live ? cached(env, ctx, 'detail:' + m.marketId, TTL.detail, () => panta(env, `/markets/${m.marketId}/`)).catch(() => null) : Promise.resolve(null),
  ]);
  if (detail) m = { ...m, ...Object.fromEntries(Object.entries(detail).filter(([k, v]) => v !== null && v !== undefined && v !== '')) };
  const stats = tapeItems ? tapeStats(tapeItems) : null;
  const row = summarizeMarket(m, title, stats, derivePrice(m, stats));
  row.walletList = tapeItems ? [...new Set(tapeItems.map((t) => t.wallet))] : [];
  return row;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// pulse = the whole catalog, enriched (time-budgeted; rows past the budget come back with stats: null and pending: true)
async function getPulse(env, ctx, { budgetMs = 20000 } = {}) {
  const catalog = await getCatalog(env, ctx);
  const started = Date.now();
  const budget = { n: 40 }; // at most 40 stale-tape refreshes per pulse call (Panta read limit is 120/min)
  const rows = await mapLimit(catalog, 6, async (m) => {
    if (Date.now() - started > budgetMs) { const t = await resolveTitle(env, ctx, m.marketId, m.title); return { ...summarizeMarket(m, t, null, derivePrice(m, null)), pending: true }; }
    return enrichRow(env, ctx, m, { tape: true, budget });
  });
  const now = nowSec();
  const tradable = rows.filter((r) => r.tradable);
  const active = rows.filter((r) => r.stats && r.stats.trades24h > 0);
  const byCat = {}; for (const r of rows) byCat[r.category] = (byCat[r.category] || 0) + 1;
  const wallets = new Set(); for (const r of rows) { for (const x of r.walletList || []) wallets.add(x); delete r.walletList; }
  return {
    generatedAt: now, count: rows.length, tradable: tradable.length, activeLast24h: active.length, uniqueWallets: wallets.size,
    pricedVolume24hUsdc: +rows.reduce((s, r) => s + ((r.stats && r.stats.pricedVolume24hUsdc) || 0), 0).toFixed(2),
    trades24h: rows.reduce((s, r) => s + ((r.stats && r.stats.trades24h) || 0), 0),
    categories: byCat, pending: rows.filter((r) => r.pending).length,
    markets: rows,
  };
}

// ---------- LLM layer (Gemini first, Groq as fallback; keys live in KV, never in code) ----------
async function llm(env, { system, user, temperature = 0.4, maxTokens = 2048 }) {
  const cfg = await getConfig(env);
  const errors = [];
  if (cfg.geminiKey) {
    for (const model of [cfg.geminiModel, cfg.geminiModel === 'gemini-3.5-flash-lite' ? 'gemini-flash-lite-latest' : 'gemini-3.5-flash-lite']) {
      try { return await geminiCall(cfg.geminiKey, model, { system, user, temperature, maxTokens }); } catch (e) { errors.push(`${model}: ${String(e.message || e).slice(0, 120)}`); }
    }
  }
  if (cfg.groqKey) {
    for (const model of [...new Set([cfg.groqModel, 'qwen/qwen3.8-27b'])]) {
      try { return await groqCall(cfg.groqKey, model, { system, user, temperature, maxTokens }); } catch (e) { errors.push(`groq ${model}: ${String(e.message || e).slice(0, 120)}`); }
    }
  }
  throw new Error(errors.length ? errors.join(' | ') : 'LLM not configured');
}
async function geminiCall(key, model, { system, user, temperature, maxTokens }) {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } },
  };
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 50000);
  let r;
  try { r = await fetch(`${GEMINI}/models/${model}:generateContent?key=${key}`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  finally { clearTimeout(t); }
  const data = await r.json();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ((data.error && data.error.message) || '').slice(0, 120));
  const cand = (data.candidates || [])[0] || {};
  const text = (cand.content && cand.content.parts || []).map((p) => p.text || '').join('');
  if (!text) throw new Error('empty answer (' + (cand.finishReason || 'no candidate') + ')');
  return { text, model, usage: data.usageMetadata || null };
}
async function groqCall(key, model, { system, user, temperature, maxTokens }) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 40000);
  let r;
  try { r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: model || 'openai/gpt-oss-120b', temperature, max_completion_tokens: Math.max(1500, maxTokens), ...(/gpt-oss/.test(model || 'openai/gpt-oss-120b') ? { reasoning_effort: 'low' } : {}), response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) }); }
  finally { clearTimeout(t); }
  const data = await r.json();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ((data.error && data.error.message) || '').slice(0, 120));
  const text = (((data.choices || [])[0] || {}).message || {}).content || '';
  if (!text) throw new Error('empty answer');
  return { text, model: model || 'openai/gpt-oss-120b', usage: data.usage || null };
}

// news context: Google News RSS for the market's question (no key needed), cached
function newsQuery(title) {
  let q = (title || '').replace(/[\u2060\u200b\u200c\u200d\ufeff]/g, '').trim().replace(/^will\s+/i, '').replace(/[?\s]+$/, '').replace(/[“”"]/g, '');
  q = q.replace(/\s+(by|before|on|at|until|from now|in the next|during|through)\s+(the\s+)?(end of\s+)?([a-z]+\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{0,4}|\d{1,2}(:\d{2})?\s*(am|pm)?.*|\w+day.*|next.*|\d+\s*(hour|day|week|month)s?.*)$/i, '');
  q = q.replace(/\b(close|closes|closing|exceed|exceeds|reach|reaches|hit|hits|drop|drops|cross|crosses|above|below|at or above|at or below|more than|less than|over|under)\b.*$/i, (m) => m.split(' ').slice(0, 1).join(' '));
  return q.split(/\s+/).filter(Boolean).slice(0, 9).join(' ').trim() || title;
}
async function fetchNews(env, ctx, title) {
  const q = newsQuery(title); if (!q) return { query: '', items: [] };
  return cached(env, ctx, 'news:' + (await sha256Hex(q.toLowerCase())).slice(0, 20), TTL.news, async () => {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
      const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 OddsMind/' + VERSION } });
      clearTimeout(t);
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((m) => { const b = m[1]; const g = (tag) => { const x = b.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`)); return x ? decodeEntities(x[1].trim()) : ''; }; return { title: g('title'), url: g('link'), date: g('pubDate'), source: g('source') }; }).filter((x) => x.title);
      return { query: q, items };
    } catch (e) { return { query: q, items: [] }; }
  });
}
function parseJsonLoose(text) {
  if (!text) return null;
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}
const fmtPct = (p) => (p === null || p === undefined ? 'n/a' : Math.round(p * 100) + '%');
const fmtWhen = (s) => (s ? new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'n/a');

const BRIEF_SYSTEM = `You are OddsMind, a sober research analyst for prediction markets on Panta (USDC markets on Solana). You write for a smart reader who wants to know what the market is pricing, why, and what could move it. Ground every number in the data given; never invent prices, volumes, dates or wallets — the deadline is exactly the tradingEnds/resolves given. Headlines are provided; use them for context and cite only the relevant ones. Be concrete and brief; no hype, no financial advice. Output strictly JSON with this shape:
{"headline": string (<=110 chars, the market's current read in plain words),
 "question": string (what exactly resolves YES, in one sentence, incl. the deadline),
 "market_read": string (2-3 sentences: implied probability, where it comes from, how much conviction the flow shows),
 "flow": string (1-3 sentences on trade activity, concentration, liquidity/depth, using the numbers),
 "context": string (2-4 sentences of real-world context from the headlines relevant to the question; if none are relevant, say so and name what you would watch),
 "what_moves_it": [string, string, string] (concrete catalysts or data releases),
 "risks": [string, string] (resolution/oracle/liquidity risks),
 "confidence": "low"|"medium"|"high" (how much the market's price should be trusted as a probability given liquidity),
 "sources": [{"title": string, "url": string}] (only headlines given to you that you actually used; else [])}`;

async function buildBrief(env, ctx, m) {
  return cached(env, ctx, 'brief:' + m.marketId, TTL.brief, async () => {
    const [depth, news] = await Promise.all([
      m.tradable ? depthLadder(env, ctx, m.marketId).catch(() => []) : Promise.resolve([]),
      fetchNews(env, ctx, m.title),
    ]);
    const data = {
      title: m.title, category: m.category, phase: m.phase, status: m.status, resolved: m.resolved, outcome: m.outcome && m.outcome.outcome || null,
      yesPrice: m.yesPrice, noPrice: m.noPrice, priceSource: m.priceSource,
      tradingEnds: fmtWhen(m.endTime), resolves: fmtWhen(m.resolutionTime), now: fmtWhen(nowSec()), oracle: m.oracle,
      volumeUsdc: m.volumeUsdc, volumeNote: 'volumeUsdc is Panta\'s figure for the market; stats.pricedVolumeUsdc counts only fills the tape prices (older fills carry no USDC amount)', stats: m.stats, depth: depth.filter((d) => !d.error).map((d) => ({ side: d.side, usdc: d.amountUsdc, avgPrice: d.avgPrice, feeUsdc: d.feeUsdc })),
      recentPricePoints: (m.series || []).slice(-12).map((p) => ({ when: fmtWhen(p.t), yesPrice: p.p, side: p.side, usdc: p.usdc })),
      topHolders: (m.holders || []).slice(0, 5).map((h) => ({ wallet: h.wallet.slice(0, 4) + '…' + h.wallet.slice(-4), trades: h.trades, yesShares: h.yes, noShares: h.no })),
      headlines: news.items.slice(0, 8),
    };
    const user = `Market data from the Panta API plus recent headlines from a news search for "${news.query}" (JSON):\n${JSON.stringify(data)}\n\nToday is ${fmtWhen(nowSec())}. Use only the headlines' titles/dates/URLs for context and only include a headline in sources if it is genuinely relevant. Write the brief as JSON only.`;
    const res = await llm(env, { system: BRIEF_SYSTEM, user });
    const parsed = parseJsonLoose(res.text);
    if (!parsed) throw new Error('brief unparseable');
    parsed.sources = (parsed.sources || []).filter((s) => s && s.url && /^https?:\/\//.test(s.url)).slice(0, 6);
    return { ...parsed, model: res.model, newsQuery: news.query, generatedAt: nowSec(), disclaimer: 'AI-written research summary over live Panta data and public headlines. Not financial advice.' };
  }, { swr: false });
}


// digest: an AI-written "today on Panta" over the enriched catalog, cached an hour
const DIGEST_SYSTEM = `You are OddsMind's desk editor. From the market data given (Panta prediction markets on Solana), write a short daily digest for traders and curious readers. Use only the numbers given; never invent. Plain words, no hype, no filler like 'tracks on Solana'; USDC amounts as $ figures. Output strictly JSON: {"headline": string (<=100 chars), "summary": string (2-3 sentences: what is live, where the activity is, what closes soon), "bullets": [string] (3-5 concrete items, each naming a market by a SHORT nickname (not the full question, e.g. "BBNaija female winner", "Brent above $104 on Oct 1") and a number, and saying why it matters: e.g. "BBNaija female winner: 52% YES on $45 of volume; a $250 order would move it 13 points, so the odds are soft"), "watch": [string] (up to 4 market ids from the data worth watching, most interesting first)}`;
async function buildDigest(env, ctx) {
  return cached(env, ctx, 'digest', 3600, async () => {
    const pulse = await getPulse(env, ctx, { budgetMs: 15000 });
    const now = nowSec();
    const rows = pulse.markets.filter((m) => m.title);
    const live = rows.filter((m) => m.tradable);
    const depth = {};
    await Promise.all(live.slice(0, 4).map(async (m) => { try { depth[m.marketId] = (await depthLadder(env, ctx, m.marketId)).filter((d) => !d.error).map((d) => ({ side: d.side, usdc: d.amountUsdc, avgPrice: d.avgPrice })); } catch (e) {} }));
    const pick = (m) => ({ id: m.marketId, title: m.title, category: m.category, yes: m.yesPrice, priceSource: m.priceSource, status: m.resolved ? 'resolved' : m.tradable ? 'live' : m.phase, ends: fmtWhen(m.endTime), trades: m.stats && m.stats.trades, trades24h: m.stats && m.stats.trades24h, volumeUsdc: m.volumeUsdc, pricedVolumeUsdc: m.stats && m.stats.pricedVolumeUsdc, wallets: m.stats && m.stats.uniqueWallets, topHolderShare: m.stats && m.stats.topHolderShare, depth: depth[m.marketId] });
    const data = {
      now: fmtWhen(now), totals: { markets: pulse.count, live: pulse.tradable, trades24h: pulse.trades24h, pricedVolume24hUsdc: pulse.pricedVolume24hUsdc, walletsOnTape: pulse.uniqueWallets, categories: pulse.categories },
      live: live.map(pick),
      closingWithin48h: rows.filter((m) => !m.resolved && m.endTime > now && m.endTime < now + 172800).map(pick),
      activeLast24h: rows.filter((m) => m.stats && m.stats.trades24h > 0 && !m.tradable).map(pick),
      mostTradedEver: rows.slice().sort((a, b) => ((b.stats && b.stats.trades) || 0) - ((a.stats && a.stats.trades) || 0)).slice(0, 5).map(pick),
      newestMarkets: rows.slice().sort((a, b) => b.startTime - a.startTime).slice(0, 5).map(pick),
    };
    const res = await llm(env, { system: DIGEST_SYSTEM, user: `Data (JSON): ${JSON.stringify(data)}\n\nWrite the digest as JSON only.`, temperature: 0.4 });
    const parsed = parseJsonLoose(res.text) || { headline: 'Panta today', summary: res.text, bullets: [], watch: [] };
    const byId = Object.fromEntries(rows.map((m) => [m.marketId, m]));
    parsed.watch = (parsed.watch || []).filter((id) => byId[id]).slice(0, 4).map((id) => ({ marketId: id, title: byId[id].title, yesPrice: byId[id].yesPrice, tradable: byId[id].tradable, category: byId[id].category }));
    return { ...parsed, model: res.model, generatedAt: now, basedOn: { markets: pulse.count, live: pulse.tradable } };
  }, { swr: true });
}

// ask: natural-language question → relevant markets → answer
const ASK_SYSTEM = `You are OddsMind. Given a user's question and a numbered list of live prediction markets (id, title, implied YES probability, phase, ends), pick the markets that actually answer the question (max 6) and answer in plain words with the odds. If nothing in the list is relevant, say so honestly and suggest what kind of market would answer it. Never invent markets or numbers. Output strictly JSON: {"answer": string (2-5 sentences, cite probabilities as percentages), "picks": [{"n": number, "why": string}], "no_match": boolean}`;
async function ask(env, ctx, q) {
  const key = 'ask:' + (await sha256Hex(q.toLowerCase().trim())).slice(0, 24);
  return cached(env, ctx, key, TTL.ask, async () => {
    const pulse = await getPulse(env, ctx, { budgetMs: 8000 });
    const list = pulse.markets.filter((m) => m.title).map((m, i) => ({ n: i + 1, id: m.marketId, title: m.title, yes: m.yesPrice, phase: m.phase, resolved: m.resolved, ends: fmtWhen(m.endTime), category: m.category }));
    const user = `Question: ${q}\n\nMarkets (JSON):\n${JSON.stringify(list.map(({ n, title, yes, phase, resolved, ends, category }) => ({ n, title, yes: fmtPct(yes), phase, resolved, ends, category })))}\n\nToday: ${fmtWhen(nowSec())}. Answer as JSON only.`;
    const res = await llm(env, { system: ASK_SYSTEM, user, temperature: 0.3 });
    const parsed = parseJsonLoose(res.text) || { answer: res.text, picks: [], no_match: true };
    const picks = (parsed.picks || []).map((p) => { const row = list[(p.n || 0) - 1]; const m = row && pulse.markets.find((x) => x.marketId === row.id); return m ? { ...m, why: p.why } : null; }).filter(Boolean);
    return { question: q, answer: parsed.answer, no_match: !!parsed.no_match, picks, model: res.model, generatedAt: nowSec(), marketsConsidered: list.length };
  }, { swr: false });
}

// wallet lens
async function walletLens(env, ctx, addr, { ai = false } = {}) {
  const base = await cached(env, ctx, 'wallet:' + addr, TTL.wallet, async () => {
    let positionsError = null;
    const [pos, tr] = await Promise.all([
      panta(env, `/positions/?wallet=${addr}`, { timeoutMs: 25000, retries: 3, retryOn400: true }).catch((e) => { positionsError = (e.body && e.body.code) || String(e.message || e).slice(0, 80); return { positions: [], summary: null }; }),
      panta(env, `/wallets/${addr}/trades/?limit=200`, { timeoutMs: 25000, retries: 2 }),
    ]);
    const trades = (tr.items || []).slice().sort((a, b) => b.blockTime - a.blockTime);
    const byMarket = new Map();
    for (const t of trades) { const k = t.marketId; const r = byMarket.get(k) || { marketId: k, trades: 0, usdc: 0, yes: 0, no: 0, first: t.blockTime, last: t.blockTime }; r.trades++; r.usdc += num(t.amountUsdc) || 0; if ((t.side || '').toLowerCase() === 'yes') r.yes += num(t.shares) || 0; else r.no += num(t.shares) || 0; r.first = Math.min(r.first, t.blockTime); r.last = Math.max(r.last, t.blockTime); byMarket.set(k, r); }
    const positions = (pos.positions || []).map((p) => ({ ...p, shares: num(p.shares), price: num(p.price), currentValueUsdc: num(p.currentValueUsdc) }));
    // titles for positions/markets we touched
    const ids = [...new Set([...positions.map((p) => p.marketId), ...byMarket.keys()])].slice(0, 40);
    const titles = {}; await mapLimit(ids, 6, async (id) => { const p = positions.find((x) => x.marketId === id); titles[id] = p && p.title ? p.title : (await resolveTitle(env, ctx, id, '')).title; });
    const yesTrades = trades.filter((t) => (t.side || '').toLowerCase() === 'yes').length;
    return {
      wallet: addr, summary: pos.summary || null, positionsError, positions: positions.map((p) => ({ ...p, title: p.title || titles[p.marketId] || '' })),
      claimable: positions.filter((p) => p.claimable).length,
      trades: trades.slice(0, 100), tradeCount: trades.length, marketsTraded: byMarket.size,
      yesBias: trades.length ? +(yesTrades / trades.length).toFixed(3) : null,
      firstTradeAt: trades.length ? trades[trades.length - 1].blockTime : null, lastTradeAt: trades.length ? trades[0].blockTime : null,
      spentUsdc: +trades.reduce((s, t) => s + (num(t.amountUsdc) || 0), 0).toFixed(2),
      perMarket: [...byMarket.values()].map((r) => ({ ...r, title: titles[r.marketId] || '', usdc: +r.usdc.toFixed(2), yes: +r.yes.toFixed(2), no: +r.no.toFixed(2) })).sort((a, b) => b.last - a.last),
      links: { panta: `${PANTA_APP}/profile/${addr}`, solscan: `https://solscan.io/account/${addr}` },
    };
  });
  if (!ai) return base;
  const profile = await cached(env, ctx, 'walletai:' + addr, TTL.brief, async () => {
    const user = `Wallet activity on Panta (JSON): ${JSON.stringify({ summary: base.summary, positions: base.positions.slice(0, 20).map((p) => ({ title: p.title, side: p.side, shares: p.shares, phase: p.phase, claimable: p.claimable, outcome: p.outcome, valueUsdc: p.currentValueUsdc })), tradeCount: base.tradeCount, marketsTraded: base.marketsTraded, yesBias: base.yesBias, spentUsdc: base.spentUsdc, first: fmtWhen(base.firstTradeAt), last: fmtWhen(base.lastTradeAt), perMarket: base.perMarket.slice(0, 15) })}\n\nDescribe this trader in JSON: {"style": string (2-3 sentences: what they trade, size, YES/NO lean, timing), "themes": [string], "notes": [string] (claimable winnings, concentration, anything actionable)}`;
    const res = await llm(env, { system: 'You are OddsMind, an analyst of prediction-market wallets. Use only the numbers given. JSON only.', user, temperature: 0.3 });
    return { ...(parseJsonLoose(res.text) || { style: res.text, themes: [], notes: [] }), model: res.model, generatedAt: nowSec() };
  }, { swr: false });
  return { ...base, ai: profile };
}

// ---------- pages (light SSR of OG tags over the static shells) ----------
async function shell(env, req, file, vars) {
  const url = new URL(req.url); url.pathname = '/shells/' + file; url.search = '';
  const r = await env.ASSETS.fetch(new Request(url.toString(), { headers: req.headers }));
  let body = await r.text();
  for (const [k, v] of Object.entries(vars)) body = body.split(`{{${k}}}`).join(esc(v));
  return html(body, 200, { 'cache-control': 'public, max-age=60' });
}

function embedHtml(m, origin) {
  const yes = m.yesPrice; const pct = yes === null ? null : Math.round(yes * 100);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.title || 'Panta market')} — OddsMind</title>
<style>:root{color-scheme:dark}body{margin:0;font:14px/1.4 Inter,system-ui,sans-serif;background:#0b1020;color:#e8ecf5}a{color:inherit;text-decoration:none}.card{padding:16px;border:1px solid #1f2a44;border-radius:14px;background:linear-gradient(180deg,#111a30,#0b1020);display:flex;flex-direction:column;gap:10px;min-height:calc(100vh - 34px)}.q{font-weight:600;font-size:15px}.row{display:flex;justify-content:space-between;align-items:center;gap:12px}.big{font-size:32px;font-weight:700;color:#5ef1c2}.bar{height:8px;border-radius:4px;background:#2a1a2e;overflow:hidden}.bar i{display:block;height:100%;background:#5ef1c2;width:${pct ?? 0}%}.meta{color:#9aa7c7;font-size:12px}.pb{font-size:11px;color:#9aa7c7;display:flex;justify-content:space-between}.pb b{color:#e8ecf5}</style></head>
<body><a class="card" href="${origin}/m/${m.marketId}" target="_blank" rel="noopener"><div class="q">${esc(m.title || m.marketId)}</div>
<div class="row"><div class="big">${pct === null ? '—' : pct + '%'}<span class="meta"> YES</span></div><div class="meta">${m.tradable ? 'trading now' : esc(m.status)} · ${esc(m.category || '')}</div></div>
<div class="bar"><i></i></div><div class="meta">${m.stats ? `${m.stats.trades} trades · ${m.stats.uniqueWallets} wallets` : ''}${m.endTime ? ` · ends ${esc(fmtWhen(m.endTime))}` : ''}</div>
<div class="pb"><span>OddsMind</span><b>Powered by Panta</b></div></a></body></html>`;
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });

      // admin bootstrap (keys into KV; never in code)
      if (p === '/admin/config' && req.method === 'POST') {
        const adminHash = env.ADMIN_TOKEN_SHA256 || '';
        if (adminHash.length !== 64) return json({ error: 'admin disabled' }, 404);
        const tok = req.headers.get('x-admin-token') || '';
        if (!tok || (await sha256Hex(tok)) !== adminHash) return json({ error: 'forbidden' }, 403);
        if (!env.CACHE) return json({ error: 'no KV binding' }, 500);
        const body = await req.json();
        const cur = (await env.CACHE.get('cfg:v1', 'json')) || {};
        const next = { ...cur }; for (const k of ['panta_key', 'gemini_key', 'gemini_model', 'groq_key', 'groq_model']) if (body[k]) next[k] = body[k];
        await env.CACHE.put('cfg:v1', JSON.stringify(next)); memCfg.v = null;
        return json({ ok: true, configured: { panta: !!next.panta_key, gemini: !!next.gemini_key, groq: !!next.groq_key, model: next.gemini_model || 'gemini-3.5-flash-lite' } });
      }
      if (p === '/admin/purge' && req.method === 'POST') {
        const adminHash = env.ADMIN_TOKEN_SHA256 || '';
        const tok = req.headers.get('x-admin-token') || '';
        if (adminHash.length !== 64 || !tok || (await sha256Hex(tok)) !== adminHash) return json({ error: 'forbidden' }, 403);
        mem.clear(); const prefix = url.searchParams.get('prefix') || 'c:'; let n = 0;
        if (env.CACHE && env.CACHE.list) { let cursor; do { const l = await env.CACHE.list({ prefix, cursor }); for (const k of l.keys) { await env.CACHE.delete(k.name); n++; } cursor = l.list_complete ? null : l.cursor; } while (cursor); }
        return json({ ok: true, deleted: n });
      }

      // API
      if (p === '/api/health') { const cfg = await getConfig(env); return json({ ok: true, version: VERSION, panta: !!cfg.pantaKey, llm: !!(cfg.geminiKey || cfg.groqKey), model: cfg.geminiModel, fallback: cfg.groqKey ? cfg.groqModel : null, cache: env.CACHE ? (env.CACHE.kind || 'store') : 'none', poweredBy: 'Panta' }); }
      if (p === '/api/pulse') { const budget = Math.min(25000, +(url.searchParams.get('budget') || 20000)); return json(await getPulse(env, ctx, { budgetMs: budget })); }
      if (p === '/api/markets') {
        const cat = url.searchParams.get('category'); const phase = url.searchParams.get('phase'); const q = (url.searchParams.get('q') || '').toLowerCase();
        const pulse = await getPulse(env, ctx, { budgetMs: 15000 });
        let rows = pulse.markets; if (cat) rows = rows.filter((r) => r.category === cat); if (phase) rows = rows.filter((r) => r.phase === phase); if (q) rows = rows.filter((r) => (r.title || '').toLowerCase().includes(q) || r.marketId.toLowerCase().includes(q));
        return json({ count: rows.length, generatedAt: pulse.generatedAt, markets: rows });
      }
      let mm;
      if ((mm = p.match(/^\/api\/market\/([1-9A-HJ-NP-Za-km-z]{32,44})(\/brief|\/depth|\/tape)?$/))) {
        const id = mm[1]; const sub = mm[2] || '';
        const detail = await cached(env, ctx, 'detail:' + id, TTL.detail, () => panta(env, `/markets/${id}/`));
        const tapeItems = await getTape(env, ctx, id).catch(() => []);
        const stats = tapeStats(tapeItems);
        const title = await resolveTitle(env, ctx, id, detail.title);
        const m = { ...summarizeMarket(detail, title, stats, derivePrice(detail, stats)), series: stats.series, holders: stats.holders, detail: { creationFee: detail.creationFee, primaryVolume: detail.primaryVolume, secondaryVolume: detail.secondaryVolume, tradingFeeAccrued: detail.tradingFeeAccrued, isGraduated: detail.isGraduated, graduationFailureReason: detail.graduationFailureReason, quoteAsset: detail.quoteAsset, programId: detail.programId, transactionHash: detail.transactionHash, sentToUma: detail.sentToUma, description: detail.description || '' } };
        if (m.resolved || detail.phase === 'resolved') { const o = await resolvedOutcome(env, ctx, id, stats.holders).catch(() => null); if (o) m.outcome = o; }
        if (sub === '/tape') return json({ marketId: id, trades: tapeItems });
        if (sub === '/depth') return json({ marketId: id, tradable: m.tradable, depth: m.tradable ? await depthLadder(env, ctx, id) : [], note: 'Read-only quote simulations from POST /primaryorderquote/; no transaction is built.' });
        if (sub === '/brief') { try { return json({ marketId: id, brief: await buildBrief(env, ctx, m) }); } catch (e) { return json({ marketId: id, brief: null, error: String(e.message || e).slice(0, 200) }, 200); } }
        const depth = m.tradable ? await depthLadder(env, ctx, id).catch(() => []) : [];
        return json({ ...m, depth, tape: tapeItems.slice().sort((a, b) => b.blockTime - a.blockTime).slice(0, 60) });
      }
      if ((mm = p.match(/^\/api\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) { return json(await walletLens(env, ctx, mm[1], { ai: url.searchParams.get('ai') === '1' })); }
      if (p === '/api/ask') {
        let q = url.searchParams.get('q') || '';
        if (req.method === 'POST') { try { q = ((await req.json()).q || q); } catch (e) {} }
        q = q.trim().slice(0, 300); if (q.length < 3) return json({ error: 'ask a question' }, 400);
        return json(await ask(env, ctx, q));
      }
      if (p === '/api/digest') { try { return json(await buildDigest(env, ctx)); } catch (e) { return json({ error: 'digest unavailable', detail: String(e.message || e).slice(0, 200) }, 200); } }
      if (p === '/llms.txt') return new Response(LLMS_TXT.replace(/\{ORIGIN\}/g, url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      if (p === '/api/categories') return json(await cached(env, ctx, 'categories', 3600, () => panta(env, '/categories/')));
      if (p.startsWith('/api/')) return json({ error: 'not found', docs: '/api' }, 404);

      // pages
      if ((mm = p.match(/^\/m\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
        const id = mm[1]; let title = ''; let desc = 'Market brief — odds, flow, depth and an AI read. Powered by Panta.'; let img = '';
        try { const cat = await getCatalog(env, ctx); const row = cat.find((x) => x.marketId === id); const t = await resolveTitle(env, ctx, id, row ? row.title : ''); title = t.title; img = row && row.images && row.images[0] || ''; } catch (e) {}
        return shell(env, req, 'market.html', { TITLE: title ? `${title} — OddsMind` : 'Market brief — OddsMind', DESC: desc, IMAGE: img || `${url.origin}/assets/og.png`, URL: url.origin + p, MARKET_ID: id });
      }
      if ((mm = p.match(/^\/w\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) return shell(env, req, 'wallet.html', { TITLE: `Wallet ${mm[1].slice(0, 4)}…${mm[1].slice(-4)} — OddsMind`, DESC: 'Positions, claimable winnings and trading style on Panta.', IMAGE: `${url.origin}/assets/og.png`, URL: url.origin + p, WALLET: mm[1] });
      if ((mm = p.match(/^\/embed\/([1-9A-HJ-NP-Za-km-z]{32,44})$/))) {
        const id = mm[1]; const detail = await cached(env, ctx, 'detail:' + id, TTL.detail, () => panta(env, `/markets/${id}/`)); const tapeItems = await getTape(env, ctx, id).catch(() => []); const stats = tapeStats(tapeItems); const title = await resolveTitle(env, ctx, id, detail.title);
        return html(embedHtml(summarizeMarket(detail, title, stats, derivePrice(detail, stats)), url.origin), 200, { 'cache-control': 'public, max-age=120' });
      }
      if (p === '/ask') return shell(env, req, 'ask.html', { TITLE: 'Ask the markets — OddsMind', DESC: 'Ask a question in plain words; OddsMind finds the Panta markets that answer it.', IMAGE: `${url.origin}/assets/og.png`, URL: url.origin + p, Q: url.searchParams.get('q') || '' });
      if (p === '/wallet') return shell(env, req, 'wallet.html', { TITLE: 'Wallet lens — OddsMind', DESC: 'Positions, claimable winnings and trading style on Panta.', IMAGE: `${url.origin}/assets/og.png`, URL: url.origin + p, WALLET: '' });
      if (p === '/api') return shell(env, req, 'api.html', { TITLE: 'OddsMind API', DESC: 'JSON endpoints for agents and builders.', IMAGE: `${url.origin}/assets/og.png`, URL: url.origin + p });
      if (p === '/about') return shell(env, req, 'about.html', { TITLE: 'About OddsMind', DESC: 'How OddsMind uses the Panta API.', IMAGE: `${url.origin}/assets/og.png`, URL: url.origin + p });
      if (p === '/') return shell(env, req, 'index.html', { TITLE: 'OddsMind — what do the markets think?', DESC: 'A research desk over Panta prediction markets on Solana: live odds, flow, depth, wallets and AI briefs.', IMAGE: `${url.origin}/assets/og.png`, URL: url.origin + '/' });
      const asset = await env.ASSETS.fetch(req);
      if (asset.status !== 404) return asset;
      const nf = await env.ASSETS.fetch(new Request(new URL('/shells/404.html', url.origin).toString()));
      return html(await nf.text(), 404);
    } catch (e) {
      const status = e instanceof PantaError ? (e.status === 404 ? 404 : 502) : 500;
      return json({ error: e instanceof PantaError ? `Panta API ${e.status}` : 'internal error', detail: (e.body && (e.body.code || e.body.message)) || String(e.message || e).slice(0, 200) }, status);
    }
  },
};
