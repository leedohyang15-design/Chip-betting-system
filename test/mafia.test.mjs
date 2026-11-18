import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/mafia-engine.js';

const first = () => 0;

// 역할을 고정해서 판을 만든다.
function table(roles) {
  const g = E.createGame();
  const ids = roles.map((_, i) => E.addPlayer(g, `P${i + 1}`).id);
  g.cfg = {
    mafia: roles.filter((r) => r === 'mafia').length,
    doctor: roles.filter((r) => r === 'doctor').length,
    police: roles.filter((r) => r === 'police').length,
    reveal: false,
  };
  E.start(g);
  g.players.forEach((p, i) => {
    p.role = roles[i];
  });
  return { g, ids };
}

const ROLES8 = ['mafia', 'mafia', 'doctor', 'police', 'citizen', 'citizen', 'citizen', 'citizen'];

test('start deals the configured roles', () => {
  const g = E.createGame();
  for (let i = 0; i < 8; i++) E.addPlayer(g, `P${i}`);
  E.start(g);
  const count = (r) => g.players.filter((p) => p.role === r).length;
  assert.deepEqual([count('mafia'), count('doctor'), count('police'), count('citizen')], [2, 1, 1, 4]);
  assert.equal(g.phase, 'night');
});

test('start refuses bad setups', () => {
  const g = E.createGame();
  for (let i = 0; i < 4; i++) E.addPlayer(g, `P${i}`);
  assert.match(E.startCheck(g), /마피아가 너무 많아요/);
  g.cfg.mafia = 1;
  g.cfg.doctor = 2;
  g.cfg.police = 2;
  assert.match(E.startCheck(g), /직업 수가/);
});

test('night resolves after everyone acts; doctor save', () => {
  const { g, ids } = table(ROLES8);
  const [m1, m2, doc, cop, c1, c2, c3, c4] = ids;
  E.nightAct(g, m1, c1);
  E.nightAct(g, m2, c1);
  E.nightAct(g, doc, c1);
  E.nightAct(g, cop, m1);
  for (const c of [c1, c2, c3]) E.nightAct(g, c, cop);
  assert.equal(g.phase, 'night');
  E.nightAct(g, c4, cop);
  assert.equal(g.phase, 'day');
  assert.ok(E.playerOf(g, c1).alive);
  assert.match(g.news, /의사가 살려냈습니다/);
  assert.deepEqual(g.checks[cop], [{ n: 1, target: m1, mafia: true }]);
});

test('mafia kill, then vote executes the top pick', () => {
  const { g, ids } = table(ROLES8);
  const [m1, m2, doc, cop, c1, c2, c3, c4] = ids;
  E.nightAct(g, m1, c2);
  E.nightAct(g, m2, c2);
  E.resolveNight(g, first);
  assert.equal(E.playerOf(g, c2).alive, false);
  E.startVote(g);
  for (const v of [doc, cop, c1, c3]) E.castVote(g, v, m1);
  E.castVote(g, m1, c1);
  E.castVote(g, m2, c1);
  E.castVote(g, c4, 'skip');
  assert.equal(g.phase, 'verdict');
  assert.equal(E.playerOf(g, m1).alive, false);
  assert.equal(g.tally[m1].length, 4);
});

test('a tie executes nobody', () => {
  const { g, ids } = table(['mafia', 'citizen', 'citizen', 'citizen', 'doctor']);
  E.resolveNight(g);
  E.startVote(g);
  E.castVote(g, ids[0], ids[1]);
  E.castVote(g, ids[1], ids[0]);
  E.resolveVote(g);
  assert.match(g.news, /동점/);
  assert.ok(g.players.every((p) => p.alive));
});

test('mafia wins at parity, citizens win when mafia is gone', () => {
  const a = table(['mafia', 'citizen', 'citizen', 'citizen']);
  E.nightAct(a.g, a.ids[0], a.ids[1]);
  E.resolveNight(a.g);
  assert.equal(a.g.phase, 'day');
  E.startVote(a.g);
  E.castVote(a.g, a.ids[0], a.ids[2]);
  E.castVote(a.g, a.ids[3], a.ids[2]);
  E.castVote(a.g, a.ids[2], a.ids[0]);
  assert.equal(a.g.phase, 'end');
  assert.equal(a.g.winner, 'mafia');

  const b = table(['mafia', 'citizen', 'citizen', 'citizen']);
  E.resolveNight(b.g);
  E.startVote(b.g);
  for (const v of b.ids.slice(1)) E.castVote(b.g, v, b.ids[0]);
  E.castVote(b.g, b.ids[0], 'skip');
  assert.equal(b.g.winner, 'citizen');
});

test('rules: police checks once, mafia cannot target mafia, dead cannot act', () => {
  const { g, ids } = table(ROLES8);
  const [m1, m2, , cop, c1] = ids;
  assert.throws(() => E.nightAct(g, m1, m2));
  E.nightAct(g, cop, c1);
  assert.throws(() => E.nightAct(g, cop, m1), /한 번만/);
  E.nightAct(g, m1, c1);
  E.nightAct(g, m2, c1);
  E.resolveNight(g);
  E.startVote(g);
  assert.throws(() => E.castVote(g, c1, m1), /살아있는/);
});

test('views hide other roles until the end', () => {
  const { g, ids } = table(ROLES8);
  const v = E.viewFor(g, ids[4]);
  assert.equal(v.me.role, 'citizen');
  assert.ok(v.players.every((p) => p.role === null));
  assert.equal(v.me.team, undefined);
  assert.deepEqual(E.viewFor(g, ids[0]).me.team, [ids[1]]);
  const s = JSON.stringify(v);
  assert.equal((s.match(/"role":"mafia"/g) ?? []).length, 0);
});

test('late joiners watch until the next game', () => {
  const { g } = table(ROLES8);
  const late = E.addPlayer(g, 'late');
  assert.equal(late.spectator, true);
  assert.equal(late.alive, false);
  assert.equal(E.alivePlayers(g).length, 8);
  E.backToLobby(g);
  assert.equal(late.spectator, false);
});

test('leaving mid-game counts as dead and can end the game', () => {
  const { g, ids } = table(['mafia', 'citizen', 'citizen', 'citizen', 'doctor']);
  E.removePlayer(g, ids[0]);
  assert.equal(g.winner, 'citizen');
});
