// 마피아 화면. 방을 만든 휴대폰이 서버 역할을 하면서 자기도 함께 플레이한다.

import * as E from './mafia-engine.js';
import { ClientLink, HostLink, newRoomCode, normalizeRoom } from './net.js';
import { esc, keepAwake, load, store, toast } from './ui.js';

const NAME_KEY = 'mf:name';
const LAST_ROOM = 'mf:lastRoom';
const roomKey = (room) => `mf:room:${room}`;
const channel = (room) => `mafia:${room}`;

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const room = normalizeRoom(params.get('room'));

const ui = { showRole: false, draft: load(NAME_KEY) ?? '', code: '' };

/* ---------- 공통 화면 조각 ---------- */

const ROLE_COLOR = { mafia: 'var(--blood)', doctor: 'var(--doc)', police: 'var(--cop)', citizen: 'var(--fg)' };
const PHASE_LABEL = (v) =>
  ({ lobby: '대기실', night: `${v.n}일차 밤`, day: `${v.n}일차 낮`, vote: `${v.n}일차 투표`, verdict: `${v.n}일차 결과`, end: '게임 끝' })[v.phase];

function header(label, status) {
  const dot = status === 'online' ? 'on' : status ? 'off' : '';
  const text = status && status !== 'online' ? '연결 중…' : label;
  return `<div class="top"><h1>MT <span>마피아</span></h1><span class="phase"><i class="dot ${dot}"></i>${esc(text ?? '')}</span></div>`;
}

const nameIn = (v, id) => v.players.find((p) => p.id === id)?.name ?? '?';

function roleCard(v) {
  const me = v.me;
  if (!me || me.spectator || !me.role) {
    return `<div class="panel"><p class="muted">이번 판은 관전 중이에요. 다음 판부터 참가해요.</p></div>`;
  }
  const team = me.role === 'mafia' && me.team?.length ? `<p class="muted">같은 편: ${me.team.map((id) => esc(nameIn(v, id))).join(', ')}</p>` : '';
  const checks = me.role === 'police' && me.checks?.length
    ? `<ul class="list">${me.checks.map((c) => `<li><span>${c.n}일차 · ${esc(nameIn(v, c.target))}</span><span class="chip ${c.mafia ? 'r-mafia' : ''}">${c.mafia ? '마피아' : '마피아 아님'}</span></li>`).join('')}</ul>`
    : '';
  return `<div class="panel">
    <div class="rolecard"><div>
      <p class="muted">내 직업${me.alive ? '' : ' · 사망'}</p>
      <div class="rolename" style="color:${ui.showRole ? ROLE_COLOR[me.role] : 'var(--dim)'}">${ui.showRole ? E.ROLE_NAMES[me.role] : '●●●'}</div>
    </div><button class="ghost" data-a="toggle-role">${ui.showRole ? '가리기' : '보기'}</button></div>
    ${ui.showRole ? team + checks : ''}
  </div>`;
}

const progress = (v) =>
  `<div class="panel"><p class="muted">${v.done} / ${v.aliveCount}명 완료</p><div class="bar"><i style="width:${v.aliveCount ? (v.done / v.aliveCount) * 100 : 0}%"></i></div></div>`;

function targetGrid(v, ids, chosen, action, extra = '') {
  return `<div class="grid">${ids
    .map((id) => `<button class="${chosen === id ? 'sel' : ''}" data-a="${action}" data-t="${esc(id)}">${esc(nameIn(v, id))}</button>`)
    .join('')}${extra}</div>`;
}

function playerList(v, extra = () => '') {
  return `<ul class="list">${v.players
    .map((p) => `<li><span class="${p.alive || p.spectator ? '' : 'dead'}">${esc(p.name)}${v.me?.id === p.id ? ' <span class="chip">나</span>' : ''}</span>${extra(p)}</li>`)
    .join('')}</ul>`;
}

const canPlay = (v) => v.me && !v.me.spectator && v.me.alive;

