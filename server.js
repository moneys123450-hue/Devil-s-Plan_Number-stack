import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as E from './engine.js';
import { aiSubmit, aiAct, PERSONAS } from './ai.js';

const SPEED = Number(process.env.SPEED || 1); // 테스트에서 연출 대기시간 축소용
const ACT_SEC = 30; // 쌓기/패스 차례 제한 시간(카드 선택 시간 설정과 별개)
const T = { draw: 3200, aiMin: 1200, aiMax: 4500, reveal: 2200, aiTurn: 1400, roundEnd: 2400, phaseEnd: 7000 };
const ms = (k) => T[k] * SPEED;
const rand = (a, b) => a + Math.random() * (b - a);

const app = express();
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
export const server = createServer(app);
const io = new Server(server);
const rooms = new Map();

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  while (rooms.has(c));
  return c;
}
const cleanName = (n) => String(n ?? '').trim().slice(0, 10) || '플레이어';
const cleanSettings = (s = {}) => ({
  turnSec: Math.min(60, Math.max(10, Math.round(Number(s.turnSec) || 20))),
  phases: Math.min(5, Math.max(1, Math.round(Number(s.phases) || 3))),
});

class Room {
  constructor(code, settings) {
    Object.assign(this, { code, hostId: null, members: [], settings: cleanSettings(settings), g: null, timers: [], deadline: 0 });
  }
  later(t, fn) {
    this.timers.push(setTimeout(() => { try { fn(); } catch (e) { console.error(e); } }, t));
  }
  clear() { this.timers.forEach(clearTimeout); this.timers = []; }
  member(id) { return this.members.find((m) => m.id === id); }
  seatOf(id) { return this.g?.players.find((p) => p.id === id)?.seat; }
  auto(seat) { const p = this.g.players[seat]; return p.ai || !this.member(p.id)?.connected; }

  start() {
    this.members = this.members.filter((m) => m.connected);
    const humans = this.members.map(({ id, name }) => ({ id, name, ai: false }));
    const ais = PERSONAS.filter((a) => !humans.some((h) => h.name === a.name))
      .slice(0, E.N - humans.length)
      .map((persona, i) => ({ id: 'ai' + i, name: persona.name, ai: true, persona }));
    this.g = E.newGame([...humans, ...ais], { phases: this.settings.phases });
    this.phase();
  }
  phase() {
    this.clear();
    E.startPhase(this.g);
    this.deadline = 0;
    this.sync();
    this.later(ms('draw'), () => this.select());
  }
  select() {
    const g = this.g;
    E.beginRound(g);
    const sec = this.settings.turnSec * 1000;
    this.deadline = Date.now() + sec;
    this.total = sec;
    for (const p of g.players) if (this.auto(p.seat)) this.later(rand(ms('aiMin'), ms('aiMax')), () => this.aiSubmit(p.seat));
    this.later(sec, () => { for (const p of g.players) if (!g.subs[p.seat]) this.submit(p.seat, E.randomPick(p)); });
    this.sync();
  }
  aiSubmit(seat) { this.submit(seat, aiSubmit(this.g, seat, this.g.players[seat].persona)); }
  submit(seat, { chip, num } = {}) {
    const g = this.g;
    if (!g || !E.canSubmit(g, seat, chip, num)) return false;
    if (E.submit(g, seat, chip, num)) {
      this.clear();
      E.reveal(g);
      this.deadline = 0;
      this.sync();
      this.later(ms('reveal'), () => this.turn());
    } else this.sync();
    return true;
  }
  turn() {
    const g = this.g;
    if (!g.queue.length) {
      this.deadline = 0;
      this.sync();
      return this.later(ms('roundEnd'), () => this.endRound());
    }
    const seat = g.queue[0], p = g.players[seat];
    if (this.auto(seat)) {
      this.deadline = 0;
      this.later(ms('aiTurn'), () => this.act(seat, aiAct(g, seat, p.persona)));
    } else {
      const sec = ACT_SEC * 1000;
      this.deadline = Date.now() + sec;
      this.total = sec;
      // 시간 초과: 쌓기(와일드면 가장 안전한 테이블)
      this.later(sec, () => this.act(seat, aiAct(g, seat, undefined, true)));
    }
    this.sync();
  }
  act(seat, a = {}) {
    const g = this.g;
    if (!g || g.stage !== 'play' || g.queue[0] !== seat) return false;
    try { E.act(g, seat, a); } catch { return false; }
    this.clear();
    this.turn();
    return true;
  }
  endRound() {
    const r = E.endRound(this.g);
    if (r === 'round') this.select();
    else if (r === 'phase') { this.sync(); this.later(ms('phaseEnd'), () => this.phase()); }
    else this.sync();
  }
  // 접속이 끊긴 사람의 차례는 AI가 바로 대신한다
  dropped(id) {
    const g = this.g, seat = this.seatOf(id);
    if (!g || seat == null) return;
    if (g.stage === 'select' && !g.subs[seat]) this.later(1000 * SPEED, () => this.aiSubmit(seat));
    if (g.stage === 'play' && g.queue[0] === seat) { this.clear(); this.turn(); }
  }

