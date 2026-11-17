// 넘버 스택 규칙 엔진. 순수 함수 — 서버만 쓰고, 클라이언트는 viewFor 결과만 받는다.
export const COLORS = ['R', 'G', 'B'];
export const WILD = 'W';
export const LIMIT = 13;
export const ROUNDS = 7;
export const N = 6;

export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const shuffle = (a, rng = Math.random) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// members: [{id, name, ai, persona?}] 6명. 좌석은 대기방 순서와 무관하게 랜덤.
export function newGame(members, { phases = 3, rng = Math.random } = {}) {
  return {
    phases, phase: 0, round: 0, stage: 'idle',
    players: shuffle(members.slice(), rng).map((m, seat) => ({ ...m, seat, penalty: 0, pens: [], cards: [], chips: {} })),
    tables: { R: [], G: [], B: [] },
    starter: 0, draw: null, subs: {}, queue: [], history: [], passed: [],
    lastPenalty: null, log: [], evt: 0, result: null,
  };
}

function push(g, e) {
  e.id = ++g.evt;
  g.log.push(e);
  if (g.log.length > 40) g.log.shift();
  return e;
}

// 페이즈 시작: 재분배 + 선 뽑기 준비. 0~6 카드 7장을 뒷면으로 펼치고 각자 1장씩 고른다(pickDraw). 테이블은 비운다.
export function startPhase(g, rng = Math.random) {
  g.phase++;
  g.round = 1;
  g.tables = { R: [], G: [], B: [] };
  for (const p of g.players) {
    p.cards = [0, 1, 2, 3, 4, 5, 6];
    p.chips = { R: 2, G: 2, B: 2, W: 1 };
    p.pens[g.phase - 1] = 0;
  }
  g.deck = shuffle([0, 1, 2, 3, 4, 5, 6], rng); // 자리(slot) → 숫자, 공개 전까지 비공개
  g.picks = {}; // seat → slot
  g.draw = null; // 공개 후 seat → 숫자
  g.starter = null;
  g.stage = 'draw';
  g.subs = {}; g.queue = []; g.history = []; g.passed = [];
}

export const freeSlots = (g) => g.deck.map((_, i) => i).filter((i) => !Object.values(g.picks).includes(i));

// 선 뽑기 카드 1장 고르기. 모두 고르면 공개하고 가장 큰 수가 선. 완료되면 true.
export function pickDraw(g, seat, slot) {
  if (g.stage !== 'draw' || g.draw || !g.players[seat] || seat in g.picks || !freeSlots(g).includes(slot)) return false;
  g.picks[seat] = slot;
  if (Object.keys(g.picks).length < N) return false;
  g.draw = g.players.map((p) => g.deck[g.picks[p.seat]]);
  g.starter = g.draw.indexOf(Math.max(...g.draw));
  push(g, { type: 'draw', phase: g.phase, seat: g.starter });
  return true;
}

// 아직 안 고른 사람은 남은 카드 중 랜덤
export function autoDraw(g, rng = Math.random) {
  for (const p of g.players) {
    if (p.seat in g.picks) continue;
    const free = freeSlots(g);
    pickDraw(g, p.seat, free[Math.floor(rng() * free.length)]);
  }
}

export function beginRound(g) {
  g.stage = 'select';
  g.subs = {}; g.queue = []; g.history = []; g.passed = []; g.lastPenalty = null;
}

export const canSubmit = (g, seat, chip, num) => {
  const p = g.players[seat];
  return g.stage === 'select' && !!p && !g.subs[seat] && p.chips[chip] > 0 && p.cards.includes(num);
};

export function submit(g, seat, chip, num) {
  if (!canSubmit(g, seat, chip, num)) throw new Error('제출할 수 없습니다');
  g.subs[seat] = { chip, num };
  return Object.keys(g.subs).length === N;
}

export function randomPick(p, rng = Math.random) {
  const chips = Object.keys(p.chips).filter((c) => p.chips[c] > 0);
  return { chip: chips[Math.floor(rng() * chips.length)], num: p.cards[Math.floor(rng() * p.cards.length)] };
}