function nightBody(v) {
  const me = v.me;
  if (!canPlay(v)) return `<div class="panel"><h2>밤이 되었습니다</h2><p class="muted">조용히 기다려 주세요. 살아있는 사람들이 고르는 중이에요.</p></div>`;
  if (me.role === 'mafia') {
    const picks = Object.entries(me.picks ?? {}).map(([id, t]) => `${esc(nameIn(v, id))} → ${esc(nameIn(v, t))}`);
    return `<div class="panel"><h2 style="color:var(--blood)">누구를 제거할까요?</h2>
      ${targetGrid(v, me.targets, me.act, 'act')}
      ${me.team?.length ? `<p class="muted">팀원 선택: ${picks.join(' · ') || '아직 없음'}<br>표가 갈리면 많이 받은 사람, 동점이면 무작위예요. 밤이 끝나기 전까지 바꿀 수 있어요.</p>` : ''}
    </div>`;
  }
  if (me.role === 'doctor') {
    return `<div class="panel"><h2 style="color:var(--doc)">누구를 살릴까요?</h2>${targetGrid(v, me.targets, me.act, 'act')}<p class="muted">자기 자신도 고를 수 있어요.</p></div>`;
  }
  if (me.role === 'police') {
    const check = me.checks?.find((c) => c.n === v.n);
    if (check) {
      return `<div class="panel"><h2 style="color:var(--cop)">조사 결과</h2><p class="news">${esc(nameIn(v, check.target))}님은 ${check.mafia ? '<span style="color:var(--blood)">마피아입니다</span>' : '마피아가 아닙니다'}</p></div>`;
    }
    return `<div class="panel"><h2 style="color:var(--cop)">누구를 조사할까요?</h2>${targetGrid(v, me.targets, null, 'act')}<p class="muted">한 번 고르면 바꿀 수 없어요.</p></div>`;
  }
  return `<div class="panel"><h2>밤이 되었습니다</h2><p class="muted">시민은 밤에 할 일이 없어요. 티 나지 않게 가장 의심 가는 사람을 골라 주세요. 결과에는 영향이 없어요.</p>${targetGrid(v, me.targets, me.act, 'act')}</div>`;
}

function voteBody(v) {
  if (!canPlay(v)) return `<div class="panel"><h2>투표 중</h2><p class="muted">죽은 사람과 관전자는 투표할 수 없어요.</p></div>`;
  const ids = v.players.filter((p) => p.alive && p.id !== v.me.id).map((p) => p.id);
  const skip = `<button class="${v.me.vote === 'skip' ? 'sel' : ''}" data-a="vote" data-t="skip">기권</button>`;
  return `<div class="panel"><h2>누구를 처형할까요?</h2>${targetGrid(v, ids, v.me.vote, 'vote', skip)}
    <p class="muted">${v.me.vote ? '투표 완료. 마감 전까지 바꿀 수 있어요.' : '가장 많이 받은 한 명이 처형돼요. 동점이면 아무도 처형되지 않아요.'}</p></div>`;
}

function tallyList(v) {
  const rows = Object.entries(v.tally ?? {})
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, voters]) => `<li><span><b>${k === 'skip' ? '기권' : esc(nameIn(v, k))}</b> · ${voters.length}표</span><span class="muted">${voters.map((id) => esc(nameIn(v, id))).join(', ')}</span></li>`);
  return `<ul class="list">${rows.join('') || '<li class="muted">투표 없음</li>'}</ul>`;
}

function configPanel(v, editable) {
  const c = v.cfg;
  const citizens = v.players.length - c.mafia - c.doctor - c.police;
  const step = (k, label, cls) => `<div class="stepper"><span class="chip ${cls}">${label}</span><div class="ctl">${
    editable ? `<button data-h="cfg" data-k="${k}" data-d="-1" aria-label="${label} 줄이기">−</button>` : ''
  }<b>${c[k]}</b>${editable ? `<button data-h="cfg" data-k="${k}" data-d="1" aria-label="${label} 늘리기">+</button>` : ''}</div></div>`;
  return `<div class="panel"><h2>직업 구성</h2>
    ${step('mafia', '마피아', 'r-mafia')}${step('doctor', '의사', 'r-doctor')}${step('police', '경찰', 'r-police')}
    <div class="stepper"><span class="chip r-citizen">시민</span><div class="ctl"><b>${Math.max(0, citizens)}</b></div></div>
    ${editable
      ? `<label class="check"><input type="checkbox" id="reveal" ${c.reveal ? 'checked' : ''}> 처형되면 직업 공개</label>`
      : `<p class="muted">처형 시 직업 ${c.reveal ? '공개' : '비공개'}</p>`}
  </div>`;
}

