import assert from 'node:assert/strict';

export async function loginWithNickname(page, nickname, invited = false) {
  await page.getByRole('heading', { name: '昵称登录', exact: true }).waitFor();
  const form = page.getByRole('textbox', { name: '昵称', exact: true });
  const submit = page.getByRole('button', { name: invited ? '登录并进入训练室' : '登录并开始练习' });
  assert.equal(await submit.isDisabled(), true);
  await form.fill(nickname);
  const response = page.waitForResponse(result =>
    new URL(result.url()).pathname === '/api/sessions/anonymous' && result.request().method() === 'POST');
  await submit.click();
  const result = await response;
  assert.equal(result.status(), 200);
  const session = await result.json();
  assert.equal(session.named, true);
  assert.equal(session.nickname, nickname.trim());
  await page.getByText('已登录 · ' + nickname.trim(), { exact: true }).waitFor();
  return session;
}
