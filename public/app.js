/* global io */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 사생활 보호 모드 */ } },
};

const roomParam = new URLSearchParams(location.search).get('room');
const socket = io({ auth: { pid: store.get('pid') } });
let S = null, recvAt = 0, sel = {}, selKey = '', seenEvt = -1;

socket.on('pid', (p) => { store.set('pid', p); socket.auth.pid = p; });
socket.on('err', toast);
// 초대 링크로 들어왔고 닉네임이 저장돼 있으면 바로 참가
socket.on('connect', () => {
  const name = store.get('name');
  if (roomParam && name && !S) socket.emit('join', { code: roomParam, name });
});
socket.on('state', (s) => {
  S = s;
  recvAt = Date.now();
  if (s?.game) effects(s.game);
  else seenEvt = -1;
  render();
});

const COL = { R: ['#e0473d', '#8e1c15', 'RED'], G: ['#2fb862', '#0f5a2c', 'GREEN'], B: ['#3c82e6', '#173f80', 'BLUE'] };
const CN = { R: '레드', G: '그린', B: '블루', W: '무지개' };
// 보드 배치 2종: 가로 화면(데스크톱·가로 휴대폰) / 세로 휴대폰. 내 자리(k=0)가 아래, 시계 방향으로 k=1..5
const LAYOUTS = {
  wide: {
    W: 1600, H: 680, TB: { cx: 800, cy: 425, rx: 650, ry: 210 }, PX: { R: 500, G: 800, B: 1100 }, DISH: 400,
    POS: [
      { x: 800, y: 636, ax: -165, ay: 0 }, { x: 170, y: 560, ax: 0, ay: -100 }, { x: 210, y: 262, ax: 0, ay: -100 },
      { x: 800, y: 58, ax: -165, ay: 0 }, { x: 1390, y: 262, ax: 0, ay: -100 }, { x: 1430, y: 560, ax: 0, ay: -100 },
    ],
    F: 1,
  },
  tall: {
    W: 1000, H: 1400, TB: { cx: 500, cy: 760, rx: 475, ry: 470 }, PX: { R: 230, G: 500, B: 770 }, DISH: 800,
    POS: [
      { x: 500, y: 1336, ax: -235, ay: 0 }, { x: 172, y: 1150, ax: 0, ay: -112 }, { x: 172, y: 390, ax: 0, ay: -112 },
      { x: 500, y: 112, ax: -235, ay: 0 }, { x: 828, y: 390, ax: 0, ay: -112 }, { x: 828, y: 1150, ax: 0, ay: -112 },
    ],
    F: 1.6, // 휴대폰에서 글씨가 읽히도록 이름표 확대
  },
};
let LY = null, W, H, TB, PX, DISH, POS;
function applyLayout() {
  const next = innerWidth < 760 && innerHeight > innerWidth ? LAYOUTS.tall : LAYOUTS.wide;
  if (next === LY) return false;
  LY = next;
  ({ W, H, TB, PX, DISH, POS } = LY);
  for (const id of ['#board', '#fx']) $(id)?.setAttribute('viewBox', `0 0 ${W} ${H}`);
  return true;
}
const rel = (G, seat) => (seat - (G.me ?? 0) + 6) % 6;
const nameOf = (G, s) => esc(G.players[s].name);
const chipDot = (c) => `<span class="mini-chip chip-${c}"></span>`;

/* ---------- 화면 전환 ---------- */
function render() {
  const screen = !S ? 'home' : S.game ? 'game' : 'lobby';
  for (const id of ['home', 'lobby', 'game']) $('#' + id).classList.toggle('on', id === screen);
  renderStatus();
  if (screen === 'lobby') renderLobby();
  if (screen === 'game') renderGame();
  else $('#overlay').hidden = true;
}

