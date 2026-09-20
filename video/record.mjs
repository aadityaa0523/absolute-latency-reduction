// Records the dashboard against a relay whose model refuses calls (like the real account), so the page's own
// demo-mode banner is on screen. Timed to narration.mp3 (~164 s).
import { chromium } from 'playwright-core';
import { startLocal } from '../relay/local.js';
const provider = { name: 'bedrock', async *stream() { throw Object.assign(new Error('Operation not allowed'), { name: 'ValidationException' }); } };
const srv = await startLocal({ port: 8795, provider, region: 'ap-south-1' });
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: 'raw', size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const at = async (s) => { const w = s * 1000 - (Date.now() - t0); if (w > 0) await page.waitForTimeout(w); };
const go = (sel) => page.evaluate((s) => document.querySelector(s).scrollIntoView({ behavior: 'smooth', block: 'start' }), sel);
await page.goto('http://127.0.0.1:8795/');
await at(23); await page.selectOption('#prompt', { index: 4 });
await at(35); await page.click('#run'); await page.waitForTimeout(1200); await go('.waterfall');
await at(60); await page.click('#run');
await at(85); await page.mouse.wheel(0, 380);
await at(100); await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await at(110); await go('#audit');
await at(124); await page.click('#audit-body summary >> nth=0');
await at(136); await go('#results');
await at(150); await go('#method');
await at(160); await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
await at(167);
await ctx.close(); await browser.close(); srv.close?.(); process.exit(0);
