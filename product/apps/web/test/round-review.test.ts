import assert from 'node:assert/strict';
import test from 'node:test';
import { roundStep } from '../src/flow.ts';

test('whole-round review keeps clarification in step six and ends at step eight', () => {
  const options = { wholeReview: true };
  assert.deepEqual(roundStep('LISTENER_CLARIFICATION', options),
    { number: 6, title: '表达者整轮标注', label: '整轮标注', count: 8 });
  assert.deepEqual(roundStep('LISTENER_CLARIFICATION', { ...options, role: 'listener' }),
    { number: 6, title: '复述者澄清', label: '复述者澄清', count: 8 });
  assert.equal(roundStep('ADVICE', options)?.number, 7);
  assert.equal(roundStep('ARCHIVED', options)?.number, 8);
});
