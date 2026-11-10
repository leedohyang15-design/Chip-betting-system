// 화면 공용 도우미.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
export const fmt = (n) => Number(n).toLocaleString('ko-KR');
export const signed = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;

export const roomKey = (room) => `cbs:room:${room}`;

export function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 시크릿 모드 등 저장소가 막혀도 진행 중인 화면은 계속 동작한다.
  }
}

export function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const DENOMINATIONS = [5000, 1000, 500, 100, 50, 10, 5, 1];
const MAX_COLUMNS = 3;
const MAX_IN_COLUMN = 7;

export const chipClass = (amount) => `c${DENOMINATIONS.find((value) => value <= amount) ?? 1}`;

export function chipStack(amount) {
  const columns = [];
  let rest = amount;
  for (const value of DENOMINATIONS) {
    const count = Math.floor(rest / value);
    if (count === 0) continue;
    rest -= count * value;
    columns.push({ value, count: Math.min(count, MAX_IN_COLUMN) });
    if (columns.length === MAX_COLUMNS) break;
  }
  return `<span class="stack">${columns
    .map(
      ({ value, count }) =>
        `<span class="col">${`<i class="chip c${value}"></i>`.repeat(count)}</span>`,
    )
    .join('')}</span>`;
}

const PILE_MAX_CHIPS = 18;

// 내 칩과 팟처럼 크게 보여 줄 더미. 금액을 정확히 나누기보다 많고 적음이 눈에 보이게 만든다.
export function chipPile(amount) {
  if (amount <= 0) return '';
  const start = Math.max(0, DENOMINATIONS.findIndex((value) => amount / value >= 8));
  const count = Math.min(PILE_MAX_CHIPS, Math.max(3, Math.ceil(amount / DENOMINATIONS[start])));
  const heights = [Math.ceil(count * 0.5), Math.ceil(count * 0.3)];
  heights.push(Math.max(0, count - heights[0] - heights[1]));
  return `<span class="stack">${heights
    .map((height, i) => {
      const value = DENOMINATIONS[Math.min(start + i, DENOMINATIONS.length - 1)];
      return `<span class="col">${`<i class="chip c${value}"></i>`.repeat(height)}</span>`;
    })
    .join('')}</span>`;
}

const toRad = (deg) => (deg * Math.PI) / 180;

export const place = (angle, rx, ry) =>
  `left:${(50 + rx * Math.cos(toRad(angle))).toFixed(2)}%;top:${(50 + ry * Math.sin(toRad(angle))).toFixed(2)}%`;

let toastTimer;
export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function keepAwake() {
  let lock = null;
  const request = async () => {
    if (document.hidden || lock || !navigator.wakeLock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        lock = null;
      });
    } catch {
      lock = null;
    }
  };
  request();
  document.addEventListener('visibilitychange', request);
  document.addEventListener('pointerdown', request);
}