const STAGE = { draw: '선 뽑기', select: '카드 선택', play: '행동 페이즈', phaseEnd: '페이즈 종료', over: '게임 종료' };
function renderStatus() {
  if (!S) { $('#leaveBtn').hidden = $('#restartBtn').hidden = true; return ($('#status').innerHTML = ''); }
  const G = S.game;
  const host = S.hostId === S.you;
  $('#leaveBtn').hidden = false;
  $('#restartBtn').hidden = !(G && host);
  const L = (long, short) => `<span class="lbl">${long}</span><span class="lbl-s">${short}</span>`;
  $('#status').innerHTML = `<span class="pill copy ${G ? 'ingame' : ''}" id="codePill" title="초대 링크 복사">${L('방 코드', '')}<b>${esc(S.code)}</b> ⧉</span>` +
    (G ? `<span class="pill">${L('페이즈', 'P')}<b>${G.phase}/${G.phases}</b></span>
      <span class="pill stage">${STAGE[G.stage] ?? ''}</span>
      <span class="pill">${L('라운드', 'R')}<b>${G.round}/${G.rounds}</b></span>
      <span class="pill timer" id="timer">${L('남은 시간', '⏱')}<b>--</b></span>` : '');
  $('#codePill').onclick = copyLink;
  tickTimer();
}
function tickTimer() {
  const el = $('#timer');
  if (!el || !S) return;
  const left = S.timeLeft ? Math.max(0, S.timeLeft - (Date.now() - recvAt)) : 0;
  const s = Math.ceil(left / 1000);
  el.querySelector('b').textContent = left ? `00:${String(s).padStart(2, '0')}` : '--';
  el.classList.toggle('low', left > 0 && s <= 5);
}
setInterval(tickTimer, 250);

function copyLink() {
  const url = `${location.origin}/?room=${S.code}`;
  navigator.clipboard?.writeText(url).then(() => toast('초대 링크를 복사했습니다'), () => toast(url));
}

function toast(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  $('#toast').append(d);
  setTimeout(() => d.remove(), 3000);
}

/* ---------- 홈 ---------- */
$('#name').value = store.get('name') || '';
if (roomParam) $('#code').value = roomParam.toUpperCase();
const myName = () => {
  const n = $('#name').value.trim();
  if (!n) { toast('닉네임을 입력하세요'); $('#name').focus(); return null; }
  store.set('name', n);
  return n;
};
const homeSettings = () => ({ turnSec: +$('#turnSec').value, phases: +$('#phases').value });
$('#soloBtn').onclick = () => { const name = myName(); if (name) socket.emit('create', { name, solo: true, settings: homeSettings() }); };
$('#createBtn').onclick = () => { const name = myName(); if (name) socket.emit('create', { name, settings: homeSettings() }); };
$('#joinBtn').onclick = () => {
  const name = myName(), code = $('#code').value.trim();
  if (!name) return;
  if (!code) return toast('초대 코드를 입력하세요');
  socket.emit('join', { code, name });
};

/* ---------- 대기실 ---------- */
function renderLobby() {
  const host = S.hostId === S.you;
  const opt = (vals, cur) => vals.map((v) => `<option ${v === cur ? 'selected' : ''}>${v}</option>`).join('');
  const slots = Array.from({ length: 6 }, (_, i) => {
    const m = S.members[i];
    return m
      ? `<div class="slot"><span>${esc(m.name)}${m.id === S.you ? ' (나)' : ''}</span><span class="tag">${m.id === S.hostId ? '방장' : m.connected ? '' : '연결 끊김'}</span></div>`
      : `<div class="slot empty"><span>빈 자리</span><span class="tag">AI 자동 배치</span></div>`;
  }).join('');
  $('#lobby').innerHTML = `<div class="panel lobby-card">
    <h1>대기실</h1>
    <div class="code-big">${esc(S.code)}</div>
    <div class="row"><button id="lkLink">초대 링크 복사</button><button id="lkCode">코드 복사</button></div>
    <div class="slots">${slots}</div>
    <div class="row">
      <label>카드 선택 시간 <select id="lsTurn" ${host ? '' : 'disabled'}>${opt([10, 15, 20, 30, 45, 60], S.settings.turnSec)}</select>초</label>
      <label>페이즈 <select id="lsPh" ${host ? '' : 'disabled'}>${opt([1, 2, 3, 4, 5], S.settings.phases)}</select></label>
    </div>
    <p class="sub">게임 시작 시 자리는 랜덤으로 배정됩니다. 빈 자리는 AI가 채웁니다.</p>
    <div class="row"><button id="lkLeave">나가기</button>
      ${host ? '<button id="lkStart" class="primary">게임 시작</button>' : '<span class="sub">방장이 시작하기를 기다리는 중…</span>'}</div>
  </div>`;
  $('#lkLink').onclick = copyLink;
  $('#lkCode').onclick = () => navigator.clipboard?.writeText(S.code).then(() => toast('코드를 복사했습니다'));
  $('#lkLeave').onclick = () => socket.emit('leave');
  if (host) {
    const send = () => socket.emit('settings', { turnSec: +$('#lsTurn').value, phases: +$('#lsPh').value });
    $('#lsTurn').onchange = send;
    $('#lsPh').onchange = send;
    $('#lkStart').onclick = () => socket.emit('start');
  }
}

