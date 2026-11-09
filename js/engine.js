// 칩 베팅 규칙 엔진. DOM과 네트워크를 모르는 순수 로직이며 상태는 JSON으로 직렬화할 수 있다.

export const MAX_SEATS = 10;

const HOLDEM_STREETS = ['프리플랍', '플랍', '턴', '리버'];
const LOG_LIMIT = 200;

export function defaultConfig(mode = 'holdem') {
  return mode === 'seotda'
    ? { mode, stack: 1000, ante: 10, sb: 0, bb: 0, rounds: 1 }
    : { mode, stack: 1000, ante: 0, sb: 5, bb: 10, rounds: 1 };
}

export function createGame(config) {
  return {
    config: { ...defaultConfig(config?.mode), ...config },
    players: [],
    hand: null,
    handNo: 0,
    dealerId: null,
    lastWinnerId: null,
    actionSeq: 0, // 베팅 흐름이 바뀔 때만 증가한다. 늦게 도착한 입력을 거르는 데 쓴다.
    nextPlayerId: 1,
    departed: [],
    log: [],
  };
}

const fail = (message) => {
  throw new Error(message);
};
const positiveInt = (n) => Number.isInteger(n) && n >= 0;
const bySeat = (a, b) => a.seat - b.seat;

export const playerOf = (g, id) => g.players.find((p) => p.id === id);
const nameOf = (g, id) => playerOf(g, id)?.name ?? '?';
const isHoldem = (h) => h.mode === 'holdem';
const foldWord = (h) => (isHoldem(h) ? '폴드' : '다이');

function addLog(g, text) {
  g.log.push({ hand: g.handNo, text });
  if (g.log.length > LOG_LIMIT) g.log.splice(0, g.log.length - LOG_LIMIT);
}

/* 플레이어 관리 */

export function addPlayer(g, name) {
  if (g.players.length >= MAX_SEATS) fail('자리가 모두 찼습니다');
  const taken = new Set(g.players.map((p) => p.seat));
  let seat = 0;
  while (taken.has(seat)) seat += 1;
  const player = {
    id: g.nextPlayerId,
    name,
    seat,
    chips: g.config.stack,
    buyIn: g.config.stack,
    sitOut: false,
    leaving: false,
  };
  g.nextPlayerId += 1;
  g.players.push(player);
  addLog(g, `${name} 입장 (${player.chips.toLocaleString()})`);
  return player;
}

export function rebuy(g, id, amount) {
  const p = playerOf(g, id) ?? fail('없는 플레이어입니다');
  if (!positiveInt(amount) || amount === 0) fail('금액을 확인해 주세요');
  p.chips += amount;
  p.buyIn += amount;
  addLog(g, `${p.name} 리바이 +${amount.toLocaleString()}`);
}

export function setChips(g, id, amount) {
  const p = playerOf(g, id) ?? fail('없는 플레이어입니다');
  if (!positiveInt(amount)) fail('금액을 확인해 주세요');
  p.chips = amount;
  addLog(g, `${p.name} 칩 수정 → ${amount.toLocaleString()}`);
}

export function transferChips(g, fromId, toId, amount) {
  if (g.hand?.phase === 'betting') fail('베팅이 끝난 뒤에 옮길 수 있습니다');
  const from = playerOf(g, fromId) ?? fail('없는 플레이어입니다');
  const to = playerOf(g, toId) ?? fail('받을 사람을 골라 주세요');
  if (from === to) fail('받을 사람을 골라 주세요');
  if (!positiveInt(amount) || amount === 0) fail('금액을 확인해 주세요');
  if (amount > from.chips) fail('가진 칩보다 많이 옮길 수 없습니다');
  from.chips -= amount;
  to.chips += amount;
  addLog(g, `${from.name} → ${to.name} 칩 이동 ${amount.toLocaleString()}`);
}

