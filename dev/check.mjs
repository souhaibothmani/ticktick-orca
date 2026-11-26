// Drives the real panel (panel/app.js) against dev/mock.js in headless Chromium: screenshots of
// every screen plus the typing checks a unit test cannot see (focus, scroll, undo across saves).
//
//   python3 -m http.server 8765 --bind 127.0.0.1 --directory .   (from the repo root)
//   CHROME=/path/to/chrome-headless-shell node dev/check.mjs out/
// Needs playwright-core installed next to it (npm i playwright-core); not a repo dependency.
import { chromium } from 'playwright-core'
const out = process.argv[2] || '.'
const url = 'http://127.0.0.1:8765/dev/harness.html'
const browser = await chromium.launch({ executablePath: process.env.CHROME })
const page = await browser.newPage({ viewport: { width: 380, height: 760 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
const fail = (m) => { console.log('FAIL', m); process.exitCode = 1 }
const snap = async (n) => { await page.waitForTimeout(150); await page.screenshot({ path: `${out}/${n}.png` }) }

await page.goto(url + '#connect'); await snap('0-connect')
await page.goto(url); await page.evaluate(() => localStorage.clear()); await page.goto(url); await snap('1-lists')
await page.click('text=VVS Growth'); await snap('2-tasks')

// Add task keeps its text through a redraw and stays focused for the next one.
await page.click('[aria-label="Add task"]'); await page.keyboard.type('half typ')
await page.click('[aria-label="Refresh"]'); await page.waitForTimeout(200)
const kept = await page.inputValue('[aria-label="Add task"]')
if (kept !== 'half typ') fail('add task lost its text on redraw: ' + kept)
await page.click('[aria-label="Add task"]'); await page.keyboard.press('End'); await page.keyboard.type('ed'); await page.keyboard.press('Enter')
await page.waitForTimeout(200)
if ((await page.inputValue('[aria-label="Add task"]')) !== '') fail('add task not cleared after create')
if ((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) !== 'Add task') fail('add task lost focus after Enter')

await page.click('[aria-label="Complete Verifica LINK offerta"]'); await snap('3-confirm')
await page.click('text=Cancel')
await page.click('button.section'); await page.waitForTimeout(200)
await page.locator('[data-k="body"]').evaluate((b) => (b.scrollTop = 9999)); await snap('4-completed')
await page.locator('[data-k="body"]').evaluate((b) => (b.scrollTop = 0))

// Task page: typing across an autosave keeps focus, text, scroll and undo.
await page.click('text=Long prompt')
await page.click('[aria-label="Description"]'); await page.keyboard.press('Control+End')
await page.locator('[data-k="body"]').evaluate((b) => (b.scrollTop = b.scrollHeight))
const before = await page.locator('[data-k="body"]').evaluate((b) => b.scrollTop)
await page.keyboard.type(' end', { delay: 20 })
await page.waitForTimeout(2800)
const after = await page.locator('[data-k="body"]').evaluate((b) => b.scrollTop)
if (Math.abs(after - before) > 40) fail(`page jumped on autosave: ${before} -> ${after}`)
await page.keyboard.type(' more', { delay: 20 })
const val = await page.inputValue('[aria-label="Description"]')
if (!val.endsWith(' end more')) fail('lost typing across autosave: ' + val.slice(-30))
await page.keyboard.press('Control+z')
if ((await page.inputValue('[aria-label="Description"]')) === val) fail('undo did nothing after an autosave')
await page.click('.back'); await page.waitForTimeout(300)

await page.click('text=nuova implemenazione'); await snap('5-task')
await page.click('[aria-label="Title"]'); await page.keyboard.press('End'); await page.keyboard.press('Enter')
if ((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) !== 'Description') fail('Enter in title did not move to description')
await page.click('[aria-label="Priority"]'); await snap('6-priority')
await page.click('.menu >> text=High priority'); await page.waitForTimeout(300); await snap('7-after-priority')

console.log('saves sent:', (await page.evaluate(() => window.__sent || [])).length)
console.log('errors', JSON.stringify(errors))
if (errors.length) process.exitCode = 1
await browser.close()
