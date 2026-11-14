import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRoundCommand, DomainError, newRound, type Actor, type Command, type Member, type Round } from '../src/round.ts';

const now = new Date('2026-11-13T10:00:00.000Z');
const members: Member[] = [
  { id: 'a', role: 'speaker', active: true },
  { id: 'b', role: 'listener', active: true },
  { id: 'c', role: 'observer', active: true },
];
const speaker: Actor = { kind: 'member', memberId: 'a' };
const listener: Actor = { kind: 'member', memberId: 'b' };
const observer: Actor = { kind: 'member', memberId: 'c' };
const system: Actor = { kind: 'system' };

function apply(round: Round, command: Command, actor: Actor, at = now, activeMembers = members): Round {
  return applyRoundCommand(round, command, { actor, members: activeMembers, expectedVersion: round.version, now: at, speakerSeconds: 30, listenerSeconds: 30, asyncWaitSeconds: 86400 });
}

function expectError(fn: () => unknown, code: string): void {
  assert.throws(fn, error => error instanceof DomainError && error.code === code);
}

function labeled(round: Round): Round {
  let next = apply(round, { type: 'task-set' }, speaker);
  next = apply(next, { type: 'speaker-submitted', audioId: 'audio-a' }, speaker);
  next = apply(next, { type: 'points-confirmed', pointCount: 2 }, speaker);
  next = apply(next, { type: 'listener-submitted', audioId: 'audio-b' }, listener);
  next = apply(next, { type: 'comparison-ready', issueIds: ['first', 'second'] }, system);
  return apply(next, { type: 'speaker-labeled', labels: [
    { issueId: 'first', tag: '遗漏重要信息', resolution: 'misunderstanding' },
    { issueId: 'second', tag: 'AI 误判', resolution: 'ai_error' },
  ] }, speaker);
}

test('two distinct members must confirm every issue before speaker submission', () => {
  let round = labeled(newRound({ id: 'r1', roomId: 'room', mode: 'sync', speakerId: 'a', listenerId: 'b' }));
  expectError(() => apply(round, { type: 'issue-confirmed', issueId: 'first' }, observer), 'FORBIDDEN_ROLE');
  round = apply(round, { type: 'issue-confirmed', issueId: 'first' }, speaker);
  round = apply(round, { type: 'issue-confirmed', issueId: 'first' }, listener);
  round = apply(round, { type: 'issue-confirmed', issueId: 'second' }, speaker);
  expectError(() => apply(round, { type: 'confirmations-submitted' }, speaker), 'UNCONFIRMED_ISSUES');
  round = apply(round, { type: 'issue-confirmed', issueId: 'second' }, listener);
  expectError(() => apply(round, { type: 'confirmations-submitted' }, listener), 'FORBIDDEN_ROLE');
  round = apply(round, { type: 'confirmations-submitted' }, speaker);
  assert.equal(round.stage, 'ADVICE');
  round = apply(round, { type: 'archived' }, speaker);
  assert.equal(round.stage, 'ARCHIVED');
  expectError(() => apply(round, { type: 'archived' }, speaker), 'TERMINAL_ROUND');
});

test('revision clears both old confirmations', () => {
  let round = labeled(newRound({ id: 'r1', roomId: 'room', mode: 'sync', speakerId: 'a', listenerId: 'b' }));
  round = apply(round, { type: 'issue-confirmed', issueId: 'first' }, speaker);
  round = apply(round, { type: 'issue-confirmed', issueId: 'first' }, listener);
  round = apply(round, { type: 'issue-revised', issueId: 'first', tag: '我表达不清', resolution: 'expression' }, speaker);
  assert.equal(round.issues[0]?.revision, 3);
  assert.equal(round.issues[0]?.speakerConfirmedRevision, null);
  assert.equal(round.issues[0]?.listenerConfirmedRevision, null);
});

