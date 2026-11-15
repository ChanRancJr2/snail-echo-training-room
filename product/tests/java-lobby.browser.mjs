import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://localhost:3100';
const verifyProcessing = process.env.ECHO_JAVA_TEST_PROCESSING === '1';
const verifyUpload = verifyProcessing || process.env.ECHO_JAVA_TEST_UPLOAD === '1';
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
      if (verifyProcessing) {
        await host.getByText('演示转写：周六先看望家人，再决定是否聚餐。').waitFor();
        await host.getByRole('textbox', { name: '信息点内容' }).fill('先看望家人，再决定是否聚餐');
        await host.getByRole('button', { name: '添加信息点' }).click();
        await host.getByRole('button', { name: '确认重点，请搭档复述' }).click();
        await guest.getByRole('button', { name: '播放表达者录音' }).click();
        await guest.getByRole('button', { name: /暂停播放|已听过/ }).waitFor();
        await guest.getByRole('button', { name: '开始录音', exact: true }).click();
        await guest.locator('.record-time').getByText('00:01', { exact: true }).waitFor();
        await guest.getByRole('button', { name: '结束录音' }).click();
        const submit = guest.getByRole('button', { name: '确认上传' });
        await submit.waitFor();
        assert.equal(await submit.isDisabled(), true);
        await guest.getByRole('checkbox', { name: /我知晓复述录音提交后会被转写/ }).check();
        const comparisonCommit = guest.waitForResponse(response => response.url().endsWith('/commit') && response.ok());
        await submit.click();
        assert.equal((await (await comparisonCommit).json()).round.stage, 'COMPARING');
        await host.getByText('演示对照使用预置转写和文字匹配。').waitFor();
        if (observer) {
          await observer.getByRole('textbox', { name: '第 1 条观察建议' }).fill('可以问清聚餐前提');
          await observer.getByRole('button', { name: '提交观察建议' }).click();
          await host.getByText(/观察者建议.*可以问清聚餐前提/).waitFor();
        }
        await host.getByRole('button', { name: '请表达者逐条标注' }).click();
        await host.getByRole('combobox', { name: /结论/ }).selectOption('expression');
        await host.getByRole('button', { name: '提交标注，邀请双方确认' }).click();
        const reviewSubmit = host.getByRole('button', { name: '表达者提交，查看改写建议' });
        await reviewSubmit.waitFor();
        assert.equal(await reviewSubmit.isDisabled(), true);
        await host.getByRole('button', { name: '确认这一条' }).click();
        await guest.getByText('待双方确认的结论：表达问题').waitFor();
        await guest.getByText('表达者：已确认 · 复述者：待确认').waitFor();
        await guest.getByRole('button', { name: '确认这一条' }).click();
        assert.equal(await guest.getByRole('button', { name: '表达者提交，查看改写建议' }).count(), 0);
        await reviewSubmit.click();
        await host.getByRole('heading', { name: '下一次可以这样确认' }).waitFor();
        await host.getByRole('button', { name: '采纳这条建议' }).click();
        await host.getByRole('button', { name: '已采纳' }).waitFor();
        await host.getByRole('button', { name: '归档本轮并查看报告' }).click();
        await guest.getByText('本轮报告已归档。').waitFor();
        if (observer) {
          const snapshot = await (await observer.request.get(`${origin}/api/rooms/${state.id}`)).json();
          assert.equal(snapshot.stage, null);
          assert.equal(snapshot.speakerAudioId, null);
          assert.equal(snapshot.listenerAudioId, null);
        }
        await guest.getByRole('checkbox', { name: '匿名显示座位代号' }).check();
        await guest.getByText('座位 A / 座位 B', { exact: false }).waitFor();
        const exportReport = await guest.getByRole('link', { name: '导出本轮报告（TXT）' }).getAttribute('href');
        assert.match(decodeURIComponent(exportReport), /座位 A\n座位 B/);
        assert.doesNotMatch(decodeURIComponent(exportReport), /先看望家人/);
        await host.getByRole('button', { name: '返回训练室，准备下一轮' }).click();
        await guest.getByRole('button', { name: '返回训练室，准备下一轮' }).click();
        await host.getByRole('button', { name: '准备好了' }).click();
        assert.equal(await host.getByRole('button', { name: '开始本轮' }).isDisabled(), true);
        await guest.getByRole('button', { name: '准备好了' }).click();
        const secondStart = host.waitForResponse(response => response.url().endsWith('/start') && response.ok());
        await host.getByRole('button', { name: '开始本轮' }).click();
        const next = await (await secondStart).json();
        assert.equal(next.stage, 'TASK');
        assert.equal(next.deadlineAt, null);
        assert.notEqual(next.roundId, snapshot.roundId);
        assert.deepEqual(next.previousPractice, { complete: 0, total: 1 });
        await host.getByText(/上轮采纳的建议/).waitFor();
      }
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
  if (verifyProcessing) console.log('Both practice rooms passed Mock transcription, comparison, mutual confirmation, anonymous export and same-room restart.');
} finally {
  await browser.close();
}