  view(id) {
    const g = this.g, seat = this.seatOf(id);
    const v = {
      code: this.code, hostId: this.hostId, you: id, settings: this.settings,
      members: this.members.map(({ id, name, connected }) => ({ id, name, connected })),
      timeLeft: this.deadline ? Math.max(0, this.deadline - Date.now()) : 0,
      timeTotal: this.total ?? 0,
      game: null,
    };
    if (!g) return v;
    const open = g.stage !== 'select' && g.stage !== 'draw';
    const me = g.players[seat];
    v.game = {
      stage: g.stage, phase: g.phase, phases: g.phases, round: g.round, rounds: E.ROUNDS,
      starter: g.starter, tables: g.tables, draw: g.draw, log: g.log, result: g.result,
      current: g.stage === 'play' ? g.queue[0] ?? null : null,
      players: g.players.map((p) => ({
        seat: p.seat, name: p.name, ai: p.ai, penalty: p.penalty, pens: p.pens,
        connected: p.ai || !!this.member(p.id)?.connected,
        submitted: !!g.subs[p.seat],
        sub: open ? g.subs[p.seat] ?? null : null,
      })),
      order: open ? [...g.history, ...g.queue.map((s) => ({ seat: s, ...g.subs[s], type: 'wait', passed: g.passed.includes(s) }))] : [],
      me: seat ?? null,
      hand: me ? { cards: me.cards, chips: me.chips, sub: g.subs[seat] ?? null, passed: g.passed.includes(seat) } : null,
    };
    return v;
  }
  sync() {
    for (const m of this.members) if (m.connected && m.sock) m.sock.emit('state', this.view(m.id));
  }
  remove(id) {
    if (this.g) { const m = this.member(id); if (m) { m.connected = false; m.sock = null; } this.dropped(id); }
    else this.members = this.members.filter((m) => m.id !== id);
    if (this.hostId === id) this.hostId = this.members.find((m) => m.connected)?.id ?? null;
    this.sync();
    this.reap();
  }
  // 사람이 모두 나가면 10분 뒤 방 삭제
  reap() {
    if (this.members.some((m) => m.connected)) return;
    setTimeout(() => {
      if (!this.members.some((m) => m.connected)) { this.clear(); rooms.delete(this.code); }
    }, 10 * 60 * 1000).unref();
  }
}

io.on('connection', (sock) => {
  let pid = sock.handshake.auth?.pid;
  if (typeof pid !== 'string' || !/^[\w-]{8,64}$/.test(pid)) pid = randomUUID();
  sock.emit('pid', pid);
  let room = null;
  const err = (m) => sock.emit('err', m);

  const attach = (r, name) => {
    if (room && room !== r) room.remove(pid);
    room = r;
    let m = r.member(pid);
    if (!m) r.members.push((m = { id: pid, name: cleanName(name) }));
    Object.assign(m, { sock, connected: true });
    if (!r.hostId || !r.member(r.hostId)?.connected) r.hostId = pid;
    r.sync();
  };

  for (const r of rooms.values()) if (r.member(pid)) { attach(r); break; } // 새로고침 복귀

  sock.on('create', ({ name, solo, settings } = {}) => {
    const r = new Room(newCode(), settings);
    rooms.set(r.code, r);
    attach(r, name);
    if (solo) r.start();
  });
  sock.on('join', ({ code, name } = {}) => {
    const r = rooms.get(String(code ?? '').trim().toUpperCase());
    if (!r) return err('방을 찾을 수 없습니다');
    if (!r.member(pid)) {
      if (r.g) return err('이미 게임이 진행 중인 방입니다');
      if (r.members.length >= E.N) return err('방이 가득 찼습니다');
    }
    attach(r, name);
  });
  const host = () => room && room.hostId === pid && !room.g;
  sock.on('settings', (s) => { if (host()) { room.settings = cleanSettings(s); room.sync(); } });
  sock.on('start', () => { if (host()) room.start(); });
  sock.on('submit', (s) => room?.g && room.submit(room.seatOf(pid), s));
  sock.on('act', (a) => room?.g && room.act(room.seatOf(pid), { type: a?.type === 'pass' ? 'pass' : 'stack', table: a?.table }));
  sock.on('lobby', () => {
    if (!room || room.hostId !== pid || room.g?.stage !== 'over') return;
    room.clear();
    room.g = null;
    room.members = room.members.filter((m) => m.connected);
    room.sync();
  });
  sock.on('leave', () => {
    if (!room) return;
    const r = room;
    room = null;
    r.remove(pid);
    // 진행 중인 방을 나가면 자리는 AI가 이어받고, 새로고침해도 다시 끌려 들어가지 않는다
    r.members = r.members.filter((m) => m.id !== pid);
    if (!r.members.length) { r.clear(); rooms.delete(r.code); }
    sock.emit('state', null);
  });
  sock.on('restart', () => {
    if (!room?.g || room.hostId !== pid) return;
    room.clear();
    room.start();
  });
  sock.on('disconnect', () => {
    if (!room) return;
    const m = room.member(pid);
    if (m?.sock !== sock) return;
    if (room.g) room.remove(pid);
    else { m.connected = false; m.sock = null; room.sync(); room.reap(); }
  });
});

const port = process.env.PORT ?? 3000;
server.listen(port, () => console.log(`넘버 스택: http://localhost:${server.address().port}`));
