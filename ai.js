// AI: 제출은 몬테카를로(상대 남은 자원에서 무작위 표본 → 라운드를 끝까지 굴려 기대 벌점 비교),
// 행동(쌓기/패스/와일드 테이블)은 공개된 제출로 남은 순서를 그대로 굴려 비교.
// 남은 자원은 매 라운드 공개 제출로 누구나 셀 수 있는 정보이므로 AI가 써도 공정하다.
import { COLORS, WILD, LIMIT, N, ROUNDS, sum, turnOrder, randomPick } from './engine.js';

// aggr: 남에게 벌점 떠넘기기 선호, chaos: 판단 흔들림(안정적 플레이만 하지 않게), hoard: 0·와일드 아껴두기
export const PERSONAS = [
  { name: '블루윙', aggr: 0.8, chaos: 0.25, hoard: 0.5 },
  { name: '루비나', aggr: 0.3, chaos: 0.15, hoard: 0.9 },
  { name: '논리왕', aggr: 0.5, chaos: 0.05, hoard: 0.7 },
  { name: '카드킹', aggr: 0.2, chaos: 0.2, hoard: 0.4 },
  { name: '스택맨', aggr: 1.0, chaos: 0.3, hoard: 0.3 },
  { name: '설화린', aggr: 0.4, chaos: 0.35, hoard: 0.6 },
];
const DEF = { aggr: 0.5, chaos: 0.1, hoard: 0.6 };

const clone = (t) => ({ R: [...t.R], G: [...t.G], B: [...t.B] });
const cost = (tables, t, num) => (sum(tables[t]) + num >= LIMIT ? tables[t].length : 0);

export function place(tables, t, num) {
  const s = tables[t];
  s.push(num);
  return sum(s) >= LIMIT ? s.splice(0, s.length - 1).length : 0;
}

// 와일드의 안전한 선택: 벌점 최소, 같으면 쌓인 합이 낮은 곳
export const safeTable = (tables, num) =>
  COLORS.reduce((b, t) => {
    const d = cost(tables, t, num) - cost(tables, b, num);
    return d < 0 || (d === 0 && sum(tables[t]) < sum(tables[b])) ? t : b;
  });

function playOut(tables, queue, subs, pens) {
  for (const s of queue) {
    const { chip, num } = subs[s];
    pens[s] += place(tables, chip === WILD ? safeTable(tables, num) : chip, num);
  }
}

export function aiSubmit(g, seat, persona = DEF, rng = Math.random, K = 48) {
  const me = g.players[seat];
  const chips = Object.keys(me.chips).filter((c) => me.chips[c] > 0);
  const left = (ROUNDS - g.round) / (ROUNDS - 1); // 1 → 0
  const samples = Array.from({ length: K }, () => {
    const subs = {};
    for (const p of g.players) if (p.seat !== seat) subs[p.seat] = randomPick(p, rng);
    return subs;
  });
  let best = null, bestScore = Infinity;
  for (const chip of chips) for (const num of me.cards) {
    let mine = 0, dealt = 0;
    for (const sm of samples) {
      const subs = { ...sm, [seat]: { chip, num } };
      const pens = Array(N).fill(0);
      playOut(clone(g.tables), turnOrder(subs, g.starter), subs, pens);
      mine += pens[seat];
      dealt += sum(pens) - pens[seat];
    }
    let score = mine / K - persona.aggr * 0.15 * dealt / K;
    // 0과 와일드는 위험한 판에서 쓸수록 값지다 → 남은 라운드가 많을 때는 아껴 둔다
    if (chip === WILD) score += persona.hoard * 1.2 * left;
    if (num === 0) score += persona.hoard * 0.6 * left;
    // 큰 수는 판이 가벼울 때 털어 두는 편이 낫다
    score -= (num / 6) * 0.08 * left;
    score += (rng() - 0.5) * 2 * persona.chaos;
    if (score < bestScore) { bestScore = score; best = { chip, num }; }
  }
  return best;
}

export function aiAct(g, seat, persona = DEF, noPass = false) {
  const sub = g.subs[seat];
  const rest = g.queue.slice(1);
  const opts = (sub.chip === WILD ? COLORS : [sub.chip]).map((table) => ({ type: 'stack', table }));
  if (!noPass && !g.passed.includes(seat) && rest.length) opts.push({ type: 'pass' });
  let best = null, bs = Infinity;
  for (const o of opts) {
    const tables = clone(g.tables), pens = Array(N).fill(0);
    if (o.type === 'stack') {
      pens[seat] += place(tables, o.table, sub.num);
      playOut(tables, rest, g.subs, pens);
    } else playOut(tables, [...rest, seat], g.subs, pens);
    const score = pens[seat] - persona.aggr * 0.2 * (sum(pens) - pens[seat]) + (o.type === 'pass' ? 0.05 : 0);
    if (score < bs) { bs = score; best = o; }
  }
  return best;
}
