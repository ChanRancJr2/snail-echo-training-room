import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loginWithNickname } from './helpers/nickname.mjs';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://127.0.0.1:3100';
const executablePath = process.env.BROWSER_EXECUTABLE ?? (process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const browser = await chromium.launch({
  executablePath,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true, permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', { name, exact: true });
  const heading = name => page.getByRole('heading', { name, exact: true });
  let audioRequests = 0;
  let archived = false;
  const issued = new Set();
  const item = { id: 'source-1', original: '如果外婆身体允许，再一起吃午饭。',
    retell: '然后一起吃午饭。', tag: '遗漏重要信息', question: '什么情况下才一起吃饭？', complete: false, accurate: false };
  const unchecked = { id: 'source-0', original: '周六上午去看外婆。', retell: '先去看外婆',
    tag: '要点吻合', question: '', complete: true, accurate: true };
  const missing = { id: 'source-2', original: '如果她累了，就早点回去。', retell: '',
    tag: '遗漏重要信息', question: '', complete: false, accurate: false };
  const transcript = `周六上午先去看外婆。${item.retell}`;

  // This intercept verifies the browser contract. Java integration tests separately exercise FFmpeg, storage and ASR.
  await page.route('**/api/practice/analysis/**', async route => {
    const request = route.request();
    const parts = new URL(request.url()).pathname.split('/');
    const id = parts[4];
    if (parts[5] === 'audio') {
      assert.equal(request.method(), 'POST');
      assert.ok(request.headers()['content-type'].startsWith('multipart/form-data;'));
      const multipart = request.postDataBuffer();
      assert.ok(multipart?.includes(Buffer.from('name="consent"\r\n\r\ntrue')));
      assert.ok(multipart?.includes(Buffer.from('name="recording"; filename="retell"')));
      issued.add(id);
      audioRequests++;
      return route.fulfill({ status: 202 });
    }
    assert.ok(issued.has(id));
    if (parts[5] === 'round-feedback') {
      assert.equal(request.method(), 'POST');
      assert.deepEqual(request.postDataJSON(), { retellTags: ['遗漏重要信息', '理解不到位', '语意被误解'],
        expressionTags: ['我表达不清', '我记不清', '我有点紧张'], accuratePointIds: [item.id], note: '需要核对午饭条件' });
      return route.fulfill({ json: { status: 'ready', suggestions: {
        listener: { text: '复述时说清午饭成立的条件。', evidenceId: item.id, provider: 'ark' },
      } } });
    }
    if (parts[5] === 'archive') {
      assert.deepEqual(request.postDataJSON(), { accepted: true });
      archived = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ json: audioRequests === 1
      ? { status: 'failed', source: 'asr', failure: 'NO_SPEECH' }
      : { status: 'ready', source: 'asr', transcript, provider: 'ark',
          comparison: { total: 3, complete: 1, accurate: 1, issues: [item, missing], rows: [unchecked, item, missing] } } });
  });

  await page.goto(origin);
  await loginWithNickname(page, '单人录音验收');
  assert.deepEqual(await page.locator('.modes button strong').allTextContents(),
    ['单人练习', '异步留言练', '双人同步练', '双座位自练']);
  assert.deepEqual(await page.locator('.modes .mode-devices').allTextContents(), ['两台手机', '一台手机']);
  await page.getByRole('button', { name: /^单人练习/ }).click();
  await heading('录音主题').waitFor();
  assert.deepEqual(await page.getByRole('group', { name: '录音主题' }).getByRole('button').allTextContents(),
    ['家庭日常', '校园生活', '疾病与需求', '工作需求', '兴趣爱好', '自定义填写']);
  assert.equal(await page.locator('audio').count(), 0);
  await button('开始练习').click();
  await heading('周六看望外婆').waitFor();
  const original = page.locator('.solo-listen audio');
  assert.equal(await original.getAttribute('src'), '/practice-audio/family.mp3');
  assert.equal(await original.getAttribute('controls'), null);
  await button('播放录音').click();
  await button('暂停播放').click();
  await button('提示词').click();
  await page.getByText('身体允许', { exact: true }).waitFor();

  await button('开始录音').click();
  await page.getByText('00:01', { exact: true }).waitFor();
  await button('结束录音').click();
  const consent = page.getByRole('checkbox', { name: /我知晓复述录音提交后会被转写/ });
  await button('确认上传并转写').waitFor();
  assert.equal(await consent.count(), 0);
  assert.equal(audioRequests, 0);
  await button('确认上传并转写').click();
  await heading('先看差异').waitFor();
  await page.getByRole('alert').filter({ hasText: '未识别到清晰语音' }).waitFor();
  assert.equal(await page.locator('.comparison-grid').count(), 0);
  assert.equal(await button('确认').count(), 0);
  await button('重试分析').click();
  await page.getByText('方舟对照了原录音要点与本轮复述转写。').waitFor();
  assert.equal(audioRequests, 2);
  await page.locator('.solo-issue summary').first().click();
  await page.locator('.solo-pair dd').filter({ hasText: item.retell }).waitFor();
  assert.equal(await page.getByText(/示例复述/).count(), 0);
  await button('确认').click();
  await heading('整轮标注').waitFor();
  await page.getByText(transcript, { exact: true }).waitFor();
  assert.equal(await page.locator('.round-recordings audio').count(), 2);
  assert.equal(await page.getByLabel('结论', { exact: true }).count(), 0);
  await page.getByRole('group', { name: '准确复述的要点（可多选）' }).getByLabel(item.original).check();
  await page.getByLabel('遗漏重要信息', { exact: true }).check();
  await page.getByLabel('理解不到位', { exact: true }).check();
  await page.getByRole('group', { name: '给复述者贴的标签（表达者评价复述方）' }).getByLabel('语意被误解').check();
  await page.getByLabel('我表达不清', { exact: true }).check();
  await page.getByLabel('我记不清', { exact: true }).check();
  await page.getByLabel('我有点紧张', { exact: true }).check();
  await page.getByLabel('补充澄清（选填）').fill('需要核对午饭条件');
  await button('提交，查看改写建议').click();
  await page.getByText('复述时说清午饭成立的条件。', { exact: true }).waitFor();
  await button('接纳这条建议').click();
  assert.ok(await button('已接纳').isDisabled());
  await button('归档本轮').click();
  await heading('本轮报告').waitFor();
  assert.equal(archived, true);
  await heading('表达者审核结果').waitFor();
  assert.equal(await page.locator('.point-review-result strong').textContent(), '1 / 3');
  assert.equal(await page.locator('.comparison-grid').count(), 0);
  const details = page.locator('.point-review-details');
  assert.deepEqual(await details.locator('h4').allTextContents(), [`1. ${unchecked.original}`, `2. ${missing.original}`]);
  await details.getByText('复述转写原句：周六上午先去看外婆。', { exact: true }).waitFor();
  await details.getByText('复述转写原句：未找到对应句子', { exact: true }).waitFor();
  assert.equal(await page.locator('.report-media audio[controls]').count(), 2);
  await button('结束并关闭训练室').click();
  await heading('选择练法').waitFor();
  assert.deepEqual(errors, []);
  console.log('solo real-recording browser contract passed');
} finally {
  await browser.close();
}
