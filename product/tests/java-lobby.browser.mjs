import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.ECHO_PRODUCT_ORIGIN ?? 'http://localhost:3100';
const executablePath = process.env.BROWSER_EXECUTABLE ??
  (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined);
const browser = await chromium.launch({ executablePath });
try {
  const [a, b, c] = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  }).then(context => context.newPage())));
  await Promise.all([a, b, c].map(page => page.goto(origin)));
  await Promise.all([a, b, c].map(page => page.getByText('匿名会话已建立').waitFor()));

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
    await host.getByRole('button', { name: '结束并关闭训练室' }).click();
    await guest.getByText('训练室已关闭或会话已失效').waitFor();
    return snapshot;
  }

  const first = await round(a, b, c);
  const second = await round(b, a);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.roundId, second.roundId);
  console.log('Java lobby passed in three browser sessions, including reversed host/guest roles in a fresh room.');
} finally {
  await browser.close();
}
