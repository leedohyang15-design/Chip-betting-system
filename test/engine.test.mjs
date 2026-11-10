import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, addPlayer, startHand, act, award, legal, rematch, abortHand,
  removePlayer, totalChips, canRematch, playerOf, transferChips, settlement, rebuy,
  reorderSeats, setNextDealer, upcomingDealerId, endBetting,
} from '../js/engine.js';

function table(config, stacks) {
  const g = createGame(config);
  const ids = stacks.map((stack, i) => {
    const p = addPlayer(g, `P${i + 1}`);
    p.chips = stack;
    p.buyIn = stack;
    return p.id;
  });
  return { g, ids };
}

const holdem = { mode: 'holdem', sb: 5, bb: 10 };
const seotda = { mode: 'seotda', ante: 10, rounds: 1 };
const chips = (g, id) => playerOf(g, id).chips;
const toAct = (g) => g.hand.toAct;

test('헤즈업은 딜러가 스몰 블라인드이고 프리플랍 선공, 플랍부터는 빅 블라인드 선공', () => {
  const { g, ids: [a, b] } = table(holdem, [1000, 1000]);
  startHand(g);
  assert.equal(g.dealerId, a);
  assert.equal(g.hand.sbId, a);
  assert.equal(g.hand.bbId, b);
  assert.equal(toAct(g), a);
  act(g, a, { type: 'call' });
  assert.equal(toAct(g), b, '빅 블라인드 옵션');
  assert.equal(legal(g, b).canCheck, true);
  act(g, b, { type: 'check' });
  assert.equal(g.hand.streetNames[g.hand.street], '플랍');
  assert.equal(toAct(g), b);
});

test('3인 프리플랍 순서와 체크 어라운드로 리버까지 진행', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  startHand(g);
  assert.equal(g.hand.sbId, b);
  assert.equal(g.hand.bbId, c);
  assert.equal(toAct(g), a);
  act(g, a, { type: 'call' });
  act(g, b, { type: 'call' });
  act(g, c, { type: 'check' });
  for (let street = 1; street <= 3; street += 1) {
    assert.equal(g.hand.street, street);
    assert.equal(toAct(g), b);
    act(g, b, { type: 'check' });
    act(g, c, { type: 'check' });
    act(g, a, { type: 'check' });
  }
  assert.equal(g.hand.phase, 'showdown');
  assert.equal(g.hand.pots[0].amount, 30);
  award(g, 0, [a]);
  assert.equal(g.hand.phase, 'done');
  assert.equal(chips(g, a), 1020);
});

test('모두 폴드하면 남은 사람이 자동으로 팟을 가져간다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  startHand(g);
  act(g, a, { type: 'fold' });
  act(g, b, { type: 'fold' });
  assert.equal(g.hand.phase, 'done');
  assert.equal(chips(g, c), 1005);
  assert.equal(chips(g, b), 995);
});

test('최소 레이즈는 직전 레이즈 크기를 따른다', () => {
  const { g, ids: [a, b] } = table(holdem, [1000, 1000]);
  startHand(g);
  assert.equal(legal(g, a).minTo, 20);
  assert.throws(() => act(g, a, { type: 'raise', to: 15 }));
  act(g, a, { type: 'raise', to: 40 });
  assert.equal(legal(g, b).minTo, 70);
});

test('3인 올인은 사이드팟을 나누고 팟별로 승자를 받는다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [100, 300, 500]);
  startHand(g);
  act(g, a, { type: 'allin' });
  act(g, b, { type: 'allin' });
  act(g, c, { type: 'allin' });
  const h = g.hand;
  assert.equal(h.phase, 'showdown');
  assert.equal(h.runout, true);
  assert.deepEqual(h.pots.map((p) => p.amount), [300, 400]);
  assert.equal(chips(g, c), 200, '마지막 사람은 상대 최고액까지만 낸다');
  award(g, 0, [a]);
  award(g, 1, [c]);
  assert.equal(chips(g, a), 300);
  assert.equal(chips(g, b), 0);
  assert.equal(chips(g, c), 600);
  assert.equal(g.hand.phase, 'done');
});

test('최소 레이즈에 못 미치는 올인은 이미 액션한 사람의 레이즈를 다시 열지 않는다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 75]);
  startHand(g); // 딜러 a, SB b, BB c
  act(g, a, { type: 'raise', to: 50 });
  act(g, b, { type: 'call' });
  act(g, c, { type: 'allin' }); // 25만 더 올린 짧은 올인
  assert.equal(toAct(g), a);
  const la = legal(g, a);
  assert.equal(la.toCall, 25);
  assert.equal(la.canRaise, false);
});