// 방장 화면이면 host에 방장 전용 조각을 넘긴다.
function gameScreen(v, status, host = null) {
  const h = (key) => (host?.[key] ? host[key]() : '');
  let body = '';
  if (v.phase === 'lobby') {
    body = (host ? h('invite') : '') +
      `<div class="panel"><h2>참가자 ${v.players.length}명</h2>${host ? h('roster') : playerList(v)}</div>` +
      configPanel(v, Boolean(host)) +
      (host ? h('lobby') : '<p class="muted">모두 들어오면 방장이 게임을 시작해요.</p>');
  } else if (v.phase === 'night') {
    body = roleCard(v) + nightBody(v) + progress(v) + h('night');
  } else if (v.phase === 'day') {
    body = roleCard(v) +
      `<div class="panel"><h2>아침이 밝았습니다</h2><p class="news">${esc(v.news ?? '')}</p></div>
       <div class="panel"><p class="big">이제 휴대폰을 내려놓고 얼굴 보고 토론하세요.</p>${playerList(v, (p) => `<span class="chip">${p.spectator ? '관전' : p.alive ? '생존' : '사망'}</span>`)}</div>` +
      (host ? h('day') : '<p class="muted">토론이 끝나면 방장이 투표를 시작해요.</p>');
  } else if (v.phase === 'vote') {
    body = roleCard(v) + voteBody(v) + progress(v) + h('vote');
  } else if (v.phase === 'verdict') {
    body = roleCard(v) + `<div class="panel"><h2>투표 결과</h2><p class="news">${esc(v.news ?? '')}</p>${tallyList(v)}</div>` +
      (host ? h('verdict') : '<p class="muted">방장이 밤으로 넘기면 다시 휴대폰을 확인하세요.</p>');
  } else if (v.phase === 'end') {
    const win = v.winner === 'mafia' ? '<span style="color:var(--blood)">마피아 승리</span>' : '<span style="color:var(--moon)">시민 승리</span>';
    body = `<div class="panel"><h2 style="font-size:2rem">${win}</h2><p class="news">${esc(v.news ?? '')}</p></div>
      <div class="panel"><h2>직업 공개</h2><ul class="list">${v.players
        .filter((p) => p.role)
        .map((p) => `<li><span class="${p.alive ? '' : 'dead'}">${esc(p.name)}</span><span class="chip r-${p.role}">${E.ROLE_NAMES[p.role]}</span></li>`)
        .join('')}</ul></div>
      <div class="panel"><h2>기록</h2><ul class="list">${v.log.map((l) => `<li><span>${esc(l)}</span></li>`).join('')}</ul></div>` +
      (host ? h('end') : '<p class="muted">방장이 대기실로 돌리면 같은 멤버로 다시 할 수 있어요.</p>');
  }
  return header(PHASE_LABEL(v), status) + body;
}

function draw(html) {
  const focused = document.activeElement?.id;
  app.innerHTML = html;
  if (focused) document.getElementById(focused)?.focus();
}

app.addEventListener('click', (event) => {
  if (event.target.closest('[data-a="toggle-role"]')) {
    ui.showRole = !ui.showRole;
    rerender();
  }
});
let rerender = () => {};

/* ---------- 첫 화면 ---------- */

function homeScreen() {
  const last = load(LAST_ROOM);
  const resume = last && load(roomKey(last)) ? `<button class="ghost" data-home="resume">열어 둔 방 ${esc(last)} 이어서 하기</button>` : '';
  draw(`${header('사회자 없는 마피아')}
    <div class="panel">
      <label class="muted" for="name">내 이름</label>
      <input id="name" type="text" maxlength="${E.NAME_LIMIT}" placeholder="예: 도현" value="${esc(ui.draft)}" autocomplete="off">
    </div>
    <div class="panel"><h2>방 참가</h2>
      <input id="code" class="code-input" type="text" maxlength="4" placeholder="방 코드" autocomplete="off" autocapitalize="characters" value="${esc(ui.code)}">
      <button class="primary" data-home="join">참가</button>
    </div>
    <div class="panel"><h2>새 방 만들기</h2>
      <p class="muted">방을 만든 휴대폰이 사회자 역할을 대신해요. 게임 내내 이 화면을 켜 두세요. 방장도 함께 플레이해요.</p>
      <button data-home="create">방 만들기</button>${resume}
    </div>`);
}

