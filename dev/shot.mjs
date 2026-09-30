
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const exe = fs.readdirSync(process.env.HOME + '/.cache/ms-playwright').filter(d => d.startsWith('chromium-')).map(d => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-linux/chrome`).find(p => fs.existsSync(p));
const [,, url, out, w = '1440', h = '900', waitMs = '8000'] = process.argv;
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => logs.push('goto: ' + e.message));
await page.waitForTimeout(+waitMs);
await page.screenshot({ path: out, fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth ? `overflow ${document.documentElement.scrollWidth}>${document.documentElement.clientWidth}` : 'no-overflow');
console.log(JSON.stringify({ url, out, overflow, title: await page.title(), logs: logs.slice(0, 20) }));
await browser.close();
