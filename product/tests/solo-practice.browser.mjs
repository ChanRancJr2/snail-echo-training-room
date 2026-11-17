import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loginWithNickname } from './helpers/nickname.mjs';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://127.0.0.1:3100';
const verifyJavaArchive = process.env.ECHO_JAVA_TEST_PROCESSING === '1';
const executablePath = process.env.BROWSER_EXECUTABLE ?? (process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', { name, exact: true });
  const heading = name => page.getByRole('heading', { name, exact: true });
  async function expectExit() {
    const exit = page.locator('.solo-practice > button.danger:last-child');
    assert.equal(await exit.textContent({ timeout: 5000 }), '结束并关闭训练室');
  }

  await page.goto(origin);
  const session = await loginWithNickname(page, '单人练习测试');
  await page.getByRole('button', { name: /^单人练习/ }).click();
  await heading('录音主题').waitFor();
  await expectExit();
  assert.equal(await page.locator('audio').count(), 0);
  assert.equal(await heading('小组汇报的分工').count(), 0);
  assert.equal(await button('30 秒').getAttribute('aria-pressed'), 'true');
  for (const label of ['1 分钟', '2 分钟', '5 分钟']) await button(label).waitFor();

  await button('大学生活').click();
  await button('1 分钟').click();
  await button('开始练习').click();
  await heading('小组汇报的分工').waitFor();
  await expectExit();
  await page.getByText('第 2 / 6 步', { exact: true }).waitFor();
  await page.getByText(/最长 60 秒/).waitFor();
  const sample = page.locator('.solo-listen audio');
  assert.equal(await sample.getAttribute('src'), '/practice-audio/campus.mp3');
  assert.equal(await sample.getAttribute('controls'), null);
  await button('播放录音').click();
  await button('暂停播放').click();
  await button('继续播放').click();
  await button('暂停播放').waitFor();
  await sample.evaluate(audio => { audio.currentTime = Math.max(0, audio.duration - 0.1); });
  await button('重新播放').click();
  await button('暂停播放').waitFor();
  await button('提示词').click();
  await page.getByText('开场介绍', { exact: true }).waitFor();

  async function record() {
    await button('开始录音').click();
    await button('暂停录音').waitFor();
    assert.equal(await sample.evaluate(audio => audio.paused), true);
    assert.equal(await button('继续播放').isDisabled(), true);
    await page.getByText('00:01', { exact: true }).waitFor();
    await button('结束录音').click();
    await button('确认复述').click();
    await heading('先看差异').waitFor();
  }

  await record();
  await expectExit();
  for (const label of ['完整度', '准确度', '偏差类型', '可澄清点']) {
    await page.getByText(label, { exact: true }).waitFor();
  }
  await page.getByText(/当前结果使用预置的示例复述/).waitFor();
  const firstIssue = page.locator('.solo-issue').first();
  await firstIssue.locator('summary').click();
  await firstIssue.getByText('录音原句', { exact: true }).waitFor();
  await firstIssue.getByText('示例复述', { exact: true }).waitFor();
  await button('确认').click();
  await heading('把误解逐条聊清楚').waitFor();
  await expectExit();
  await button('提交，查看改写建议').click();
  await heading('把误解逐条聊清楚').waitFor();
  assert.equal(await page.getByLabel('结论', { exact: true }).first().evaluate(field => field.validity.valueMissing), true);
  for (const field of await page.getByLabel('结论', { exact: true }).all()) {
    await field.selectOption('真误解');
  }
  await page.getByLabel('补充澄清（选填）').first().fill('确认图表和开场的分工');
  await button('提交，查看改写建议').click();
  await heading('收下一条建议').waitFor();
  await expectExit();
  await button('接纳这条建议').click();
  assert.ok(await button('已接纳').isDisabled());
  await button('归档本轮').click();
  await heading('本轮报告').waitFor();
  const reportAudio = page.locator('.report-media .audio-player');
  assert.equal(await reportAudio.locator('audio[controls]').count(), 2);
  await button('播放表达者录音').click();
  await reportAudio.first().locator('audio').evaluate(audio => audio.pause());
  await button('播放复述者录音').click();
  if (verifyJavaArchive) {
    const consent = button('上传素材库');
    assert.equal(await reportAudio.first().getByRole('button', { name: '上传素材库', exact: true }).count(), 0);
    assert.equal(await consent.count(), 1);
    page.once('dialog', dialog => dialog.accept());
    await consent.click();
    assert.ok(await button('已同意上传').isDisabled());
  }
  await page.getByText('已接纳改写建议', { exact: true }).waitFor();
  await page.locator('.solo-issue summary').first().click();
  await page.getByText('澄清：确认图表和开场的分工', { exact: true }).waitFor();

  await button('再练一轮').click();
  await button('开始练习').click();
  await button('播放录音').click();
  await button('暂停播放').waitFor();
  await record();
  await page.getByText('用自己的复述文本重新对照', { exact: true }).click();
  await button('听自己的复述').click();
  await button('暂停复述录音').click();
  await page.getByLabel('复述文本', { exact: true }).fill(
    '周三晚上在图书馆准备汇报。我负责图表，你负责开场介绍。教室变化就在群里提醒。',
  );
  await button('更新对照').click();
  await page.getByText(/当前结果使用你输入的复述/).waitFor();
  await button('确认').click();
  await page.getByText('本轮没有需要确认的差异。', { exact: true }).waitFor();
  await button('提交，查看改写建议').click();
  await button('跳过建议，归档本轮').click();
  await page.getByText('本轮跳过改写建议', { exact: true }).waitFor();
  const replay = await button('再练一轮').boundingBox();
  const returnHome = button('结束并关闭训练室');
  assert.ok((await returnHome.getAttribute('class'))?.includes('danger'));
  const homeButton = await returnHome.boundingBox();
  assert.ok(replay && homeButton && homeButton.y >= replay.y + replay.height);
  await returnHome.click();
  await heading('选择练法').waitFor();
  assert.equal(await heading('本轮报告').count(), 0);

  const reports = await page.evaluate(ownerId => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith(`echo:solo-report:${ownerId}:`));
    return keys.map(key => JSON.parse(localStorage.getItem(key)));
  }, session.id);
  assert.equal(reports.length, 2);
  assert.equal(reports.find(report => report.transcriptSource === 'demo')?.accepted, true);
  assert.equal(reports.find(report => report.transcriptSource === 'manual')?.accepted, false);
  if (verifyJavaArchive) {
    const endpoint = `${origin}/api/practice/reports`;
    const response = await page.request.get(endpoint);
    assert.equal(response.status(), 200);
    const archived = await response.json();
    assert.equal(archived.length, 2);
    const demo = archived.find(report => report.transcriptSource === 'demo');
    assert.equal(demo.materialId, 'campus');
    assert.equal(demo.accepted, true);
    assert.equal(archived.find(report => report.transcriptSource === 'manual')?.accepted, false);
    assert.equal((await page.request.post(endpoint, {
      headers: { Origin: origin },
      data: { id: demo.id, materialId: demo.materialId, duration: demo.duration, transcriptSource: demo.transcriptSource,
        complete: demo.complete, accurate: demo.accurate, total: demo.total, accepted: demo.accepted },
    })).status(), 204);
    assert.equal((await (await page.request.get(endpoint)).json()).length, 2);
    const another = await browser.newContext();
    assert.equal((await another.request.get(endpoint)).status(), 401);
    const otherPage = await another.newPage();
    await otherPage.goto(origin);
    await loginWithNickname(otherPage, '单人练习测试');
    assert.deepEqual(await (await another.request.get(endpoint)).json(), []);
    await another.close();
  }
  assert.deepEqual(errors, []);
  console.log('solo practice browser flow passed');
} finally {
  await browser.close();
}
