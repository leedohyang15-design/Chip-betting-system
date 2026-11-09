import { ClientLink, normalizeRoom } from './net.js';
import { chipStack, esc, fmt, keepAwake, load, signed, store, toast } from './ui.js';

const CONFIRM_MS = 2500;

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
let armed = null;
let armTimer = null;
let wasMyTurn = false;
let sheetValue = 0;

let token = load(tokenKey);
if (room.length !== 4) location.replace('index.html');

const link = new ClientLink(room, {
  onStatus(next) {
    status = next;
    render();
  },
  onOpen: sendJoin,
  onMessage(msg) {
    if (msg.t === 'state') {
      view = msg.view;
      sentSeq = null;
      render();
    } else if (msg.t === 'reject') {
      sentSeq = null;
      toast(msg.message);
      render();
    } else if (msg.t === 'full') {
      toast('자리가 모두 찼습니다');
    } else if (msg.t === 'kicked') {
      try {
        localStorage.removeItem(tokenKey);
      } catch {
        // 저장소를 쓸 수 없으면 지울 것도 없다.
      }
      token = null;
      view = null;
      app.innerHTML = `<div class="p-center"><h1>테이블에서 나왔습니다</h1><a class="btn primary wide" href="index.html">처음으로</a></div>`;
      link.send = () => {};
      link.watch = () => {};
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
  sendJoin();
  render();
}

/* 액션 전송 */

function send(action) {
  if (!view || sentSeq !== null) return;
  sentSeq = view.seq;
  closeSheet();
  link.send({ t: 'act', seq: view.seq, action });
  render();
}

function arm(key) {
  armed = key;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armed = null;
    render();
  }, CONFIRM_MS);
  render();
}

function sendConfirmed(key, action) {
  if (armed !== key) {
    arm(key);
    return;
  }
  armed = null;
  clearTimeout(armTimer);
  send(action);
}

/* 레이즈 시트 */

function closeSheet() {
  sheet.hidden = true;
  sheet.innerHTML = '';
}

function sheetSteps(la) {
  return Math.ceil((la.maxTo - la.minTo) / la.unit);
}
function stepToAmount(la, step) {
  return Math.min(la.maxTo, la.minTo + step * la.unit);
}
function amountToStep(la, amount) {
  return Math.round((amount - la.minTo) / la.unit);
}

function paintSheet(la) {
  const value = sheetValue;
  sheet.querySelector('.sheet-amount').textContent = fmt(value);
  sheet.querySelector('.sheet-sub').textContent =
    value === la.maxTo ? '올인' : `내 칩에서 ${fmt(value - la.bet)} 나감`;
  sheet.querySelector('input').value = amountToStep(la, value);
  const verb = la.isOpening ? '벳' : '레이즈';
  sheet.querySelector('[data-cmd="sheet-ok"]').textContent =
    value === la.maxTo ? `${fmt(value)} 올인` : `${fmt(value)}까지 ${verb}`;
}

function openSheet() {
  const la = view.legal;
  sheetValue = la.minTo;
  sheet.innerHTML = `<div class="sheet-card">
    <button class="sheet-close" data-cmd="sheet-close" aria-label="닫기">✕</button>
    <p class="sheet-label">이번 베팅 총액</p>
    <p class="sheet-amount"></p>
    <p class="sheet-sub"></p>
    <div class="sheet-slider">
      <button class="btn round" data-cmd="sheet-step" data-dir="-1" aria-label="줄이기">−</button>
      <input type="range" min="0" max="${sheetSteps(la)}" step="1" aria-label="베팅 금액">
      <button class="btn round" data-cmd="sheet-step" data-dir="1" aria-label="늘리기">+</button>
    </div>
    <div class="sheet-presets">
      ${la.presets.map((p) => `<button class="btn" data-cmd="sheet-set" data-to="${p.to}">${esc(p.label)}</button>`).join('')}
      <button class="btn gold" data-cmd="sheet-set" data-to="${la.maxTo}">올인</button>
    </div>
    <button class="btn primary wide big" data-cmd="sheet-ok"></button>
  </div>`;
  sheet.hidden = false;
  sheet.querySelector('input').addEventListener('input', (event) => {
    sheetValue = stepToAmount(la, Number(event.target.value));
    paintSheet(la);
  });
  paintSheet(la);
}

const commands = {
  fold() {
    if (view.legal.canCheck) sendConfirmed('fold', { type: 'fold' });
    else send({ type: 'fold' });
  },
  check: () => send({ type: 'check' }),
  call: () => send({ type: 'call' }),
  allin: () => sendConfirmed('allin', { type: 'allin' }),
  preset: ({ key }) => send({ type: 'preset', key }),
  'open-sheet': openSheet,
  'sheet-close': closeSheet,
  'sheet-step': ({ dir }) => {
    const la = view.legal;
    const step = Math.max(0, Math.min(sheetSteps(la), amountToStep(la, sheetValue) + Number(dir)));
    sheetValue = stepToAmount(la, step);
    paintSheet(la);
  },
  'sheet-set': ({ to }) => {
    sheetValue = Number(to);
    paintSheet(view.legal);
  },
  'sheet-ok': () => {
    const la = view.legal;
    send(sheetValue === la.maxTo ? { type: 'allin' } : { type: 'raise', to: sheetValue });
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-cmd]');
  if (!el || el.disabled) return;
  commands[el.dataset.cmd]?.(el.dataset);
});