/* ---------- 게임 ---------- */
function renderGame() {
  const G = S.game;
  const key = `${G.phase}-${G.round}`;
  if (key !== selKey) { selKey = key; sel = {}; }
  $('#board').innerHTML = boardSVG(G);
  renderSide(G);
  renderHand(G);
  renderOrder(G);
  renderOverlay(G);
}

function renderSide(G) {
  const me = G.players[G.me];
  const tower = (c) => `<li><span class="c-${c}">${COL[c][2]}</span> : ${G.tables[c].length ? G.tables[c].join(' - ') : '비어 있음'} <small>(합 ${G.tables[c].reduce((a, b) => a + b, 0)})</small></li>`;
  const log = G.log.slice().reverse().map((e) => `<li>${logText(G, e)}</li>`).join('');
  $('#side').innerHTML = `<h4>게임 목표</h4>
    <ul><li>세 탑에 블럭을 쌓되 합 13 이상을 만들지 마세요. 최종 벌점 상위 2명 탈락.</li></ul>
    <h4>현재 상황</h4>
    <ul><li>${STAGE[G.stage]} · 페이즈 ${G.phase}/${G.phases} · 라운드 ${G.round}/${G.rounds}</li>
      <li>선 : ${nameOf(G, G.starter)}</li>
      <li>내 벌점 : <span class="pen">${me?.penalty ? "-" + me.penalty : 0}</span></li>
      ${['R', 'G', 'B'].map(tower).join('')}</ul>
    <h4>기록</h4><ul class="log">${log}</ul>`;
}

function logText(G, e) {
  if (e.type === 'draw') return `페이즈 ${e.phase} 시작 — 선 뽑기: <b>${nameOf(G, e.seat)}</b>`;
  if (e.type === 'reveal') return `라운드 ${e.round} 카드 공개`;
  if (e.type === 'pass') return `${nameOf(G, e.seat)} 패스`;
  return `${nameOf(G, e.seat)} → <span class="c-${e.table}">${COL[e.table][2]}</span>에 ${e.num}${e.chip === 'W' ? ' (무지개)' : ''}` +
    (e.removed.length ? ` <span class="pen">벌점 -${e.removed.length}</span>` : '');
}