test('version and absolute deadline reject stale or premature advancement', () => {
  let round = newRound({ id: 'r1', roomId: 'room', mode: 'sync', speakerId: 'a', listenerId: 'b' });
  round = apply(round, { type: 'task-set' }, speaker);
  assert.equal(round.deadlineAt, '2026-11-13T10:00:30.000Z');
  expectError(() => applyRoundCommand(round, { type: 'speaker-submitted', audioId: 'x' }, { actor: speaker, members, expectedVersion: 1, now, speakerSeconds: 30, listenerSeconds: 30, asyncWaitSeconds: 86400 }), 'STALE_VERSION');
  expectError(() => apply(round, { type: 'expired' }, system), 'NOT_DUE');
  round = apply(round, { type: 'expired' }, system, new Date('2026-11-13T10:00:30.000Z'));
  assert.equal(round.stage, 'CANCELLED');
});

test('inactive or forged membership cannot act', () => {
  const round = newRound({ id: 'r1', roomId: 'room', mode: 'sync', speakerId: 'a', listenerId: 'b' });
  expectError(() => apply(round, { type: 'task-set' }, { kind: 'member', memberId: 'unknown' }), 'NOT_MEMBER');
  expectError(() => apply(round, { type: 'task-set' }, speaker, now, members.map(row => row.id === 'a' ? { ...row, active: false } : row)), 'NOT_MEMBER');
  expectError(() => apply(round, { type: 'task-set' }, listener), 'FORBIDDEN_ROLE');
});

test('async message waits for listener and allows a new round after archive', () => {
  let round = newRound({ id: 'r1', roomId: 'room', mode: 'async', speakerId: 'a', listenerId: 'b' });
  round = apply(round, { type: 'task-set' }, speaker);
  round = apply(round, { type: 'speaker-submitted', audioId: 'audio-a' }, speaker);
  round = apply(round, { type: 'points-confirmed', pointCount: 2 }, speaker);
  assert.equal(round.stage, 'ASYNC_PENDING');
  expectError(() => apply(round, { type: 'async-opened' }, speaker), 'FORBIDDEN_ROLE');
  round = apply(round, { type: 'async-opened' }, listener);
  assert.equal(round.stage, 'LISTENER_RETELL');
  const another = newRound({ id: 'r2', roomId: 'room', mode: 'async', speakerId: 'a', listenerId: 'b' });
  assert.equal(another.stage, 'TASK');
  assert.notEqual(another.id, round.id);
});

test('solo seat switches are limited to the same participant', () => {
  const soloMembers: Member[] = [{ id: 'a', role: 'speaker', active: true }];
  let round = newRound({ id: 'r1', roomId: 'room', mode: 'solo', speakerId: 'a', listenerId: 'a' });
  round = apply(round, { type: 'task-set' }, speaker, now, soloMembers);
  round = apply(round, { type: 'speaker-submitted', audioId: 'audio-a' }, speaker, now, soloMembers);
  round = apply(round, { type: 'points-confirmed', pointCount: 1 }, speaker, now, soloMembers);
  assert.equal(round.activeSeat, 'listener');
  round = apply(round, { type: 'listener-submitted', audioId: 'audio-b' }, speaker, now, soloMembers);
  round = apply(round, { type: 'comparison-ready', issueIds: ['first'] }, system, now, soloMembers);
  assert.equal(round.activeSeat, 'speaker');
  round = apply(round, { type: 'speaker-labeled', labels: [{ issueId: 'first', tag: '遗漏重要信息', resolution: 'misunderstanding' }] }, speaker, now, soloMembers);
  round = apply(round, { type: 'issue-confirmed', issueId: 'first' }, speaker, now, soloMembers);
  round = apply(round, { type: 'seat-switched', seat: 'listener' }, speaker, now, soloMembers);
  round = apply(round, { type: 'issue-confirmed', issueId: 'first' }, speaker, now, soloMembers);
  expectError(() => apply(round, { type: 'confirmations-submitted' }, speaker, now, soloMembers), 'FORBIDDEN_ROLE');
  round = apply(round, { type: 'seat-switched', seat: 'speaker' }, speaker, now, soloMembers);
  round = apply(round, { type: 'confirmations-submitted' }, speaker, now, soloMembers);
  assert.equal(round.stage, 'ADVICE');
});
