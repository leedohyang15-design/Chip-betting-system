import { createGame, defaultConfig } from './engine.js';
import { newRoomCode, normalizeRoom } from './net.js';
import { load, roomKey, store, toast } from './ui.js';

const LAST_ROOM = 'cbs:lastRoom';

const joinForm = document.getElementById('join-form');
const codeInput = document.getElementById('join-code');
const createForm = document.getElementById('create-form');
const resume = document.getElementById('resume');

codeInput.addEventListener('input', () => {
  codeInput.value = normalizeRoom(codeInput.value);
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const room = normalizeRoom(codeInput.value);
  if (room.length !== 4) {
    toast('방 코드 4자리를 입력해 주세요');
    return;
  }
  location.href = `play.html?room=${room}`;
});

function syncMode() {
  const mode = createForm.elements.mode.value;
  createForm.dataset.mode = mode;
  const preset = defaultConfig(mode);
  createForm.elements.ante.value = preset.ante;
}
for (const radio of createForm.elements.mode) radio.addEventListener('change', syncMode);
syncMode();

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const f = createForm.elements;
  const mode = f.mode.value;
  const number = (el) => Math.max(0, Math.floor(Number(el.value) || 0));
  const config = {
    mode,
    stack: number(f.stack),
    ante: number(f.ante),
    sb: number(f.sb),
    bb: number(f.bb),
    rounds: Number(f.rounds.value),
  };
  if (config.stack < 1) {
    toast('시작 칩을 입력해 주세요');
    return;
  }
  if (mode === 'holdem' && config.bb < 1) {
    toast('빅 블라인드를 입력해 주세요');
    return;
  }
  if (mode === 'seotda' && config.ante < 1) {
    toast('앤티를 입력해 주세요');
    return;
  }

  const previous = load(LAST_ROOM);
  const previousGame = previous && JSON.parse(load(roomKey(previous)) ?? 'null')?.game;
  if (previousGame?.players.length > 0 && !confirm(`열어 둔 테이블 ${previous}의 칩 기록이 삭제됩니다. 새로 열까요?`)) {
    return;
  }
  if (previous) {
    try {
      localStorage.removeItem(roomKey(previous));
    } catch {
      // 저장소를 쓸 수 없으면 지울 것도 없다.
    }
  }
  const room = newRoomCode();
  store(roomKey(room), JSON.stringify({ game: createGame(config), tokens: {}, history: [] }));
  store(LAST_ROOM, room);
  location.href = `table.html?room=${room}`;
});

const last = load(LAST_ROOM);
if (last && load(roomKey(last))) {
  resume.hidden = false;
  resume.href = `table.html?room=${last}`;
  resume.textContent = `열어 둔 테이블 ${last} 이어서 하기`;
}