/* 화면 */

const STATUS_TEXT = { online: '연결됨', connecting: '연결 중…', searching: '테이블을 찾는 중…' };

function renderJoin() {
  // 연결 상태가 바뀌어도 입력 중인 이름이 지워지지 않게 버튼만 갱신한다.
  if (!document.getElementById('name-form')) {
    const previous = esc(load(NAME_KEY) ?? '');
    app.innerHTML = `<form class="p-center" id="name-form">
      <p class="eyebrow">테이블 ${room}</p>
      <h1>이름을 입력하세요</h1>
      <input id="name" class="input-big" maxlength="12" autocomplete="off" value="${previous}" placeholder="이름">
      <button class="btn primary wide big"></button>
    </form>`;
    document.getElementById('name-form').addEventListener('submit', (event) => {
      event.preventDefault();
      submitName(document.getElementById('name').value);
    });
  }
  const button = app.querySelector('#name-form button');
  button.disabled = status !== 'online';
  button.textContent = status === 'online' ? '입장' : STATUS_TEXT[status];
}

function othersHtml(me) {
  const h = view.hand;
  return view.players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .filter((p) => p.id !== me.id)
    .map((p) => {
      const s = h?.seats[p.id];
      const turn = h?.toAct === p.id;
      let note = '';
      if (p.sitOut) note = '자리비움';
      else if (s?.folded) note = s.last;
      else if (s?.allIn) note = '올인';
      else if (s?.last && h.phase !== 'done') note = s.last;
      const bet = s?.bet > 0 && h.phase === 'betting' ? fmt(s.bet) : '';
      return `<li class="${turn ? 'turn' : ''} ${s?.folded ? 'folded' : ''} ${p.connected ? '' : 'offline'}">
        <span class="o-name"><i class="dot"></i>${esc(p.name)}</span>
        <span class="o-note">${esc(note)}</span>
        <span class="o-bet">${bet}</span>
        <span class="o-chips">${fmt(p.chips)}</span>
      </li>`;
    })
    .join('');
}

function dockButtons(la, h) {
  const busy = sentSeq !== null ? 'disabled' : '';
  const isHoldem = h.mode === 'holdem';
  const foldLabel = armed === 'fold' ? '체크 가능! 한 번 더' : isHoldem ? '폴드' : '다이';
  const main = la.canCheck
    ? `<button class="btn go action" data-cmd="check" ${busy}>체크</button>`
    : `<button class="btn go action" data-cmd="call" ${busy}>콜<small>${fmt(la.call)}${la.callIsAllIn ? ' 올인' : ''}</small></button>`;
  const fold = `<button class="btn danger action ${armed === 'fold' ? 'armed' : ''}" data-cmd="fold" ${busy}>${foldLabel}</button>`;
  const allin = la.canRaise
    ? `<button class="btn gold ${armed === 'allin' ? 'armed' : ''}" data-cmd="allin" ${busy}>
        ${armed === 'allin' ? '한 번 더 누르면 올인' : '올인'}<small>${fmt(la.chips)}</small></button>`
    : '';

  if (isHoldem) {
    const raise = la.canRaise
      ? `<button class="btn raise action" data-cmd="open-sheet" ${busy}>${la.isOpening ? '벳' : '레이즈'}<small>${fmt(la.minTo)}부터</small></button>`
      : '';
    return `<div class="dock-row">${fold}${main}${raise}</div>`;
  }
  const presets = la.presets
    .map(
      (p) => `<button class="btn raise" data-cmd="preset" data-key="${p.key}" ${busy}>${esc(p.label)}<small>${fmt(p.pay)}</small></button>`,
    )
    .join('');
  return `<div class="dock-grid">${presets}${allin}</div><div class="dock-row">${fold}${main}</div>`;
}

