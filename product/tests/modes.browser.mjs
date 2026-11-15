import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://127.0.0.1:3100';
const executablePath = process.env.BROWSER_EXECUTABLE ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];

async function mobile() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByText('匿名会话已建立').waitFor();
  return page;
}

async function simulateBrokenMediaRecorder(page) {
  await page.addInitScript(() => {
    window.MediaRecorder = class extends EventTarget {
      static isTypeSupported(type) { return type === 'audio/webm'; }
      mimeType = 'audio/webm';
      state = 'inactive';
      start(...args) { if (args.length) throw new Error('Expected stop-time encoding'); this.state = 'recording'; }
      pause() { this.state = 'paused'; }
      resume() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob([new Uint8Array(5)], { type: 'audio/webm' }) });
          this.onstop?.();
        });
      }
    };
  });
  await page.reload();
}

const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const room = page => page.evaluate(async () => (await fetch(`/api/rooms/${new URLSearchParams(location.search).get('room')}`)).json());
const status = (page, path) => page.evaluate(async url => (await fetch(url)).status, path);

async function setup(page, mode, childRole) {
  await page.getByRole('button', { name: new RegExp(mode) }).click();
  await click(page, '关键词辅助');
  if (childRole) {
    await page.getByLabel('孩子昵称').fill('小禾');
    await click(page, childRole);
    await page.getByLabel('设置 6 位监护人退出码').fill('429613');
    await page.getByLabel('我是监护人，同意本次训练、录音和转写。').check();
  }
  const created = page.waitForResponse(result => result.url().endsWith('/api/rooms') && result.request().method() === 'POST');
  await click(page, '创建训练室');
  const response = await created;
  assert.ok(response.ok());
  await click(page, '准备好了');
  await click(page, '开始本轮');
  return response.json();
}

async function record(page, listener = false) {
  await click(page, '开始录音');
  await page.getByRole('button', { name: '暂停录音' }).waitFor();
  await page.waitForTimeout(650);
  await click(page, '结束录音');
  if (listener) await page.getByLabel('我知晓复述录音提交后会被转写，用于本轮逐条对照。').check();
  await click(page, '确认上传');
}

async function express(page) {
  await click(page, '开始表达录音');
  await record(page);
  await page.getByLabel('信息点内容').fill('午饭要看外婆身体情况');
  await click(page, '添加信息点');
  await page.getByLabel('信息点内容').fill('累了就早点回家');
  await click(page, '添加信息点');
  await click(page, '确认重点，请搭档复述');
}

async function guardianReturn(page) {
  await page.getByLabel('监护人退出码').fill('000000');
  await click(page, '监护人已接回手机');
  await page.getByText('监护人退出码不正确。').waitFor();
  await page.getByLabel('监护人退出码').fill('429613');
  await click(page, '监护人已接回手机');
  await page.getByRole('button', { name: '监护人已接回手机' }).waitFor({ state: 'hidden' });
}

async function sameDeviceReport(page) {
  await click(page, '请表达者逐条标注');
  await click(page, '提交标注，邀请双方确认');
  await click(page, '确认这一条');
  await click(page, '切换到复述者座位');
  await click(page, '确认这一条');
  await click(page, '切换到表达者座位');
  await click(page, '表达者提交，查看改写建议');
  await click(page, '归档本轮并查看报告');
  await page.getByText('本轮报告已归档。').waitFor();
}