function renderHand(G) {
  const h = G.hand;
  if (!h) return ($('#hand').innerHTML = '');
  const picking = G.stage === 'select' && !h.sub;
  const cur = h.sub ?? sel;
  const cards = [0, 1, 2, 3, 4, 5, 6].map((n) => {
    const has = h.cards.includes(n);
    return `<button class="card ${has ? '' : 'used'} ${cur.num === n ? 'sel' : ''}" data-num="${n}" ${picking && has ? '' : 'disabled'}>${n}</button>`;
  }).join('');
  const chips = ['R', 'G', 'B', 'W'].map((c) => `<div class="chipbox">
      <button class="chip chip-${c} ${h.chips[c] ? '' : 'out'} ${cur.chip === c ? 'sel' : ''}" data-chip="${c}" title="${CN[c]}" ${picking && h.chips[c] ? '' : 'disabled'}></button>
      <span class="cnt">×${h.chips[c]}</span></div>`).join('');

  let actions = '';
  if (G.stage === 'select') {
    actions = h.sub
      ? '<span class="msg">제출 완료 — 다른 플레이어를 기다리는 중</span>'
      : `<span class="sub">칩과 숫자를 하나씩 고르세요</span><button id="submitBtn" class="primary" ${sel.chip != null && sel.num != null ? '' : 'disabled'}>제출</button>`;
  } else if (G.stage === 'play') {
    if (G.current === G.me && G.current != null) {
      const sub = G.players[G.me].sub;
      const stackBtns = sub.chip === 'W'
        ? ['R', 'G', 'B'].map((c) => `<button class="act-${c}" data-stack="${c}">${COL[c][2]}에 쌓기</button>`).join('')
        : `<button class="act-${sub.chip}" data-stack="${sub.chip}">${COL[sub.chip][2]}에 ${sub.num} 쌓기</button>`;
      actions = `<span class="msg">내 차례!</span>${stackBtns}<button id="passBtn" ${h.passed ? 'disabled title="이번 라운드에 이미 패스했습니다"' : ''}>패스</button>`;
    } else if (G.current != null) actions = `<span class="sub">${nameOf(G, G.current)}의 차례</span>`;
    else actions = '<span class="sub">라운드 정리 중…</span>';
  } else if (G.stage === 'draw') actions = '<span class="sub">선 뽑기 중…</span>';

  $('#hand').innerHTML = `<div class="hand-title">내 남은 자원</div>
    <div class="group"><small>숫자 카드 (0~6)</small><div class="cards">${cards}</div></div>
    <div class="group"><small>컬러 칩</small><div class="chips">${chips}</div></div>
    <div class="actions">${actions}</div>`;

  $('#hand').querySelectorAll('[data-num]').forEach((b) => (b.onclick = () => { sel.num = +b.dataset.num; renderHand(G); }));
  $('#hand').querySelectorAll('[data-chip]').forEach((b) => (b.onclick = () => { sel.chip = b.dataset.chip; renderHand(G); }));
  $('#hand').querySelectorAll('[data-stack]').forEach((b) => (b.onclick = () => socket.emit('act', { type: 'stack', table: b.dataset.stack })));
  if ($('#submitBtn')) $('#submitBtn').onclick = () => socket.emit('submit', sel);
  if ($('#passBtn')) $('#passBtn').onclick = () => socket.emit('act', { type: 'pass' });
}

function renderOrder(G) {
  let body;
  if (!G.order.length) {
    body = G.players.map((p) => `<div class="ent"><span class="who">${esc(p.name)}</span>
      <span class="what">${G.stage === 'select' ? (p.submitted ? '<span class="badge">제출 완료</span>' : '<span class="badge wait">선택 중…</span>') : ''}</span></div>`).join('');
    body = `<span class="order-note">${G.stage === 'select' ? '모두 제출하면 행동 순서가 공개됩니다.' : ''}</span>${G.stage === 'select' ? body : ''}`;
  } else {
    const firstWait = G.order.findIndex((o) => o.type === 'wait');
    body = G.order.map((o, i) => {
      const now = i === firstWait && G.current === o.seat;
      const badge = o.type === 'stack'
        ? `<span class="badge">쌓기${o.chip === 'W' ? ` → <span class="c-${o.table}">${COL[o.table][2]}</span>` : ''}</span>${o.penalty ? `<span class="pen">-${o.penalty}</span>` : ''}`
        : o.type === 'pass' ? '<span class="badge pass">패스</span>'
          : now ? '<span class="badge">진행 중</span>' : `<span class="badge wait">${o.passed ? '패스 후 대기' : '대기'}</span>`;
      return `${i ? '<span class="arrow">›</span>' : ''}<div class="ent ${now ? 'now' : ''} ${o.type !== 'wait' ? 'done' : ''}">
        <span class="who"><i>${i + 1}</i>${nameOf(G, o.seat)}${o.seat === G.me ? ' (나)' : ''}</span>
        <span class="what">${chipDot(o.chip)}<span class="mini-card">${o.num}</span>${badge}</span></div>`;
    }).join('');
    if (G.order.some((o) => o.type === 'pass')) body += '<span class="order-note">ⓘ 패스 시 행동 순서가 재배정됩니다.</span>';
  }
  $('#order').innerHTML = `<div class="order-title">순서<small>(이번 라운드 행동 순서)</small></div>${body}`;
}