export function setSitOut(g, id, sitOut) {
  const p = playerOf(g, id) ?? fail('없는 플레이어입니다');
  p.sitOut = sitOut;
  addLog(g, `${p.name} ${sitOut ? '자리비움' : '복귀'}`);
}

export function removePlayer(g, id) {
  const p = playerOf(g, id) ?? fail('없는 플레이어입니다');
  const h = g.hand;
  if (h && h.phase !== 'done' && h.seats[id]) {
    p.leaving = true;
    g.actionSeq += 1;
    addLog(g, `${p.name} 이번 판 후 퇴장`);
    if (h.phase === 'betting' && !h.seats[id].folded) foldOut(g, id);
    return;
  }
  depart(g, p);
}

function depart(g, p) {
  g.departed.push({ id: p.id, name: p.name, buyIn: p.buyIn, chips: p.chips });
  g.players = g.players.filter((x) => x !== p);
  addLog(g, `${p.name} 퇴장`);
}

function dropLeaving(g) {
  for (const p of g.players.filter((x) => x.leaving)) depart(g, p);
}

export function settlement(g) {
  const rows = [
    ...g.players.map((p) => ({ name: p.name, buyIn: p.buyIn, chips: p.chips, left: false })),
    ...g.departed.map((p) => ({ name: p.name, buyIn: p.buyIn, chips: p.chips, left: true })),
  ];
  return rows.map((row) => ({ ...row, net: row.chips - row.buyIn })).sort((a, b) => b.net - a.net);
}

export function updateConfig(g, patch) {
  if (g.hand && g.hand.phase !== 'done') fail('판이 끝난 뒤에 바꿀 수 있습니다');
  g.config = { ...g.config, ...patch };
}

/* 판 시작 */

function nextDealer(g, players) {
  const current = playerOf(g, g.dealerId);
  if (!current) return players[0].id;
  return (players.find((p) => p.seat > current.seat) ?? players[0]).id;
}

function chooseDealer(g, players, isRematch) {
  const inGame = (id) => players.some((p) => p.id === id);
  if (g.config.mode === 'holdem') return nextDealer(g, players);
  if (isRematch && inGame(g.dealerId)) return g.dealerId;
  if (inGame(g.lastWinnerId)) return g.lastWinnerId;
  return nextDealer(g, players);
}

function pay(g, id, amount, toStreetBet = true) {
  const p = playerOf(g, id);
  const s = g.hand.seats[id];
  const paid = Math.min(amount, p.chips);
  p.chips -= paid;
  s.total += paid;
  if (toStreetBet) s.bet += paid;
  if (p.chips === 0) s.allIn = true;
  return paid;
}