try {
  const [asyncHost, asyncGuest, solo, teen] = await Promise.all([mobile(), mobile(), mobile(), mobile()]);
  const asyncRoom = await setup(asyncHost, '异步留言练');
  await express(asyncHost);
  await asyncHost.getByText('留言已送达训练室，等待复述者打开。').waitFor();
  await asyncGuest.goto(`${origin}/#invite=${asyncRoom.inviteToken}`);
  await click(asyncGuest, '加入');
  await asyncGuest.waitForURL(`${origin}/?room=${asyncRoom.state.id}`);
  const message = await room(asyncGuest);
  assert.equal(message.stage, 'ASYNC_PENDING');
  assert.equal(await status(asyncGuest, `/api/rounds/${message.roundId}/audio/${message.speakerAudioId}/access`), 403);
  await click(asyncGuest, '打开留言，开始复述');
  await click(asyncGuest, '查看关键词提示');
  await asyncGuest.getByText('重点 · 午饭要看外婆…').waitFor();
  await simulateBrokenMediaRecorder(asyncGuest);
  await click(asyncGuest, '开始录音');
  await asyncGuest.getByRole('button', { name: '暂停录音' }).waitFor();
  await asyncGuest.getByText('00:30', { exact: true }).waitFor({ timeout: 35_000 });
  await asyncGuest.getByLabel('我知晓复述录音提交后会被转写，用于本轮逐条对照。').check();
  const preview = asyncGuest.locator('.recorder audio');
  await preview.evaluate(audio => new Promise((resolve, reject) => {
    if (audio.readyState >= 1) return resolve();
    if (audio.error) return reject(audio.error.message);
    audio.addEventListener('loadedmetadata', resolve, { once: true });
    audio.addEventListener('error', () => reject(audio.error.message), { once: true });
  }));
  assert.ok(await preview.evaluate(audio => audio.duration) >= 28, 'playable fallback preserves the full recording');
  const wavUpload = asyncGuest.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/uploads'));
  await click(asyncGuest, '确认上传');
  const fallback = (await wavUpload).postDataJSON();
  assert.equal(fallback.mimeType, 'audio/wav');
  assert.ok(fallback.byteSize >= 896_044);
  await asyncHost.getByRole('heading', { name: '先看差异' }).waitFor();
  await click(asyncHost, '请表达者逐条标注');
  await click(asyncHost, '提交标注，邀请双方确认');
  await click(asyncHost, '确认这一条');
  await click(asyncGuest, '确认这一条');
  await click(asyncHost, '表达者提交，查看改写建议');
  await click(asyncHost, '归档本轮并查看报告');
  await asyncHost.getByText(/提示级别 3/).waitFor();
  await click(asyncHost, '结束并关闭训练室');

  await setup(solo, '双座位自练');
  await express(solo);
  await click(solo, '确认交棒');
  await record(solo, true);
  await sameDeviceReport(solo);
  await click(solo, '结束并关闭训练室');

  await setup(teen, '亲子同机练', '表达者');
  await click(teen, '确认交棒给 小禾');
  await teen.getByRole('button', { name: '交还监护人' }).waitFor();
  assert.equal(await status(teen, '/api/history'), 403);
  const childState = await room(teen);
  assert.equal(childState.teen.locked, true);
  assert.equal(await teen.evaluate(async id => (await fetch(`/api/rooms/${id}/leave`, { method: 'POST' })).status, childState.id), 403);
  await teen.goto(origin);
  await teen.waitForURL(`${origin}/?room=${childState.id}`);
  const replaceSession = await teen.request.post(`${origin}/api/sessions/anonymous`, {
    headers: { Origin: origin }, data: { nickname: '尝试切换身份' },
  });
  assert.equal(replaceSession.status(), 403);
  await express(teen);
  await teen.getByRole('heading', { name: '请把手机交还监护人' }).waitFor();
  await guardianReturn(teen);
  assert.equal(await status(teen, '/api/history'), 200);
  await record(teen, true);
  await sameDeviceReport(teen);
  await click(teen, '结束并关闭训练室');

  await setup(teen, '亲子同机练', '复述者');
  await express(teen);
  await click(teen, '确认交棒给 小禾');
  await record(teen, true);
  await guardianReturn(teen);
  await sameDeviceReport(teen);
  await click(teen, '结束并关闭训练室');

  assert.deepEqual(errors, []);
  console.log('Async invite after sending, solo handoff, and both guardian seat assignments passed');
} finally { await browser.close(); }