function renderOverlay(G) {
  const ov = $('#overlay');
  const rows = (outSet) => [...G.players].sort((a, b) => b.penalty - a.penalty).map((p) =>
    `<tr class="${outSet?.has(p.seat) ? 'out' : ''}"><td>${esc(p.name)}${p.seat === G.me ? ' (나)' : ''}</td>
      ${p.pens.map((x) => `<td>-${x}</td>`).join('')}<td class="pen">-${p.penalty}</td><td>${outSet?.has(p.seat) ? '탈락' : ''}</td></tr>`).join('');
  const head = `<tr><th>플레이어</th>${G.players[0].pens.map((_, i) => `<th>P${i + 1}</th>`).join('')}<th>합계</th><th></th></tr>`;
  let html = '';
  if (G.stage === 'draw') {
    html = `<div class="panel result"><h2>페이즈 ${G.phase} — 선 뽑기</h2>
      <div class="draws">${G.players.map((p) => `<div class="${p.seat === G.starter ? 'win' : ''}">${esc(p.name)}<b>${G.draw[p.seat]}</b></div>`).join('')}</div>
      <p><b>${nameOf(G, G.starter)}</b> 님이 선입니다.</p></div>`;
  } else if (G.stage === 'phaseEnd') {
    html = `<div class="panel result"><h2>페이즈 ${G.phase} 종료</h2><table>${head}${rows()}</table><p class="sub">잠시 후 다음 페이즈가 시작됩니다. 칩과 카드를 다시 받습니다.</p></div>`;
  } else if (G.stage === 'over') {
    const out = new Set(G.result.out);
    const host = S.hostId === S.you;
    html = `<div class="panel result"><h2>게임 종료</h2><p>${out.has(G.me) ? '<span class="pen">탈락했습니다</span>' : '생존했습니다!'}</p>
      <table>${head}${rows(out)}</table>
      <div class="row">${host ? '<button id="toLobby" class="primary">대기실로</button>' : ''}<button id="quit">나가기</button></div></div>`;
  }
  ov.innerHTML = html;
  ov.hidden = !html;
  if ($('#toLobby')) $('#toLobby').onclick = () => socket.emit('lobby');
  if ($('#quit')) $('#quit').onclick = () => socket.emit('leave');
}

/* ---------- SVG 보드 ---------- */
function defs() {
  const blk = (c) => `<linearGradient id="blk-${c}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COL[c][0]}"/><stop offset="1" stop-color="${COL[c][1]}"/></linearGradient>
    <radialGradient id="dish-${c}" cx=".5" cy=".4" r=".6"><stop offset="0" stop-color="${COL[c][0]}"/><stop offset="1" stop-color="${COL[c][1]}"/></radialGradient>`;
  return `<defs>
    <linearGradient id="goldg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9ad"/><stop offset=".5" stop-color="#c99a45"/><stop offset="1" stop-color="#6e4f1c"/></linearGradient>
    <linearGradient id="rainbow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4d4d"/><stop offset=".3" stop-color="#ffe94d"/><stop offset=".55" stop-color="#4dff88"/><stop offset=".8" stop-color="#4dc3ff"/><stop offset="1" stop-color="#b34dff"/></linearGradient>
    ${['R', 'G', 'B'].map(blk).join('')}
    <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#07050a" stop-opacity=".25"/><stop offset=".55" stop-color="#07050a" stop-opacity=".35"/><stop offset="1" stop-color="#07050a" stop-opacity=".7"/></linearGradient>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1f36"/><stop offset="1" stop-color="#0d0912"/></linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity=".65"/></filter>
  </defs>`;
}

