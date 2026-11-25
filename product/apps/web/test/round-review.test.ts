import assert from 'node:assert/strict';
import test from 'node:test';
import { roundStep } from '../src/flow.ts';
import { correspondingRetell, summarizePointReview } from '../src/round-report.ts';

test('whole-round review keeps clarification in step six and ends at step eight', () => {
  const options = { wholeReview: true };
  assert.deepEqual(roundStep('LISTENER_CLARIFICATION', options),
    { number: 6, title: '表达者整轮标注', label: '整轮标注', count: 8 });
  assert.deepEqual(roundStep('LISTENER_CLARIFICATION', { ...options, role: 'listener' }),
    { number: 6, title: '复述者澄清', label: '复述者澄清', count: 8 });
  assert.equal(roundStep('ADVICE', options)?.number, 7);
  assert.equal(roundStep('ARCHIVED', options)?.number, 8);
});

test('the report distinguishes missing review, no points, and all points left unchecked', () => {
  const points = [{ id: 'a', original: '约在中午。' }, { id: 'b', original: '如果下雨就改期。' }];
  assert.equal(summarizePointReview(points), null);
  assert.deepEqual(summarizePointReview([], []), { total: 0, accurate: 0, unselected: [] });
  assert.deepEqual(summarizePointReview(points, []), { total: 2, accurate: 0, unselected: points });
  assert.deepEqual(summarizePointReview(points, ['a']), { total: 2, accurate: 1, unselected: [points[1]] });
});

test('a matching quote can show its full sentence without guessing when evidence is absent or ambiguous', () => {
  assert.equal(correspondingRetell('约在中午', '今天见面。我们约在中午。'), '我们约在中午。');
  assert.equal(correspondingRetell('', '今天见面。'), '未找到对应句子');
  assert.equal(correspondingRetell('中午', '中午出发。中午回来。'), '中午');
});
