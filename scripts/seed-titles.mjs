// Regenerates src/titles-seed.json: titles for catalog markets whose API row has an empty title,
// read from each market's public page on panta.market. Run: PANTA_API_KEY=… node scripts/seed-titles.mjs
import fs from 'node:fs';
const key = process.env.PANTA_API_KEY; if (!key) { console.error('PANTA_API_KEY required'); process.exit(1); }
const B = 'https://live-api.panta.market/api/v1';
const out = 'src/titles-seed.json';
const seed = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
let cursor = null; const items = [];
do { const r = await fetch(`${B}/markets/?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { 'X-Api-Key': key } }); const d = await r.json(); items.push(...(d.items || [])); cursor = d.nextCursor; } while (cursor);
let added = 0;
for (const m of items) {
  if ((m.title && m.title.trim()) || seed[m.marketId]) continue;
  try {
    const h = await (await fetch(`https://panta.market/market/${m.marketId}`, { headers: { 'user-agent': 'Mozilla/5.0 OddsMind' } })).text();
    const mm = h.match(/property="og:image:alt"\s+content="([^"]+)"/) || h.match(/<title>([^<]+?)\s*\|\s*Panta Market<\/title>/);
    if (mm) { seed[m.marketId] = mm[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[\u2060\u200b]/g, '').trim(); added++; }
  } catch (e) {}
}
fs.writeFileSync(out, JSON.stringify(seed, null, 1));
console.log(`${items.length} markets, ${Object.keys(seed).length} seeded titles (${added} new)`);