// 배경·테이블·석상은 Higgsfield로 생성한 이미지(public/img). 블럭·이름표·숫자는 그 위의 SVG 레이어.
function hall() {
  return `<image href="img/hall-${LY === LAYOUTS.tall ? 'tall' : 'wide'}.webp" width="${W}" height="${H}" preserveAspectRatio="xMidYMin slice"/>
    <rect width="${W}" height="${H}" fill="url(#vignette)"/>`;
}

function table() {
  const { cx, cy, rx, ry } = TB;
  return `<ellipse cx="${cx}" cy="${cy + 30}" rx="${rx + 14}" ry="${ry + 14}" fill="#000" opacity=".65" filter="url(#blur)"/>
    <ellipse cx="${cx}" cy="${cy + 16}" rx="${rx}" ry="${ry}" fill="#3a2a10"/>
    <ellipse cx="${cx}" cy="${cy + 8}" rx="${rx}" ry="${ry}" fill="#8a6a2a"/>
    <image href="img/table.webp" x="${cx - rx}" y="${cy - ry}" width="${rx * 2}" height="${ry * 2}" preserveAspectRatio="none"/>`;
}

const AW = 190, AH = AW * 612 / 560; // 석상 이미지 크기(접시 윗면 중심이 DISH-6에 오도록 배치)
function atlas(c) {
  const x = PX[c];
  return `<g transform="translate(${x} ${DISH})">
    <ellipse cx="0" cy="${AH - 24}" rx="70" ry="14" fill="#000" opacity=".6" filter="url(#blur)"/>
    <ellipse cx="0" cy="90" rx="95" ry="85" fill="${COL[c][0]}" opacity=".28" filter="url(#blur)"/>
    <image href="img/atlas.webp" x="${-AW / 2}" y="-19" width="${AW}" height="${AH}"/>
    <ellipse cx="0" cy="-6" rx="87" ry="10" fill="url(#dish-${c})" opacity=".88"/>
    <ellipse cx="0" cy="-6" rx="87" ry="10" fill="none" stroke="${COL[c][0]}" stroke-width="2" opacity=".9"/>
    <rect x="-34" y="3" width="68" height="19" rx="9.5" fill="${COL[c][1]}" stroke="url(#goldg)" stroke-width="1.5"/>
    <text x="0" y="17" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="13" letter-spacing="1.5" fill="#fff4d6">${COL[c][2]}</text>
  </g>`;
}

function block(x, y, h, c, num, cls = '', w = 104) {
  const d = 14, l = x - w / 2 - d / 2;
  return `<g class="${cls}">
    <polygon points="${l},${y} ${l + d},${y - d} ${l + w + d},${y - d} ${l + w},${y}" fill="${COL[c][0]}" opacity=".95"/>
    <polygon points="${l + w},${y} ${l + w + d},${y - d} ${l + w + d},${y + h - d} ${l + w},${y + h}" fill="${COL[c][1]}"/>
    <rect x="${l}" y="${y}" width="${w}" height="${h}" fill="url(#blk-${c})" stroke="#0007"/>
    <rect x="${l + 3}" y="${y + 3}" width="${w - 6}" height="${h * 0.38}" rx="3" fill="#fff" opacity=".16"/>
    <rect x="${l + 1.5}" y="${y + 1.5}" width="${w - 3}" height="${h - 3}" fill="none" stroke="#ffe9ad" stroke-width="1.2" opacity=".55"/>
    <text x="${l + w / 2}" y="${y + h / 2 + 11}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="${Math.min(32, h * 0.7)}" fill="#fff3d0" stroke="#0009" stroke-width="3" paint-order="stroke">${num}</text>
  </g>`;
}

