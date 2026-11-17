import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePractice, type PracticeMaterial } from '../src/practice-comparison.ts';

const sample: PracticeMaterial = {
  id: 'test', title: '见面安排', topic: '家庭日常', keywords: ['周六', '午饭'],
  source: ['周六先去看外婆。', '外婆身体允许，再一起吃午饭。'],
  checks: [
    { sourceIndex: 0, keywords: ['周六', '外婆'], tag: '遗漏重要信息', question: '哪天去看外婆？' },
    { sourceIndex: 1, keywords: ['身体允许', '午饭'], tag: '遗漏关键条件', question: '什么情况下吃午饭？' },
  ],
  advice: '把条件和安排一起复述。',
};

test('aligns reordered sentences and keeps the actual paired lines', () => {
  const result = comparePractice(sample, '再一起吃午饭。周六先看外婆。');
  assert.deepEqual([result.complete, result.accurate, result.total], [2, 1, 2]);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.original, sample.source[1]);
  assert.equal(result.issues[0]?.retell, '再一起吃午饭。');
});

test('an explicitly blank transcript is never scored using the built-in demo', () => {
  const result = comparePractice(sample, ' ');
  assert.equal(result.complete, 0);
  assert.equal(result.accurate, 0);
  assert.ok(result.issues.every(item => item.retell === ''));
});
