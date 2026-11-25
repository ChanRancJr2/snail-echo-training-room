import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loginWithNickname } from './helpers/nickname.mjs';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://localhost:3121';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE ?? (process.platform === 'win32'
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const errors = [];
const button = (page, name) => page.getByRole('button', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, exact: true });
const click = (page, name) => button(page, name).click();
async function open(name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await loginWithNickname(page, name);
  return page;
}

async function snapshot(page) {
  const roomId = new URL(page.url()).searchParams.get('room');
  assert.ok(roomId);
  const response = await page.request.get(`${origin}/api/rooms/${roomId}`);
  assert.equal(response.status(), 200);
  return response.json();
}

async function create(page, mode) {
  await page.getByRole('button', { name: new RegExp('^' + mode) }).click();
  const response = page.waitForResponse(response => response.url().endsWith('/api/rooms') &&
    response.request().method() === 'POST' && response.ok());
  await click(page, '创建训练室');
  return (await response).json();
}

async function record(page, listener = false) {
  await click(page, '开始录音');
  await page.locator('.record-time').getByText('00:01', { exact: true }).waitFor();
  await click(page, '结束录音');
  await button(page, '确认上传并转写').waitFor();
  if (listener) assert.equal(await page.getByRole('checkbox', { name: /我知晓复述录音提交后会被转写/ }).count(), 0);
  const response = page.waitForResponse(response => response.url().endsWith('/commit'));
  await click(page, '确认上传并转写');
  assert.equal((await response).status(), 200);
}

async function express(page, beforePoints) {
  await click(page, '开始表达录音');
  await record(page);
  await heading(page, '本轮信息点').waitFor();
  await page.getByText(/演示转写：/).waitFor();
  await page.getByRole('textbox', { name: '信息点内容' }).fill('先看望家人，再决定是否聚餐');
  await click(page, '添加信息点');
  if (beforePoints) await beforePoints();
  await click(page, '确认重点，请搭档复述');
}

async function sameDevice(page) {
  await create(page, '双座位自练');
  await click(page, '准备好了');
  await click(page, '开始本轮');
  await heading(page, '先定这轮任务').waitFor();
  const first = await snapshot(page);
  assert.equal(first.stage, 'TASK');
  assert.equal(first.mode, 'solo');
  await express(page);
  await page.getByRole('button', { name: /^确认交棒/ }).click();
  await click(page, '播放表达者录音');
  await page.getByRole('button', { name: /暂停播放|已听过/ }).waitFor();
  await record(page, true);
  await click(page, '开始整轮标注');
  await page.getByRole('group', { name: '准确复述的要点（可多选）' }).getByLabel('先看望家人，再决定是否聚餐').check();
  await page.getByLabel('语意被误解', { exact: true }).check();
  const label = page.waitForResponse(response => response.url().endsWith('/review/round-labels'));
  await click(page, '提交标注，查看建议');
  assert.equal((await label).status(), 200);
  await heading(page, '本轮建议').waitFor();
  assert.equal((await snapshot(page)).stage, 'ADVICE');
  assert.equal(await heading(page, '把误解逐条聊清楚').count(), 0);
  await page.reload();
  await heading(page, '本轮建议').waitFor();
  await click(page, '归档本轮并查看报告');
  await heading(page, '本轮报告').waitFor();
  await page.getByText('人工标注的准确复述要点：先看望家人，再决定是否聚餐', { exact: true }).waitFor();
  await page.getByText(/第 8 步 \/ 8/).waitFor();
  await page.getByRole('link', { name: '导出本轮报告（TXT）' }).waitFor();
  const speakerAudio = page.locator('[data-recording-label="表达者录音"]');
  const listenerAudio = page.locator('[data-recording-label="复述者录音"]');
  const speakerConsent = speakerAudio.getByRole('button', { name: '上传素材库', exact: true });
  const listenerConsent = listenerAudio.getByRole('button', { name: '上传素材库', exact: true });
  await speakerConsent.waitFor();
  await listenerConsent.waitFor();
  page.once('dialog', dialog => dialog.accept());
  await speakerConsent.click();
  await speakerAudio.getByRole('button', { name: '已同意上传', exact: true }).waitFor();
  assert.ok(await listenerConsent.isEnabled());
  await click(page, '再练一轮');
  await click(page, '准备好了');
  await click(page, '开始本轮');
  await heading(page, '先定这轮任务').waitFor();
  const second = await snapshot(page);
  assert.equal(second.stage, 'TASK');
  assert.notEqual(second.roundId, first.roundId);
  assert.equal(second.deadlineAt, null);
  await click(page, '结束并关闭训练室');
}

