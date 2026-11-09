import * as E from './engine.js';
import { HostLink, normalizeRoom } from './net.js';
import { chipStack, esc, fmt, keepAwake, load, roomKey, signed, store, toast } from './ui.js';

const HISTORY_LIMIT = 30;
const NAME_LIMIT = 12;

const room = normalizeRoom(new URLSearchParams(location.search).get('room'));
const saved = JSON.parse(load(roomKey(room)) ?? 'null');

const tableEl = document.getElementById('table');
const sideEl = document.getElementById('side');
const dialog = document.getElementById('dialog');

if (!saved) {
  tableEl.innerHTML = '';
  sideEl.innerHTML = `<div class="panel"><h2>테이블을 찾을 수 없습니다</h2>
    <p class="hint">이 기기에 저장된 방이 아닙니다. 새 테이블을 열어 주세요.</p>
    <a class="btn primary wide" href="index.html">처음으로</a></div>`;
  throw new Error('saved room not found');
}

let game = saved.game;
const tokens = saved.tokens;
const history = saved.history ?? [];
const conns = new Map();
let netStatus = 'connecting';
let picks = { key: '', pots: {} };
let dealtCards = 0;

const joinUrl = new URL(`play.html?room=${room}`, location.href).href;
const qrSvg = (() => {
  const qr = qrcode(0, 'M');
  qr.addData(joinUrl);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
})();

/* 상태 저장과 전파 */

function persist() {
  store(roomKey(room), JSON.stringify({ game, tokens, history }));
}

function viewFor(id) {
  return {
    room,
    config: game.config,
    players: game.players.map((p) => ({ ...p, connected: conns.has(p.id) })),
    hand: game.hand,
    handNo: game.handNo,
    dealerId: game.dealerId,
    seq: game.seq,
    log: game.log.slice(-8),
    you: id,
    legal: E.legal(game, id),
  };
}

function broadcast() {
  for (const [id, conn] of conns) link.send(conn, { t: 'state', view: viewFor(id) });
}

function commit() {
  persist();
  broadcast();
  render();
}

function mutate(change, onError = toast) {
  const before = JSON.stringify(game);
  try {
    change(game);
  } catch (err) {
    game = JSON.parse(before);
    onError(err.message);
    return false;
  }
  history.push(before);
  if (history.length > HISTORY_LIMIT) history.shift();
  commit();
  return true;
}

function undo() {
  if (history.length === 0) {
    toast('되돌릴 내용이 없습니다');
    return;
  }
  const snapshot = JSON.parse(history.pop());
  for (const p of game.players) {
    if (!snapshot.players.some((x) => x.id === p.id)) snapshot.players.push({ ...p });
  }
  snapshot.nextPlayerId = game.nextPlayerId;
  snapshot.seq = game.seq + 1;
  snapshot.log.push({ hand: snapshot.handNo, text: '↩ 되돌리기' });
  game = snapshot;
  commit();
}

/* 플레이어 메시지 */

function uniqueName(raw) {
  const base = String(raw ?? '').trim().slice(0, NAME_LIMIT) || '손님';
  let name = base;
  for (let i = 2; game.players.some((p) => p.name === name); i += 1) name = `${base}${i}`;
  return name;
}

function handleJoin(conn, msg) {
  if (typeof msg.token !== 'string' || msg.token.length > 64) return;
  let id = tokens[msg.token];
  if (!E.playerOf(game, id)) {
    if (game.players.length >= E.MAX_SEATS) {
      link.send(conn, { t: 'full' });
      return;
    }
    id = E.addPlayer(game, uniqueName(msg.name)).id;
    tokens[msg.token] = id;
  }
  const old = conns.get(id);
  if (old && old !== conn) {
    old.playerId = null;
    old.close();
  }
  conn.playerId = id;
  conn.token = msg.token;
  conns.set(id, conn);
  commit();
}

