import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://localhost:3121';
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
try {
  for (const resultVersion of [11, 9]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let roomReads = 0;
    let comparisonReads = 0;
    const currentVersion = Math.max(10, resultVersion);
    const mutations = [];
    await page.route('**/*', async route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/me') return route.fulfill({ json: { id: 'listener', nickname: '版本核对', named: true } });
      if (pathname === '/api/rooms/version-room') return route.fulfill({ json: {
        id: 'version-room', version: 1, mode: 'async', status: 'ACTIVE', durationSeconds: 30,
        retellStyle: 'auditory', topic: '家庭日常', roundId: 'version-round', stage: 'LISTENER_CLARIFICATION',
        roundVersion: ++roomReads === 1 ? 10 : currentVersion, activeSeat: 'listener',
        deadlineAt: null, speakerAudioId: null, listenerAudioId: null, previousPractice: null,
        teen: null, you: { role: 'listener', ready: true }, members: [],
      } });
      if (pathname === '/api/rounds/version-round/comparison') return route.fulfill({ json: {
        version: ++comparisonReads === 1 ? resultVersion : currentVersion,
        total: 1, complete: 0, accurate: 0, adviceAccepted: false,
        issues: [{ id: 'condition', category: '重点', original: '身体允许再聚餐。',
          speakerQuote: '身体允许再聚餐。', listenerQuote: '一起聚餐。', complete: false, accurate: false,
          tag: '遗漏重要信息', resolution: 'misunderstanding', speakerConfirmed: true, listenerConfirmed: false }],
      } });
      if (pathname === '/api/rounds/version-round/review/round-clarification') {
        const command = route.request().postDataJSON();
        mutations.push(command);
        return route.fulfill({ status: command.expectedVersion === currentVersion ? 200 : 409,
          json: { id: 'version-round', stage: 'LISTENER_CLARIFICATION', version: currentVersion } });
      }
      if (pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      // Serve the current build through the test browser; no extra local listening port is needed.
      if (process.env.ECHO_BROWSER_LOCAL_ASSETS === '1') {
        const root = resolve('dist/web');
        const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        assert.ok(file.startsWith(root + '/') || file.startsWith(root + '\\'));
        const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)];
        return route.fulfill({ body: await readFile(file), contentType });
      }
      return route.continue();
    });
    await page.goto(`${origin}/?room=version-room`);
    await page.getByLabel('补充澄清（选填）').fill('请核对条件');
    const confirm = page.getByRole('button', { name: '保存澄清', exact: true });
    await confirm.waitFor();
    const response = page.waitForResponse(value => value.url().endsWith('/review/round-clarification'));
    await confirm.click();
    assert.equal((await response).status(), 200, 'confirmation must use the version belonging to the displayed comparison');
    assert.deepEqual(mutations, [{ expectedVersion: currentVersion, note: '请核对条件' }]);
    assert.ok(roomReads >= 2 && comparisonReads >= 2, 'a mismatched result refreshes the room and comparison before editing');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Comparison version regression passed: newer and stale results refresh before confirmation.');
} finally {
  await browser.close();
}
