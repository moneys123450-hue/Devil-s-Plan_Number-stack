import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../engine.js';
import { aiSubmit, aiAct, PERSONAS } from '../ai.js';

const S = (chip, num) => ({ chip, num });

test('행동 순서: 와일드 먼저(숫자 큰 순), 같은 색은 자기 슬롯 안에서 큰 수 우선', () => {
  const subs = { 0: S('R', 1), 1: S('G', 3), 2: S('R', 6), 3: S('W', 2), 4: S('W', 5), 5: S('B', 0) };
  assert.deepEqual(E.turnOrder(subs, 0), [4, 3, 2, 1, 0, 5]);
});

test('행동 순서: 와일드 숫자 동점이면 선과 가까운 쪽', () => {
  const subs = { 0: S('R', 1), 1: S('G', 1), 2: S('W', 3), 3: S('B', 1), 4: S('R', 2), 5: S('W', 3) };
  assert.deepEqual(E.turnOrder(subs, 4).slice(0, 2), [5, 2]);
});

function playing(subs, starter = 0) {
  const g = E.newGame(Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, name: 'p' + i })), { rng: () => 0.99 });
  g.players.forEach((p, i) => (p.seat = i));
  E.startPhase(g);
  E.beginRound(g);
  g.starter = starter;
  for (const [s, v] of Object.entries(subs)) E.submit(g, +s, v.chip, v.num);
  E.reveal(g);
  return g;
}

test('패스: 맨 뒤로, 같은 색 패스자끼리는 늦게 한 쪽이 먼저, 라운드당 1회', () => {
  const g = playing({ 0: S('R', 6), 1: S('R', 5), 2: S('G', 4), 3: S('G', 3), 4: S('B', 2), 5: S('B', 1) });
  assert.deepEqual(g.queue, [0, 1, 2, 3, 4, 5]);
  E.act(g, 0, { type: 'pass' });
  assert.deepEqual(g.queue, [1, 2, 3, 4, 5, 0]);
  E.act(g, 1, { type: 'pass' });
  assert.deepEqual(g.queue, [2, 3, 4, 5, 1, 0]);
  E.act(g, 2, { type: 'pass' });
  assert.deepEqual(g.queue, [3, 4, 5, 1, 0, 2]);
  for (const s of [3, 4, 5]) E.act(g, s, { type: 'stack' });
  assert.throws(() => E.act(g, 1, { type: 'pass' }));
});

test('13 이상이면 마지막 블럭 빼고 개수만큼 벌점, 다음 선은 마지막 벌점자', () => {
  const g = playing({ 0: S('R', 6), 1: S('R', 5), 2: S('R', 2), 3: S('W', 0), 4: S('G', 6), 5: S('G', 6) });
  E.act(g, 3, { type: 'stack', table: 'B' });
  for (const s of [0, 1]) E.act(g, s, { type: 'stack' });
  assert.deepEqual(g.tables.R, [6, 5]);
  E.act(g, 2, { type: 'stack' }); // 6+5+2 = 13
  assert.equal(g.players[2].penalty, 2);
  assert.deepEqual(g.tables.R, [2]);
  E.act(g, 4, { type: 'stack' });
  E.act(g, 5, { type: 'stack' }); // 12, 벌점 없음
  assert.deepEqual(g.tables.G, [6, 6]);
  assert.equal(E.endRound(g), 'round');
  assert.equal(g.starter, 2);
});

test('벌점자 없으면 선은 시계 방향으로 양도', () => {
  const g = playing({ 0: S('R', 1), 1: S('G', 1), 2: S('B', 1), 3: S('R', 1), 4: S('G', 1), 5: S('B', 1) }, 3);
  while (g.queue.length) E.act(g, g.queue[0], { type: 'stack' });
  E.endRound(g);
  assert.equal(g.starter, 4);
});

test('탈락 판정', () => {
  const P = (...pens) => pens.map((penalty, seat) => ({ seat, penalty }));
  assert.deepEqual(E.eliminated(P(9, 7, 3, 2, 1, 0)).sort(), [0, 1]);
  assert.deepEqual(E.eliminated(P(9, 9, 9, 2, 1, 0)).sort(), [0, 1, 2]);
  assert.deepEqual(E.eliminated(P(9, 7, 7, 2, 1, 0)).sort(), [0, 1, 2]);
});

test('AI 6명이 3페이즈 완주: 자원 정확히 소진, 사라진 블럭 수 = 총 벌점', () => {
  const g = E.newGame(PERSONAS.map((p, i) => ({ id: 'a' + i, name: p.name, ai: true, persona: p })), { phases: 3 });
  let removed = 0;
  let wilds = 0, zeros = 0, wildEarly = 0;
  for (;;) {
    E.startPhase(g);
    for (;;) {
      E.beginRound(g);
      for (const p of g.players) {
        const s = aiSubmit(g, p.seat, p.persona, Math.random, 16);
        if (s.chip === 'W') { wilds++; if (g.round <= 4) wildEarly++; }
        if (s.num === 0) zeros++;
        E.submit(g, p.seat, s.chip, s.num);
      }
      E.reveal(g);
      while (g.queue.length) {
        const s = g.queue[0];
        const e = E.act(g, s, aiAct(g, s, g.players[s].persona));
        if (e.removed) removed += e.removed.length;
      }
      const r = E.endRound(g);
      if (r !== 'round') break;
    }
    for (const p of g.players) {
      assert.deepEqual(p.cards, []);
      assert.ok(Object.values(p.chips).every((c) => c === 0));
    }
    if (g.stage === 'over') break;
  }
  assert.equal(removed, E.sum(g.players.map((p) => p.penalty)));
  assert.equal(wilds, 18);
  assert.equal(zeros, 18);
  assert.ok(g.result.out.length >= 2);
  console.log('벌점', g.players.map((p) => `${p.name}:${p.penalty}`).join(' '), '| 와일드 4라운드 이내 사용', wildEarly, '/ 18');
});