test('최소 레이즈 이상의 올인은 액션을 다시 연다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 150]);
  startHand(g);
  act(g, a, { type: 'raise', to: 50 });
  act(g, b, { type: 'call' });
  act(g, c, { type: 'allin' });
  assert.equal(legal(g, a).canRaise, true);
});

test('공동 승자는 나누고 나머지 칩은 딜러 왼쪽부터 받는다', () => {
  const { g, ids: [a, b, c] } = table({ mode: 'holdem', sb: 1, bb: 2, ante: 0 }, [101, 101, 101]);
  startHand(g);
  act(g, a, { type: 'raise', to: 11 });
  act(g, b, { type: 'call' });
  act(g, c, { type: 'fold' });
  for (let i = 0; i < 3; i += 1) {
    act(g, b, { type: 'check' });
    act(g, a, { type: 'check' });
  }
  assert.equal(g.hand.pots[0].amount, 24);
  award(g, 0, [a, b]);
  assert.equal(chips(g, a), 102);
  assert.equal(chips(g, b), 102);
});

test('블라인드만으로 전원 올인이어도 멈추지 않는다', () => {
  const { g } = table(holdem, [3, 8]);
  startHand(g);
  assert.notEqual(g.hand.phase, 'betting');
  assert.equal(totalChips(g), 11);
});

test('섯다: 앤티를 걷고 선부터 삥·따당·하프 금액을 계산한다', () => {
  const { g, ids: [a, b, c] } = table(seotda, [1000, 1000, 1000]);
  startHand(g);
  assert.equal(g.dealerId, a);
  assert.equal(toAct(g), a);
  assert.equal(g.hand.seats[a].total, 10);
  const first = legal(g, a);
  assert.equal(first.pot, 30);
  // 쿼터는 삥과 같은 10이라 하나만 남는다.
  assert.deepEqual(first.presets.map((p) => p.key), ['ping', 'half', 'full']);
  act(g, a, { type: 'preset', key: 'ping' });
  assert.equal(g.hand.seats[a].last, '삥');

  const second = legal(g, b);
  assert.equal(second.toCall, 10);
  const dd = second.presets.find((p) => p.key === 'ddadang');
  assert.equal(dd.to, 20);
  // 판돈 40 + 콜 10 = 50, 절반은 앤티 단위로 올려 30, 목표 베팅은 10 + 30
  assert.equal(second.presets.find((p) => p.key === 'half').to, 40);
  act(g, b, { type: 'preset', key: 'half' });
  assert.equal(g.hand.currentBet, 40);
  assert.equal(toAct(g), c);
  act(g, c, { type: 'fold' });
  assert.equal(g.hand.seats[c].last, '다이');
  act(g, a, { type: 'call' });
  assert.equal(g.hand.phase, 'showdown');
  assert.equal(g.hand.pots[0].amount, 110);
});

test('섯다 기본은 1회 베팅, rounds 2면 두 번 베팅한다', () => {
  const one = table(seotda, [100, 100]);
  startHand(one.g);
  act(one.g, one.ids[0], { type: 'check' });
  act(one.g, one.ids[1], { type: 'check' });
  assert.equal(one.g.hand.phase, 'showdown');

  const two = table({ ...seotda, rounds: 2 }, [100, 100]);
  startHand(two.g);
  act(two.g, two.ids[0], { type: 'check' });
  act(two.g, two.ids[1], { type: 'check' });
  assert.equal(two.g.hand.phase, 'betting');
  assert.equal(two.g.hand.streetNames[two.g.hand.street], '2차 베팅');
});

test('섯다 승자가 다음 판의 선이 된다', () => {
  const { g, ids: [a, b, c] } = table(seotda, [100, 100, 100]);
  startHand(g);
  act(g, a, { type: 'check' });
  act(g, b, { type: 'check' });
  act(g, c, { type: 'check' });
  award(g, 0, [c]);
  startHand(g);
  assert.equal(g.dealerId, c);
  assert.equal(toAct(g), c);
});

