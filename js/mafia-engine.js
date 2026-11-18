// 마피아 규칙. DOM과 네트워크 없이 상태만 다룬다 (`npm test`로 검증).

export const ROLE_NAMES = { mafia: '마피아', doctor: '의사', police: '경찰', citizen: '시민' };
export const NAME_LIMIT = 10;
export const MAX_PLAYERS = 20;

export function createGame() {
  return {
    phase: 'lobby',
    cfg: { mafia: 2, doctor: 1, police: 1, reveal: false },
    players: [],
    nextId: 1,
    gameNo: 0,
    n: 0,
    acts: {},
    votes: {},
    checks: {},
    news: null,
    tally: null,
    winner: null,
    log: [],
  };
}

const fail = (message) => {
  throw new Error(message);
};

export const playerOf = (g, id) => g.players.find((p) => p.id === id) ?? null;
export const alivePlayers = (g) => g.players.filter((p) => p.alive);
const roleOf = (g, id) => playerOf(g, id)?.role ?? null;

export function addPlayer(g, name) {
  if (g.players.length >= MAX_PLAYERS) fail('자리가 모두 찼어요');
  // 게임 중에 들어온 사람은 다음 판까지 관전한다.
  const spectator = g.phase !== 'lobby';
  const p = { id: `p${g.nextId++}`, name, role: null, alive: !spectator, spectator };
  g.players.push(p);
  return p;
}

export function removePlayer(g, id) {
  const p = playerOf(g, id);
  if (!p) return;
  if (g.phase === 'lobby' || p.spectator) {
    g.players = g.players.filter((q) => q !== p);
    return;
  }
  // 게임 중에 나가면 죽은 것으로 처리하고 승패를 다시 본다.
  p.alive = false;
  g.log.push(`${p.name}님이 게임에서 나갔습니다.`);
  const win = winnerOf(g);
  if (win) finish(g, win);
  else autoAdvance(g);
}

export function setConfig(g, key, value) {
  if (g.phase !== 'lobby') fail('게임 중에는 바꿀 수 없어요');
  if (key === 'reveal') g.cfg.reveal = Boolean(value);
  else if (['mafia', 'doctor', 'police'].includes(key)) g.cfg[key] = Math.max(key === 'mafia' ? 1 : 0, Math.min(10, Math.floor(value)));
  else fail('알 수 없는 설정');
}

export const lobbyPlayers = (g) => g.players;
export const citizenCount = (g) => g.players.length - g.cfg.mafia - g.cfg.doctor - g.cfg.police;

export function startCheck(g) {
  const n = g.players.length;
  const { mafia, doctor, police } = g.cfg;
  if (n < 4) return '최소 4명이 있어야 시작할 수 있어요';
  if (mafia + doctor + police > n) return '직업 수가 인원보다 많아요';
  if (mafia * 2 >= n) return '마피아가 너무 많아요. 시작하자마자 마피아가 이겨요';
  return null;
}

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function start(g, rng = Math.random) {
  const problem = startCheck(g);
  if (problem) fail(problem);
  const { mafia, doctor, police } = g.cfg;
  const deck = shuffle(
    [
      ...Array(mafia).fill('mafia'),
      ...Array(doctor).fill('doctor'),
      ...Array(police).fill('police'),
      ...Array(g.players.length - mafia - doctor - police).fill('citizen'),
    ],
    rng,
  );
  g.players.forEach((p, i) => {
    p.role = deck[i];
    p.alive = true;
    p.spectator = false;
  });
  g.gameNo += 1;
  g.n = 1;
  g.phase = 'night';
  g.acts = {};
  g.votes = {};
  g.checks = {};
  g.news = null;
  g.tally = null;
  g.winner = null;
  g.log = [];
}

/* 밤 */

export function nightTargets(g, id) {
  const role = roleOf(g, id);
  const alive = alivePlayers(g);
  if (role === 'mafia') return alive.filter((p) => p.role !== 'mafia');
  if (role === 'doctor') return alive;
  return alive.filter((p) => p.id !== id);
}

export function nightAct(g, id, target, rng = Math.random) {
  if (g.phase !== 'night') fail('지금은 밤이 아니에요');
  const me = playerOf(g, id);
  if (!me?.alive || me.spectator) fail('살아있는 참가자만 행동할 수 있어요');
  if (!nightTargets(g, id).some((p) => p.id === target)) fail('고를 수 없는 사람이에요');
  if (me.role === 'police') {
    if (g.acts[id]) fail('경찰은 하룻밤에 한 번만 조사할 수 있어요');
    (g.checks[id] ??= []).push({ n: g.n, target, mafia: roleOf(g, target) === 'mafia' });
  }
  g.acts[id] = target;
  autoAdvance(g, rng);
}

export const nightDone = (g) => alivePlayers(g).filter((p) => g.acts[p.id]).map((p) => p.id);

// 표가 갈리면 많이 받은 사람, 동점이면 무작위.
export function mafiaChoice(g, rng = Math.random) {
  const count = {};
  for (const p of alivePlayers(g)) {
    const t = g.acts[p.id];
    if (p.role === 'mafia' && t) count[t] = (count[t] ?? 0) + 1;
  }
  const max = Math.max(0, ...Object.values(count));
  if (max === 0) return null;
  const top = Object.keys(count).filter((k) => count[k] === max);
  return top[Math.floor(rng() * top.length)];
}

