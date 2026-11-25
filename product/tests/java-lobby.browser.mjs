import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loginWithNickname } from './helpers/nickname.mjs';

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
    if (response.status() >= 400 && !(pathname === '/api/me' && response.status() === 401)) {
      startupErrors.push({ pathname, status: response.status() });
    }
  };
  for (const page of [a, b, c]) page.on('response', watchStartup);
  await Promise.all([a, b, c].map(page => page.goto(origin)));
  const [firstSession, secondSession] = await Promise.all([
    loginWithNickname(a, '同名搭档'), loginWithNickname(b, '同名搭档'), loginWithNickname(c, '观察员'),
  ]);
  assert.notEqual(firstSession.id, secondSession.id);
  await a.reload();
  await a.getByText('已登录 · 同名搭档', { exact: true }).waitFor();
  assert.equal((await (await a.request.get(`${origin}/api/me`)).json()).id, firstSession.id);
  const icon = await a.locator('link[rel="icon"]').getAttribute('href');
  assert.ok(icon && (await a.request.get(new URL(icon, origin).href)).ok());
  assert.deepEqual(startupErrors, []);
  for (const page of [a, b, c]) page.off('response', watchStartup);

  async function round(host, guest, observer) {
    await host.getByRole('button', { name: /双人同步练/ }).click();
    if (observer) await host.getByRole('button', { name: '关键词辅助' }).click();
    const created = host.waitForResponse(response => response.url().endsWith('/api/rooms') &&
      response.request().method() === 'POST' && response.ok());
    await host.getByRole('button', { name: '创建训练室' }).click();
    const { inviteToken, state } = await (await created).json();
    await guest.goto(`${origin}/#invite=${inviteToken}`);
    await guest.getByText('你的座位：复述者', { exact: false }).waitFor();
    assert.equal(await guest.getByLabel('邀请密码').count(), 0);

    if (observer) {
      await host.getByRole('button', { name: '观察者', exact: true }).click();
      const invitation = host.waitForResponse(response => response.url().endsWith('/invitations') && response.ok());
      await host.getByRole('button', { name: '生成观察者邀请' }).click();
      const { token } = await (await invitation).json();
      await observer.goto(`${origin}/#invite=${token}`);
      await observer.getByText('你的座位：观察者', { exact: false }).waitFor();
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
        if (observer) {
          await observer.getByRole('button', { name: '播放表达者录音' }).waitFor();
          assert.equal(await observer.getByRole('button', { name: '开始录音' }).count(), 0);
          await observer.getByRole('button', { name: '查看关键词提示' }).click();
          await observer.getByText('先看望家人，…', { exact: false }).waitFor();
          const points = origin + '/api/rounds/' + snapshot.roundId + '/points';
          assert.equal((await guest.request.get(points)).status(), 403);
          await guest.getByRole('button', { name: '查看关键词提示' }).click();
          await guest.getByText('先看望家人，…', { exact: false }).waitFor();
        }
        await guest.getByRole('button', { name: '播放表达者录音' }).click();
        await guest.getByRole('button', { name: /暂停播放|已听过/ }).waitFor();
        await guest.waitForFunction(() => (document.querySelector('.audio-player audio')?.currentTime ?? 0) > 0.15);
        const engagement = guest.waitForResponse(response => {
          if (!response.url().endsWith('/listener-engagement') || response.status() !== 204) return false;
          const data = response.request().postDataJSON();
          return data.recordingAttempts === 1 && data.playbackMs > 0 && data.dwellMs > 0;
        });
        await guest.getByRole('button', { name: '开始录音', exact: true }).click();
        await engagement;
        await guest.locator('.record-time').getByText('00:01', { exact: true }).waitFor();
        await guest.getByRole('button', { name: '结束录音' }).click();
        const submit = guest.getByRole('button', { name: '确认上传' });
        await submit.waitFor();
        assert.equal(await submit.isEnabled(), true);
        assert.equal(await guest.getByRole('checkbox', { name: /我知晓复述录音提交后会被转写/ }).count(), 0);
        const comparisonCommit = guest.waitForResponse(response => response.url().endsWith('/commit') && response.ok());
        await submit.click();
        assert.equal((await (await comparisonCommit).json()).round.stage, 'COMPARING');
        await host.getByText('演示对照使用预置转写和文字匹配。').waitFor();
        if (observer) {
          await observer.getByRole('heading', { name: '先看差异' }).waitFor();
          await observer.getByRole('button', { name: '播放复述者录音' }).waitFor();
          assert.equal(await observer.getByRole('button', { name: '播放表达者录音' }).count(), 0);
          assert.equal(await observer.getByRole('button', { name: '提交观察建议' }).count(), 0);
          await observer.getByRole('button', { name: '播放复述者录音' }).click();
          await observer.waitForFunction(() => (document.querySelector('.audio-player audio')?.currentTime ?? 0) > 0);
        }
        await host.getByRole('button', { name: '开始整轮标注' }).click();
        await host.getByRole('heading', { name: '表达者整轮标注' }).waitFor();
        await guest.getByRole('heading', { name: '复述者澄清' }).waitFor();
        const initial = await (await guest.request.get(`${origin}/api/rounds/${snapshot.roundId}/comparison`)).json();
        await guest.getByLabel('补充澄清（选填）').fill('我想再核对聚餐前提');
        await guest.getByRole('button', { name: '保存澄清', exact: true }).click();
        await guest.getByText('澄清已保存。').waitFor();
        const saved = await (await guest.request.get(`${origin}/api/rounds/${snapshot.roundId}/comparison`)).json();
        assert.equal(saved.version, initial.version, 'saving a note must not invalidate the speaker’s form');
        assert.equal(saved.wholeRoundFeedback.note, '我想再核对聚餐前提');
        await guest.reload();
        assert.equal(await guest.getByLabel('补充澄清（选填）').inputValue(), '我想再核对聚餐前提');
        const pointChoices = host.getByRole('group', { name: '准确复述的要点（可多选）' }).getByRole('checkbox');
        assert.equal(await pointChoices.count(), initial.issues.length);
        const selected = observer ? initial.issues.slice(0, 1) : [];
        if (selected.length) await pointChoices.first().check();
        await host.getByLabel('遗漏重要信息', { exact: true }).check();
        await host.getByLabel('理解不到位', { exact: true }).check();
        await host.getByLabel('我表达不清', { exact: true }).check();
        assert.equal(await guest.locator('.round-recordings audio').count(), 2);
        assert.equal(await guest.getByRole('button', { name: '确认这一条' }).count(), 0);
        const reviewed = await (await guest.request.get(`${origin}/api/rounds/${snapshot.roundId}/comparison`)).json();
        const denied = await host.request.post(`${origin}/api/rounds/${snapshot.roundId}/review/round-clarification`, {
          headers: { Origin: origin }, data: { expectedVersion: reviewed.version, note: 'forbidden' },
        });
        assert.equal(denied.status(), 403);
        if (observer) {
          await observer.getByRole('heading', { name: '查看本轮回顾' }).waitFor();
          assert.deepEqual(await observer.locator('.round-content .audio-player').evaluateAll(players => players.map(player => player.dataset.recordingLabel)), ['表达者录音', '复述者录音']);
          assert.equal(await observer.getByLabel('补充澄清（选填）').count(), 0);
        }
        await host.getByRole('button', { name: '提交标注', exact: true }).click();
        await host.getByRole('heading', { name: '给表达者的建议' }).waitFor();
        await guest.getByRole('heading', { name: '给复述者的建议' }).waitFor();
        const submittedReview = await (await guest.request.get(`${origin}/api/rounds/${snapshot.roundId}/comparison`)).json();
        assert.deepEqual(submittedReview.wholeRoundFeedback.accuratePointIds, selected.map(point => point.id));
        assert.equal(await host.getByRole('heading', { name: '等待复述者澄清' }).count(), 0);
        if (observer) {
          await observer.getByRole('heading', { name: '给表达者的建议' }).waitFor();
          await observer.getByRole('heading', { name: '给复述者的建议' }).waitFor();
          assert.equal(await observer.locator('.round-content .audio-player').count(), 0);
          assert.equal(await observer.getByRole('button', { name: '采纳这条建议' }).count(), 0);
        }
        const refreshed = host.waitForResponse(async response => response.url().endsWith('/comparison') &&
          response.ok() && (await response.json()).listenerAdviceAccepted === true);
        await guest.getByRole('button', { name: '采纳这条建议' }).click();
        await guest.getByRole('button', { name: '已采纳' }).waitFor();
        await guest.reload();
        await guest.getByRole('button', { name: '已采纳' }).waitFor();
        await refreshed;
        assert.equal(await host.getByRole('button', { name: '已采纳' }).count(), 0);
        await host.getByRole('button', { name: '采纳这条建议' }).click();
        await host.getByRole('button', { name: '已采纳' }).waitFor();
        await host.getByRole('button', { name: '归档本轮并查看报告' }).click();
        await guest.getByText('本轮报告已归档。').waitFor();
        await guest.getByText('澄清：我想再核对聚餐前提').waitFor();
        await guest.getByRole('heading', { name: '表达者审核结果' }).waitFor();
        assert.equal(await guest.locator('.point-review-result strong').textContent(), `${selected.length} / ${initial.issues.length}`);
        assert.equal(await guest.locator('.comparison-grid').count(), 0);
        assert.equal(await guest.getByRole('heading', { name: '全文逐句对照' }).count(), 0);
        assert.equal(await guest.locator('.point-review-details article').count(), initial.issues.length - selected.length);
        const ownRecording = (page, label) => page.locator(`.report-media [data-recording-label="${label}"]`);
        const hostConsent = ownRecording(host, '表达者录音').getByRole('button', { name: '上传素材库', exact: true });
        const guestConsent = ownRecording(guest, '复述者录音').getByRole('button', { name: '上传素材库', exact: true });
        await hostConsent.waitFor();
        await guestConsent.waitFor();
        const consentPath = `${origin}/api/rounds/${snapshot.roundId}/audio/${audioId}/material-consent`;
        assert.equal((await guest.request.get(consentPath)).status(), 403);
        assert.equal((await guest.request.post(consentPath, { headers: { Origin: origin } })).status(), 403);
        if (observer) assert.equal((await observer.request.get(consentPath)).status(), 403);
        assert.equal(await ownRecording(host, '复述者录音').getByRole('button', { name: '上传素材库', exact: true }).count(), 0);
        assert.equal(await ownRecording(guest, '表达者录音').getByRole('button', { name: '上传素材库', exact: true }).count(), 0);
        host.once('dialog', dialog => dialog.accept());
        await hostConsent.click();
        await host.getByRole('button', { name: '已同意上传', exact: true }).waitFor();
        await host.reload();
        await host.getByRole('button', { name: '已同意上传', exact: true }).waitFor();
        assert.deepEqual(await (await host.request.post(consentPath, { headers: { Origin: origin } })).json(), { submitted: true });
        assert.equal(await guestConsent.isEnabled(), true);
        if (observer) {
          await observer.getByRole('button', { name: '返回训练室，继续做观察者' }).click();
          const snapshot = await (await observer.request.get(`${origin}/api/rooms/${state.id}`)).json();
          assert.equal(snapshot.reportRole, 'observer');
          assert.equal(snapshot.speakerAudioId, null);
          assert.equal(snapshot.listenerAudioId, null);
        }
        await guest.getByRole('checkbox', { name: '匿名显示座位代号' }).check();
        await guest.getByText('座位 A / 座位 B', { exact: false }).waitFor();
        const exportReport = await guest.getByRole('link', { name: '导出本轮报告（TXT）' }).getAttribute('href');
        assert.match(decodeURIComponent(exportReport), /座位 A\n座位 B/);
        assert.ok(decodeURIComponent(exportReport).includes(`准确度：${selected.length} / ${initial.issues.length}`));
        assert.doesNotMatch(decodeURIComponent(exportReport), /先看望家人/);
        await host.getByRole('button', { name: '返回训练室，成为复述者' }).click();
        await guest.getByRole('button', { name: '返回训练室，成为表达者' }).click();
        await guest.getByRole('button', { name: '准备好了' }).click();
        assert.equal(await guest.getByRole('button', { name: '开始本轮' }).isDisabled(), true);
        await host.getByRole('button', { name: '准备好了' }).click();
        const secondStart = guest.waitForResponse(response => response.url().endsWith('/start') && response.ok());
        await guest.getByRole('button', { name: '开始本轮' }).click();
        const next = await (await secondStart).json();
        assert.equal(next.stage, 'TASK');
        assert.equal(next.deadlineAt, null);
        assert.notEqual(next.roundId, snapshot.roundId);
        assert.equal(next.previousPractice.total, 1);
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
  const account = await (await a.request.get(`${origin}/api/me`)).json();
  a.once('dialog', dialog => dialog.accept());
  await a.getByRole('button', { name: '退出登录', exact: true }).click();
  await a.getByRole('heading', { name: '昵称登录', exact: true }).waitFor();
  assert.equal((await a.request.get(`${origin}/api/me`)).status(), 401);
  await loginWithNickname(a, account.nickname);
  assert.notEqual((await (await a.request.get(`${origin}/api/me`)).json()).id, account.id);
  console.log('Three Java browser sessions passed: startup, reload, recording, re-recording and reversed roles in a fresh room.');
  if (verifyUpload) console.log('Both browser recordings reached confirmed storage and authorized range playback.');
  if (verifyProcessing) console.log('Both practice rooms passed mock transcription, comparison, whole-round feedback, anonymous export and same-room restart.');
} finally {
  await browser.close();
}