function dockHtml(me) {
  const h = view.hand;
  const s = h?.seats[me.id];
  if (view.legal) {
    const la = view.legal;
    return `<p class="dock-title">내 차례${la.canCheck ? '' : ` · 콜 ${fmt(la.toCall)}`}</p>${dockButtons(la, h)}`;
  }
  if (!h) return `<p class="dock-wait">첫 판을 기다리는 중</p>`;
  const benched = me.chips === 0
    ? `<p class="dock-wait">칩이 없습니다<br><small>관리자에게 리바이를 요청하세요</small></p>`
    : `<p class="dock-wait">다음 판부터 참여합니다</p>`;
  if (h.phase === 'done') {
    if (!s) return benched;
    const won = h.pots.reduce((sum, pot) => sum + (pot.payouts?.[me.id] ?? 0), 0);
    const net = won - s.total;
    return `<p class="dock-result ${net > 0 ? 'plus' : net < 0 ? 'minus' : ''}">${signed(net)}</p>
      <p class="dock-wait small">다음 판을 기다리는 중</p>`;
  }
  if (!s) return benched;
  if (h.phase === 'showdown') return `<p class="dock-wait">패를 공개하세요<br><small>관리자가 승자를 고르는 중</small></p>`;
  const actor = view.players.find((p) => p.id === h.toAct);
  const mine = s.folded ? `${s.last}한 상태 · ` : s.allIn ? '올인 상태 · ' : '';
  return `<p class="dock-wait">${mine}<b>${esc(actor?.name ?? '')}</b> 차례</p>`;
}

function renderGame() {
  const me = view.players.find((p) => p.id === view.you);
  if (!me) return;
  const h = view.hand;
  const s = h?.seats[me.id];
  const myTurn = Boolean(view.legal);
  if (myTurn && !wasMyTurn) navigator.vibrate?.([120, 60, 120]);
  wasMyTurn = myTurn;
  if (!myTurn) closeSheet();
  document.body.classList.toggle('my-turn', myTurn);

  const pot = h ? (h.phase === 'betting' ? h.carry + Object.values(h.seats).reduce((a, x) => a + x.total, 0)
    : h.pots.filter((x) => !x.winners).reduce((a, x) => a + x.amount, 0)) : 0;
  const stage = !h ? '대기 중' : h.phase === 'done' ? '판 종료' : h.phase === 'showdown' ? '쇼다운' : h.streetNames[h.street];
  const isDealer = view.dealerId === me.id;
  const role = isDealer ? (view.config.mode === 'holdem' ? '딜러' : '선') : h?.sbId === me.id ? 'SB' : h?.bbId === me.id ? 'BB' : '';

  app.innerHTML = `
    <header class="p-top">
      <span class="p-room">${room}</span>
      <span class="p-stage">${esc(stage)}</span>
      <span class="net ${status === 'online' ? 'on' : 'wait'}"><i class="dot"></i>${esc(STATUS_TEXT[status])}</span>
    </header>
    <section class="p-pot"><small>팟</small><b>${fmt(pot)}</b></section>
    <ul class="p-others">${othersHtml(me)}</ul>
    <section class="p-me">
      <div><small>${esc(me.name)}${role ? ` · ${role}` : ''}</small><b>${fmt(me.chips)}</b></div>
      ${s?.bet > 0 && h.phase === 'betting' ? `<div class="p-mybet">${chipStack(s.bet)}<span>${fmt(s.bet)}</span></div>` : ''}
    </section>
    <section class="p-dock">${dockHtml(me)}</section>`;
}

function render() {
  if (!token && !view) {
    renderJoin();
  } else if (!view) {
    app.innerHTML = `<div class="p-center"><p class="eyebrow">테이블 ${room}</p><h1>${esc(STATUS_TEXT[status] ?? '입장 중…')}</h1>
      <p class="hint">관리자 화면이 열려 있는지 확인해 주세요.</p></div>`;
  } else {
    renderGame();
  }
}

render();
link.start();
keepAwake();