export function startHand(g, rematch = null) {
  if (g.hand && g.hand.phase !== 'done' && !rematch) fail('진행 중인 판이 있습니다');
  const seated = [...g.players].sort(bySeat);
  const players = rematch
    ? seated.filter((p) => rematch.ids.includes(p.id))
    : seated.filter((p) => p.chips > 0 && !p.sitOut && !p.leaving);
  if (players.length < 2) fail('칩이 있는 플레이어가 2명 이상 필요합니다');

  const prevDealerId = g.dealerId;
  const mode = g.config.mode;
  g.dealerId = chooseDealer(g, players, Boolean(rematch));
  g.handNo += 1;
  g.actionSeq += 1;

  const dealerIdx = players.findIndex((p) => p.id === g.dealerId);
  const startIdx = mode === 'holdem' ? dealerIdx + 1 : dealerIdx;
  const order = players.map((_, i) => players[(startIdx + i) % players.length].id);

  const streetNames =
    mode === 'holdem'
      ? HOLDEM_STREETS
      : g.config.rounds === 2
        ? ['1차 베팅', '2차 베팅']
        : ['베팅'];

  const seats = {};
  for (const p of players) {
    seats[p.id] = {
      bet: 0,
      total: 0,
      folded: false,
      allIn: p.chips === 0,
      acted: false,
      canRaise: true,
      last: null,
    };
  }

  const h = {
    no: g.handNo,
    mode,
    phase: 'betting',
    street: 0,
    streetNames,
    order,
    seats,
    currentBet: 0,
    minRaise: mode === 'holdem' ? g.config.bb : 1,
    toAct: null,
    carry: rematch?.carry ?? 0,
    pots: [],
    sbId: null,
    bbId: null,
    isRematch: Boolean(rematch),
    runout: false,
    prevDealerId,
  };
  g.hand = h;
  addLog(g, `— ${g.handNo}번째 판${rematch ? ' (재경기)' : ''} 시작 —`);

  let firstIdx = 0;
  if (!rematch && g.config.ante > 0) {
    for (const id of order) pay(g, id, g.config.ante, false);
  }
  if (mode === 'holdem') {
    const headsUp = order.length === 2;
    const sbIdx = headsUp ? 1 : 0;
    const bbIdx = headsUp ? 0 : 1;
    h.sbId = order[sbIdx];
    h.bbId = order[bbIdx];
    pay(g, h.sbId, g.config.sb);
    pay(g, h.bbId, g.config.bb);
    h.currentBet = g.config.bb;
    firstIdx = (bbIdx + 1) % order.length;
    addLog(g, `블라인드 ${nameOf(g, h.sbId)} ${g.config.sb} · ${nameOf(g, h.bbId)} ${g.config.bb}`);
  }

  h.toAct = findActor(h, firstIdx);
  if (h.toAct === null) closeStreet(g);
}

/* 차례 계산 */

const activeIds = (h) =>
  h.order.filter((id) => !h.seats[id].folded && !h.seats[id].allIn);
const liveIds = (h) => h.order.filter((id) => !h.seats[id].folded);

function highestOtherBet(h, id) {
  return Math.max(0, ...liveIds(h).filter((x) => x !== id).map((x) => h.seats[x].bet));
}

// 혼자 남은 액티브 플레이어는 올인한 사람들의 최고액까지만 맞추면 된다.
function callTarget(h, id) {
  return activeIds(h).length > 1 ? h.currentBet : Math.min(h.currentBet, highestOtherBet(h, id));
}

function needsAction(h, id) {
  const s = h.seats[id];
  if (s.folded || s.allIn) return false;
  if (activeIds(h).length > 1) return !s.acted || s.bet < h.currentBet;
  return s.bet < callTarget(h, id);
}

function findActor(h, fromIdx) {
  const n = h.order.length;
  for (let i = 0; i < n; i += 1) {
    const id = h.order[(fromIdx + i) % n];
    if (needsAction(h, id)) return id;
  }
  return null;
}

export const potTotal = (h) =>
  h.carry + Object.values(h.seats).reduce((sum, s) => sum + s.total, 0);

/* 가능한 액션 */

function roundUp(value, unit) {
  return unit > 1 ? Math.ceil(value / unit) * unit : Math.ceil(value);
}

function buildPresets(g, h, ctx) {
  const { target, toCall, maxTo, minTo, pot, bet } = ctx;
  const unit = (isHoldem(h) ? g.config.sb : g.config.ante) || 1;
  const afterCall = pot + toCall;
  const byPot = (fraction) => Math.min(maxTo, target + roundUp(afterCall * fraction, unit));

  const list = [];
  if (isHoldem(h)) {
    list.push({ key: 'min', label: '최소', to: minTo });
    list.push({ key: 'half', label: '½팟', to: Math.max(minTo, byPot(0.5)) });
    list.push({ key: 'pot', label: '팟', to: Math.max(minTo, byPot(1)) });
  } else {
    if (h.currentBet === 0) {
      list.push({ key: 'ping', label: '삥', to: Math.min(maxTo, g.config.ante || 1) });
    } else {
      list.push({ key: 'ddadang', label: '따당', to: Math.min(maxTo, bet + toCall * 2) });
    }
    list.push({ key: 'quarter', label: '쿼터', to: byPot(0.25) });
    list.push({ key: 'half', label: '하프', to: byPot(0.5) });
    list.push({ key: 'full', label: '풀', to: byPot(1) });
  }
  const seen = new Set();
  return list
    .filter((x) => x.to > h.currentBet && !seen.has(x.to) && seen.add(x.to))
    .map((x) => ({ ...x, pay: x.to - bet }));
}

