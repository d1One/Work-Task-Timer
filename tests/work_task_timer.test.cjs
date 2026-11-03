// Run with Node.js and Playwright installed. TIMER_BROWSER_PATH can select Chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, '..', 'work_task_timer.html'), 'utf8');
const html = source.replace('setInterval(() => render(false), 200);', `
  globalThis.timerTest = {
    get state() { return state; },
    set state(value) { state = { ...blankState(), ...value }; },
    get goal() { return GOAL; },
    target: () => blockForTimestamp().targetMs,
    render, buildLogRows, buildLogTSV, buildLogHTML, reconcileStateWithSchedule,
    copyFormattedLog
  };
`);
const now = Date.parse('2026-11-03T09:00:00Z');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.TIMER_BROWSER_PATH ? { executablePath: process.env.TIMER_BROWSER_PATH } : {})
  });
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 1000 }, timezoneId: 'Europe/Lisbon' });
    await context.route('https://timer.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await context.addInitScript(({ now }) => {
      window.testNow = now;
      Date.now = () => window.testNow;
      // Simulate a day that the old version stopped at its daily goal.
      if (!localStorage.getItem('work-task-timer-v1')) localStorage.setItem('work-task-timer-v1', JSON.stringify({
        version: 2, started: true, completed: true, startedAt: now - 1000000,
        tasks: Array.from({ length: 166 }, (_, i) => ({ number: i + 1, durationMs: 1000, completedAt: now - 100000 + i })),
        pauses: [], runningSegmentStartedAt: null
      }));
    }, { now });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://timer.test/');
    assert.equal(await page.locator('#currentTimer').textContent(), '00:00');
    assert.equal(await page.locator('#doneButton').isEnabled(), true);
    await page.locator('#doneButton').click();
    await page.locator('#doneButton').click();
    assert.equal(await page.locator('#progressCount').textContent(), '168 / 166');
    assert.equal(await page.locator('#pauseCard').isVisible(), true);
    assert.equal(await page.evaluate(() => timerTest.state.runningSegmentStartedAt), now);
    await page.reload();
    assert.equal(await page.locator('#progressCount').textContent(), '168 / 166');
    assert.equal(await page.locator('#doneButton').isEnabled(), true);
    await page.evaluate(() => timerTest.reconcileStateWithSchedule());
    assert.equal(await page.locator('#doneButton').isEnabled(), true);
    console.log('PASS: old completed sessions resume; counting and schedule changes continue beyond the goal.');

    const colors = [];
    for (const remaining of [20001, 20000, 0, -1]) {
      colors.push(await page.evaluate(remaining => {
        timerTest.state = { started: true, currentTaskAccumulatedMs: timerTest.target() - remaining, runningSegmentStartedAt: Date.now() };
        timerTest.render(true);
        return getComputedStyle(document.querySelector('#currentTimer')).color;
      }, remaining));
    }
    assert.deepEqual(colors, ['rgb(53, 196, 106)', 'rgb(227, 179, 65)', 'rgb(227, 179, 65)', 'rgb(255, 93, 93)']);
    assert.equal(await page.locator('#paceStatus').evaluate(el => getComputedStyle(el).fontSize), '14px');
    await page.locator('#pauseButton').click();
    assert.equal(await page.locator('#doneButton').isDisabled(), true);
    await page.evaluate(() => { window.testNow += 10000; timerTest.render(); });
    assert.equal(await page.locator('#currentTimer').textContent(), '02:35');
    await page.locator('#pauseButton').click();
    assert.equal(await page.evaluate(() => timerTest.state.pauses[0].durationMs), 10000);
    console.log('PASS: clock colors at 20-second boundary and target; pause accounting; target text size.');

    await page.evaluate(() => {
      const now = Date.now();
      timerTest.state = {
        started: true, runningSegmentStartedAt: now,
        tasks: [
          { number: 1, durationMs: 50000, targetMs: 60000, completedAt: now - 6000 },
          { number: 2, durationMs: 60000, targetMs: 60000, completedAt: now - 3000 },
          { number: 3, durationMs: 70000, targetMs: 60000, completedAt: now }
        ],
        pauses: [{ reason: '=SUM(1,2)\t<&>\nBreak', durationMs: 1000, startedAt: now - 5000, endedAt: now - 4000 }],
        offClockPeriods: [{ reason: 'Lunch', durationMs: 1000, startedAt: now - 2000, endedAt: now - 1000 }]
      };
      timerTest.render(true);
    });
    const log = await page.evaluate(() => ({ rows: timerTest.buildLogRows(), tsv: timerTest.buildLogTSV(), html: timerTest.buildLogHTML() }));
    assert.deepEqual(log.rows.slice(1, 6).map(row => row[0]), [1, 'Pause', 2, 'Off clock', 3]);
    assert.equal(log.rows[1][4], '00:00:10 under');
    assert.equal(log.rows[3][4], 'At target');
    assert.equal(log.rows[5][4], '00:00:10 over');
    assert.ok(log.tsv.split('\n').every(row => row.split('\t').length === 8));
    assert.ok(log.tsv.split(/[\t\n]/).every(cell => !/^[=+@-]/.test(cell.trimStart())));
    assert.ok(log.html.includes('&lt;&amp;&gt;'));
    const exportedColors = await page.evaluate(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return Array.from(doc.querySelectorAll('tr')).slice(1, 6).map(row => row.children[5].style.backgroundColor);
    }, log.html);
    assert.deepEqual(exportedColors, ['rgb(217, 234, 211)', 'rgb(255, 255, 255)', 'rgb(217, 234, 211)', 'rgb(255, 255, 255)', 'rgb(244, 204, 204)']);
    const entries = await page.locator('#taskLog > div').allTextContents();
    assert.ok(entries[0].includes('#3') && entries[1].includes('Off clock') && entries[2].includes('#2') && entries[3].includes('Pause') && entries[4].includes('#1'));
    assert.ok(entries.some(text => text === 'Pauses') && entries.some(text => text === 'Off clock'));
    console.log('PASS: chronological tasks/breaks, bottom summaries, safe differences/reasons, green/red exported status cells.');

    // Inspect both clipboard formats without overwriting the user's clipboard.
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => {
        window.copiedLog = Object.fromEntries(await Promise.all(items[0].types.map(async type => [type, await (await items[0].getType(type)).text()])));
      } } });
    });
    await page.locator('#logDetails').evaluate(el => el.open = true);
    await page.locator('#copyLogButton').click();
    await page.waitForFunction(() => document.querySelector('#copyLogButton').textContent === 'Copied');
    assert.equal(await page.locator('#copyLogButton').textContent(), 'Copied');
    const copied = await page.evaluate(() => window.copiedLog);
    assert.equal(copied['text/plain'], log.tsv);
    assert.equal(copied['text/html'], log.html);
    await page.evaluate(() => {
      navigator.clipboard.write = async () => { throw Error('Async clipboard unavailable'); };
      document.execCommand = () => {
        const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), cancelable: true });
        document.dispatchEvent(event);
        window.legacyLog = { text: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html') };
        return event.defaultPrevented;
      };
    });
    const fallback = await page.evaluate(async () => timerTest.copyFormattedLog(timerTest.buildLogTSV(), timerTest.buildLogHTML()));
    assert.equal(fallback, 'formatted');
    assert.deepEqual(await page.evaluate(() => window.legacyLog), { text: log.tsv, html: log.html });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.TIMER_SCREENSHOT_PATH) await page.screenshot({ path: process.env.TIMER_SCREENSHOT_PATH, fullPage: true });
    console.log('PASS: rich clipboard, legacy clipboard fallback, narrow layout, no browser errors.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
