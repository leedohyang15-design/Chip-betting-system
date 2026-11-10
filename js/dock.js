// 베팅 버튼과 레이즈 시트. 플레이어 화면과 관리자 겸 플레이어 화면이 함께 쓴다.

import { esc, fmt } from './ui.js';

const CONFIRM_MS = 2500;
const TOKEN_ONE = '<i class="token c5"></i>';
const TOKEN_TWO = '<i class="token c100"></i><i class="token c5 overlap"></i>';

export function createDock({ sheet, getLegal, send, rerender }) {
  let armed = null;
  let armTimer = null;
  let value = 0;

  function close() {
    sheet.hidden = true;
    sheet.innerHTML = '';
  }

  function submit(action) {
    close();
    send(action);
  }

  function arm(key) {
    armed = key;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armed = null;
      rerender();
    }, CONFIRM_MS);
    rerender();
  }

  function confirmThen(key, action) {
    if (armed !== key) {
      arm(key);
      return;
    }
    armed = null;
    clearTimeout(armTimer);
    submit(action);
  }

  const stepCount = (la) => Math.ceil((la.maxTo - la.minTo) / la.unit);
  const stepToAmount = (la, step) => Math.min(la.maxTo, la.minTo + step * la.unit);
  const amountToStep = (la, amount) => Math.round((amount - la.minTo) / la.unit);

  function paint(la) {
    sheet.querySelector('.sheet-amount').textContent = fmt(value);
    sheet.querySelector('.sheet-sub').textContent =
      value === la.maxTo ? '올인' : `내 칩에서 ${fmt(value - la.bet)} 나감`;
    sheet.querySelector('input').value = amountToStep(la, value);
    const verb = la.isOpening ? '벳' : '레이즈';
    sheet.querySelector('[data-cmd="sheet-ok"]').textContent =
      value === la.maxTo ? `${fmt(value)} 올인` : `${fmt(value)}까지 ${verb}`;
  }

  function open() {
    const la = getLegal();
    value = la.minTo;
    sheet.innerHTML = `<div class="sheet-card">
      <button class="sheet-close" data-cmd="sheet-close" aria-label="닫기">✕</button>
      <p class="sheet-label">이번 베팅 총액</p>
      <p class="sheet-amount"></p>
      <p class="sheet-sub"></p>
      <div class="sheet-slider">
        <button class="btn round" data-cmd="sheet-step" data-dir="-1" aria-label="줄이기">−</button>
        <input type="range" min="0" max="${stepCount(la)}" step="1" aria-label="베팅 금액">
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
      value = stepToAmount(la, Number(event.target.value));
      paint(la);
    });
    paint(la);
  }

  const commands = {
    fold() {
      if (getLegal().canCheck) confirmThen('fold', { type: 'fold' });
      else submit({ type: 'fold' });
    },
    check: () => submit({ type: 'check' }),
    call: () => submit({ type: 'call' }),
    allin: () => confirmThen('allin', { type: 'allin' }),
    preset: ({ key }) => submit({ type: 'preset', key }),
    'open-sheet': open,
    'sheet-close': close,
    'sheet-step': ({ dir }) => {
      const la = getLegal();
      const step = Math.max(0, Math.min(stepCount(la), amountToStep(la, value) + Number(dir)));
      value = stepToAmount(la, step);
      paint(la);
    },
    'sheet-set': ({ to }) => {
      value = Number(to);
      paint(getLegal());
    },
    'sheet-ok': () => {
      const la = getLegal();
      submit(value === la.maxTo ? { type: 'allin' } : { type: 'raise', to: value });
    },
  };

  function buttons(la, mode, disabled) {
    const busy = disabled ? 'disabled' : '';
    const isHoldem = mode === 'holdem';
    const foldLabel = armed === 'fold' ? '체크 가능! 한 번 더' : isHoldem ? '폴드' : '다이';
    const main = la.canCheck
      ? `<button class="btn go action" data-cmd="check" ${busy}><span class="lbl"><i class="ico-check">✓</i>체크</span></button>`
      : `<button class="btn go action" data-cmd="call" ${busy}><span class="lbl">${TOKEN_ONE}콜</span><small>${fmt(la.call)}${la.callIsAllIn ? ' 올인' : ''}</small></button>`;
    const fold = `<button class="btn danger action ${armed === 'fold' ? 'armed' : ''}" data-cmd="fold" ${busy}><span class="lbl"><i class="ico-card"></i>${foldLabel}</span></button>`;

    if (isHoldem) {
      const raise = la.canRaise
        ? `<button class="btn raise action" data-cmd="open-sheet" ${busy}><span class="lbl">${TOKEN_TWO}${la.isOpening ? '벳' : '레이즈'}</span><small>${fmt(la.minTo)}부터</small></button>`
        : '';
      return `<div class="dock-row">${fold}${main}${raise}</div>`;
    }
    const presets = la.presets
      .map(
        (p) => `<button class="btn raise" data-cmd="preset" data-key="${p.key}" ${busy}><span class="lbl">${TOKEN_ONE}${esc(p.label)}</span><small>${fmt(p.pay)}</small></button>`,
      )
      .join('');
    const allin = la.canRaise
      ? `<button class="btn gold ${armed === 'allin' ? 'armed' : ''}" data-cmd="allin" ${busy}>
          <span class="lbl">${TOKEN_TWO}${armed === 'allin' ? '한 번 더!' : '올인'}</span><small>${fmt(la.chips)}</small></button>`
      : '';
    return `<div class="dock-grid">${presets}${allin}</div><div class="dock-row">${fold}${main}</div>`;
  }

  return { buttons, commands, close };
}
