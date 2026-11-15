import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://localhost:3100';
const verifyUpload = process.env.ECHO_JAVA_TEST_UPLOAD === '1';
const executablePath = process.env.BROWSER_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const browser = await chromium.launch({
  executablePath,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const [a, b, c] = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  }).then(context => context.newPage())));
  const startupErrors = [];
  const watchStartup = response => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 400) startupErrors.push({ pathname, status: response.status() });
  };
  for (const page of [a, b, c]) page.on('response', watchStartup);
  await Promise.all([a, b, c].map(page => page.goto(origin)));
  await Promise.all([a, b, c].map(page => page.getByText('匿名会话已建立').waitFor()));
  const icon = await a.locator('link[rel="icon"]').getAttribute('href');
  assert.ok(icon && (await a.request.get(new URL(icon, origin).href)).ok());
  assert.deepEqual(startupErrors, []);
  for (const page of [a, b, c]) page.off('response', watchStartup);

  async function round(host, guest, observer) {
    await host.getByRole('button', { name: /双人同步练/ }).click();
    const created = host.waitForResponse(response => response.url().endsWith('/api/rooms') &&
      response.request().method() === 'POST' && response.ok());
    await host.getByRole('button', { name: '创建训练室' }).click();
    const { inviteToken, state } = await (await created).json();
    await guest.goto(`${origin}/#invite=${inviteToken}`);
    await guest.getByRole('button', { name: '加入', exact: true }).click();

    if (observer) {
      await host.getByRole('button', { name: '观察者', exact: true }).click();
      const invitation = host.waitForResponse(response => response.url().endsWith('/invitations') && response.ok());
      await host.getByRole('button', { name: '生成观察者邀请' }).click();
      const { token } = await (await invitation).json();
      await observer.goto(`${origin}/#invite=${token}`);
      await observer.getByRole('button', { name: '加入', exact: true }).click();
      await observer.getByRole('button', { name: '准备好了' }).click();
      await observer.getByRole('button', { name: '取消准备' }).waitFor();
    }

    await host.getByRole('button', { name: '准备好了' }).click();
    const start = host.getByRole('button', { name: '开始本轮' });
    assert.equal(await start.isDisabled(), true);
    await guest.getByRole('button', { name: '准备好了' }).click();
    await start.click();
    await host.getByRole('heading', { name: '先定这轮任务' }).waitFor();
    const snapshot = await host.evaluate(async id => (await fetch(`/api/rooms/${id}`)).json(), state.id);
    assert.equal(snapshot.stage, 'TASK');
    assert.equal(snapshot.deadlineAt, null);
    await host.reload();
    await host.getByRole('heading', { name: '先定这轮任务' }).waitFor();
    await host.getByRole('button', { name: '开始表达录音' }).click();
    const beginning = host.waitForResponse(response => response.url().endsWith('/task') && response.ok());
    await host.getByRole('button', { name: '开始录音', exact: true }).click();
    const recording = await (await beginning).json();
    assert.equal(recording.stage, 'SPEAKER_RECORDING');
    const remaining = Date.parse(recording.deadlineAt) - Date.now();
    assert.ok(remaining > 25_000 && remaining <= 31_000, `unexpected recording window ${remaining}ms`);
    await host.getByRole('button', { name: '结束录音' }).waitFor();
    await host.getByRole('button', { name: '删除录音，重新录入' }).click();
    const restarting = host.waitForResponse(response => response.url().endsWith('/restart-recording') && response.ok());
    await host.getByRole('button', { name: '开始录音', exact: true }).click();
    const restarted = await (await restarting).json();
    assert.equal(restarted.version, recording.version + 1);
    assert.ok(Date.parse(restarted.deadlineAt) > Date.parse(recording.deadlineAt));
    if (verifyUpload) {
      await host.locator('.record-time').getByText('00:01', { exact: true }).waitFor();
      await host.getByRole('button', { name: '结束录音' }).click();
      const confirm = host.waitForResponse(response => response.url().endsWith('/commit'));
      const upload = host.waitForResponse(response => response.request().method() === 'PUT');
      await host.getByRole('button', { name: '确认上传' }).click();
      assert.ok((await upload).ok(), 'cross-origin storage upload failed');
      const confirmed = await confirm;
      assert.equal(confirmed.status(), 200);
      const { audioId, round } = await confirmed.json();
      assert.equal(round.stage, 'KEYPOINT_CONFIRM');
      await host.getByRole('heading', { name: '本轮信息点' }).waitFor();
      const access = `${origin}/api/rounds/${snapshot.roundId}/audio/${audioId}/access`;
      assert.equal((await guest.request.get(access)).status(), 403);
      const audio = await host.request.get(access);
      assert.equal(audio.status(), 200);
      const { url } = await audio.json();
      const playback = await host.request.get(url, { headers: { Range: 'bytes=0-15' } });
      assert.equal(playback.status(), 206);
      assert.equal((await playback.body()).length, 16);
    }
    await host.getByRole('button', { name: '结束并关闭训练室' }).click();
    await guest.getByText('训练室已关闭或会话已失效').waitFor();
    return snapshot;
  }

  const first = await round(a, b, c);
  const second = await round(b, a);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.roundId, second.roundId);
  console.log('Three Java browser sessions passed: startup, reload, recording, re-recording and reversed roles in a fresh room.');
  if (verifyUpload) console.log('Both browser recordings reached confirmed storage and authorized range playback.');
} finally {
  await browser.close();
}
