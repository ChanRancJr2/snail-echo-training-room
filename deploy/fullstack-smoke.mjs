import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:3101';
const origin = process.argv[3] ?? new URL(base).origin;
const mode = process.argv[4] === 'async' ? 'async' : 'sync';
const audio = await readFile(new URL('../speaker-sample.mp3', import.meta.url));
const listenerWav = process.env.ECHO_SMOKE_LISTENER_WAV ? await readFile(process.env.ECHO_SMOKE_LISTENER_WAV) : null;
async function request(path, cookie, data) {
  const response = await fetch(new URL(path, base), {
    headers: { ...(cookie ? { cookie } : {}), ...(data ? { origin, 'content-type': 'application/json' } : {}) },
    ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${result.error ?? ''}`);
  return { result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
const post = async (path, cookie, data = {}) => (await request(path, cookie, data)).result;
const get = async (path, cookie) => (await request(path, cookie)).result;
const host = (await request('/api/sessions/anonymous', null, { nickname: '上线验证表达者' })).cookie;
const guest = (await request('/api/sessions/anonymous', null, { nickname: '上线验证复述者' })).cookie;
const created = await post('/api/rooms', host, { mode, createKey: randomUUID() });
const room = `/api/rooms/${created.state.id}`;
try {
  await post('/api/rooms/join', guest, { token: created.inviteToken });
  await post(`${room}/ready`, host, { ready: true });
  await post(`${room}/ready`, guest, { ready: true });
  const started = await post(`${room}/start`, host);
  const round = `/api/rounds/${started.roundId}`;
  async function upload(cookie, kind, version, transcribe = false) {
    const bytes = kind === 'listener' && listenerWav ? listenerWav : audio;
    const mimeType = bytes === listenerWav ? 'audio/wav' : 'audio/mpeg';
    const target = await post(`${round}/uploads`, cookie, { kind, mimeType, byteSize: bytes.length, idempotencyKey: randomUUID() });
    const preflight = await fetch(target.uploadUrl, { method: 'OPTIONS', headers: {
      origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type',
    }, signal: AbortSignal.timeout(12000) });
    assert.ok(preflight.ok, `upload preflight HTTP ${preflight.status}`);
    assert.ok(['*', origin].includes(preflight.headers.get('access-control-allow-origin')), 'upload CORS origin');
    const put = await fetch(target.uploadUrl, { method: 'PUT', headers: { origin, 'content-type': mimeType }, body: bytes, signal: AbortSignal.timeout(12000) });
    assert.ok(put.ok, `storage PUT HTTP ${put.status}`);
    return post(`${round}/uploads/${target.audioId}/commit`, cookie, { expectedVersion: version, transcribe, consentToTranscribe: kind === 'listener' });
  }
  const task = await post(`${round}/task`, host, { expectedVersion: started.roundVersion });
  const speaker = await upload(host, 'speaker', task.version, true);
  let transcript;
  for (let i = 0; i < 35; i++) {
    transcript = await get(`${round}/speaker-transcript`, host);
    if (transcript.status === 'ready') break;
    await wait(2000);
  }
  assert.equal(transcript?.status, 'ready', 'real speaker transcription completed');
  assert.match(transcript.text, /外婆/);
  if (process.env.ECHO_EXPECT_CANDIDATES === '1') assert.ok(transcript.candidates?.length > 0, 'Ark extracted candidate points');
  const points = await post(`${round}/points/confirm`, host, { expectedVersion: speaker.round.version, points: [
    { category: '事件', text: '周六先去看望外婆' },
    { category: '需求', text: '周日必须去机场接同学' },
  ] });
  let readyToRetell = points.round;
  if (mode === 'async') {
    assert.equal(readyToRetell.stage, 'ASYNC_PENDING');
    readyToRetell = await post(`${round}/open-message`, guest, { expectedVersion: readyToRetell.version });
    assert.equal(readyToRetell.stage, 'LISTENER_RETELL');
  }
  const source = await get(`${round}/audio/${speaker.audioId}/access`, guest);
  const playback = await fetch(source.url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(12000) });
  assert.ok(playback.ok, `audio playback HTTP ${playback.status}`);
  console.log('Real speaker ASR and audio playback passed');
  const listening = await post(`${round}/restart-recording`, guest, { expectedVersion: readyToRetell.version, kind: 'listener' });
  await upload(guest, 'listener', listening.version);
  let state;
  for (let i = 0; i < 55; i++) {
    state = await get(room, host);
    if (state.stage === 'SPEAKER_LABELING') break;
    await wait(2000);
  }
  assert.equal(state?.stage, 'SPEAKER_LABELING', 'real listener ASR and Ark comparison completed');
  const compared = await get(`${round}/comparison`, host);
  assert.equal(compared.total, 2);
  assert.ok(compared.issues.some(item => !item.complete));
  const labels = compared.issues.filter(item => !item.complete || !item.accurate)
    .map(item => ({ issueId: item.id, tag: item.tag ?? '遗漏重要信息', resolution: 'misunderstanding' }));
  let review = await post(`${round}/review/label`, host, { expectedVersion: state.roundVersion, labels });
  for (const { issueId } of labels) {
    review = await post(`${round}/review/confirm`, host, { expectedVersion: review.version, issueId });
    review = await post(`${round}/review/confirm`, guest, { expectedVersion: review.version, issueId });
  }
  const report = await post(`${round}/review/submit`, host, { expectedVersion: review.version });
  assert.equal(report.stage, 'ADVICE');
  const next = await post(`${room}/next-round`, host, { roundId: started.roundId, expectedVersion: report.version });
  assert.equal(next.stage, 'ARCHIVED');
  assert.equal(next.status, 'WAITING');
  console.log('Real listener ASR, comparison, mutual confirmation, report and archive passed');
} finally {
  await post(`${room}/leave`, host).catch(() => undefined);
}