function startHome() {
  homeScreen();
  app.addEventListener('input', (e) => {
    if (e.target.id === 'name') ui.draft = e.target.value;
    if (e.target.id === 'code') e.target.value = ui.code = normalizeRoom(e.target.value);
  });
  app.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-home]')?.dataset.home;
    if (!cmd) return;
    const name = ui.draft.trim();
    if (cmd === 'resume') {
      location.href = `mafia.html?room=${load(LAST_ROOM)}&host=1`;
      return;
    }
    if (!name) {
      toast('이름을 먼저 입력해 주세요');
      document.getElementById('name')?.focus();
      return;
    }
    store(NAME_KEY, name);
    if (cmd === 'join') {
      if (ui.code.length !== 4) {
        toast('방 코드 4자리를 입력해 주세요');
        return;
      }
      location.href = `mafia.html?room=${ui.code}&go=1`;
    } else if (cmd === 'create') {
      const previous = load(LAST_ROOM);
      if (previous) {
        try {
          localStorage.removeItem(roomKey(previous));
        } catch {
          // 저장소를 쓸 수 없으면 지울 것도 없다.
        }
      }
      const code = newRoomCode();
      const game = E.createGame();
      const hostId = E.addPlayer(game, name.slice(0, E.NAME_LIMIT)).id;
      store(roomKey(code), JSON.stringify({ game, tokens: {}, hostId }));
      store(LAST_ROOM, code);
      location.href = `mafia.html?room=${code}&host=1`;
    }
  });
}

/* ---------- 방장 ---------- */

