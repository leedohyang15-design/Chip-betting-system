// 칩이 날아가는 연출과 효과음.

import { chipClass, load, store } from './ui.js';

const MUTE_KEY = 'cbs:muted';
const FLIGHT_MS = 420;
const CHIPS_PER_FLIGHT = 3;
const COLLECT_DELAY_MS = 480;

/* 소리 */

let ctx = null;
let muted = load(MUTE_KEY) === '1';

export const isMuted = () => muted;

export function toggleMuted() {
  muted = !muted;
  store(MUTE_KEY, muted ? '1' : '0');
  return muted;
}

// 브라우저는 사용자의 터치가 있어야 소리를 허용한다. 아이폰은 화면 복귀 후에도 다시 깨워야 한다.
export function initAudio() {
  const wake = () => {
    const AudioCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtor) return;
    ctx ??= new AudioCtor();
    if (ctx.state !== 'running') ctx.resume();
  };
  addEventListener('pointerdown', wake, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ctx && ctx.state !== 'running') ctx.resume();
  });
}

function tone(frequency, delay, duration, volume = 0.14, type = 'sine') {
  if (muted || ctx?.state !== 'running') return;
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration);
}

function noise(delay, duration, volume) {
  if (muted || ctx?.state !== 'running') return;
  const start = ctx.currentTime + delay;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start(start);
}

export const sound = {
  chip() {
    tone(2300, 0, 0.035, 0.1, 'triangle');
    tone(1850, 0.05, 0.035, 0.09, 'triangle');
    tone(2100, 0.1, 0.04, 0.07, 'triangle');
  },
  card() {
    noise(0, 0.09, 0.16);
  },
  win() {
    [523, 659, 784, 1047].forEach((frequency, i) => tone(frequency, i * 0.09, 0.2, 0.13));
  },
  turn() {
    tone(880, 0, 0.13, 0.2);
    tone(1175, 0.15, 0.2, 0.2);
  },
};

/* 칩 연출 */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function centerOf(el) {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function capture(root) {
  const map = (selector) =>
    Object.fromEntries([...root.querySelectorAll(selector)].map((el) => [el.dataset.id, centerOf(el)]));
  const pot = root.querySelector('.pot');
  return { seats: map('.seat, [data-seat]'), bets: map('.bet'), pot: pot ? centerOf(pot) : null };
}

function flyChip(from, to, cls, delay) {
  const chip = document.createElement('i');
  chip.className = `chip fly ${cls}`;
  chip.style.left = `${from.x}px`;
  chip.style.top = `${from.y}px`;
  document.body.append(chip);
  chip.animate(
    [
      { transform: 'translate(-50%, -50%)' },
      { transform: `translate(calc(-50% + ${to.x - from.x}px), calc(-50% + ${to.y - from.y}px))` },
    ],
    { duration: FLIGHT_MS, delay, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' },
  );
  // 화면이 가려지면 애니메이션 완료 이벤트가 늦어지므로 시간으로 지운다.
  setTimeout(() => chip.remove(), delay + FLIGHT_MS + 200);
}

function burst(from, to, amount, delay = 0) {
  if (!from || !to) return;
  for (let i = 0; i < CHIPS_PER_FLIGHT; i += 1) flyChip(from, to, chipClass(amount), delay + i * 55);
}

const NO_SOUND = { chip() {}, card() {}, win() {} };

function playNewHand(after, next, sfx) {
  let moved = false;
  for (const id of next.order) {
    if (next.seats[id].bet > 0) {
      burst(after.seats[id], after.bets[id], next.seats[id].bet);
      moved = true;
    }
  }
  if (moved) sfx.chip();
}

function playSameHand(before, after, prev, next, sfx) {
  const closed = next.street !== prev.street || (prev.phase === 'betting' && next.phase !== 'betting');
  let moved = false;
  for (const id of next.order) {
    const paid = next.seats[id].total - prev.seats[id].total;
    if (closed) {
      if (prev.seats[id].bet > 0) burst(before.bets[id], after.pot, prev.seats[id].bet);
      if (paid > 0) burst(after.seats[id], after.pot, paid);
      moved ||= prev.seats[id].bet > 0 || paid > 0;
    } else if (paid > 0) {
      burst(after.seats[id], after.bets[id] ?? after.pot, paid);
      moved = true;
    }
  }
  if (moved) sfx.chip();
  if (next.mode === 'holdem' && next.street > prev.street) sfx.card();

  let won = false;
  const delay = closed ? COLLECT_DELAY_MS : 0;
  next.pots.forEach((pot, i) => {
    if (!pot.payouts || prev.pots[i]?.payouts) return;
    for (const [id, amount] of Object.entries(pot.payouts)) burst(after.pot, after.seats[id], amount, delay);
    won = true;
  });
  if (won) setTimeout(sfx.win, delay);
}

// prev가 undefined면 첫 렌더링이나 되돌리기라서 연출하지 않는다.
// 휴대폰 여러 대가 같은 소리를 동시에 내지 않도록 플레이어 화면은 silent로 부른다.
export function play(root, before, prev, next, { silent = false } = {}) {
  if (prev === undefined || !next) return;
  const animate = !reduceMotion.matches && !document.hidden;
  const after = animate ? capture(root) : { seats: {}, bets: {}, pot: null };
  const sfx = silent ? NO_SOUND : sound;
  if (prev?.no !== next.no) playNewHand(after, next, sfx);
  else if (JSON.stringify(prev) !== JSON.stringify(next)) playSameHand(before, after, prev, next, sfx);
}
