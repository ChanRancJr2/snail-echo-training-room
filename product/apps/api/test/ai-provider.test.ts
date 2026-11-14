import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeComparison, VolcAiProvider } from '../src/ai-provider.ts';

const points = [
  { id: 'p1', category: '需求', text: '先确认外婆身体情况' },
  { id: 'p2', category: '因果', text: '累了就早点回家' },
];

test('comparison accepts only known point IDs, fills missing items and constrains labels', () => {
  const output = normalizeComparison(points, { items: [{ id: 'p1', complete: true, accurate: true, listenerQuote: '先看看外婆身体', tag: '伪造标签', clarification: '' }] });
  assert.deepEqual(output.map(row => [row.id, row.complete, row.accurate, row.tag]), [['p1', true, true, null], ['p2', false, false, '遗漏重要信息']]);
  assert.throws(() => normalizeComparison(points, { items: [{ id: 'other', complete: true, accurate: true, listenerQuote: '', tag: null, clarification: null }] }));
  assert.throws(() => normalizeComparison(points, { items: [
    { id: 'p1', complete: false, accurate: false, listenerQuote: '', tag: null, clarification: null },
    { id: 'p1', complete: false, accurate: false, listenerQuote: '', tag: null, clarification: null },
  ] }));
  const inconsistent = normalizeComparison(points, { items: [{ id: 'p1', complete: false, accurate: true, listenerQuote: '', tag: null, clarification: null }] });
  assert.equal(inconsistent[0]?.accurate, false);
});

test('silent listener audio yields deterministic comparison without an Ark request', async () => {
  const provider = new VolcAiProvider({ speechKey: 'test', resourceId: 'test', arkKey: 'test', modelId: 'test' }, async () => { throw new Error('vendor called'); });
  assert.equal((await provider.compare(points, ''))[0]?.tag, '遗漏重要信息');
});

test('file ASR submit/query uses one task ID and does not expose keys in errors', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const provider = new VolcAiProvider({ speechKey: 'private-test-key', resourceId: 'volc.seedasr.auc', arkKey: 'ark-test', modelId: 'endpoint-test' }, async (url, options) => {
    calls.push({ url: String(url), options: options ?? {} });
    return new Response(calls.length === 1 ? '{}' : JSON.stringify({ result: { text: '先去看外婆。' } }),
      { headers: { 'X-Api-Status-Code': '20000000' } });
  });
  assert.equal(await provider.transcribe('https://storage.example/audio.mp3'), '先去看外婆。');
  assert.equal(calls.length, 2);
  assert.equal((calls[0]?.options.headers as Record<string, string>)['X-Api-Request-Id'], (calls[1]?.options.headers as Record<string, string>)['X-Api-Request-Id']);
  assert.equal(JSON.parse(String(calls[0]?.options.body)).audio.format, 'mp3');
});

test('Ark response is schema checked before becoming comparison data', async () => {
  const provider = new VolcAiProvider({ speechKey: 'test', resourceId: 'test', arkKey: 'test', modelId: 'test' }, async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.response_format.type, 'json_object');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: [
      { id: 'p1', complete: false, accurate: false, listenerQuote: '一起吃午饭', tag: '理解偏了', clarification: '午饭是否要看外婆身体？' },
    ] }) } }] });
  });
  const result = await provider.compare(points, '一起吃午饭');
  assert.deepEqual(result.map(row => row.tag), ['理解偏了', '遗漏重要信息']);
  assert.equal(result[0]?.clarification, '午饭是否要看外婆身体？');
});
