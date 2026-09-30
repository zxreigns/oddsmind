
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const exe = fs.readdirSync(process.env.HOME + '/.cache/ms-playwright').filter(d => d.startsWith('chromium-')).map(d => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-linux/chrome`).find(p => fs.existsSync(p));
const [,, name, outDir, durStr] = process.argv;
const dur = +durStr * 1000;
const BASE = 'https://oddsmind.vercel.app';
const MKT = '6yEBmxJu2oWdubFVKZshVVUpLLsXd61csSfmf8y4Qtwd';
const WALLET = 'CzYecSKKe63Ej4jdShacVLCbEoXAS5TzjjLsoYibRBwd';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const left = () => dur - (Date.now() - t0);
async function scrollTo(y, ms = 1200) { await page.evaluate(([y]) => window.scrollTo({ top: y, behavior: 'smooth' }), [y]); await sleep(ms); }
async function glide(from, to, ms) { const steps = Math.max(10, Math.round(ms / 40)); for (let i = 1; i <= steps; i++) { await page.evaluate(([y]) => window.scrollTo(0, y), [from + (to - from) * i / steps]); await sleep(ms / steps); } }
async function moveTo(sel) { const b = await page.locator(sel).first().boundingBox().catch(() => null); if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 }); }
const segs = {
  async d1_home() { await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await sleep(4000); await moveTo('#stats'); await sleep(Math.max(0, left() - 9000)); await glide(0, 420, 2500); await sleep(2000); },
  async d2_board() { await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await sleep(2500); await scrollTo(1100, 1500); await sleep(800); await moveTo('#cats button[data-cat="sports"]'); await page.click('#cats button[data-cat="sports"]'); await sleep(1800); await page.click('#cats button[data-cat=""]'); await sleep(900); await moveTo('#phases button[data-phase="live"]'); await page.click('#phases button[data-phase="live"]'); await sleep(1800); await moveTo(`#board a[href="/m/${MKT}"]`); await sleep(Math.max(600, left() - 2200)); await page.click(`#board a[href="/m/${MKT}"]`); await sleep(2000); },
  async d3_market() { await page.goto(BASE + '/m/' + MKT, { waitUntil: 'networkidle' }); await sleep(5000); await moveTo('#bigodds'); await sleep(2500); await moveTo('#chart'); await sleep(2500); await moveTo('#depth'); await sleep(6500); await glide(0, 560, 2000); await sleep(1500); await moveTo('#brief .headline'); await glide(560, 820, 2500); await sleep(4000); await glide(820, 1150, 2500); await sleep(3000); await glide(1150, 1700, 3000); await sleep(Math.max(500, left() - 2500)); await glide(1700, 2100, 2000); },
  async d4_ask() { await page.goto(BASE + '/ask', { waitUntil: 'networkidle' }); await sleep(800); await page.click('#ask-q'); await page.type('#ask-q', 'what does the market think about BBNaija?', { delay: 45 }); await sleep(400); await page.keyboard.press('Enter'); await page.waitForSelector('#ask-out .answer', { timeout: 60000 }).catch(() => {}); await sleep(Math.max(500, left() - 2500)); await glide(0, 300, 2000); },
  async d5_wallet() { await page.goto(BASE + '/w/' + WALLET, { waitUntil: 'networkidle' }); await page.waitForSelector('#w-out .stats', { timeout: 60000 }).catch(() => {}); await sleep(3000); await moveTo('#w-out .stats'); await sleep(2500); await glide(0, 350, 2000); await sleep(Math.max(500, left() - 2500)); await glide(350, 700, 2000); },
  async d6_api() { await page.goto(BASE + '/api', { waitUntil: 'networkidle' }); await sleep(3500); await glide(0, 500, 3000); await sleep(2500); await page.goto(BASE + '/m/' + MKT, { waitUntil: 'networkidle' }); await sleep(1500); await scrollTo(1500, 1500); await page.click('#embed-btn').catch(() => {}); await sleep(3000); await moveTo('#trade-link'); await sleep(Math.max(500, left() - 4500)); await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await sleep(1200); await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(3000); },
  async broll_home() { await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await sleep(3000); await glide(0, 900, 6000); await sleep(Math.max(0, left())); },
  async broll_market() { await page.goto(BASE + '/m/' + MKT, { waitUntil: 'networkidle' }); await sleep(4000); await glide(0, 1300, 9000); await sleep(Math.max(0, left())); },
  async broll_ask() { await page.goto(BASE + '/ask?q=' + encodeURIComponent('what does the market think about SOL this week?'), { waitUntil: 'networkidle' }); await page.waitForSelector('#ask-out .answer', { timeout: 60000 }).catch(() => {}); await sleep(Math.max(0, left())); },
  async broll_api() { await page.goto(BASE + '/api', { waitUntil: 'networkidle' }); await sleep(2000); await glide(0, 600, 5000); await sleep(Math.max(0, left())); },
};
await segs[name]();
while (left() > 0) await sleep(100);
await ctx.close();
const vid = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm')).map((f) => path.join(outDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
fs.renameSync(vid, path.join(outDir, name + '.webm'));
await browser.close();
console.log(JSON.stringify({ name, file: path.join(outDir, name + '.webm'), ms: Date.now() - t0 }));