test('섯다 재경기는 판돈을 유지하고 고른 사람만 앤티 없이 진행한다', () => {
  const { g, ids: [a, b, c] } = table(seotda, [100, 100, 10]);
  startHand(g);
  act(g, a, { type: 'check' });
  act(g, b, { type: 'check' });
  assert.equal(canRematch(g), true);
  rematch(g, [b, c]);
  const h = g.hand;
  assert.deepEqual(Object.keys(h.seats).map(Number).sort(), [b, c]);
  assert.equal(h.carry, 30);
  assert.equal(chips(g, b), 90);
  assert.equal(h.seats[c].allIn, true, '칩 0인 참가자도 재경기에 남는다');
  assert.equal(h.phase, 'showdown', '상대가 칩이 없으면 바로 승자 선택');
  assert.equal(h.pots[0].amount, 30);
  award(g, 0, [c]);
  assert.equal(chips(g, c), 30);
  assert.equal(chips(g, a), 90);
});

test('차례가 아니거나 불가능한 액션은 거부한다', () => {
  const { g, ids: [a, b] } = table(holdem, [1000, 1000]);
  startHand(g);
  assert.throws(() => act(g, b, { type: 'fold' }));
  assert.throws(() => act(g, a, { type: 'check' }));
  assert.throws(() => act(g, a, { type: 'nope' }));
});

test('판 중간 퇴장은 폴드 처리 후 판이 끝나면 자리에서 빠진다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  startHand(g);
  removePlayer(g, b);
  assert.equal(g.hand.seats[b].folded, true);
  assert.equal(toAct(g), a);
  act(g, a, { type: 'fold' });
  assert.equal(g.hand.phase, 'done');
  assert.equal(playerOf(g, b), undefined);
  assert.equal(chips(g, c), 1005);
});

test('판 취소는 낸 칩을 모두 돌려주고 딜러를 되돌린다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  startHand(g);
  act(g, a, { type: 'raise', to: 100 });
  abortHand(g);
  assert.deepEqual([a, b, c].map((id) => chips(g, id)), [1000, 1000, 1000]);
  assert.equal(g.hand, null);
  startHand(g);
  assert.equal(g.dealerId, a);
});

test('입장과 리바이는 베팅 입력의 순번을 바꾸지 않는다', () => {
  const { g, ids: [a, b] } = table(holdem, [1000, 1000]);
  startHand(g);
  const before = g.actionSeq;
  addPlayer(g, '늦은손님');
  rebuy(g, b, 500);
  assert.equal(g.actionSeq, before);
  act(g, a, { type: 'call' });
  assert.equal(g.actionSeq, before + 1);
});

test('나간 사람도 정산에 남아 손익 합계가 0이다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  startHand(g);
  removePlayer(g, b);
  act(g, a, { type: 'fold' });
  assert.equal(playerOf(g, b), undefined);
  removePlayer(g, c);
  const rows = settlement(g);
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((sum, row) => sum + row.net, 0), 0);
  assert.equal(rows.find((row) => row.name === 'P2').left, true);
});

test('판 밖의 사람을 내보내도 퇴장 예약자는 판이 끝날 때까지 남는다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  startHand(g);
  const waiting = addPlayer(g, '대기');
  removePlayer(g, b);
  removePlayer(g, waiting.id);
  assert.ok(playerOf(g, b), '판이 끝나기 전에는 자리에 있다');
  assert.equal(toAct(g), a);
  act(g, a, { type: 'fold' });
  assert.equal(playerOf(g, b), undefined);
  assert.equal(chips(g, c), 1005);
});

test('칩 이동은 총량을 유지하고 베팅 중이나 잔액 초과는 막는다', () => {
  const { g, ids: [a, b] } = table(holdem, [1000, 1000]);
  transferChips(g, a, b, 300);
  assert.deepEqual([chips(g, a), chips(g, b)], [700, 1300]);
  assert.throws(() => transferChips(g, a, b, 701));
  assert.throws(() => transferChips(g, a, a, 10));
  assert.throws(() => transferChips(g, a, b, 0));
  assert.equal(playerOf(g, a).buyIn, 1000, '바이인은 그대로라 손익에 반영된다');
  startHand(g);
  assert.throws(() => transferChips(g, a, b, 10));
});

test('관리자가 정한 자리 순서와 딜러로 판이 진행되고 그다음은 다시 돈다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  reorderSeats(g, [c, a, b]);
  setNextDealer(g, a);
  assert.equal(upcomingDealerId(g), a);
  startHand(g); // 시계 방향 c, a, b에서 딜러 a → SB b, BB c, 선공 a
  assert.equal(g.dealerId, a);
  assert.equal(g.hand.sbId, b);
  assert.equal(g.hand.bbId, c);
  act(g, a, { type: 'fold' });
  act(g, b, { type: 'fold' });
  assert.equal(upcomingDealerId(g), b, '지정은 한 판만 적용된다');
});