function startHost(saved) {
  const { game, tokens, hostId } = saved;
  const conns = new Map();
  let netStatus = 'connecting';
  const joinUrl = new URL(`mafia.html?room=${room}`, location.href).href;
  const qrSvg = (() => {
    const qr = qrcode(0, 'M');
    qr.addData(joinUrl);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  })();

  const persist = () => store(roomKey(room), JSON.stringify({ game, tokens, hostId }));
  const broadcast = () => {
    for (const [id, conn] of conns) link.send(conn, { t: 'state', view: E.viewFor(game, id) });
  };
  const commit = () => {
    persist();
    broadcast();
    render();
  };
  const mutate = (fn, onError = toast) => {
    try {
      fn(game);
    } catch (err) {
      onError(err.message);
      return;
    }
    commit();
  };

  function uniqueName(raw) {
    const base = String(raw ?? '').trim().slice(0, E.NAME_LIMIT) || '손님';
    let name = base;
    for (let i = 2; game.players.some((p) => p.name === name); i += 1) name = `${base}${i}`;
    return name;
  }

  function handleJoin(conn, msg) {
    if (typeof msg.token !== 'string' || msg.token.length > 64) return;
    let id = tokens[msg.token];
    if (!E.playerOf(game, id)) {
      try {
        id = E.addPlayer(game, uniqueName(msg.name)).id;
      } catch (err) {
        link.send(conn, { t: 'reject', message: err.message });
        return;
      }
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

  const link = new HostLink(channel(room), {
    onStatus(status) {
      netStatus = status;
      render();
    },
    onMessage(conn, msg) {
      if (msg.t === 'join') return handleJoin(conn, msg);
      const id = conn.playerId;
      if (!id) return;
      const reject = (message) => {
        link.send(conn, { t: 'reject', message });
        link.send(conn, { t: 'state', view: E.viewFor(game, id) });
      };
      if (msg.t === 'act') mutate((g) => E.nightAct(g, id, String(msg.target)), reject);
      if (msg.t === 'vote') mutate((g) => E.castVote(g, id, String(msg.target)), reject);
    },
    onClose(conn) {
      if (conn.playerId && conns.get(conn.playerId) === conn) {
        conns.delete(conn.playerId);
        render();
      }
    },
  });

  const online = (id) => id === hostId || conns.has(id);

  const hostParts = {
    invite: () => `<div class="panel"><div class="invite">
        <button class="qr" data-h="qr" aria-label="QR 크게 보기">${qrSvg}</button>
        <div><p class="muted">방 코드</p><div class="room-code">${room}</div>
        <button class="small" data-h="share">참가 링크 보내기</button></div>
      </div><p class="muted">QR을 누르면 크게 보여요. 카메라로 찍거나 링크를 받아 열고 이름만 넣으면 들어와요.</p></div>`,
    roster: () => `<ul class="list">${game.players
      .map((p) => `<li><span><i class="dot ${online(p.id) ? 'on' : 'off'}"></i> ${esc(p.name)}${p.id === hostId ? ' <span class="chip">방장</span>' : ''}</span>${
        p.id === hostId ? '' : `<button class="ghost small" data-h="kick" data-id="${esc(p.id)}">내보내기</button>`
      }</li>`)
      .join('')}</ul><p class="muted">초록 점은 연결된 사람이에요.</p>`,
    lobby: () => {
      const problem = E.startCheck(game);
      return `<div class="panel"><button class="primary" data-h="start" ${problem ? 'disabled' : ''}>게임 시작 (${game.players.length}명)</button>
        <p class="muted">${problem ? esc(problem) : '8명이면 마피아 2 · 의사 1 · 경찰 1 · 시민 4를 추천해요.'}</p></div>`;
    },
    night: () => `<div class="panel"><p class="muted">방장 메뉴 · 연결 안 된 사람: ${offline()}</p><button class="ghost" data-h="force-night">기다리지 않고 밤 끝내기</button></div>`,
    day: () => `<div class="panel"><button class="primary" data-h="vote">투표 시작</button></div>`,
    vote: () => `<div class="panel"><p class="muted">방장 메뉴 · 연결 안 된 사람: ${offline()}</p><button class="ghost" data-h="force-vote">기다리지 않고 투표 마감</button></div>`,
    verdict: () => `<div class="panel"><button class="primary" data-h="night">밤으로 넘어가기</button></div>`,
    end: () => `<div class="panel"><button class="primary" data-h="lobby">같은 멤버로 대기실로</button></div>`,
  };
  const offline = () => E.alivePlayers(game).filter((p) => !online(p.id)).map((p) => esc(p.name)).join(', ') || '없음';

  function render() {
    draw(gameScreen(E.viewFor(game, hostId), netStatus, hostParts));
  }
  rerender = render;

  async function share() {
    const data = { title: '마피아 하자', text: `방 코드 ${room}`, url: joinUrl };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(joinUrl);
        toast('링크를 복사했어요');
      }
    } catch (err) {
      if (err.name !== 'AbortError') toast(joinUrl);
    }
  }

  const commands = {
    share,
    qr: () => {
      const layer = document.createElement('div');
      layer.className = 'qr-full';
      layer.setAttribute('role', 'dialog');
      layer.innerHTML = `<div class="qr-box">${qrSvg}</div><div class="room-code">${room}</div><p>카메라로 찍으면 바로 참가해요</p><button>닫기</button>`;
      layer.addEventListener('click', () => layer.remove());
      document.body.append(layer);
    },
    start: () => mutate((g) => E.start(g)),
    vote: () => mutate((g) => E.startVote(g)),
    night: () => mutate((g) => E.toNight(g)),
    lobby: () => mutate((g) => E.backToLobby(g)),
    'force-night': () => {
      if (confirm('아직 안 고른 사람이 있어도 밤을 끝낼까요?')) mutate((g) => E.resolveNight(g));
    },
    'force-vote': () => {
      if (confirm('아직 투표 안 한 사람이 있어도 마감할까요?')) mutate((g) => E.resolveVote(g));
    },
  };

  app.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]');
    if (a?.dataset.a === 'act') mutate((g) => E.nightAct(g, hostId, a.dataset.t));
    if (a?.dataset.a === 'vote') mutate((g) => E.castVote(g, hostId, a.dataset.t));
    const b = e.target.closest('[data-h]');
    if (!b) return;
    const cmd = b.dataset.h;
    if (cmd === 'cfg') mutate((g) => E.setConfig(g, b.dataset.k, g.cfg[b.dataset.k] + Number(b.dataset.d)));
    else if (cmd === 'kick') {
      const id = b.dataset.id;
      const p = E.playerOf(game, id);
      if (!p || !confirm(`${p.name}님을 내보낼까요?`)) return;
      const conn = conns.get(id);
      if (conn) {
        link.send(conn, { t: 'kicked' });
        delete tokens[conn.token];
        conns.delete(id);
        conn.playerId = null;
        setTimeout(() => conn.close(), 300);
      }
      for (const [t, pid] of Object.entries(tokens)) if (pid === id) delete tokens[t];
      mutate((g) => E.removePlayer(g, id));
    } else commands[cmd]?.();
  });
  app.addEventListener('change', (e) => {
    if (e.target.id === 'reveal') mutate((g) => E.setConfig(g, 'reveal', e.target.checked));
  });

  render();
  link.start();
  keepAwake();
}