export function legal(g, id) {
  const h = g.hand;
  if (!h || h.phase !== 'betting' || h.toAct !== id) return null;
  const s = h.seats[id];
  const p = playerOf(g, id);
  const target = callTarget(h, id);
  const toCall = Math.max(0, target - s.bet);
  const call = Math.min(toCall, p.chips);
  const maxTo = s.bet + p.chips;
  const othersCanRespond = activeIds(h).some((x) => x !== id);
  const canRaise = s.canRaise && othersCanRespond && maxTo > h.currentBet;
  const minTo = Math.min(h.currentBet + (isHoldem(h) ? h.minRaise : 1), maxTo);
  const pot = potTotal(h);
  return {
    canCheck: toCall === 0,
    toCall,
    call,
    callIsAllIn: toCall > 0 && call === p.chips,
    canRaise,
    minTo,
    maxTo,
    bet: s.bet,
    chips: p.chips,
    pot,
    isOpening: h.currentBet === 0,
    unit: (isHoldem(h) ? g.config.sb : g.config.ante) || 1,
    presets: canRaise ? buildPresets(g, h, { target, toCall, maxTo, minTo, pot, bet: s.bet }) : [],
  };
}

/* 액션 처리 */

function raiseTo(g, id, wanted, label, la) {
  const h = g.hand;
  const s = h.seats[id];
  if (!la.canRaise) fail('지금은 레이즈할 수 없습니다');
  if (!Number.isFinite(wanted)) fail('금액을 확인해 주세요');
  const to = Math.min(Math.floor(wanted), la.maxTo);
  const isAllIn = to === la.maxTo;
  if (to <= h.currentBet) fail('현재 베팅보다 많아야 합니다');
  if (to < la.minTo && !isAllIn) fail(`최소 ${la.minTo.toLocaleString()}까지 올려야 합니다`);

  const size = to - h.currentBet;
  const isFull = !isHoldem(h) || size >= h.minRaise;
  pay(g, id, to - s.bet);
  for (const other of h.order) {
    if (other === id) continue;
    const seat = h.seats[other];
    if (isFull) {
      seat.acted = false;
      seat.canRaise = true;
    } else if (seat.acted) {
      seat.canRaise = false;
    }
  }
  if (isFull && isHoldem(h)) h.minRaise = size;
  h.currentBet = to;
  s.last = isAllIn ? '올인' : label;
  addLog(g, `${nameOf(g, id)} ${s.last} ${to.toLocaleString()}`);
}

export function act(g, id, action) {
  const h = g.hand;
  const la = legal(g, id);
  if (!la) fail('지금은 차례가 아닙니다');
  const s = h.seats[id];

  switch (action.type) {
    case 'fold':
      s.folded = true;
      s.last = foldWord(h);
      addLog(g, `${nameOf(g, id)} ${s.last}`);
      break;
    case 'check':
      if (!la.canCheck) fail('체크할 수 없습니다');
      s.last = '체크';
      addLog(g, `${nameOf(g, id)} 체크`);
      break;
    case 'call':
      if (la.toCall === 0) fail('콜할 금액이 없습니다');
      callChips(g, id, la);
      break;
    case 'raise':
      raiseTo(g, id, action.to, la.isOpening ? '벳' : '레이즈', la);
      break;
    case 'preset': {
      const preset = la.presets.find((x) => x.key === action.key) ?? fail('할 수 없는 베팅입니다');
      raiseTo(g, id, preset.to, isHoldem(h) ? (la.isOpening ? '벳' : '레이즈') : preset.label, la);
      break;
    }
    case 'allin':
      if (la.canRaise) raiseTo(g, id, la.maxTo, '올인', la);
      else if (la.toCall > 0) callChips(g, id, la);
      else fail('올인할 수 없습니다');
      break;
    default:
      fail('알 수 없는 액션입니다');
  }

  s.acted = true;
  g.actionSeq += 1;
  advance(g, id);
}

