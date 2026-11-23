import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const [address, recording, expectedPhrase] = process.argv.slice(2);
assert.ok(address && recording && expectedPhrase,
  'Usage: node deploy/solo-live-smoke.mjs STAGING_ORIGIN FIXTURE.wav EXPECTED_TRANSCRIPT_PHRASE');
const expectNoSpeech = expectedPhrase === '--no-speech';
const site = new URL(address);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
assert.ok(site.protocol === 'https:' || (site.protocol === 'http:' && loopback), 'Use HTTPS or a loopback HTTP address');
assert.equal(site.href, `${site.origin}/`, 'Supply the exact staging origin');
const formats = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const extension = extname(recording).toLowerCase();
assert.ok(Object.hasOwn(formats, extension), 'Use a WAV or MP3 speech fixture');
const sound = await readFile(recording);
assert.ok(sound.length > 0 && sound.length <= 15_000_000, 'Fixture exceeds the recording size limit');

async function request(path, { cookie, body, status = 200 } = {}) {
  const method = body ? 'POST' : 'GET';
  const headers = new Headers(cookie ? { cookie } : {});
  if (body) headers.set('Origin', site.origin);
  if (typeof body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(new URL(path, site), { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status !== status) {
    const failure = await response.json().catch(() => null);
    const code = /^[A-Z_]+$/.test(failure?.error ?? '') ? ` (${failure.error})` : '';
    assert.equal(response.status, status, `${method} ${path.replaceAll(analysisId, '{analysisId}')}${code}`);
  }
  return response;
}

async function untilSettled(path, cookie, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const view = await (await request(path, { cookie })).json();
    if (view.status === 'ready' || view.status === 'failed') return view;
    assert.equal(view.status, 'pending', 'Unexpected provider status');
    await wait(2200);
  }
  assert.fail('Provider result did not arrive before the deadline');
}

const analysisId = randomUUID();
const path = `/api/practice/analysis/${analysisId}`;
const signedIn = await request('/api/sessions/anonymous', { body: JSON.stringify({ nickname: '单人联调样本' }) });
const cookie = signedIn.headers.get('Set-Cookie')?.split(';', 1)[0];
assert.ok(cookie, 'Session cookie is missing');
try {
  const form = new FormData();
  form.set('materialId', 'family');
  form.set('duration', '30');
  form.set('consent', 'true');
  form.set('recording', new Blob([sound], { type: formats[extension] }), `fixture${extension}`);
  await request(`${path}/audio`, { cookie, body: form, status: 202 });
  const analyzed = await untilSettled(path, cookie, 250_000);
  if (expectNoSpeech) {
    assert.equal(analyzed.status, 'failed');
    assert.equal(analyzed.failure, 'NO_SPEECH');
    assert.equal(analyzed.comparison, null);
    await request(`${path}/archive`, { cookie, body: JSON.stringify({ accepted: false }), status: 409 });
    const reports = await (await request('/api/practice/reports', { cookie })).json();
    assert.equal(reports.length, 0);
    console.log('Solo staging silence check passed: no transcript, no score, archive rejected.');
  } else {
    assert.equal(analyzed.status, 'ready', analyzed.failure ?? 'Speech analysis did not complete');
    assert.equal(analyzed.source, 'asr');
    assert.ok(analyzed.transcript?.includes(expectedPhrase), 'Recognized transcript did not match the fixture');
    assert.equal(analyzed.provider, 'ark', 'Semantic comparison must complete without a rules fallback');
    const issues = analyzed.comparison.issues;
    assert.ok(issues.length > 0, 'Use a fixture with an intentional omission to test model-generated advice');
    await request(`${path}/round-feedback`, { cookie, body: JSON.stringify({
      retellTags: ['遗漏重要信息'], expressionTags: [], note: '',
    }) });
    const advice = await untilSettled(`${path}/advice`, cookie, 125_000);
    assert.equal(advice.status, 'ready');
    assert.deepEqual(Object.keys(advice.suggestions), ['listener']);
    assert.equal(advice.suggestions.listener.provider, 'ark');
    assert.ok(issues.some(issue => issue.id === advice.suggestions.listener.evidenceId));
    await request(`${path}/archive`, { cookie, body: JSON.stringify({ accepted: true }), status: 204 });
    const reports = await (await request('/api/practice/reports', { cookie })).json();
    const result = reports.find(report => report.id === analysisId);
    assert.ok(result, 'The report was not found in the originating session');
    for (const score of ['total', 'complete', 'accurate']) assert.equal(result[score], analyzed.comparison[score]);
    assert.equal(result.transcriptSource, 'asr');
    assert.equal(result.accepted, true);
    await request(path, { status: 401 });
    console.log('Solo staging smoke passed: file ASR, Ark comparison and advice, authorized archive, and access isolation.');
  }
} finally {
  await request('/api/sessions/logout', { cookie, body: '{}', status: 204 });
}
