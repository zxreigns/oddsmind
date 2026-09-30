# OddsMind — what do the markets think?

**A research desk over [Panta](https://panta.market) prediction markets on Solana.** Live odds, order flow, fill depth, wallets — and an AI analyst that explains what the price is saying, why, and what could move it. Every view is also a JSON endpoint, so agents and bots can use market intelligence too.

**Live:** https://oddsmind.vercel.app · **API docs:** https://oddsmind.vercel.app/api · Built for the Colosseum Crypto World's Fair 2026 — Panta API sidetrack.

> Prediction markets are usually a destination. OddsMind treats them as a **data source**: the crowd's live probability, plus the context to judge how much to trust it.

---

## What it does

| Surface | What you get | Panta API behind it |
|---|---|---|
| **Pulse** (`/`) | Every USDC market in the catalog, enriched with its trade tape: implied YES/NO, 24h trades and volume, unique wallets, holder concentration, status, category filters, live-now cards with a $50 fill quote. | `GET /markets/` (cursor-paginated), `GET /markets/{id}/trades/` per market, `POST /primaryorderquote/` |
| **Market brief** (`/m/{id}`) | Live odds and their source, a price curve reconstructed from fills, a **fill-depth ladder** quoted live from the bonding curve ($10 / $50 / $250, YES and NO, with slippage and fees), top holders, resolution details, on-chain links, and the **AI brief**: headline, market read, flow & liquidity, real-world context with sources, catalysts, risks, and a confidence grade. Resolved markets show their outcome. | `GET /markets/{id}/`, `GET /markets/{id}/trades/`, `POST /primaryorderquote/`, `GET /positions/?wallet=` (outcome) |
| **Ask** (`/ask`) | A plain-words question → the markets that actually answer it → an answer quoting the crowd's odds. | pulse (catalog + tapes) |
| **Wallet lens** (`/w/{wallet}`) | Positions with current value, claimable winnings, outcomes; trade history, per-market activity, YES/NO bias; optional AI trader profile. | `GET /positions/?wallet=`, `GET /wallets/{wallet}/trades/` |
| **Embed** (`/embed/{id}`) | A live market card for any website (iframe), with **Powered by Panta**. | detail + tape |
| **API** (`/api/*`) | JSON for all of the above, CORS open, cached. | everything above |

Nothing here places trades or holds keys. The "Trade on Panta" button opens the market on panta.market. Quote sessions are read-only simulations — no transaction is built or signed.

## How the Panta API is used (integration depth)

- **Discovery** — the whole catalog through `GET /markets/?limit=100&cursor=…`, following `nextCursor`; `GET /categories/` for filters.
- **Market data** — `GET /markets/{id}/` for phase, spot prices, oracle, creator, timings, program id and creation signature.
- **Trade tape → analytics** — `GET /markets/{id}/trades/` (up to 200 rows) is turned into: a price series (each fill's `amountUsdc ÷ shares`; NO fills plotted as `1 − price`), 24h activity, YES share of flow, unique wallets, top-holder and top-3 concentration, last trade time, 24h change.
- **Liquidity** — `POST /primaryorderquote/` for both sides at three sizes gives a real fill ladder; the difference between the $10 and $250 average fill is shown as slippage, and the fee ratio is read from `feeUsdc`.
- **Positions & outcomes** — `GET /positions/?wallet=` gives holdings with valuation (`price`, `priceSource`, `currentValueUsdc`), claim eligibility and `outcome`. OddsMind also uses it to recover the **outcome of resolved markets** (the catalog has no outcome field) by reading the top holders' positions.
- **Wallet history** — `GET /wallets/{wallet}/trades/` for per-market activity and trader style.
- **Price provenance** — every response states `priceSource`: `spot (Panta API)` when the detail row carries a price, else `last trade (Panta trade tape)`, else `no price data`. Nothing is simulated.
- **Title provenance** — catalog rows for markets created inside the Panta app currently return an empty `title`. OddsMind resolves those from the market's public page on panta.market (`og:image:alt` / `<title>`) and caches them for a week; every response says `titleSource`.

## Architecture

```
browser ── /, /m/:id, /w/:addr, /ask …   static shells (public/, plain HTML/CSS/JS, no framework)
        ── /api/*  ───► src/app.js — one portable Web-standard handler: export default { fetch(request, env, ctx) }
                           ├─ Panta client (timeouts, retries, 429/5xx + transient-400 handling)
                           ├─ cache (stale-while-revalidate; catalog 2 min, tapes 5 min, titles 7 d, briefs 30 min) + CDN cache headers
                           ├─ analytics (tape → price series, flow, concentration; quotes → depth ladder)
                           ├─ news context (Google News RSS for the market's question)
                           └─ LLM layer (Gemini; Groq as fallback) → strict-JSON briefs / answers / profiles
        api/index.js — Vercel Node adapter (Request in, Response out); vercel.json rewrites every path to it
```

- **One portable module, zero build step.** `src/app.js` has the Workers-style `fetch(request, env, ctx)` signature, so it runs on Vercel (via `api/index.js`), on Cloudflare Workers, or on the bundled local dev server without changes. Static files live in `public/`; the page shells are lightly server-rendered (Open Graph title/description per market) before they are sent.
- **Secrets never touch the repo or the browser.** The Panta key and LLM keys are environment variables on the host (`PANTA_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`). This satisfies Panta's Terms of Use §3 (no credentials in public code). A KV-backed deployment can instead bootstrap them through `POST /admin/config` guarded by `ADMIN_TOKEN_SHA256`.
- **Seeded titles.** `src/titles-seed.json` holds the page-resolved titles for the catalog at build time (`node scripts/seed-titles.mjs` refreshes it); unknown markets fall back to a live page read.
- **Honest data.** Prices and titles carry their source; AI output is labelled, dated, and says which model wrote it; the disclaimer is on every brief.
- **"Powered by Panta"** appears in the footer of every page and on every embed card, linking to panta.market (Terms §6).

## Run it locally

```bash
git clone https://github.com/zxreigns/oddsmind && cd oddsmind
export PANTA_API_KEY=pk_live_…        # from https://docs.panta.market/quickstart
export GEMINI_API_KEY=…               # optional: AI briefs (Google AI Studio)
export GROQ_API_KEY=…                 # optional: fallback LLM
node dev/local-server.mjs 8787        # http://localhost:8787
node --test test/                     # tests
```

The dev server runs the exact app module with a Map-backed cache and a static file server. Deploying to Vercel: import the repo, set the three env vars, deploy — `vercel.json` routes every path to `api/index.js`. Any host that runs Workers-shaped modules (Cloudflare Workers with a KV namespace bound as `CACHE`, Deno Deploy, …) works too.

## API

See https://oddsmind.vercel.app/api for the endpoint table. Quick taste:

```bash
curl -s https://oddsmind.vercel.app/api/market/6yEBmxJu2oWdubFVKZshVVUpLLsXd61csSfmf8y4Qtwd | jq '{title, yesPrice, priceSource, stats, depth}'
curl -s "https://oddsmind.vercel.app/api/ask?q=what+does+the+market+think+about+BBNaija"
```

## Notes for the Panta team (things we hit while building)

1. `GET /markets/` and `GET /markets/{id}/` return `title: ""` for markets created in the Panta app (6 of 86 had titles); the same markets have titles in `GET /positions/` rows and on their public pages.
2. `yesPrice`/`noPrice` are `null` for every `secondary`/`resolved` market and `volumeUsdc` is often `null` or `"0.00"` while the trade tape shows volume.
3. `GET /positions/` and `POST /primaryorderquote/` intermittently answer `400 INVALID_MARKET_PARAMS` for input that succeeds on retry (we retry up to 3× with backoff); `/positions/` sometimes takes >10 s or returns a Cloudflare 504.
4. Older trade rows have `amountUsdc: null` (only `shares` and base-unit `yesAmount`/`noAmount`), so historical prices can't be reconstructed before the field was added.
5. The catalog `phase` for the same market flips between `secondary` and `resolved` across calls; `resolved: true` is the stable signal.
6. A `GET /markets/{id}/outcome`-style field (or `outcome` on the detail row) would remove the positions-lookup workaround.

## Disclosure

All code in this repository was written during the hackathon window (from 30 September 2026). It uses no pre-existing OddsMind code. Dependencies: none at runtime (Web platform APIs only); `playwright-core` is used only by the QA screenshot/recording scripts in `dev/`.

## License

MIT — see [LICENSE](./LICENSE). Market data © Panta; "Powered by Panta" per the [Panta API Terms of Use](https://docs.panta.market/guides/terms-of-use). AI briefs are research summaries, not financial advice.