function callChips(g, id, la) {
  const s = g.hand.seats[id];
  pay(g, id, la.call);
  s.last = la.callIsAllIn ? '올인' : '콜';
  addLog(g, `${nameOf(g, id)} ${s.last} ${la.call.toLocaleString()}`);
}

function advance(g, fromId) {
  const h = g.hand;
  if (liveIds(h).length === 1) {
    goShowdown(g);
    return;
  }
  const next = findActor(h, h.order.indexOf(fromId) + 1);
  if (next === null) closeStreet(g);
  else h.toAct = next;
}

function foldOut(g, id) {
  const h = g.hand;
  if (h.toAct === id) {
    act(g, id, { type: 'fold' });
    return;
  }
  h.seats[id].folded = true;
  h.seats[id].last = foldWord(h);
  addLog(g, `${nameOf(g, id)} ${h.seats[id].last}`);
  if (liveIds(h).length === 1) goShowdown(g);
  else if (!needsAction(h, h.toAct)) advance(g, h.toAct);
}

function closeStreet(g) {
  const h = g.hand;
  const isLast = h.street >= h.streetNames.length - 1;
  if (isLast || activeIds(h).length <= 1) {
    if (!isLast) h.runout = true;
    h.street = h.streetNames.length - 1;
    goShowdown(g);
    return;
  }
  h.street += 1;
  h.currentBet = 0;
  h.minRaise = isHoldem(h) ? g.config.bb : 1;
  for (const id of h.order) {
    const s = h.seats[id];
    s.bet = 0;
    s.acted = false;
    s.canRaise = true;
    if (!s.folded && !s.allIn) s.last = null;
  }
  addLog(g, `▸ ${h.streetNames[h.street]}`);
  h.toAct = findActor(h, 0);
}

/* 팟과 정산 */

export function buildPots(h) {
  const seats = h.order.map((id) => ({ id, ...h.seats[id] }));
  const levels = [...new Set(seats.map((s) => s.total).filter((t) => t > 0))].sort((a, b) => a - b);
  const pots = [];
  const push = (amount, eligible) => {
    const last = pots[pots.length - 1];
    if (last && last.eligible.join() === eligible.join()) last.amount += amount;
    else pots.push({ amount, eligible, winners: null, payouts: null });
  };

  const live = seats.filter((s) => !s.folded).map((s) => s.id);
  if (h.carry > 0) push(h.carry, live);

  let prev = 0;
  let orphan = 0;
  for (const level of levels) {
    const amount = seats.reduce(
      (sum, s) => sum + Math.min(s.total, level) - Math.min(s.total, prev),
      0,
    );
    const eligible = seats.filter((s) => !s.folded && s.total >= level).map((s) => s.id);
    if (eligible.length === 0) {
      if (pots.length > 0) pots[pots.length - 1].amount += amount;
      else orphan += amount;
    } else {
      push(amount + orphan, eligible);
      orphan = 0;
    }
    prev = level;
  }
  return pots;
}

function payout(g, pot, winnerIds) {
  const h = g.hand;
  const winners = h.order.filter((id) => winnerIds.includes(id));
  const share = Math.floor(pot.amount / winners.length);
  let remainder = pot.amount - share * winners.length;
  pot.winners = winners;
  pot.payouts = {};
  for (const id of winners) {
    const amount = share + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    playerOf(g, id).chips += amount;
    pot.payouts[id] = amount;
  }
}