function handleAction(conn, msg) {
  const id = conn.playerId;
  if (!id || !msg.action) return;
  const reject = (message) => {
    link.send(conn, { t: 'reject', message });
    link.send(conn, { t: 'state', view: viewFor(id) });
  };
  if (msg.seq !== game.seq) {
    reject('상황이 바뀌었어요. 다시 눌러 주세요');
    return;
  }
  const { type, key, to } = msg.action;
  mutate((g) => E.act(g, id, { type, key, to: Number(to) }), reject);
}

const link = new HostLink(room, {
  onStatus(status) {
    netStatus = status;
    render();
  },
  onMessage(conn, msg) {
    if (msg.t === 'join') handleJoin(conn, msg);
    if (msg.t === 'act') handleAction(conn, msg);
  },
  onClose(conn) {
    if (conn.playerId && conns.get(conn.playerId) === conn) {
      conns.delete(conn.playerId);
      broadcast();
      render();
    }
  },
});

/* 테이블 렌더링 */

const toRad = (deg) => (deg * Math.PI) / 180;
const place = (angle, rx, ry) =>
  `left:${(50 + rx * Math.cos(toRad(angle))).toFixed(2)}%;top:${(50 + ry * Math.sin(toRad(angle))).toFixed(2)}%`;

function winnersOf(h) {
  const totals = {};
  for (const pot of h.pots) {
    for (const [id, amount] of Object.entries(pot.payouts ?? {})) {
      totals[id] = (totals[id] ?? 0) + amount;
    }
  }
  return totals;
}

function badgeFor(g, h, p) {
  if (h?.mode === 'seotda' || (!h && g.config.mode === 'seotda')) {
    return g.dealerId === p.id ? '<span class="badge sun">선</span>' : '';
  }
  if (!h) return '';
  if (h.sbId === p.id && g.dealerId !== p.id) return '<span class="badge">SB</span>';
  if (h.bbId === p.id) return '<span class="badge">BB</span>';
  return '';
}

function seatHtml(g, h, p, angle, won) {
  const s = h?.seats[p.id];
  const classes = ['seat'];
  if (h && h.phase !== 'done' && !s) classes.push('out');
  if (s?.folded) classes.push('folded');
  if (s?.allIn && !s.folded) classes.push('allin');
  if (h?.toAct === p.id) classes.push('turn');
  if (!conns.has(p.id)) classes.push('offline');
  if (p.sitOut) classes.push('sitout');
  if (won[p.id]) classes.push('winner');

  let tag = '';
  if (won[p.id]) tag = `+${fmt(won[p.id])}`;
  else if (p.sitOut) tag = '자리비움';
  else if (s?.last && h.phase !== 'done') tag = s.last;
  const cards = s && !s.folded && h.phase !== 'done' ? '<span class="minis"><i></i><i></i></span>' : '';

  return `<button class="${classes.join(' ')}" style="${place(angle, 45, 43)}" data-cmd="seat" data-id="${p.id}">
    ${cards}
    <span class="seat-name"><i class="dot"></i>${esc(p.name)}${badgeFor(g, h, p)}</span>
    <span class="seat-chips">${fmt(p.chips)}</span>
    ${tag ? `<span class="seat-tag">${esc(tag)}</span>` : ''}
  </button>`;
}

function centerHtml(g, h, lobby) {
  if (lobby) {
    return `<div class="lobby">
      <div class="qr">${qrSvg}</div>
      <div>
        <p class="lobby-label">스캔하거나 코드 입력</p>
        <p class="lobby-code">${room}</p>
        <p class="lobby-count">${g.players.length}명 입장${g.config.mode === 'seotda' ? ' · 섯다' : ' · 텍사스 홀덤'}</p>
      </div>
    </div>`;
  }
  const isHoldem = h.mode === 'holdem';
  const shown = isHoldem ? [0, 3, 4, 5][h.street] : 0;
  const cards = isHoldem
    ? `<div class="board">${[0, 1, 2, 3, 4]
        .map((i) => `<i class="card ${i < shown ? 'dealt' : ''} ${i < shown && i >= dealtCards ? 'flip' : ''}"></i>`)
        .join('')}</div>`
    : '';
  dealtCards = h.phase === 'done' ? 0 : shown;

  const unpaid = h.pots.filter((pot) => !pot.winners).reduce((sum, pot) => sum + pot.amount, 0);
  const amount = h.phase === 'betting' ? E.potTotal(h) : h.phase === 'showdown' ? unpaid : 0;
  const label =
    h.phase === 'done' ? `${h.no}번째 판 종료` : h.phase === 'showdown' ? '승자 선택' : h.streetNames[h.street];
  return `<div class="center-stack">
    <p class="street">${esc(label)}${h.isRematch ? ' · 재경기' : ''}</p>
    ${cards}
    <div class="pot ${amount ? '' : 'empty'}">${amount ? chipStack(amount) : ''}<b>${amount ? fmt(amount) : ''}</b></div>
  </div>`;
}

