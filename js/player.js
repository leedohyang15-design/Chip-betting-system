import { createDock } from './dock.js';
import { capture, initAudio, isMuted, play, sound, toggleMuted } from './fx.js';
import { ClientLink, normalizeRoom } from './net.js';
import { chipPile, chipStack, esc, fmt, keepAwake, load, place, signed, store, toast } from './ui.js';

const HELP_MS = 12000;
const ACK_TIMEOUT_MS = 4000;
const FLASH_MS = 800;
const RADII = { seat: [39, 41], bet: [23, 23], dealer: [29, 30] };
const BOARD_CARDS = [0, 3, 4, 5];
const DECOR_PILE = 1650;

const params = new URLSearchParams(location.search);
const room = normalizeRoom(params.get('room'));
const slot = (params.get('slot') ?? '').slice(0, 8);
const tokenKey = `cbs:token:${room}:${slot}`;
const NAME_KEY = 'cbs:name';

const app = document.getElementById('app');
const sheet = document.getElementById('sheet');

let view = null;
let status = 'connecting';
let sentSeq = null;
let wasMyTurn = false;
let announcedHand = null;
let helpTimer = null;
let showHelp = false;
let seatsFull = false;
let kicked = false;
let prevHand;
let dealtCards = 0;

let token = load(tokenKey);
if (room.length !== 4) location.replace('index.html');

function forgetToken() {
  try {
    localStorage.removeItem(tokenKey);
  } catch {
    // 저장소를 쓸 수 없으면 지울 것도 없다.
  }
  token = null;
  view = null;
}

const link = new ClientLink(room, {
  onStatus(next) {
    status = next;
    if (next === 'online') {
      clearTimeout(helpTimer);
      helpTimer = null;
      showHelp = false;
    } else if (!helpTimer) {
      helpTimer = setTimeout(() => {
        showHelp = true;
        render();
      }, HELP_MS);
    }
    render();
  },
  onOpen: sendJoin,
  onMessage(msg) {
    if (msg.t === 'state') {
      view = msg.view;
      sentSeq = null;
      seatsFull = false;
      render();
    } else if (msg.t === 'reject') {
      sentSeq = null;
      toast(msg.message);
      render();
    } else if (msg.t === 'full') {
      forgetToken();
      seatsFull = true;
      render();
    } else if (msg.t === 'kicked') {
      forgetToken();
      kicked = true;
      link.send = () => {};
      link.watch = () => {};
      dock.close();
      document.body.classList.remove('my-turn');
      render();
    }
  },
});

function sendJoin() {
  if (!token) return;
  link.send({ t: 'join', token, name: load(NAME_KEY) ?? '' });
}

function submitName(name) {
  const clean = name.trim();
  if (!clean) {
    toast('이름을 입력해 주세요');
    return;
  }
  store(NAME_KEY, clean);
  token = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
  store(tokenKey, token);
  document.getElementById('name-form')?.remove();
  sendJoin();
  render();
}

function sendAction(action) {
  if (!view || sentSeq !== null) return;
  if (!link.connected) {
    toast('연결이 끊겨 있어요. 잠시 후 다시 눌러 주세요');
    return;
  }
  const seq = view.seq;
  sentSeq = seq;
  link.send({ t: 'act', seq, action });
  if (action.type !== 'fold' && action.type !== 'check') sound.chip();
  render();
  // 전송이 유실되면 다시 누를 수 있게 잠금을 푼다. 중복 입력은 관리자가 순번으로 거른다.
  setTimeout(() => {
    if (sentSeq === seq) {
      sentSeq = null;
      render();
    }
  }, ACK_TIMEOUT_MS);
}

const dock = createDock({ sheet, getLegal: () => view.legal, send: sendAction, rerender: render });

const commands = {
  ...dock.commands,
  mute: () => {
    toggleMuted();
    render();
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-cmd]');
  if (!el || el.disabled) return;
  commands[el.dataset.cmd]?.(el.dataset);
});

/* 화면 */

const STATUS_TEXT = { online: '연결됨', connecting: '연결 중…', searching: '테이블을 찾는 중…' };
const HELP_HTML = `<ul class="help">
  <li>관리자 화면이 켜져 있는지 확인해 주세요.</li>
  <li>방 코드가 맞는지 확인해 주세요.</li>
  <li>휴대폰의 인터넷 연결을 확인해 주세요.</li>
</ul>`;

function renderJoin() {
  // 연결 상태가 바뀌어도 입력 중인 이름이 지워지지 않게 버튼만 갱신한다.
  if (!document.getElementById('name-form')) {
    const previous = esc(load(NAME_KEY) ?? '');
    app.innerHTML = `<form class="p-center" id="name-form">
      <div class="join-pile" aria-hidden="true">${chipPile(DECOR_PILE)}</div>
      <p class="eyebrow">테이블 ${room}</p>
      <h1>${seatsFull ? '자리가 모두 찼습니다' : '이름을 입력하세요'}</h1>
      ${seatsFull ? '<p class="hint">자리가 나면 다시 입장해 주세요.</p>' : ''}
      <input id="name" class="input-big" maxlength="12" autocomplete="off" value="${previous}" placeholder="이름">
      <button class="btn primary wide big"></button>
      <div id="join-help"></div>
    </form>`;
    document.getElementById('name-form').addEventListener('submit', (event) => {
      event.preventDefault();
      submitName(document.getElementById('name').value);
    });
  }
  const button = app.querySelector('#name-form button');
  button.disabled = status !== 'online';
  button.textContent = status === 'online' ? '입장' : STATUS_TEXT[status];
  document.getElementById('join-help').innerHTML = showHelp ? HELP_HTML : '';
}

