import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loginWithNickname } from './helpers/nickname.mjs';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://localhost:33128';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE ?? (process.platform === 'win32'
    ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(7000);
  const button = name => page.getByRole('button', { name, exact: true });
  const heading = name => page.getByRole('heading', { name, exact: true });
  const mutations = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/practice\//.test(request.url())) {
      mutations.push(new URL(request.url()).pathname.split('/').at(-1));
    }
  });
  await page.goto(origin);
  await loginWithNickname(page, '本地单人验收');
  await page.getByRole('button', { name: /^单人练习/ }).click();

  async function record() {
    await button('开始练习').click();
    await button('开始录音').click();
    await page.getByText('00:01', { exact: true }).waitFor();
    await button('结束录音').click();
    const unavailable = page.waitForResponse(response => response.url().endsWith('/audio'));
    await button('确认上传并转写').click();
    assert.equal((await unavailable).status(), 503);
    await button('跳过分析，继续体验').waitFor();
  }

  async function finish() {
    await heading('整轮标注').waitFor();
    assert.equal(await page.locator('.round-recordings audio').count(), 2);
    await page.getByLabel('遗漏重要信息', { exact: true }).check();
    await button('提交，查看改写建议').click();
    await heading('收下一条建议').waitFor();
    await button('查看预览报告').click();
    await heading('本轮报告').waitFor();
    await page.getByText('本轮为本地预览，未写入练习历史。').waitFor();
    assert.equal(await button('上传素材库').count(), 0);
  }

  await record();
  await button('跳过分析，继续体验').click();
  await finish();
  assert.equal(await page.locator('.comparison-grid').count(), 0);
  await button('再练一轮').click();
  await record();
  await page.getByLabel('本轮复述的手动转写').fill('这周六上午，我们先去看外婆。');
  await button('用手动转写对照').click();
  await page.getByText('本地预览 · 手动转写与关键词对照').waitFor();
  await button('确认').click();
  await finish();
  await page.locator('.comparison-grid').waitFor();
  assert.deepEqual(mutations, ['audio', 'audio']);
  console.log('Local solo preview passed: real capture, unscored review, manual comparison and no report writes.');
} finally {
  await browser.close();
}