function renderTable() {
  const g = game;
  const h = g.hand;
  const lobby = !h || (h.phase === 'done' && g.handNo === 0);
  const sorted = [...g.players].sort((a, b) => a.seat - b.seat);
  const won = h?.phase === 'done' ? winnersOf(h) : {};
  const step = 360 / Math.max(sorted.length, 1);

  const pieces = sorted.map((p, i) => {
    const angle = 90 + i * step;
    let extra = '';
    const bet = h?.seats[p.id]?.bet ?? 0;
    if (bet > 0 && h.phase === 'betting') {
      extra += `<div class="bet" style="${place(angle, 28, 25)}">${chipStack(bet)}<b>${fmt(bet)}</b></div>`;
    }
    if (h && h.mode === 'holdem' && g.dealerId === p.id) {
      extra += `<div class="dealer" style="${place(angle + 13, 33, 30)}">D</div>`;
    }
    return seatHtml(g, h, p, angle, won) + extra;
  });

  tableEl.innerHTML = `<div class="rail"><div class="felt">${centerHtml(g, h, lobby)}</div></div>${pieces.join('')}`;
}

/* 사이드 패널 */

const STATUS_TEXT = {
  online: ['연결됨', 'on'],
  connecting: ['연결 중…', 'wait'],
  taken: ['이 코드는 사용 중입니다. 새 테이블을 여세요', 'bad'],
};

function proxyButtons(h) {
  const la = E.legal(game, h.toAct);
  if (!la) return '';
  const button = (label, action, cls = '') =>
    `<button class="btn ${cls}" data-cmd="proxy" data-action="${esc(JSON.stringify(action))}">${esc(label)}</button>`;
  const parts = [button(h.mode === 'holdem' ? '폴드' : '다이', { type: 'fold' }, 'danger')];
  parts.push(
    la.canCheck ? button('체크', { type: 'check' }) : button(`콜 ${fmt(la.call)}`, { type: 'call' }, 'go'),
  );
  for (const preset of la.presets) {
    parts.push(button(`${preset.label} ${fmt(preset.to)}`, { type: 'preset', key: preset.key }));
  }
  if (la.canRaise) parts.push(button('올인', { type: 'allin' }, 'gold'));
  return parts.join('');
}

function stagePicks(h) {
  const key = `${h.no}:${game.seq}:${h.pots.filter((pot) => pot.winners).length}`;
  if (picks.key.split(':')[0] !== String(h.no)) picks = { key, pots: {} };
  return picks.pots;
}

function showdownHtml(h) {
  const chosen = stagePicks(h);
  const contested = h.pots.map((pot, i) => ({ pot, i })).filter(({ pot }) => !pot.winners);
  const cards = contested
    .map(({ pot, i }) => {
      const selected = chosen[i] ?? [];
      const title = i === 0 ? '메인 팟' : `사이드 팟 ${i}`;
      return `<div class="pot-card">
        <div class="pot-head"><span>${title}</span><b>${fmt(pot.amount)}</b></div>
        <div class="choices">${pot.eligible
          .map(
            (id) => `<button class="choice ${selected.includes(id) ? 'on' : ''}" data-cmd="pick" data-pot="${i}" data-id="${id}">
              ${esc(E.playerOf(game, id).name)}</button>`,
          )
          .join('')}</div>
        <button class="btn primary wide" data-cmd="award" data-pot="${i}" ${selected.length ? '' : 'disabled'}>
          ${selected.length > 1 ? `${selected.length}명이 나누기` : '이 팟 지급'}</button>
      </div>`;
    })
    .join('');
  const rematchBtn = E.canRematch(game)
    ? '<button class="btn wide" data-cmd="rematch-open">재경기 (판돈 유지)</button>'
    : '';
  return `<h2>승자를 골라 주세요</h2><p class="hint">공동 승자는 여러 명 누르면 나눕니다.</p>${cards}${rematchBtn}`;
}