function wonAmounts(h) {
  const won = {};
  if (h?.phase !== 'done') return won;
  for (const pot of h.pots) {
    for (const [id, amount] of Object.entries(pot.payouts ?? {})) won[id] = (won[id] ?? 0) + amount;
  }
  return won;
}

function seatHtml(p, angle, won) {
  const h = view.hand;
  const s = h?.seats[p.id];
  const classes = ['seat'];
  if (h && h.phase !== 'done' && !s) classes.push('out');
  if (s?.folded) classes.push('folded');
  if (s?.allIn && !s.folded) classes.push('allin');
  if (h?.toAct === p.id) classes.push('turn');
  if (!p.connected) classes.push('offline');
  if (p.sitOut) classes.push('sitout');
  if (won[p.id]) classes.push('winner');

  let tag = '';
  if (won[p.id]) tag = `+${fmt(won[p.id])}`;
  else if (p.sitOut) tag = '자리비움';
  else if (s?.last && h.phase !== 'done') tag = s.last;
  const cards = s && !s.folded && h.phase !== 'done' ? '<span class="minis"><i></i><i></i></span>' : '';
  const sun = view.config.mode === 'seotda' && view.dealerId === p.id ? '<span class="badge sun">선</span>' : '';

  return `<div class="${classes.join(' ')}" style="${place(angle, ...RADII.seat)}" data-id="${p.id}">
    ${cards}
    <span class="seat-name"><i class="dot"></i>${esc(p.name)}${sun}</span>
    <span class="seat-chips"><i class="token c5"></i>${fmt(p.chips)}</span>
    ${tag ? `<span class="seat-tag">${esc(tag)}</span>` : ''}
  </div>`;
}

function potAmount(h) {
  if (!h) return 0;
  if (h.phase === 'betting') return h.carry + Object.values(h.seats).reduce((sum, s) => sum + s.total, 0);
  return h.pots.filter((pot) => !pot.winners).reduce((sum, pot) => sum + pot.amount, 0);
}

function centerHtml(stage, pot) {
  const h = view.hand;
  let board = '';
  if (h?.mode === 'holdem') {
    const shown = BOARD_CARDS[h.street];
    board = `<div class="board">${[0, 1, 2, 3, 4]
      .map((i) => `<i class="card ${i < shown ? 'dealt' : ''} ${i < shown && i >= dealtCards ? 'flip' : ''}"></i>`)
      .join('')}</div>`;
    dealtCards = h.phase === 'done' ? 0 : shown;
  }
  return `<div class="center-stack">
    <p class="street">${esc(stage)}</p>
    ${board}
    <div class="pot">${chipPile(pot || DECOR_PILE)}${pot ? `<b>${fmt(pot)}</b>` : ''}</div>
  </div>`;
}

function tableHtml(me, stage, pot) {
  const h = view.hand;
  const sorted = [...view.players].sort((a, b) => a.seat - b.seat);
  const myIndex = sorted.findIndex((p) => p.id === me.id);
  const step = 360 / sorted.length;
  const won = wonAmounts(h);

  const pieces = sorted.map((_, k) => {
    const p = sorted[(myIndex + k) % sorted.length];
    const angle = 90 + k * step; // 내 자리가 맨 아래, 나머지는 시계 방향
    let html = k === 0 ? '' : seatHtml(p, angle, won);
    const bet = h?.phase === 'betting' ? h.seats[p.id]?.bet ?? 0 : 0;
    if (bet > 0) {
      html += `<div class="bet" data-id="${p.id}" style="${place(angle, ...RADII.bet)}">${chipStack(bet)}<b>${fmt(bet)}</b></div>`;
    }
    if (h?.mode === 'holdem' && view.dealerId === p.id) {
      html += `<div class="dealer" style="${place(angle + 14, ...RADII.dealer)}">D</div>`;
    }
    return html;
  });

  return `<div class="table"><div class="rail"><div class="felt">${centerHtml(stage, pot)}</div></div>${pieces.join('')}</div>`;
}

