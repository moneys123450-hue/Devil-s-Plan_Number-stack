// 실제 서버 + 소켓 클라이언트로 끝까지 플레이 (연출 대기시간만 1/100로 축소)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

process.env.PORT = '0';
process.env.SPEED = '0.01';
const { server } = await import('../server.js');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const url = `http://localhost:${server.address().port}`;
const clients = [];
const done = () => { clients.forEach((c) => c.close()); server.close(); };

// 사람처럼: 선택 단계엔 남은 것 중 하나 제출, 내 차례엔 가끔 패스
function bot(pid) {
  const c = io(url, { auth: { pid }, forceNew: true });
  clients.push(c);
  c.states = [];
  c.on('state', (s) => {
    c.last = s;
    c.states.push(s);
    const G = s?.game;
    if (!G || G.me == null) return;
    const h = G.hand;
    if (G.stage === 'select' && !h.sub) {
      const chip = Object.keys(h.chips).find((k) => h.chips[k] > 0);
      c.emit('submit', { chip, num: h.cards[h.cards.length - 1] });
    }
    if (G.stage === 'play' && G.current === G.me) {
      if (!h.passed && Math.random() < 0.3) c.emit('act', { type: 'pass' });
      else c.emit('act', { type: 'stack', table: 'RGB'[Math.floor(Math.random() * 3)] });
    }
  });
  return c;
}
const until = (c, pred, ms = 20000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  const chk = () => { if (c.last !== undefined && pred(c.last)) { clearTimeout(t); res(c.last); } else setTimeout(chk, 20); };
  chk();
});

test('솔로: AI 5명과 1페이즈 완주, 남의 손패·미공개 제출은 보이지 않음', async () => {
  const c = bot('solo-player-1');
  c.emit('create', { name: '나', solo: true, settings: { phases: 1, turnSec: 10 } });
  const end = await until(c, (s) => s.game?.stage === 'over');
  assert.equal(end.game.players.length, 6);
  assert.ok(end.game.result.out.length >= 2);
  for (const s of c.states) {
    const G = s.game;
    if (!G) continue;
    assert.ok(!('cards' in G.players[0]) && !('chips' in G.players[0]));
    if (G.stage === 'select') assert.ok(G.players.every((p) => p.sub === null));
  }
});

test('멀티: 방 만들기 → 코드로 참가 → 시작, 빈 자리 AI, 둘 다 같은 결과', async () => {
  const a = bot('multi-host-1'), b = bot('multi-guest-1');
  a.emit('create', { name: '방장', settings: { phases: 2, turnSec: 10 } });
  const lobby = await until(a, (s) => s?.code);
  b.emit('join', { code: lobby.code.toLowerCase(), name: '손님' });
  await until(a, (s) => s.members.length === 2);
  b.emit('start'); // 방장이 아니면 무시
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.last.game, null);
  a.emit('start');
  const ea = await until(a, (s) => s.game?.stage === 'over', 40000);
  const eb = await until(b, (s) => s.game?.stage === 'over', 5000);
  assert.equal(ea.game.players.filter((p) => p.ai).length, 4);
  assert.deepEqual(ea.game.players.map((p) => p.penalty), eb.game.players.map((p) => p.penalty));
  assert.equal(ea.game.players[0].pens.length, 2);
  assert.notEqual(ea.game.me, eb.game.me);
});

test('새로고침 복귀: 같은 pid로 다시 접속하면 같은 방·같은 자리', async () => {
  const a = bot('rejoin-player-1');
  a.emit('create', { name: '복귀', settings: { phases: 1 } });
  const s1 = await until(a, (s) => s?.code);
  a.close();
  const a2 = io(url, { auth: { pid: 'rejoin-player-1' }, forceNew: true });
  clients.push(a2);
  const s2 = await new Promise((r) => a2.once('state', r));
  assert.equal(s2.code, s1.code);
});

test('다시 시작: 방장이 누르면 같은 방에서 새 게임, 나가기: 새로고침해도 그 방으로 돌아가지 않음', async () => {
  const c = io(url, { auth: { pid: 'restart-player-1' }, forceNew: true });
  clients.push(c);
  c.on('state', (s) => (c.last = s));
  c.emit('create', { name: '재시작', solo: true, settings: { phases: 1 } });
  await until(c, (s) => s.game?.stage === 'select');
  const code = c.last.code;
  c.emit('submit', { chip: 'R', num: 3 });
  await until(c, (s) => s.game?.hand.sub);
  c.emit('restart');
  const r = await until(c, (s) => s.game?.stage === 'draw' && !s.game.hand.sub && s.code === code);
  assert.equal(r.game.hand.cards.length, 7);
  c.emit('leave');
  await until(c, (s) => s === null);
  c.close();
  const c2 = io(url, { auth: { pid: 'restart-player-1' }, forceNew: true });
  clients.push(c2);
  let got = 'none';
  c2.on('state', (s) => (got = s));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(got, 'none');
  done();
});