test('섯다는 지정한 사람이 직전 승자 대신 선이 된다', () => {
  const { g, ids: [a, b, c] } = table(seotda, [100, 100, 100]);
  startHand(g);
  act(g, a, { type: 'check' });
  act(g, b, { type: 'check' });
  act(g, c, { type: 'check' });
  award(g, 0, [c]);
  assert.equal(upcomingDealerId(g), c);
  setNextDealer(g, b);
  startHand(g);
  assert.equal(g.dealerId, b);
  assert.equal(toAct(g), b);
});

test('판 중에는 순서를 바꿀 수 없고, 판을 취소하면 지정이 유지된다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  assert.throws(() => reorderSeats(g, [a, b]));
  setNextDealer(g, c);
  startHand(g);
  assert.throws(() => reorderSeats(g, [c, b, a]));
  assert.throws(() => setNextDealer(g, a));
  abortHand(g);
  assert.equal(upcomingDealerId(g), c);
});

test('판 끝내기는 승자 선택으로 넘어가고 콜되지 않은 금액은 돌려준다', () => {
  const { g, ids: [a, b, c] } = table(holdem, [1000, 1000, 1000]);
  startHand(g); // 딜러 a, SB b(5), BB c(10)
  act(g, a, { type: 'raise', to: 100 });
  endBetting(g);
  assert.equal(g.hand.phase, 'showdown');
  assert.equal(g.hand.toAct, null);
  assert.equal(chips(g, a), 990, '10을 넘게 올린 90은 돌려받는다');
  // SB는 5만 냈으므로 메인 15에만 권리가 있고, 나머지 10은 a와 c의 사이드 팟이다.
  assert.deepEqual(g.hand.pots.filter((pot) => !pot.winners).map((pot) => pot.amount), [15, 10]);
  assert.equal(totalChips(g), 3000);
  assert.throws(() => endBetting(g));
});

test('금액이 같은 베팅 버튼은 하나만 남는다', () => {
  const { g, ids: [a] } = table(holdem, [1000, 1000]);
  startHand(g);
  const amounts = legal(g, a).presets.map((p) => p.to);
  assert.equal(new Set(amounts).size, amounts.length);
});

test('무작위 진행에서 칩 총량이 보존되고 판이 항상 끝난다', () => {
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 400; round += 1) {
    const mode = round % 2 ? 'seotda' : 'holdem';
    const count = 2 + rand(5);
    const stacks = Array.from({ length: count }, () => 1 + rand(400));
    const config = mode === 'seotda'
      ? { mode, ante: 1 + rand(10), rounds: 1 + rand(2) }
      : { mode, sb: 5, bb: 10, ante: rand(3) };
    const { g } = table(config, stacks);
    const total = stacks.reduce((a, b) => a + b, 0);
    for (let handIdx = 0; handIdx < 6; handIdx += 1) {
      if (g.players.filter((p) => p.chips > 0).length < 2) break;
      startHand(g);
      let guard = 0;
      while (g.hand.phase === 'betting') {
        guard += 1;
        assert.ok(guard < 500, '액션 루프가 끝나지 않음');
        const id = g.hand.toAct;
        const la = legal(g, id);
        assert.ok(la, '차례인 사람의 액션이 없음');
        const options = [];
        options.push(la.canCheck ? { type: 'check' } : { type: 'call' });
        options.push(la.canCheck ? { type: 'check' } : { type: 'fold' });
        for (const preset of la.presets) options.push({ type: 'preset', key: preset.key });
        if (la.canRaise) options.push({ type: 'allin' });
        act(g, id, options[rand(options.length)]);
        assert.equal(totalChips(g), total);
      }
      if (g.hand.phase === 'showdown') {
        g.hand.pots.forEach((pot, i) => {
          if (pot.winners) return;
          const pick = pot.eligible.filter(() => rand(2));
          award(g, i, pick.length ? pick : [pot.eligible[0]]);
        });
      }
      assert.equal(g.hand.phase, 'done');
      assert.equal(g.players.reduce((sum, p) => sum + p.chips, 0), total);
    }
  }
});