// 블럭은 2줄로 쌓는다: 1층 왼쪽 → 1층 오른쪽 → 2층 왼쪽 … (마지막 블럭이 항상 맨 위)
const BW = 78, BGAP = 8;
const rowH = (n) => Math.min(46, 270 / Math.max(1, Math.ceil(n / 2)));
function blocks2(c, nums, lastCls = '') {
  const h = rowH(nums.length), base = DISH - 9;
  return nums.map((n, i) => block(PX[c] + (i % 2 ? 1 : -1) * (BW + BGAP) / 2, base - (Math.floor(i / 2) + 1) * h, h, c, n,
    i === nums.length - 1 ? lastCls : '', BW)).join('');
}

function stackSVG(G, c, fresh) {
  const s = G.tables[c];
  const total = s.reduce((a, b) => a + b, 0);
  const blocks = blocks2(c, s, fresh ? 'drop' : '');
  const ty = DISH - 9 - Math.ceil(s.length / 2) * rowH(s.length) - 30;
  const danger = total >= 9 ? '#ff6b5e' : total >= 6 ? '#ffd76a' : '#e8dcc0';
  return `${blocks}<text x="${PX[c]}" y="${ty}" text-anchor="middle" font-family="Noto Sans KR" font-weight="700" font-size="${17 * 1.7 * LY.F}" fill="${danger}" stroke="#000a" stroke-width="5" paint-order="stroke">${total} / 13</text>`;
}

// 선 플레이어 딱지: 이름표 왼쪽 위 모서리에 걸친 빨간 배지
function starterTag(x, y, F) {
  const w = 46 * F, h = 30 * F;
  return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${8 * F}" fill="#d8322a" stroke="#ffd76a" stroke-width="${2.5 * F}" filter="url(#shadow)"/>
    <text x="${x}" y="${y + 7 * F}" text-anchor="middle" font-family="Noto Sans KR" font-weight="900" font-size="${20 * F}" fill="#fff">선</text>`;
}

function seatSVG(G, p) {
  const k = rel(G, p.seat), { x, y } = POS[k];
  const cur = G.current === p.seat;
  const F = LY.F;
  const sx = x + (k === 0 || k === 3 ? 150 : x < TB.cx ? 145 : -145) * F;
  let side = '';
  if (p.sub) {
    side = `<circle cx="${sx - 18}" cy="${y}" r="16" fill="${p.sub.chip === 'W' ? 'url(#rainbow)' : COL[p.sub.chip][0]}" stroke="#fff" stroke-width="2" stroke-dasharray="4 3"/>
      <rect x="${sx + 4}" y="${y - 22}" width="30" height="44" rx="4" fill="#f6e8c6" stroke="#c9a75b" stroke-width="2"/>
      <text x="${sx + 19}" y="${y + 9}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="24" fill="#2a1e10">${p.sub.num}</text>`;
  } else if (G.stage === 'select') {
    side = `<text x="${sx}" y="${y + 6}" text-anchor="middle" font-size="${15 * F}" font-weight="700" fill="${p.submitted ? '#7fe0a0' : '#9b907c'}">${p.submitted ? '✓ 제출' : '선택 중…'}</text>`;
  }
  const label = `${esc(p.name)}${p.seat === G.me ? ' (나)' : ''}${p.connected ? '' : ' · 끊김'}`;
  return `<g>
    ${cur ? `<rect class="glow" x="${x - 112 * F}" y="${y - 44 * F}" width="${224 * F}" height="${88 * F}" rx="16" fill="none" stroke="#ffd76a" stroke-width="5"/>` : ''}
    <rect x="${x - 102 * F}" y="${y - 36 * F}" width="${204 * F}" height="${72 * F}" rx="12" fill="url(#plate)" fill-opacity=".94" stroke="${cur ? '#ffd76a' : '#a8843a'}" stroke-width="2" filter="url(#shadow)"/>
    
    ${p.ai ? `<text x="${x + 90 * F}" y="${y - 20 * F}" text-anchor="end" font-size="${11 * F}" font-weight="700" fill="#a58cff">AI</text>` : ''}
    <text x="${x}" y="${y - 10 * F}" text-anchor="middle" font-size="${17 * F}" font-weight="700" fill="#efe6d2">${label}</text>
    <text x="${x}" y="${y + 26 * F}" text-anchor="middle" font-family="Noto Sans KR" font-weight="900" font-size="${30 * F}" fill="${p.penalty ? '#ff4f45' : '#8f8676'}">${p.penalty ? '-' + p.penalty : '0'}</text>
    ${side}${G.starter === p.seat ? starterTag(Math.max(26 * F, x - 96 * F), y - 36 * F, F) : ''}</g>`;
}