function myPanelHtml(me) {
  const h = view.hand;
  const s = h?.seats[me.id];
  const isDealer = view.dealerId === me.id;
  const role = isDealer ? (view.config.mode === 'holdem' ? '딜러' : '선') : h?.sbId === me.id ? 'SB' : h?.bbId === me.id ? 'BB' : '';
  const inHand = s && h.phase !== 'done';
  const state = s?.folded ? s.last : s?.allIn ? '올인' : '';
  return `<section class="p-me ${s?.folded ? 'folded' : ''}" data-seat data-id="${me.id}">
    ${inHand ? '<div class="my-cards" aria-hidden="true"><i></i><i></i></div>' : ''}
    <div class="my-info">
      <small>${esc(me.name)}${role ? ` <em>${role}</em>` : ''}${state && inHand ? ` <em class="bad">${esc(state)}</em>` : ''}</small>
      <b>${fmt(me.chips)}</b>
    </div>
    <div class="my-pile" aria-hidden="true">${chipPile(me.chips)}</div>
  </section>`;
}

function netOfHand(h, id) {
  const won = h.pots.reduce((sum, pot) => sum + (pot.payouts?.[id] ?? 0), 0);
  return won - h.seats[id].total;
}

function dockHtml(me) {
  const h = view.hand;
  const s = h?.seats[me.id];
  if (view.legal) {
    const la = view.legal;
    const disabled = sentSeq !== null || status !== 'online';
    return `<p class="dock-title">내 차례${la.canCheck ? '' : ` · 콜 ${fmt(la.toCall)}`}</p>${dock.buttons(la, h.mode, disabled)}`;
  }
  if (!h) return `<p class="dock-wait">첫 판을 기다리는 중</p>`;
  const benched = me.chips === 0
    ? `<p class="dock-wait">칩이 없습니다<br><small>관리자에게 리바이를 요청하세요</small></p>`
    : `<p class="dock-wait">다음 판부터 참여합니다</p>`;
  if (h.phase === 'done') {
    if (!s) return benched;
    const net = netOfHand(h, me.id);
    return `<p class="dock-result ${net > 0 ? 'plus' : net < 0 ? 'minus' : ''}">${net > 0 ? '<i class="token c1000"></i>' : ''}${signed(net)}</p>
      <p class="dock-wait small">다음 판을 기다리는 중</p>`;
  }
  if (!s) return benched;
  if (h.phase === 'showdown') return `<p class="dock-wait">패를 공개하세요<br><small>관리자가 승자를 고르는 중</small></p>`;
  const actor = view.players.find((p) => p.id === h.toAct);
  const mine = s.folded ? `${s.last}한 상태 · ` : s.allIn ? '올인 상태 · ' : '';
  return `<p class="dock-wait">${mine}<b>${esc(actor?.name ?? '')}</b> 차례</p>`;
}

function announce(me, myTurn) {
  if (myTurn && !wasMyTurn) {
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([120, 60, 120]);
    sound.turn();
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), FLASH_MS);
  }
  wasMyTurn = myTurn;

  const h = view.hand;
  if (h?.phase === 'done' && h.seats[me.id] && announcedHand !== h.no) {
    announcedHand = h.no;
    if (netOfHand(h, me.id) > 0) sound.win();
  }
}

function renderGame() {
  const me = view.players.find((p) => p.id === view.you);
  if (!me) return;
  const h = view.hand;
  const myTurn = Boolean(view.legal);
  announce(me, myTurn);
  if (!myTurn) dock.close();
  document.body.classList.toggle('my-turn', myTurn);

  const stage = !h ? '대기 중' : h.phase === 'done' ? '판 종료' : h.phase === 'showdown' ? '쇼다운' : h.streetNames[h.street];
  const latest = view.log[view.log.length - 1]?.text ?? '';
  const before = capture(app);

  app.innerHTML = `
    ${status === 'online' ? '' : `<div class="p-offline">재연결 중… 버튼이 잠시 잠깁니다${showHelp ? HELP_HTML : ''}</div>`}
    <header class="p-top">
      <span class="p-room">${room}</span>
      <span class="p-ticker">${esc(latest)}</span>
      <button class="mute" data-cmd="mute" aria-label="${isMuted() ? '소리 켜기' : '소리 끄기'}">${isMuted() ? '🔇' : '🔊'}</button>
      <i class="dot ${status === 'online' ? '' : 'wait'}" role="img" aria-label="${esc(STATUS_TEXT[status])}"></i>
    </header>
    <section class="p-table">${tableHtml(me, stage, potAmount(h))}</section>
    ${myPanelHtml(me)}
    <section class="p-dock">${dockHtml(me)}</section>`;

  play(app, before, prevHand, h, { silent: true });
  prevHand = h;
}

function render() {
  if (kicked) {
    app.innerHTML = `<div class="p-center"><h1>테이블에서 나왔습니다</h1><a class="btn primary wide" href="index.html">처음으로</a></div>`;
  } else if (!token && !view) {
    renderJoin();
  } else if (!view) {
    app.innerHTML = `<div class="p-center"><p class="eyebrow">테이블 ${room}</p><h1>${esc(STATUS_TEXT[status] ?? '입장 중…')}</h1>
      ${showHelp ? HELP_HTML : '<p class="hint">잠시만 기다려 주세요.</p>'}</div>`;
  } else {
    renderGame();
  }
}

render();
link.start();
keepAwake();
initAudio();