async function asyncRoom(host, guest, early) {
  const { inviteToken, state } = await create(host, '异步留言练');
  await heading(host, '邀请搭档，开始游戏').waitFor();
  assert.equal(await host.getByLabel('有效期').inputValue(), '0');
  assert.equal(await host.getByRole('button', { name: /^(复述者|观察者|准备好了)$/ }).count(), 0);
  const invitationUrl = await host.getByRole('textbox', {name: '邀请链接'}).inputValue();
  assert.equal(invitationUrl, `${origin}/#invite=${inviteToken}`);
  const waiting = guest.getByText('正在等待表达者录音并确认重点。', { exact: true });
  const join = async () => {
    await guest.goto(invitationUrl);
    await guest.waitForURL(`${origin}/?room=${state.id}`);
    assert.equal(await button(guest, '准备好了').count(), 0);
  };
  assert.ok(inviteToken);
  if (early) {
    await join();
    await waiting.waitFor();
  }
  await click(host, '开始本轮');
  await heading(host, '先定这轮任务').waitFor();
  assert.equal(await host.locator('.invite-card').count(), 0);
  assert.equal(await guest.locator('.invite-card').count(), 0);
  if (early) await waiting.waitFor();
  await express(host, early ? () => waiting.waitFor() : undefined);
  await host.getByText('留言已送达训练室，等待复述者打开。', { exact: true }).waitFor();
  assert.equal(await host.locator('.invite-card').count(), 0);
  if (!early) await join();
  await button(guest, '打开留言，开始复述').waitFor();
  const pending = await snapshot(guest);
  assert.equal(pending.stage, 'ASYNC_PENDING');
  const stored = await snapshot(host);
  const access = `${origin}/api/rounds/${stored.roundId}/audio/${stored.speakerAudioId}/access`;
  assert.equal((await guest.request.get(access)).status(), 403);
  await click(guest, '打开留言，开始复述');
  await click(guest, '播放表达者录音');
  assert.equal((await snapshot(guest)).stage, 'LISTENER_RETELL');
  assert.equal((await guest.request.get(access)).status(), 200);
  if (!early) {
    await record(guest, true);
    await click(host, '开始整轮标注');
    await heading(guest, '复述者澄清').waitFor();
    assert.equal(await guest.getByRole('group', { name: '准确复述的要点（可多选）' }).count(), 0);
    await host.getByRole('group', { name: '准确复述的要点（可多选）' }).getByLabel('先看望家人，再决定是否聚餐').check();
    await button(guest, '播放表达者录音').waitFor();
    await button(guest, '播放复述者录音').waitFor();
    await click(host, '提交标注');
    await heading(guest, '给复述者的建议').waitFor();
    await click(host, '归档本轮并查看报告');
    await heading(guest, '本轮报告').waitFor();
    await guest.getByText('人工标注的准确复述要点：先看望家人，再决定是否聚餐', { exact: true }).waitFor();
    const hostUpload = host.locator('[data-recording-label="表达者录音"]').getByRole('button', { name: '上传素材库', exact: true });
    const guestUpload = guest.locator('[data-recording-label="复述者录音"]').getByRole('button', { name: '上传素材库', exact: true });
    await hostUpload.waitFor();
    await guestUpload.waitFor();
    guest.once('dialog', dialog => dialog.accept());
    await guestUpload.click();
    await guest.getByRole('button', { name: '已同意上传', exact: true }).waitFor();
    assert.ok(await hostUpload.isEnabled());
    await click(guest, '返回留言列表');
    await heading(guest, '收到的异步留言').waitFor();
    await guest.getByRole('button', { name: /本轮已完成$/ }).click();
    await heading(guest, '本轮报告').waitFor();
  }
  await click(host, '结束并关闭训练室');
  await guest.getByText('训练室已关闭或会话已失效').waitFor();
}

try {
  const [solo, host, guest] = await Promise.all(['双座位玩家', '留言表达者', '留言复述者'].map(open));
  assert.equal(await solo.getByRole('button', { name: /^亲子同机练/ }).count(), 0);
  const retired = await solo.request.post(`${origin}/api/rooms`, { headers: { Origin: origin }, data: {
    mode: 'teen', createKey: 'retired-mode-check', durationSeconds: 30, retellStyle: 'auditory',
  } });
  assert.equal(retired.status(), 400);
  await sameDevice(solo);
  await asyncRoom(host, guest, true);
  await asyncRoom(host, guest, false);
  assert.deepEqual(errors, []);
  console.log('Java browser regression passed: same-device practice and early/late asynchronous invitations.');
} finally {
  await browser.close();
}