function idleHtml(g, h) {
  const ready = g.players.filter((p) => p.chips > 0 && !p.sitOut && !p.leaving).length;
  let summary = '';
  if (h?.phase === 'done') {
    const won = winnersOf(h);
    summary = `<ul class="results">${Object.entries(won)
      .map(([id, amount]) => {
        const net = amount - h.seats[id].total;
        return `<li><span>${esc(E.playerOf(g, Number(id))?.name ?? '퇴장')}</span><b>${signed(net)}</b></li>`;
      })
      .join('')}</ul>`;
  }
  return `<h2>${h ? '다음 판 준비' : '플레이어를 기다리는 중'}</h2>
    ${summary}
    <button class="btn primary wide big" data-cmd="start" ${ready < 2 ? 'disabled' : ''}>
      ${g.handNo === 0 ? '첫 판 시작' : '다음 판 시작'}</button>
    ${ready < 2 ? '<p class="hint">칩이 있는 플레이어가 2명 이상 필요합니다.</p>' : ''}`;
}

function bettingHtml(h) {
  const actor = E.playerOf(game, h.toAct);
  const la = E.legal(game, h.toAct);
  const need = la.canCheck ? '체크 가능' : `콜 ${fmt(la.call)}`;
  return `<h2><em>${esc(actor.name)}</em> 차례</h2>
    <p class="hint">${need} · 남은 칩 ${fmt(la.chips)}</p>
    <details class="proxy" ${conns.has(h.toAct) ? '' : 'open'}>
      <summary>대신 입력하기</summary>
      <div class="proxy-grid">${proxyButtons(h)}</div>
    </details>`;
}

function renderSide() {
  const g = game;
  const h = g.hand;
  let stage;
  if (!h || h.phase === 'done') stage = idleHtml(g, h);
  else if (h.phase === 'showdown') stage = showdownHtml(h);
  else stage = bettingHtml(h);

  const [statusText, statusCls] = STATUS_TEXT[netStatus] ?? STATUS_TEXT.connecting;
  const inHand = h && h.phase !== 'done';
  const log = [...g.log].reverse().slice(0, 40).map((x) => `<li>${esc(x.text)}</li>`).join('');

  sideEl.innerHTML = `
    <header class="side-head">
      <button class="code" data-cmd="qr" title="QR 크게 보기">${room}</button>
      <span class="net ${statusCls}"><i class="dot"></i>${statusText}</span>
      <div class="side-tools">
        <button class="btn small" data-cmd="settle">정산</button>
        <button class="btn small" data-cmd="settings" ${inHand ? 'disabled' : ''}>설정</button>
      </div>
    </header>
    <section class="panel stage">${stage}</section>
    <div class="side-actions">
      <button class="btn" data-cmd="undo" ${history.length ? '' : 'disabled'}>↩ 되돌리기</button>
      <button class="btn" data-cmd="abort" ${inHand ? '' : 'disabled'}>판 취소</button>
    </div>
    <section class="panel log"><h3>기록</h3><ol>${log}</ol></section>`;
}

function render() {
  renderTable();
  const details = sideEl.querySelector('details.proxy');
  const proxyOpen = details?.open;
  renderSide();
  const next = sideEl.querySelector('details.proxy');
  if (next && proxyOpen) next.open = true;
}

/* 대화상자 */

function openDialog(html) {
  dialog.innerHTML = html;
  dialog.showModal();
}