// 행동 순서.
// 1) 와일드 제출자가 맨 앞: 숫자 큰 순, 같으면 선과 가까운 순.
// 2) 나머지는 선부터 시계 방향 자리(슬롯). 같은 색끼리는 자기 색의 슬롯들 안에서 숫자 큰 사람이 앞 슬롯을 가져간다.
export function turnOrder(subs, starter) {
  const dist = (s) => (s - starter + N) % N;
  const pri = (a, b) => subs[b].num - subs[a].num || dist(a) - dist(b);
  const seats = Object.keys(subs).map(Number);
  const wild = seats.filter((s) => subs[s].chip === WILD).sort(pri);
  const rest = seats.filter((s) => subs[s].chip !== WILD).sort((a, b) => dist(a) - dist(b));
  const out = rest.slice();
  for (const c of COLORS) {
    const idx = rest.flatMap((s, i) => (subs[s].chip === c ? [i] : []));
    const sorted = idx.map((i) => rest[i]).sort(pri);
    idx.forEach((i, k) => (out[i] = sorted[k]));
  }
  return [...wild, ...out];
}

export function reveal(g) {
  for (const [s, { chip, num }] of Object.entries(g.subs)) {
    const p = g.players[s];
    p.chips[chip]--;
    p.cards.splice(p.cards.indexOf(num), 1);
  }
  g.queue = turnOrder(g.subs, g.starter);
  g.stage = 'play';
  push(g, { type: 'reveal', round: g.round });
}

export function act(g, seat, { type, table } = {}) {
  if (g.stage !== 'play' || g.queue[0] !== seat) throw new Error('차례가 아닙니다');
  const sub = g.subs[seat];
  if (type === 'pass') {
    if (g.passed.includes(seat)) throw new Error('패스는 라운드당 1회');
    g.queue.shift();
    // 맨 뒤로. 같은 색 패스 대기자가 있으면 늦게 패스한 쪽이 먼저(그 앞에 끼움).
    const i = g.queue.findIndex((s) => g.passed.includes(s) && g.subs[s].chip === sub.chip);
    g.queue.splice(i < 0 ? g.queue.length : i, 0, seat);
    g.passed.push(seat);
    g.history.push({ seat, ...sub, type: 'pass' });
    return push(g, { type: 'pass', seat, chip: sub.chip, num: sub.num });
  }
  const t = sub.chip === WILD ? table : sub.chip;
  if (!COLORS.includes(t)) throw new Error('테이블을 골라야 합니다');
  g.queue.shift();
  const stack = g.tables[t];
  stack.push(sub.num);
  let removed = [];
  if (sum(stack) >= LIMIT) {
    removed = stack.splice(0, stack.length - 1);
    const p = g.players[seat];
    p.penalty += removed.length;
    p.pens[g.phase - 1] += removed.length;
    g.lastPenalty = seat;
  }
  g.history.push({ seat, ...sub, type: 'stack', table: t, penalty: removed.length });
  return push(g, { type: 'stack', seat, chip: sub.chip, num: sub.num, table: t, removed });
}

// 라운드 정리. 다음 선 = 이번 라운드 마지막 벌점자, 없으면 시계 방향으로 양도.
export function endRound(g) {
  g.starter = g.lastPenalty ?? (g.starter + 1) % N;
  if (g.round < ROUNDS) {
    g.round++;
    return 'round';
  }
  if (g.phase < g.phases) {
    g.stage = 'phaseEnd';
    return 'phase';
  }
  g.stage = 'over';
  g.result = { out: eliminated(g.players) };
  return 'game';
}

// 탈락: 벌점 상위 2명. 1위 동점이 2명 이상이면 그 동점자만. 2위 동점은 모두 탈락.
export function eliminated(players) {
  const s = [...players].sort((a, b) => b.penalty - a.penalty);
  const tops = s.filter((p) => p.penalty === s[0].penalty);
  if (tops.length >= 2) return tops.map((p) => p.seat);
  return s.filter((p) => p.penalty >= s[1].penalty).map((p) => p.seat);
}
