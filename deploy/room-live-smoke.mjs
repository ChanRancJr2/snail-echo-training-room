import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [address, speakerPath, listenerPath, ...requested] = process.argv.slice(2);
assert.ok(address && speakerPath && listenerPath,
  'Usage: node deploy/room-live-smoke.mjs STAGING_ORIGIN SPEAKER.mp3 LISTENER.mp3 [sync solo async]');
const url = new URL(address);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
assert.equal(url.href, `${url.origin}/`);
const origin = url.origin;
const [source, responseAudio] = await Promise.all([readFile(speakerPath), readFile(listenerPath)]);
const allModes = ['sync', 'solo', 'async'];
const modes = requested.length ? requested : allModes;
assert.ok(modes.every(mode => allModes.includes(mode)));

async function request(path, cookie, body, expected = 200) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : {
    Origin: origin, 'Content-Type': 'application/json',
  }) };
  const response = await fetch(origin + path, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null);
  assert.equal(response.status, expected, `${path.replace(/[a-f0-9-]{36}/g, '{id}')} ${result?.error ?? ''}`);
  return { result, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] };
}

const get = async (path, actor) => (await request(path, actor)).result;
const post = async (path, actor, body = {}, status) => (await request(path, actor, body, status)).result;

async function poll(read, ready, label) {
  const until = Date.now() + 150_000;
  while (Date.now() < until) {
    const current = await read();
    if (ready(current)) return current;
    await delay(1700);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function run(mode) {
  const sameDevice = mode === 'solo';
  const cookies = [];
  let room;
  async function session(label) {
    const { cookie } = await request('/api/sessions/anonymous', null, { nickname: `发布验收${label}` });
    assert.ok(cookie);
    cookies.push(cookie);
    return cookie;
  }
  const speaker = await session('表达');
  try {
    const listener = sameDevice ? speaker : await session('复述');
    const observer = mode === 'sync' ? await session('观察') : null;
    const { state, inviteToken } = await post('/api/rooms', speaker, {
      mode, createKey: randomUUID(), durationSeconds: 60, retellStyle: 'keywords',
    }, 201);
    room = `/api/rooms/${state.id}`;
    if (!sameDevice) assert.equal((await post('/api/rooms/join', listener, { token: inviteToken })).you.role, 'listener');
    if (observer) {
      const invite = await post(`${room}/invitations`, speaker, { role: 'observer', minutes: 5, maxUses: 1 }, 201);
      assert.equal((await post('/api/rooms/join', observer, { token: invite.token })).you.role, 'observer');
    }
    if (mode !== 'async') {
      await post(`${room}/ready`, speaker, { ready: true });
      if (!sameDevice) await post(`${room}/ready`, listener, { ready: true });
    }
    const started = await post(`${room}/start`, speaker);
    const round = `/api/rounds/${started.roundId}`;
    const recording = await post(`${round}/task`, speaker, { expectedVersion: started.roundVersion });

    async function upload(actor, kind, version, data) {
      const target = await post(`${round}/uploads`, actor, {
        kind, mimeType: 'audio/mpeg', byteSize: data.length, idempotencyKey: randomUUID(),
      });
      const result = await fetch(target.uploadUrl, { method: 'PUT', redirect: 'error', headers: {
        Origin: origin, 'Content-Type': 'audio/mpeg', 'Content-Length': String(data.length),
      }, body: data, signal: AbortSignal.timeout(20_000) });
      assert.ok(result.ok, `Signed ${kind} upload failed: ${result.status}`);
      assert.equal(result.headers.get('access-control-allow-origin'), origin);
      return post(`${round}/uploads/${target.audioId}/commit`, actor, { expectedVersion: version, consentToTranscribe: true });
    }

    const audio = await upload(speaker, 'speaker', recording.version, source);
    const transcription = await poll(() => get(`${round}/speaker-transcript`, speaker),
      result => result.status === 'ready' || result.status === 'failed', 'speaker ASR');
    assert.equal(transcription.status, 'ready');
    assert.ok(transcription.text.includes('外婆') && transcription.text.includes('早点'), 'Unexpected speaker transcript');
    assert.ok(transcription.candidates.length > 0, 'Ark returned no source candidates');
    if (!sameDevice) await request(`${round}/speaker-transcript`, listener, undefined, 403);
    const missing = transcription.text.split(/[。？！.!?\n]+/).filter(Boolean).find(sentence => sentence.includes('早点'))?.trim();
    assert.ok(missing);
    const speakerState = await get(room, speaker);
    const covered = transcription.candidates.find(point => point.text.includes('外婆') && point.text !== missing);
    assert.ok(covered, 'Expected a candidate about the visit');
    await post(`${round}/points/confirm`, speaker, { expectedVersion: speakerState.roundVersion,
      points: [{ category: '重点', text: missing }, { category: '重点', text: covered.text }] });
    let listenerState = await get(room, listener);
    if (mode === 'async') {
      assert.equal(listenerState.stage, 'ASYNC_PENDING');
      await request(`${round}/audio/${audio.audioId}/access`, listener, undefined, 403);
      await post(`${round}/open-message`, listener, { expectedVersion: listenerState.roundVersion });
      listenerState = await get(room, listener);
    }
    assert.equal(listenerState.stage, 'LISTENER_RETELL');
    const media = await get(`${round}/audio/${audio.audioId}/access`, listener);
    const range = await fetch(media.url, { headers: { Range: 'bytes=0-15' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 16);
    const retell = await post(`${round}/restart-recording`, listener, { expectedVersion: listenerState.roundVersion, kind: 'listener' });
    await upload(listener, 'listener', retell.version, responseAudio);
    const reviewed = await poll(() => get(room, speaker), item => ['SPEAKER_LABELING', 'CANCELLED'].includes(item.stage), 'listener ASR and Ark comparison');
    assert.equal(reviewed.stage, 'SPEAKER_LABELING');
    const comparison = await get(`${round}/comparison`, speaker);
    assert.equal(comparison.provider, 'ark', 'Semantic comparison must complete without a rules fallback');
    assert.equal(comparison.version, reviewed.roundVersion);
    const issues = comparison.issues.filter(item => !item.complete || !item.accurate);
    assert.ok(issues.length > 0, 'The retell fixture should omit the confirmed point');
    let labelVersion = reviewed.roundVersion;
    const clarification = '验收样本需要核对原表达的条件。';
    if (!sameDevice) {
      const opened = await post(`${round}/review/open-round-review`, speaker, { expectedVersion: labelVersion });
      assert.equal(opened.stage, 'LISTENER_CLARIFICATION');
      labelVersion = opened.version;
      const saved = await post(`${round}/review/round-clarification`, listener, { expectedVersion: labelVersion, note: clarification });
      assert.equal(saved.stage, 'LISTENER_CLARIFICATION');
      assert.equal(saved.version, labelVersion);
    }
    const selected = comparison.issues.find(item => item.original === covered.text)?.id;
    assert.ok(selected, 'The confirmed point must appear in the review');
    const labels = { expectedVersion: labelVersion, retellTags: ['遗漏重要信息', '语意被误解'],
      expressionTags: ['我记不清', '我有点紧张'] };
    await post(`${round}/review/round-labels`, speaker, { ...labels, accuratePointIds: [randomUUID()] }, 400);
    const step = await post(`${round}/review/round-labels`, speaker, { ...labels, accuratePointIds: [selected] });
    assert.equal(step.stage, 'ADVICE');
    const coached = await poll(() => get(`${round}/comparison`, speaker), result => result.advice?.status === 'ready', 'Ark coaching');
    assert.deepEqual(Object.keys(coached.advice.suggestions), ['speaker']);
    assert.equal(coached.advice.suggestions.speaker.provider, 'ark');
    if (!sameDevice) {
      const other = await get(`${round}/comparison`, listener);
      assert.deepEqual(Object.keys(other.advice.suggestions), ['listener']);
      assert.equal(other.advice.suggestions.listener.provider, 'ark');
    }
    if (observer) {
      const both = await get(`${round}/comparison`, observer);
      assert.deepEqual(Object.keys(both.advice.suggestions).sort(), ['listener', 'speaker']);
    }
    const archived = await post(`${room}/next-round`, speaker, { roundId: started.roundId, expectedVersion: step.version });
    assert.equal(archived.stage, 'ARCHIVED');
    if (mode === 'sync') assert.equal(archived.you.role, 'listener');
    const report = await get(`${round}/comparison`, listener);
    assert.equal(report.excluded, 0);
    assert.equal(report.wholeRoundFeedback.note, sameDevice ? '' : clarification);
    assert.deepEqual(report.wholeRoundFeedback.accuratePointIds, [selected]);
    assert.deepEqual(report.wholeRoundFeedback.retellTags, labels.retellTags);
    assert.deepEqual(report.wholeRoundFeedback.expressionTags, labels.expressionTags);
    console.log(`${mode}: candidate extraction, file ASR, ${comparison.provider} comparison, role-scoped Ark coaching, and archive passed.`);
  } finally {
    if (room) await post(`${room}/leave`, speaker).catch(() => undefined);
    for (const cookie of cookies) await post('/api/sessions/logout', cookie, {}, 204);
  }
}

for (const mode of modes) await run(mode);