export function resolveNight(g, rng = Math.random) {
  if (g.phase !== 'night') fail('지금은 밤이 아니에요');
  const kill = mafiaChoice(g, rng);
  const saved = Boolean(kill) && alivePlayers(g).some((p) => p.role === 'doctor' && g.acts[p.id] === kill);
  let news;
  if (kill && !saved) {
    const victim = playerOf(g, kill);
    victim.alive = false;
    news = `지난밤 ${victim.name}님이 마피아에게 당했습니다.`;
  } else if (saved) {
    news = '누군가 습격당했지만 의사가 살려냈습니다!';
  } else {
    news = '아무 일도 없는 조용한 밤이었습니다.';
  }
  g.news = news;
  g.log.push(`${g.n}일차 밤 · ${news}`);
  g.acts = {};
  const win = winnerOf(g);
  if (win) finish(g, win);
  else g.phase = 'day';
}

/* 낮과 투표 */

export function startVote(g) {
  if (g.phase !== 'day') fail('토론 중일 때만 투표를 시작할 수 있어요');
  g.phase = 'vote';
  g.votes = {};
  g.tally = null;
}

export function castVote(g, id, target, rng = Math.random) {
  if (g.phase !== 'vote') fail('지금은 투표 시간이 아니에요');
  const me = playerOf(g, id);
  if (!me?.alive || me.spectator) fail('살아있는 참가자만 투표할 수 있어요');
  if (target !== 'skip' && (target === id || !playerOf(g, target)?.alive)) fail('고를 수 없는 사람이에요');
  g.votes[id] = target;
  autoAdvance(g, rng);
}

export const voteDone = (g) => alivePlayers(g).filter((p) => g.votes[p.id]).map((p) => p.id);

export function resolveVote(g) {
  if (g.phase !== 'vote') fail('지금은 투표 시간이 아니에요');
  const tally = {};
  for (const p of alivePlayers(g)) {
    const t = g.votes[p.id];
    if (t) (tally[t] ??= []).push(p.id);
  }
  const max = Math.max(0, ...Object.values(tally).map((a) => a.length));
  const top = Object.keys(tally).filter((k) => tally[k].length === max);
  const exec = max > 0 && top.length === 1 && top[0] !== 'skip' ? top[0] : null;
  let news;
  if (exec) {
    const p = playerOf(g, exec);
    p.alive = false;
    news = `투표로 ${p.name}님이 처형되었습니다.` + (g.cfg.reveal ? ` (${ROLE_NAMES[p.role]})` : '');
  } else if (max === 0) {
    news = '아무도 투표하지 않아 처형이 없습니다.';
  } else if (top.length > 1) {
    news = '동점이라 아무도 처형되지 않았습니다.';
  } else {
    news = '기권이 가장 많아 아무도 처형되지 않았습니다.';
  }
  g.tally = tally;
  g.news = news;
  g.log.push(`${g.n}일차 투표 · ${news}`);
  const win = winnerOf(g);
  if (win) finish(g, win);
  else g.phase = 'verdict';
}

export function toNight(g) {
  if (g.phase !== 'verdict') fail('투표 결과를 본 뒤에 밤으로 넘어갈 수 있어요');
  g.n += 1;
  g.phase = 'night';
  g.acts = {};
  g.votes = {};
  g.news = null;
}

export function winnerOf(g) {
  const alive = alivePlayers(g);
  const mafia = alive.filter((p) => p.role === 'mafia').length;
  if (mafia === 0) return 'citizen';
  if (mafia >= alive.length - mafia) return 'mafia';
  return null;
}

function finish(g, win) {
  g.winner = win;
  g.phase = 'end';
}

export function backToLobby(g) {
  g.phase = 'lobby';
  for (const p of g.players) {
    p.role = null;
    p.alive = true;
    p.spectator = false;
  }
  g.n = 0;
  g.acts = {};
  g.votes = {};
  g.checks = {};
  g.news = null;
  g.tally = null;
  g.winner = null;
}

// 살아있는 사람이 모두 고르면 자동으로 다음 단계로 넘어간다.
function autoAdvance(g, rng = Math.random) {
  const alive = alivePlayers(g).length;
  if (g.phase === 'night' && nightDone(g).length === alive) resolveNight(g, rng);
  else if (g.phase === 'vote' && voteDone(g).length === alive) resolveVote(g);
}

/* 한 사람에게 보내는 화면 정보. 다른 사람의 직업은 게임이 끝나야 담긴다. */

export function viewFor(g, id) {
  const me = playerOf(g, id);
  const ended = g.phase === 'end';
  const view = {
    phase: g.phase,
    cfg: g.cfg,
    n: g.n,
    gameNo: g.gameNo,
    news: g.news,
    winner: g.winner,
    log: g.log,
    tally: g.phase === 'verdict' || ended ? g.tally : null,
    done: g.phase === 'night' ? nightDone(g).length : g.phase === 'vote' ? voteDone(g).length : 0,
    aliveCount: alivePlayers(g).length,
    players: g.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      spectator: p.spectator,
      role: ended && !p.spectator ? p.role : null,
    })),
    me: null,
  };
  if (!me) return view;
  const mine = {
    id: me.id,
    name: me.name,
    role: me.role,
    alive: me.alive,
    spectator: me.spectator,
    act: g.acts[id] ?? null,
    vote: g.votes[id] ?? null,
    targets: g.phase === 'night' && me.alive && !me.spectator ? nightTargets(g, id).map((p) => p.id) : [],
  };
  if (me.role === 'mafia' && !me.spectator) {
    mine.team = g.players.filter((p) => p.role === 'mafia' && p.id !== id).map((p) => p.id);
    mine.picks = Object.fromEntries(mine.team.filter((t) => g.acts[t]).map((t) => [t, g.acts[t]]));
  }
  if (me.role === 'police') mine.checks = g.checks[id] ?? [];
  view.me = mine;
  return view;
}