function seatDialog(id) {
  const p = E.playerOf(game, id);
  if (!p) return;
  const status = conns.has(id) ? '접속 중' : '접속 끊김';
  openDialog(`<h2>${esc(p.name)}</h2>
    <p class="hint">${status} · 칩 ${fmt(p.chips)} · 총 바이인 ${fmt(p.buyIn)}</p>
    <label class="field"><span>리바이</span>
      <span class="inline"><input id="rebuy" type="number" min="1" inputmode="numeric" value="${game.config.stack}">
      <button class="btn go" data-cmd="rebuy" data-id="${id}">추가</button></span></label>
    <label class="field"><span>칩 직접 수정</span>
      <span class="inline"><input id="setchips" type="number" min="0" inputmode="numeric" value="${p.chips}">
      <button class="btn" data-cmd="setchips" data-id="${id}">적용</button></span></label>
    <div class="dialog-row">
      <button class="btn" data-cmd="sitout" data-id="${id}">${p.sitOut ? '복귀' : '자리비움'}</button>
      <button class="btn danger" data-cmd="kick" data-id="${id}">내보내기</button>
    </div>
    <button class="btn wide" data-cmd="close">닫기</button>`);
}

function settleDialog() {
  const inHand = game.hand && game.hand.phase !== 'done';
  const rows = [...game.players]
    .map((p) => ({ p, net: p.chips - p.buyIn }))
    .sort((a, b) => b.net - a.net)
    .map(
      ({ p, net }) => `<tr><td>${esc(p.name)}</td><td>${fmt(p.buyIn)}</td><td>${fmt(p.chips)}</td>
        <td class="${net > 0 ? 'plus' : net < 0 ? 'minus' : ''}">${signed(net)}</td></tr>`,
    )
    .join('');
  openDialog(`<h2>정산</h2>
    ${inHand ? '<p class="hint">판이 진행 중이라 팟에 들어간 칩은 빠져 있습니다.</p>' : ''}
    <table class="settle"><thead><tr><th>이름</th><th>바이인</th><th>현재</th><th>손익</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <button class="btn wide" data-cmd="close">닫기</button>`);
}

function settingsDialog() {
  const c = game.config;
  openDialog(`<h2>설정</h2>
    <form id="settings" class="fields" data-mode="${c.mode}">
      <div class="seg">
        <label><input type="radio" name="mode" value="holdem" ${c.mode === 'holdem' ? 'checked' : ''}><span>텍사스 홀덤</span></label>
        <label><input type="radio" name="mode" value="seotda" ${c.mode === 'seotda' ? 'checked' : ''}><span>섯다</span></label>
      </div>
      <label class="field"><span>새 플레이어 시작 칩</span><input name="stack" type="number" min="1" inputmode="numeric" value="${c.stack}"></label>
      <label class="field only-holdem"><span>스몰 블라인드</span><input name="sb" type="number" min="0" inputmode="numeric" value="${c.sb}"></label>
      <label class="field only-holdem"><span>빅 블라인드</span><input name="bb" type="number" min="1" inputmode="numeric" value="${c.bb}"></label>
      <label class="field"><span>앤티</span><input name="ante" type="number" min="0" inputmode="numeric" value="${c.ante}"></label>
      <label class="field only-seotda"><span>베팅 횟수</span>
        <select name="rounds"><option value="1" ${c.rounds === 1 ? 'selected' : ''}>2장 받고 1번</option><option value="2" ${c.rounds === 2 ? 'selected' : ''}>한 장씩 2번</option></select></label>
    </form>
    <div class="dialog-row">
      <button class="btn" data-cmd="close">취소</button>
      <button class="btn primary" data-cmd="save-settings">저장</button>
    </div>`);
  const form = document.getElementById('settings');
  form.addEventListener('change', () => {
    form.dataset.mode = form.elements.mode.value;
  });
}

