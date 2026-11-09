import { createDock } from './dock.js';
import { initAudio, isMuted, sound, toggleMuted } from './fx.js';
import { ClientLink, normalizeRoom } from './net.js';
import { chipStack, esc, fmt, keepAwake, load, signed, store, toast } from './ui.js';

const HELP_MS = 12000;
const ACK_TIMEOUT_MS = 4000;
const FLASH_MS = 800;
const FEED_LENGTH = 4;

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
    return `<p class="dock-result ${net > 0 ? 'plus' : net < 0 ? 'minus' : ''}">${signed(net)}</p>
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
  const s = h?.seats[me.id];
  const myTurn = Boolean(view.legal);
  announce(me, myTurn);
  if (!myTurn) dock.close();
  document.body.classList.toggle('my-turn', myTurn);

  const pot = h ? (h.phase === 'betting' ? h.carry + Object.values(h.seats).reduce((a, x) => a + x.total, 0)
    : h.pots.filter((x) => !x.winners).reduce((a, x) => a + x.amount, 0)) : 0;
  const stage = !h ? '대기 중' : h.phase === 'done' ? '판 종료' : h.phase === 'showdown' ? '쇼다운' : h.streetNames[h.street];
  const isDealer = view.dealerId === me.id;
  const role = isDealer ? (view.config.mode === 'holdem' ? '딜러' : '선') : h?.sbId === me.id ? 'SB' : h?.bbId === me.id ? 'BB' : '';
  const feed = view.log.slice(-FEED_LENGTH).reverse().map((x) => `<li>${esc(x.text)}</li>`).join('');

  app.innerHTML = `
    ${status === 'online' ? '' : `<div class="p-offline">재연결 중… 버튼이 잠시 잠깁니다${showHelp ? HELP_HTML : ''}</div>`}
    <header class="p-top">
      <span class="p-room">${room}</span>
      <span class="p-stage">${esc(stage)}</span>
      <button class="mute" data-cmd="mute" aria-label="${isMuted() ? '소리 켜기' : '소리 끄기'}">${isMuted() ? '🔇' : '🔊'}</button>
      <span class="net ${status === 'online' ? 'on' : 'wait'}"><i class="dot"></i>${esc(STATUS_TEXT[status])}</span>
    </header>
    <section class="p-pot"><small>팟</small><b>${fmt(pot)}</b></section>
    <div class="p-mid">
      <ul class="p-others">${othersHtml(me)}</ul>
      <ol class="p-feed">${feed}</ol>
    </div>
    <section class="p-me">
      <div><small>${esc(me.name)}${role ? ` · ${role}` : ''}</small><b>${fmt(me.chips)}</b></div>
      ${s?.bet > 0 && h.phase === 'betting' ? `<div class="p-mybet">${chipStack(s.bet)}<span>${fmt(s.bet)}</span></div>` : ''}
    </section>
    <section class="p-dock">${dockHtml(me)}</section>`;
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
