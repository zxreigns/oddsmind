
/* OddsMind front-end — vanilla JS, one file, no build step. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (p) => (p === null || p === undefined ? '—' : Math.round(p * 100) + '%');
  const usd = (v) => (v === null || v === undefined ? '—' : '$' + Number(v).toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : 2 }));
  const n = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
  const short = (w) => (w ? w.slice(0, 4) + '…' + w.slice(-4) : '');
  const ago = (s) => { if (!s) return '—'; const d = Math.floor(Date.now() / 1000) - s; const a = Math.abs(d); const u = a < 60 ? [a, 's'] : a < 3600 ? [Math.floor(a / 60), 'm'] : a < 86400 ? [Math.floor(a / 3600), 'h'] : [Math.floor(a / 86400), 'd']; return d >= 0 ? `${u[0]}${u[1]} ago` : `in ${u[0]}${u[1]}`; };
  const when = (s) => (s ? new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const dateFull = (s) => (s ? new Date(s * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const statusOf = (m) => (m.resolved || m.phase === 'resolved' ? 'resolved' : m.tradable ? 'live' : m.phase === 'secondary' ? 'secondary' : m.status || m.phase);
  const chip = (m) => { const s = statusOf(m); const cls = s === 'live' ? 'live' : s === 'resolved' ? 'resolved' : s === 'secondary' ? 'secondary' : ''; const label = s === 'live' ? 'trading now' : s === 'secondary' ? 'secondary phase' : s; return `<span class="chip ${cls}">${esc(label)}</span>`; };
  const toast = (msg) => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 1800); };
  const api = async (path, opts) => { const r = await fetch(path, opts); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`); return d; };

  // nav state
  const page = document.body.dataset.page;
  const navKey = { index: 'pulse', market: 'pulse', ask: 'ask', wallet: 'wallet', api: 'api', about: 'about' }[page];
  $$('nav.main a').forEach((a) => { if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page'); });

  // sparkline / chart
  function sparkline(series, w = 120, h = 36) {
    if (!series || series.length < 2) return '';
    const xs = series.map((p) => p.t), ys = series.map((p) => p.p);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
    const pts = series.map((p) => `${(((p.t - x0) / (x1 - x0 || 1)) * (w - 2) + 1).toFixed(1)},${((1 - p.p) * (h - 4) + 2).toFixed(1)}`).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${up ? '#5ef1c2' : '#ff7a90'}" stroke-width="2" points="${pts}"/></svg>`;
  }
  function chart(svg, series, spot) {
    const W = 600, H = 160, L = 34, R = 10, T = 10, B = 24;
    if (!series || series.length < 2) {
      svg.style.display = 'none'; const d = document.createElement('div'); d.className = 'chart-empty'; d.textContent = series && series.length === 1 ? 'One priced fill so far — not enough for a curve.' : 'No priced fills on the tape yet.'; svg.insertAdjacentElement('afterend', d); return;
    }
    const xs = series.map((p) => p.t); const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
    const ps = series.map((p) => p.p).concat(spot !== null && spot !== undefined ? [spot] : []);
    let lo = Math.max(0, Math.min(...ps) - 0.08), hi = Math.min(1, Math.max(...ps) + 0.08); if (hi - lo < 0.2) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - 0.1); hi = Math.min(1, mid + 0.1); }
    const X = (t) => L + ((t - x0) / (x1 - x0 || 1)) * (W - L - R); const Y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
    let d = ''; series.forEach((p, i) => { d += (i ? 'L' : 'M') + X(p.t).toFixed(1) + ',' + Y(p.p).toFixed(1); });
    const area = d + `L${X(x1).toFixed(1)},${Y(lo)}L${X(x0).toFixed(1)},${Y(lo)}Z`;
    const step = (hi - lo) > 0.5 ? 0.25 : (hi - lo) > 0.25 ? 0.1 : 0.05; const gl = []; for (let g = Math.ceil(lo / step) * step; g <= hi + 1e-9; g += step) gl.push(+g.toFixed(4));
    const grid = gl.map((g) => `<line x1="${L}" x2="${W - R}" y1="${Y(g)}" y2="${Y(g)}" stroke="#1f2b48" stroke-dasharray="3 4"/><text x="${L - 6}" y="${Y(g) + 4}" fill="#6b7899" font-size="10" text-anchor="end">${Math.round(g * 100)}%</text>`).join('');
    const dots = series.map((p) => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.p).toFixed(1)}" r="2.6" fill="${p.side === 'yes' ? '#5ef1c2' : '#ff7a90'}"><title>${p.side.toUpperCase()} $${p.usdc} at ${Math.round(p.p * 100)}% YES · ${new Date(p.t * 1000).toLocaleString()}</title></circle>`).join('');
    const spotLine = spot !== null && spot !== undefined ? `<line x1="${L}" x2="${W - R}" y1="${Y(spot)}" y2="${Y(spot)}" stroke="#ffc857" stroke-width="1" stroke-dasharray="2 3"/>` : '';
    svg.innerHTML = `<defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7aa2ff" stop-opacity=".35"/><stop offset="1" stop-color="#7aa2ff" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#g)"/><path d="${d}" fill="none" stroke="#7aa2ff" stroke-width="2"/>${spotLine}${dots}
      <text x="${L}" y="${H - 6}" fill="#6b7899" font-size="10">${new Date(x0 * 1000).toLocaleDateString()}</text><text x="${W - R}" y="${H - 6}" fill="#6b7899" font-size="10" text-anchor="end">${new Date(x1 * 1000).toLocaleDateString()}</text>`;
  }

  function marketCard(m) {
    const depth = m.depth50 ? `<span>$50 fills at <b>${pct(m.depth50)}</b></span>` : '';
    return `<a class="card link" href="/m/${m.marketId}">
      <div class="row" style="justify-content:space-between">${chip(m)}<span class="chip">${esc(m.category || '')}</span></div>
      <div class="q">${esc(m.title || m.marketId)}</div>
      <div class="odds">${m.yesPrice === null ? '<div class="na">no price data</div>' : `<div class="yes">${pct(m.yesPrice)}<small>YES</small></div><div class="no">NO ${pct(m.noPrice)}</div>`}</div>
      <div class="bar"><i style="width:${m.yesPrice === null ? 0 : m.yesPrice * 100}%"></i></div>
      <div class="meta">${m.stats ? `<span><b>${m.stats.trades}</b> trades</span><span><b>${m.stats.uniqueWallets}</b> wallets</span>` : ''}${m.volumeUsdc ? `<span><b>${usd(m.volumeUsdc)}</b> vol</span>` : ''}${m.endTime ? `<span>ends <b>${ago(m.endTime)}</b></span>` : ''}${depth}</div>
    </a>`;
  }

  // ---------- index ----------
  async function initIndex() {
    // digest loads independently of the board
    (async () => {
      try {
        const dg = await api('/api/digest'); if (dg.error) throw new Error(dg.detail || dg.error);
        $('#digest-state').textContent = `${dg.model} · ${ago(dg.generatedAt)}`;
        $('#digest-body').innerHTML = `<div class="headline">${esc(dg.headline)}</div><p style="margin:0 0 10px">${esc(dg.summary)}</p><ul style="margin:0 0 10px 18px;padding:0">${(dg.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>${dg.watch && dg.watch.length ? `<div class="chips" style="margin:0">${dg.watch.map((m) => `<a class="chip ${m.tradable ? 'live' : ''}" href="/m/${m.marketId}" style="text-decoration:none">${esc(m.title.length > 60 ? m.title.slice(0, 58) + '…' : m.title)}${m.yesPrice !== null ? ` · ${pct(m.yesPrice)}` : ''}</a>`).join('')}</div>` : ''}<p class="disclaimer" style="margin-top:8px">Written by OddsMind's AI editor over the live Panta catalog (${dg.basedOn.markets} markets). Not financial advice.</p>`;
      } catch (e) { $('#digest-state').textContent = 'unavailable'; $('#digest-body').innerHTML = `<p class="muted small" style="margin:0">The editor is quiet right now (${esc(e.message)}). The live numbers below don't need it.</p>`; }
    })();
    let pulse;
    try { pulse = await api('/api/pulse?budget=7000'); }
    catch (e) { $('#live').innerHTML = `<div class="err">Couldn't reach the Panta API right now (${esc(e.message)}). Try again in a moment.</div>`; $('#board tbody').innerHTML = ''; return; }
    // cold cache: rows past the server's time budget come back pending — keep polling until every row is enriched
    if (pulse.pending) {
      (async () => { for (let i = 0; i < 6 && pulse.pending; i++) { await new Promise((r) => setTimeout(r, 1500)); try { const p2 = await api('/api/pulse?budget=9000'); if (p2.pending < pulse.pending || !p2.pending) { pulse = p2; initIndex.render && initIndex.render(p2); } } catch (e) {} } })();
    }
    let ms = pulse.markets;
    const renderStats = (pulse) => { $('#stats').innerHTML = [
      [pulse.count, 'markets'], [pulse.tradable, 'trading now'], [pulse.trades24h, 'trades · 24h'], [usd(pulse.pricedVolume24hUsdc), 'priced volume · 24h'], [pulse.uniqueWallets ?? '—', 'wallets on tape'],
    ].map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join(''); };
    renderStats(pulse);
    const live = ms.filter((m) => m.tradable);
    if (live.length) {
      $('#live').innerHTML = live.map(marketCard).join('');
      // depth for live cards (async)
      live.forEach(async (m) => { try { const d = await api(`/api/market/${m.marketId}/depth`); const q = (d.depth || []).find((x) => x.side === 'yes' && x.amountUsdc === 50 && !x.error); if (q) { const card = $(`#live a[href="/m/${m.marketId}"] .meta`); if (card) card.insertAdjacentHTML('beforeend', `<span>$50 YES fills at <b>${pct(q.avgPrice)}</b></span>`); } } catch (e) {} });
    } else $('#live').innerHTML = '<div class="empty">No market is open on the primary curve right now. The board below still has every market and its history.</div>';
    const noteFor = (p) => { $('#board-note').textContent = p.pending ? `${p.pending} of ${p.count} rows are still being enriched from their trade tapes…` : 'Every USDC market in the Panta catalog, enriched with its trade tape.'; }; noteFor(pulse);

    // categories
    const cats = Object.entries(pulse.categories).sort((a, b) => b[1] - a[1]);
    let cat = '', phase = '', q = '';
    $('#cats').innerHTML = `<button aria-pressed="true" data-cat="">all</button>` + cats.map(([c, k]) => `<button data-cat="${esc(c)}">${esc(c)} <span class="dim">${k}</span></button>`).join('');
    const render = () => {
      let rows = ms.filter((m) => (!cat || m.category === cat) && (!phase || (phase === 'live' ? m.tradable : statusOf(m) === 'resolved')) && (!q || (m.title || '').toLowerCase().includes(q)));
      rows = rows.slice().sort((a, b) => (b.tradable - a.tradable) || (((b.stats && b.stats.trades) || 0) - ((a.stats && a.stats.trades) || 0)) || (b.endTime - a.endTime));
      $('#board tbody').innerHTML = rows.length ? rows.map((m) => `<tr>
        <td><a href="/m/${m.marketId}" style="color:inherit;font-weight:600">${esc(m.title || m.marketId)}</a><div class="dim small">${esc(m.category)}${m.oracle ? ' · ' + esc(m.oracle) : ''}</div></td>
        <td>${chip(m)}</td>
        <td class="num">${m.yesPrice === null ? '<span class="dim">—</span>' : `<span class="yes-t">${pct(m.yesPrice)}</span>`}${m.stats && m.stats.change24h && Math.abs(m.stats.change24h) >= 0.01 ? `<div class="small ${m.stats.change24h > 0 ? 'yes-t' : 'no-t'}">${m.stats.change24h > 0 ? '+' : ''}${Math.round(m.stats.change24h * 100)} pts 24h</div>` : ''}</td>
        <td class="num">${m.stats ? m.stats.trades : '<span class="dim">…</span>'}</td>
        <td class="num">${m.stats ? m.stats.uniqueWallets : '<span class="dim">…</span>'}</td>
        <td class="num">${m.volumeUsdc ? usd(m.volumeUsdc) : m.stats && m.stats.pricedVolumeUsdc ? usd(m.stats.pricedVolumeUsdc) : '<span class="dim">—</span>'}</td>
        <td class="small">${when(m.endTime)}<div class="dim">${ago(m.endTime)}</div></td>
      </tr>`).join('') : '<tr><td colspan="7"><div class="empty">Nothing matches.</div></td></tr>';
    };
    render();
    initIndex.render = (p2) => { ms = p2.markets; renderStats(p2); noteFor(p2); render(); };
    $('#cats').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; cat = b.dataset.cat; $$('#cats button').forEach((x) => x.setAttribute('aria-pressed', x === b)); render(); });
    $('#phases').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; phase = b.dataset.phase; $$('#phases button').forEach((x) => x.setAttribute('aria-pressed', x === b)); render(); });
    $('#filter').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); render(); });

    // wallets leaderboard from holders (per-market top holders are in /api/market; pulse carries topHolderShare only) → fetch tapes lazily for top 12 active markets
    const top = ms.filter((m) => m.stats && m.stats.trades > 0).sort((a, b) => b.stats.trades - a.stats.trades).slice(0, 12);
    const agg = new Map();
    await Promise.all(top.map(async (m) => { try { const d = await api(`/api/market/${m.marketId}/tape`); for (const t of d.trades || []) { const w = agg.get(t.wallet) || { wallet: t.wallet, trades: 0, usdc: 0, markets: new Set() }; w.trades++; w.usdc += Number(t.amountUsdc || 0); w.markets.add(m.marketId); agg.set(t.wallet, w); } } catch (e) {} }));
    const lead = [...agg.values()].sort((a, b) => b.trades - a.trades).slice(0, 8);
    $('#wallets').innerHTML = lead.length ? `<table><thead><tr><th>Wallet</th><th class="num">Trades</th><th class="num">Markets</th><th class="num">USDC</th></tr></thead><tbody>${lead.map((w) => `<tr><td><a class="mono" href="/w/${w.wallet}">${short(w.wallet)}</a></td><td class="num">${w.trades}</td><td class="num">${w.markets.size}</td><td class="num">${w.usdc ? usd(w.usdc) : '<span class="dim">—</span>'}</td></tr>`).join('')}</tbody></table><p class="footnote" style="margin:8px 0 0">From the ${top.length} most-traded markets' tapes. USDC shows only for fills the API prices.</p>` : '<div class="empty">No tape data yet.</div>';
  }

  // ---------- market ----------
  async function initMarket() {
    const id = $('#market').dataset.id;
    $('#trade-link').href = `https://panta.market/market/${id}`; $('#json-link').href = `/api/market/${id}`;
    $('#share-btn').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch (e) { toast(location.href); } };
    $('#embed-btn').onclick = () => { const pre = $('#embed-code'); pre.hidden = !pre.hidden; pre.textContent = `<iframe src="${location.origin}/embed/${id}" width="360" height="200" style="border:0;border-radius:14px" loading="lazy" title="OddsMind market card"></iframe>`; };
    const briefP = api(`/api/market/${id}/brief`);
    let m;
    try { m = await api(`/api/market/${id}`); }
    catch (e) { $('#m-title').textContent = 'Market not available'; $('#odds-card').innerHTML = `<div class="err">${esc(e.message)}</div>`; $('#brief').hidden = true; return; }
    document.title = (m.title || 'Market') + ' — OddsMind';
    $('#m-title').textContent = m.title || m.marketId;
    $('#m-chips').innerHTML = chip(m) + (m.outcome && m.outcome.outcome ? `<span class="chip ${m.outcome.outcome === 'yes' ? 'live' : ''}" style="${m.outcome.outcome === 'no' ? 'color:var(--no);border-color:rgba(255,122,144,.4)' : ''}" title="read from ${esc(m.outcome.via)}">resolved ${esc(m.outcome.outcome.toUpperCase())}</span>` : '') + `<span class="chip">${esc(m.category)}</span>` + (m.marketType ? `<span class="chip">${esc(m.marketType)} market</span>` : '') + (m.createdByPartner ? '<span class="chip">API-created</span>' : '');
    $('#m-meta').innerHTML = `<span>ends <b>${dateFull(m.endTime)}</b> (${ago(m.endTime)})</span><span>oracle <b>${esc(m.oracle || '—')}</b></span><span>title via <b>${esc(m.titleSource)}</b></span>`;
    if (m.image) { const img = $('#m-img'); img.src = m.image; img.hidden = false; }
    // odds
    const oc = m.outcome && m.outcome.outcome;
    $('#bigodds').innerHTML = oc
      ? `<div><span class="lbl">Resolved</span><div class="outcome ${oc === 'yes' ? 'yes-t' : 'no-t'}">${oc.toUpperCase()}</div></div>${m.yesPrice !== null ? `<div><span class="lbl">Last traded</span><div class="no" style="color:var(--text)">${pct(m.yesPrice)} YES</div></div>` : ''}<div><span class="lbl">Read from</span><div class="small muted">${esc(m.outcome.via)}</div></div>`
      : m.yesPrice === null
      ? `<div><span class="lbl">Implied probability</span><div class="no" style="color:var(--dim)">no price data</div></div>`
      : `<div><span class="lbl">Implied probability</span><div class="yes">${pct(m.yesPrice)}<span class="lbl" style="display:inline;margin-left:8px">yes</span></div></div><div><span class="lbl">No</span><div class="no">${pct(m.noPrice)}</div></div>${m.stats && m.stats.change24h !== null && Math.abs(m.stats.change24h) >= 0.005 ? `<div><span class="lbl">24h</span><div class="${m.stats.change24h >= 0 ? 'yes-t' : 'no-t'}" style="font-size:22px">${m.stats.change24h > 0 ? '+' : ''}${Math.round(m.stats.change24h * 100)} pts</div></div>` : ''}`;
    $('#m-bar').style.width = (oc ? (oc === 'yes' ? 100 : 0) : m.yesPrice === null ? 0 : m.yesPrice * 100) + '%';
    $('#m-pricemeta').innerHTML = `<span>price source: <b>${esc(m.priceSource)}</b></span>${m.stats ? `<span>last trade <b>${ago(m.stats.lastTradeAt)}</b></span>` : ''}${m.volumeUsdc ? `<span>volume <b>${usd(m.volumeUsdc)}</b></span>` : ''}${m.stats && m.stats.pricedVolumeUsdc ? `<span>priced fills <b>${usd(m.stats.pricedVolumeUsdc)}</b></span>` : ''}`;
    chart($('#chart'), m.series, m.yesPrice);
    $('#chart-note').innerHTML = m.series && m.series.length ? `<span>${m.series.length} priced fills · price = USDC ÷ shares per fill (NO fills shown as 1 − price)</span>` : `<span class="dim">The tape has ${m.stats.trades} trades; Panta reports USDC amounts on recent fills only, so older trades can't be priced.</span>`;
    // depth
    const spot = m.yesPrice;
    if (!m.tradable) $('#depth').innerHTML = `<div class="empty small">${statusOf(m) === 'resolved' ? 'This market has resolved — no primary-curve fills to quote.' : 'Primary trading is closed on this market; quotes are only available while it trades on the bonding curve.'}</div>`;
    else {
      const rows = ['yes', 'no'].map((side) => { const qs = (m.depth || []).filter((d) => d.side === side); return `<tr><td class="${side}-t">${side.toUpperCase()}</td>${qs.map((d) => d.error ? `<td class="num dim" title="${esc(d.error)}">n/a</td>` : `<td class="num"><b>${pct(d.avgPrice)}</b><div class="dim small">${n(d.shares, 1)} sh · fee ${usd(d.feeUsdc)}</div></td>`).join('')}</tr>`; }).join('');
      const slip = (m.depth || []).filter((d) => !d.error && d.side === 'yes'); const s250 = slip.find((d) => d.amountUsdc === 250), s10 = slip.find((d) => d.amountUsdc === 10);
      $('#depth').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Side</th><th class="num">$10</th><th class="num">$50</th><th class="num">$250</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="small muted" style="margin:10px 0 0">${s10 && s250 ? `Moving from a $10 to a $250 YES order raises the average fill from <b>${pct(s10.avgPrice)}</b> to <b>${pct(s250.avgPrice)}</b> — ${Math.round((s250.avgPrice - s10.avgPrice) * 100)} points of slippage. ${Math.round((s250.avgPrice - s10.avgPrice) * 100) >= 8 ? 'Thin book: treat the headline odds as soft.' : 'Reasonable depth for this size.'}` : 'Some sizes are not fillable right now.'} Fees ≈ ${slip[0] ? Math.round((slip[0].feeUsdc / slip[0].amountUsdc) * 1000) / 10 : 2}% of the deposit.</p>`;
    }
    // flow
    const st = m.stats || {};
    $('#flow').innerHTML = `<div class="stats" style="grid-template-columns:repeat(2,1fr);margin:0 0 12px">
      <div class="stat"><div class="v">${st.trades ?? 0}</div><div class="k">trades</div></div><div class="stat"><div class="v">${st.uniqueWallets ?? 0}</div><div class="k">wallets</div></div>
      <div class="stat"><div class="v">${st.yesShareOfFlow === null || st.yesShareOfFlow === undefined ? '—' : pct(st.yesShareOfFlow)}</div><div class="k">of shares bought YES</div></div><div class="stat"><div class="v">${st.topHolderShare === null || st.topHolderShare === undefined ? '—' : pct(st.topHolderShare)}</div><div class="k">held by top wallet</div></div></div>
      ${m.holders && m.holders.length ? `<table><thead><tr><th>Top wallets</th><th class="num">Trades</th><th class="num">YES sh</th><th class="num">NO sh</th></tr></thead><tbody>${m.holders.slice(0, 6).map((w) => `<tr><td><a class="mono" href="/w/${w.wallet}">${short(w.wallet)}</a></td><td class="num">${w.trades}</td><td class="num yes-t">${n(w.yes, 1)}</td><td class="num no-t">${n(w.no, 1)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty small">No trades on the tape yet.</div>'}`;
    // resolution
    const d = m.detail || {};
    $('#res').innerHTML = [['Status', `${esc(m.status)}${m.resolved ? ' · resolved' : ''}`], ['Trading ends', dateFull(m.endTime)], ['Resolves', dateFull(m.resolutionTime)], ['Oracle', esc(m.oracle || '—')], ['Creator', m.creatorAddress ? `<a class="mono" href="/w/${m.creatorAddress}">${short(m.creatorAddress)}</a>` : '—'], ['Program', d.programId ? `<a class="mono" href="https://solscan.io/account/${d.programId}" target="_blank" rel="noopener">${short(d.programId)}</a>` : '—'], ['Created tx', d.transactionHash ? `<a class="mono" href="https://solscan.io/tx/${d.transactionHash}" target="_blank" rel="noopener">${short(d.transactionHash)}</a>` : '—'], ['Graduated', d.isGraduated ? 'yes' : 'no'], ['Market id', `<span class="mono">${m.marketId}</span>`]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    // tape
    const tb = $('#tape tbody');
    const tapeRow = (t) => { const sh = Number(t.shares); const amt = t.amountUsdc !== null && t.amountUsdc !== undefined ? Number(t.amountUsdc) : null; const p = amt !== null && sh ? (t.side === 'yes' ? amt / sh : 1 - amt / sh) : null; return `<tr><td class="small when">${when(t.blockTime)}<div class="dim">${ago(t.blockTime)}</div></td><td class="${t.side}-t">${t.side.toUpperCase()}${t.isPrimary ? '' : ' <span class="dim">2°</span>'}</td><td class="num">${amt === null ? '<span class="dim">—</span>' : usd(amt)}</td><td class="num">${n(sh, 2)}</td><td class="num">${p === null ? '<span class="dim">—</span>' : pct(p) + ' YES'}</td><td><a class="mono" href="/w/${t.wallet}">${short(t.wallet)}</a> <a class="dim small" href="https://solscan.io/tx/${t.signature}" target="_blank" rel="noopener" title="View on Solscan">tx</a></td></tr>`; };
    const tape = m.tape || []; const first = tape.slice(0, 15);
    tb.innerHTML = tape.length ? first.map(tapeRow).join('') : '<tr><td colspan="6"><div class="empty small">No trades yet.</div></td></tr>';
    if (tape.length > 15) { const btn = document.createElement('button'); btn.className = 'btn ghost sm'; btn.style.marginTop = '10px'; btn.textContent = `Show all ${tape.length} trades`; btn.onclick = () => { tb.innerHTML = tape.map(tapeRow).join(''); btn.remove(); }; $('#tape-card').appendChild(btn); }
    // brief
    try {
      const b = await briefP; const br = b.brief;
      if (!br) throw new Error(b.error || 'unavailable');
      $('#brief-state').textContent = `${br.model || 'AI'} · ${ago(br.generatedAt)}`;
      $('#brief-body').innerHTML = `<div class="headline">${esc(br.headline)}</div>
        <div class="sec"><h4>The question</h4><p>${esc(br.question)}</p></div>
        <div class="sec"><h4>Market read <span class="conf ${esc(br.confidence)}">${esc(br.confidence)} confidence</span></h4><p>${esc(br.market_read)}</p></div>
        <div class="sec"><h4>Flow &amp; liquidity</h4><p>${esc(br.flow)}</p></div>
        <div class="sec"><h4>Context</h4><p>${esc(br.context)}</p></div>
        <div class="two" style="gap:12px"><div class="sec"><h4>What moves it</h4><ul>${(br.what_moves_it || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div><div class="sec"><h4>Risks</h4><ul>${(br.risks || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></div>
        ${br.sources && br.sources.length ? `<div class="sec sources"><h4>Sources</h4>${br.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(s.title || s.url)}</a>`).join('')}</div>` : ''}
        <p class="disclaimer">${esc(br.disclaimer)}</p>`;
    } catch (e) { $('#brief-state').textContent = 'unavailable'; $('#brief-body').innerHTML = `<p class="muted small">The analyst couldn't write a brief right now (${esc(e.message)}). The numbers above are live regardless.</p>`; }
  }

  // ---------- ask ----------
  async function initAsk() {
    const form = $('#ask-form'), input = $('#ask-q'), out = $('#ask-out');
    const examples = ['What does the market think about SOL this week?', 'Will a female housemate win Big Brother Naija?', 'Any markets on the Steelers vs Browns game?', 'Which markets are closing in the next 48 hours?'];
    $('#examples').innerHTML = examples.map((x) => `<button type="button">${esc(x)}</button>`).join('');
    $('#examples').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; input.value = b.textContent; run(); });
    async function run() {
      const q = input.value.trim(); if (q.length < 3) return;
      history.replaceState(null, '', '/ask?q=' + encodeURIComponent(q));
      out.innerHTML = `<div class="card"><div class="skeleton" style="height:22px;margin-bottom:8px"></div><div class="skeleton" style="height:14px;width:80%"></div><p class="muted small" style="margin:10px 0 0">Reading every live market and thinking…</p></div>`;
      try {
        const r = await api('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q }) });
        out.innerHTML = `<div class="card brief"><h2><img src="/assets/logo.svg" alt="" width="22" height="22"> The markets say</h2><p class="answer">${esc(r.answer)}</p><p class="footnote">${r.marketsConsidered} markets considered · ${esc(r.model)} · not financial advice</p></div>
          ${r.picks && r.picks.length ? `<section class="section"><div class="section-head"><h2>Markets behind the answer</h2></div><div class="grid">${r.picks.map((m) => marketCard(m).replace('</a>', `<div class="small muted">${esc(m.why || '')}</div></a>`)).join('')}</div></section>` : ''}`;
      } catch (e) { out.innerHTML = `<div class="err">Couldn't answer right now: ${esc(e.message)}</div>`; }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
    if (input.value.trim().length >= 3) run();
  }

  // ---------- wallet ----------
  async function initWallet() {
    const form = $('#w-form'), input = $('#w-addr'), out = $('#w-out');
    $('#w-examples').innerHTML = `<button type="button" data-w="Bji2jpKEYAphqJv9q3J8cXJPcnWLtamWD21zLSqHkE2z">most active market maker</button><button type="button" data-w="CzYecSKKe63Ej4jdShacVLCbEoXAS5TzjjLsoYibRBwd">a BBNaija YES buyer</button><button type="button" data-w="BZvaJBkAHjtiE4tGVDFDRAxyAADbvqNqjUsb51VezY1e">frequent trader</button>`;
    $('#w-examples').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; input.value = b.dataset.w; run(); });
    async function run() {
      const w = input.value.trim(); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) { out.innerHTML = '<div class="err">That doesn\'t look like a Solana address.</div>'; return; }
      history.replaceState(null, '', '/w/' + w);
      out.innerHTML = `<div class="card"><div class="skeleton" style="height:22px;margin-bottom:8px"></div><div class="skeleton" style="height:14px;width:70%"></div><p class="muted small" style="margin:10px 0 0">Reading positions and trade history from Panta… (their positions call can take ~10 s)</p></div>`;
      try {
        const r = await api(`/api/wallet/${w}`);
        const s = r.summary || {};
        out.innerHTML = `<div class="stats">
            <div class="stat"><div class="v">${usd(s.currentValueUsdc)}</div><div class="k">positions value</div></div>
            <div class="stat"><div class="v">${r.positions.length}</div><div class="k">open positions</div></div>
            <div class="stat"><div class="v">${r.claimable}</div><div class="k">claimable</div></div>
            <div class="stat"><div class="v">${r.tradeCount}</div><div class="k">trades</div></div>
            <div class="stat"><div class="v">${r.marketsTraded}</div><div class="k">markets</div></div>
            <div class="stat"><div class="v">${r.yesBias === null ? '—' : pct(r.yesBias)}</div><div class="k">of trades YES</div></div>
          </div>
          <div class="two">
            <div class="card"><h3>Positions</h3>${r.positionsError ? `<div class="note" style="margin-bottom:10px">Panta's positions endpoint answered <code>${esc(r.positionsError)}</code> for this wallet after retries, so holdings and value are unavailable right now — the trade history below still comes from the tape.</div>` : ''}${r.positions.length ? `<div class="table-wrap"><table><thead><tr><th>Market</th><th>Side</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Value</th><th>State</th></tr></thead><tbody>${r.positions.map((p) => `<tr><td><a href="/m/${p.marketId}" style="color:inherit">${esc(p.title || short(p.marketId))}</a></td><td class="${p.side}-t">${p.side.toUpperCase()}</td><td class="num">${n(p.shares, 2)}</td><td class="num">${p.price === null ? '—' : pct(p.price)}</td><td class="num">${usd(p.currentValueUsdc)}</td><td class="small">${esc(p.phase || '')}${p.claimable ? ' <span class="badge claim">claimable</span>' : ''}${p.outcome ? ` · ${esc(p.outcome)}` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">No open positions on Panta.</div>'}</div>
            <div>
              <div class="card brief"><h3>Trader profile</h3><div id="w-ai"><button class="btn sm" id="w-ai-btn" type="button">Profile this wallet with AI</button></div></div>
              <div class="card" style="margin-top:16px"><h3>Activity</h3><dl class="kv"><dt>First trade</dt><dd>${dateFull(r.firstTradeAt)}</dd><dt>Last trade</dt><dd>${dateFull(r.lastTradeAt)}</dd><dt>USDC deployed</dt><dd>${usd(r.spentUsdc)} <span class="dim small">(priced fills only)</span></dd><dt>Explorer</dt><dd><a href="${esc(r.links.solscan)}" target="_blank" rel="noopener">Solscan ↗</a></dd></dl></div>
            </div>
          </div>
          <section class="section"><div class="section-head"><h2>Markets traded</h2></div><div class="table-wrap"><table><thead><tr><th>Market</th><th class="num">Trades</th><th class="num">YES sh</th><th class="num">NO sh</th><th class="num">USDC</th><th>Last</th></tr></thead><tbody>${r.perMarket.map((m) => `<tr><td><a href="/m/${m.marketId}" style="color:inherit">${esc(m.title || short(m.marketId))}</a></td><td class="num">${m.trades}</td><td class="num yes-t">${n(m.yes, 1)}</td><td class="num no-t">${n(m.no, 1)}</td><td class="num">${m.usdc ? usd(m.usdc) : '<span class="dim">—</span>'}</td><td class="small">${ago(m.last)}</td></tr>`).join('') || '<tr><td colspan="6"><div class="empty small">No trades on the tape.</div></td></tr>'}</tbody></table></div></section>`;
        $('#w-ai-btn').onclick = async () => { $('#w-ai').innerHTML = '<div class="skeleton" style="height:60px"></div>'; try { const a = await api(`/api/wallet/${w}?ai=1`); const ai = a.ai; $('#w-ai').innerHTML = `<p style="margin:0 0 8px">${esc(ai.style)}</p>${ai.themes && ai.themes.length ? `<div class="chips" style="margin:6px 0">${ai.themes.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}${ai.notes && ai.notes.length ? `<ul class="small" style="margin:6px 0 0 18px;padding:0">${ai.notes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}<p class="disclaimer">${esc(ai.model)} · from Panta positions + trade history only</p>`; } catch (e) { $('#w-ai').innerHTML = `<p class="muted small">Profile unavailable (${esc(e.message)}).</p>`; } };
      } catch (e) { out.innerHTML = `<div class="err">Couldn't read that wallet: ${esc(e.message)}</div>`; }
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
    if (input.value.trim()) run();
  }

  ({ index: initIndex, market: initMarket, ask: initAsk, wallet: initWallet }[page] || (() => {}))();
})();