/* ---------- 참가자 ---------- */

function startPlayer() {
  const tokenKey = `mf:token:${room}`;
  let token = load(tokenKey);
  let view = null;
  let status = 'connecting';
  let kicked = false;

  const link = new ClientLink(channel(room), {
    onStatus(next) {
      status = next;
      render();
    },
    onOpen: sendJoin,
    onMessage(msg) {
      if (msg.t === 'state') view = msg.view;
      else if (msg.t === 'reject') toast(msg.message);
      else if (msg.t === 'kicked') {
        kicked = true;
        token = null;
        try {
          localStorage.removeItem(tokenKey);
        } catch {
          // 저장소를 쓸 수 없으면 지울 것도 없다.
        }
        link.send = () => {};
        link.watch = () => {};
      }
      render();
    },
  });

  function sendJoin() {
    if (token) link.send({ t: 'join', token, name: load(NAME_KEY) ?? '' });
  }

  function join() {
    const name = ui.draft.trim();
    if (!name) {
      toast('이름을 입력해 주세요');
      return;
    }
    store(NAME_KEY, name);
    token = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    store(tokenKey, token);
    sendJoin();
    render();
  }

  function render() {
    if (kicked) {
      draw(`${header('')}<div class="panel"><p class="big">방장이 방에서 내보냈어요.</p><a href="mafia.html" style="color:var(--moon)">처음 화면으로</a></div>`);
    } else if (!token) {
      draw(`${header(`방 ${room}`, status)}<div class="panel"><h2>방 ${esc(room)}에 참가</h2>
        <label class="muted" for="name">게임에서 쓸 이름</label>
        <div class="row"><input id="name" type="text" maxlength="${E.NAME_LIMIT}" placeholder="예: 도현" value="${esc(ui.draft)}" autocomplete="off"><button class="primary" data-p="join">참가</button></div>
      </div>`);
    } else if (!view) {
      draw(`${header(`방 ${room}`, status)}<div class="panel"><p class="big">방장 휴대폰을 찾는 중이에요…</p>
        <p class="muted">오래 걸리면 방 코드가 맞는지, 방장 휴대폰 화면이 켜져 있는지 확인해 주세요.</p></div>`);
    } else {
      draw(gameScreen(view, status));
    }
  }
  rerender = render;

  const send = (msg) => {
    if (!link.connected) {
      toast('연결이 끊겨 있어요. 잠시 후 다시 눌러 주세요');
      return;
    }
    link.send(msg);
  };

  app.addEventListener('input', (e) => {
    if (e.target.id === 'name') ui.draft = e.target.value;
  });
  app.addEventListener('keydown', (e) => {
    if (e.target.id === 'name' && e.key === 'Enter') join();
  });
  app.addEventListener('click', (e) => {
    if (e.target.closest('[data-p="join"]')) join();
    const a = e.target.closest('[data-a]');
    if (a?.dataset.a === 'act') send({ t: 'act', target: a.dataset.t });
    if (a?.dataset.a === 'vote') send({ t: 'vote', target: a.dataset.t });
  });

  // 첫 화면에서 이름을 넣고 들어왔다면 바로 참가한다.
  if (!token && ui.draft.trim() && params.get('go') === '1') join();
  render();
  link.start();
  keepAwake();
}

/* ---------- 시작 ---------- */

if (room.length !== 4) {
  startHome();
} else {
  const saved = params.has('host') ? JSON.parse(load(roomKey(room)) ?? 'null') : null;
  if (saved?.game) startHost(saved);
  else startPlayer();
}