function goShowdown(g) {
  const h = g.hand;
  h.phase = 'showdown';
  h.toAct = null;
  for (const id of h.order) h.seats[id].bet = 0;
  h.pots = buildPots(h);

  const totals = h.order.map((id) => h.seats[id].total).sort((a, b) => b - a);
  const uncalled = totals[0] - totals[1];
  for (const pot of h.pots) {
    if (pot.eligible.length !== 1) continue;
    payout(g, pot, pot.eligible);
    const isRefund = h.pots.length > 1 && pot === h.pots[h.pots.length - 1] && pot.amount === uncalled;
    addLog(g, `${nameOf(g, pot.eligible[0])} ${isRefund ? '돌려받음' : '획득'} +${pot.amount.toLocaleString()}`);
  }
  finishIfSettled(g);
}

function finishIfSettled(g) {
  const h = g.hand;
  if (h.pots.some((pot) => !pot.winners)) return;
  h.phase = 'done';

  // 콜되지 않아 돌려받은 팟은 제외하고, 가장 큰 팟의 승자를 다음 판의 선으로 삼는다.
  const contested = h.pots.filter((pot) => pot.eligible.length > 1);
  const main = (contested.length > 0 ? contested : h.pots).reduce(
    (best, pot) => (pot.amount > best.amount ? pot : best),
    h.pots[0],
  );
  g.lastWinnerId = main.winners[0];
  g.actionSeq += 1;
  dropLeaving(g);
}

export function award(g, potIndex, winnerIds) {
  const h = g.hand;
  if (!h || h.phase !== 'showdown') fail('승자를 고를 단계가 아닙니다');
  const pot = h.pots[potIndex] ?? fail('없는 팟입니다');
  if (pot.winners) fail('이미 분배된 팟입니다');
  if (winnerIds.length === 0 || !winnerIds.every((id) => pot.eligible.includes(id))) {
    fail('승자를 확인해 주세요');
  }
  payout(g, pot, winnerIds);
  addLog(g, `${pot.winners.map((id) => nameOf(g, id)).join(', ')} 획득 +${pot.amount.toLocaleString()}`);
  g.actionSeq += 1;
  finishIfSettled(g);
}

export function canRematch(g) {
  const h = g.hand;
  return Boolean(
    h && h.mode === 'seotda' && h.phase === 'showdown' && h.pots.filter((pot) => !pot.winners).length === 1,
  );
}

export function rematch(g, ids) {
  if (!canRematch(g)) fail('재경기를 할 수 없는 상태입니다');
  const pot = g.hand.pots.find((x) => !x.winners);
  if (ids.length < 2 || !ids.every((id) => pot.eligible.includes(id))) {
    fail('재경기는 2명 이상 골라야 합니다');
  }
  startHand(g, { ids, carry: pot.amount });
}

export function abortHand(g) {
  const h = g.hand;
  if (!h || h.phase === 'done') fail('취소할 판이 없습니다');
  const paid = {};
  for (const pot of h.pots) {
    for (const [id, amount] of Object.entries(pot.payouts ?? {})) paid[id] = amount;
  }
  const share = Math.floor(h.carry / h.order.length);
  let remainder = h.carry - share * h.order.length;
  for (const id of h.order) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    playerOf(g, id).chips += h.seats[id].total + share + extra - (paid[id] ?? 0);
  }
  g.dealerId = h.prevDealerId;
  g.handNo -= 1;
  g.hand = null;
  g.actionSeq += 1;
  dropLeaving(g);
  addLog(g, '판 취소, 칩을 돌려줬습니다');
}

export function totalChips(g) {
  const h = g.hand;
  let onTable = 0;
  if (h?.phase === 'betting') onTable = potTotal(h);
  if (h?.phase === 'showdown') {
    onTable = h.pots.filter((pot) => !pot.winners).reduce((sum, pot) => sum + pot.amount, 0);
  }
  return g.players.reduce((sum, p) => sum + p.chips, 0) + onTable;
}