function rematchDialog() {
  const pot = game.hand.pots.find((x) => !x.winners);
  openDialog(`<h2>재경기</h2>
    <p class="hint">판돈 ${fmt(pot.amount)}을 유지하고, 고른 사람만 앤티 없이 다시 칩니다.</p>
    <div class="choices" id="rematch-list">${pot.eligible
      .map((id) => `<button class="choice on" data-cmd="toggle" data-id="${id}">${esc(E.playerOf(game, id).name)}</button>`)
      .join('')}</div>
    <div class="dialog-row">
      <button class="btn" data-cmd="close">취소</button>
      <button class="btn primary" data-cmd="rematch">재경기 시작</button>
    </div>`);
}

const amountOf = (selector) => Math.floor(Number(document.querySelector(selector).value));

const commands = {
  start: () => mutate((g) => E.startHand(g)),
  undo,
  abort: () => {
    if (confirm('이번 판을 취소하고 낸 칩을 모두 돌려줄까요?')) mutate((g) => E.abortHand(g));
  },
  seat: ({ id }) => seatDialog(Number(id)),
  settle: settleDialog,
  settings: settingsDialog,
  close: () => dialog.close(),
  qr: () =>
    openDialog(`<div class="qr big">${qrSvg}</div><p class="big-code">${room}</p>
      <p class="hint url">${esc(joinUrl)}</p><button class="btn wide" data-cmd="close">닫기</button>`),
  proxy: ({ action }) => {
    const id = game.hand.toAct;
    mutate((g) => E.act(g, id, JSON.parse(action)));
  },
  pick: ({ pot, id }) => {
    const list = picks.pots[pot] ?? [];
    const pid = Number(id);
    picks.pots[pot] = list.includes(pid) ? list.filter((x) => x !== pid) : [...list, pid];
    renderSide();
  },
  award: ({ pot }) => {
    const winners = picks.pots[pot] ?? [];
    if (mutate((g) => E.award(g, Number(pot), winners))) delete picks.pots[pot];
  },
  'rematch-open': rematchDialog,
  toggle: (_, el) => el.classList.toggle('on'),
  rematch: () => {
    const ids = [...dialog.querySelectorAll('#rematch-list .choice.on')].map((el) => Number(el.dataset.id));
    if (mutate((g) => E.rematch(g, ids))) dialog.close();
  },
  rebuy: ({ id }) => {
    if (mutate((g) => E.rebuy(g, Number(id), amountOf('#rebuy')))) dialog.close();
  },
  setchips: ({ id }) => {
    if (mutate((g) => E.setChips(g, Number(id), amountOf('#setchips')))) dialog.close();
  },
  sitout: ({ id }) => {
    const p = E.playerOf(game, Number(id));
    if (mutate((g) => E.setSitOut(g, p.id, !p.sitOut))) dialog.close();
  },
  kick: ({ id }) => {
    const pid = Number(id);
    const p = E.playerOf(game, pid);
    if (!confirm(`${p.name}님을 내보낼까요? 남은 칩은 정산에서 사라집니다.`)) return;
    const conn = conns.get(pid);
    if (mutate((g) => E.removePlayer(g, pid))) {
      if (conn) {
        link.send(conn, { t: 'kicked' });
        delete tokens[conn.token];
        conns.delete(pid);
        conn.playerId = null;
        setTimeout(() => conn.close(), 300);
      }
      persist();
      render();
      dialog.close();
    }
  },
  'save-settings': () => {
    const f = document.getElementById('settings').elements;
    const number = (el) => Math.max(0, Math.floor(Number(el.value) || 0));
    const patch = {
      mode: f.mode.value,
      stack: Math.max(1, number(f.stack)),
      sb: number(f.sb),
      bb: number(f.bb),
      ante: number(f.ante),
      rounds: Number(f.rounds.value),
    };
    if (patch.mode === 'holdem' && patch.bb < 1) {
      toast('빅 블라인드를 입력해 주세요');
      return;
    }
    if (patch.mode === 'seotda' && patch.ante < 1) {
      toast('섯다는 앤티가 필요합니다');
      return;
    }
    if (mutate((g) => E.updateConfig(g, patch))) dialog.close();
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-cmd]');
  if (!el || el.disabled) return;
  event.preventDefault();
  commands[el.dataset.cmd]?.(el.dataset, el);
});

render();
link.start();
keepAwake();