let fresh = null; // 방금 쌓인 탑(떨어지는 연출)
function boardSVG(G) {
  const out = defs() + hall() + table() + ['R', 'G', 'B'].map((c) => atlas(c) + stackSVG(G, c, fresh === c)).join('') + G.players.map((p) => seatSVG(G, p)).join('');
  fresh = null;
  return out;
}

/* ---------- 이벤트 연출 (별도 SVG 레이어라 보드가 다시 그려져도 끊기지 않는다) ---------- */
function effects(G) {
  const last = G.log.at(-1)?.id ?? 0;
  if (seenEvt < 0 || last < seenEvt) { seenEvt = last; return; } // 첫 접속·새로고침·다시 시작 // 첫 접속·새로고침: 지난 연출은 다시 틀지 않는다
  for (const e of G.log) {
    if (e.id <= seenEvt) continue;
    if (e.type === 'stack') {
      fresh = e.table;
      if (e.removed.length) {
        burstFX(G, e);
        toast(`${G.players[e.seat].name} 벌점 -${e.removed.length}!`);
      }
    } else if (e.type === 'pass') toast(`${G.players[e.seat].name} 패스`);
    else if (e.type === 'reveal') toast('카드 공개! 행동 순서가 정해졌습니다');
  }
  seenEvt = last;
}

function burstFX(G, e) {
  const fx = $('#fx');
  const blocks = blocks2(e.table, e.removed);
  const { x, y } = POS[rel(G, e.seat)];
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.innerHTML = `<ellipse cx="${PX[e.table]}" cy="${DISH - 80}" rx="110" ry="150" fill="${COL[e.table][0]}" class="float" filter="url(#fxblur)"/>
    <g class="burst">${blocks}</g>
    <text class="float" x="${x}" y="${y - 50}" text-anchor="middle" font-family="Noto Sans KR" font-weight="900" font-size="54" fill="#ff4f45" stroke="#000" stroke-width="4" paint-order="stroke">-${e.removed.length}</text>`;
  fx.append(g);
  setTimeout(() => g.remove(), 2000);
}

document.querySelector('.board-wrap').insertAdjacentHTML('beforeend',
  '<svg id="fx" preserveAspectRatio="xMidYMid meet"><defs><filter id="fxblur"><feGaussianBlur stdDeviation="30"/></filter></defs></svg>');

/* ---------- 나가기 / 다시 시작 ---------- */
function ask(msg, yes) {
  $('#confirmMsg').textContent = msg;
  $('#confirm').hidden = false;
  $('#confirmYes').onclick = () => { $('#confirm').hidden = true; yes(); };
}
$('#confirmNo').onclick = () => ($('#confirm').hidden = true);
$('#leaveBtn').onclick = () => ask(S?.game && S.game.stage !== 'over'
  ? '진행 중인 방을 나갈까요? 내 자리는 AI가 이어서 플레이합니다.' : '방을 나갈까요?', () => socket.emit('leave'));
$('#restartBtn').onclick = () => ask('지금 게임을 끝내고 같은 인원·설정으로 처음부터 다시 시작할까요?', () => socket.emit('restart'));

/* ---------- 게임설명 ---------- */
$('#rulesBtn').onclick = () => ($('#rules').hidden = false);
$('#rules').onclick = (e) => { if (e.target.id === 'rules' || e.target.dataset.close != null) $('#rules').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#rules').hidden = true; });

applyLayout();
addEventListener('resize', () => { if (applyLayout() && S?.game) render(); });
render();
