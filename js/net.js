// PeerJS 연결 계층. 관리자 브라우저가 서버 역할을 하고 휴대폰이 거기에 붙는다.

const PEER_PREFIX = 'chip-betting-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PING_MS = 4000;
const HOST_TIMEOUT_MS = 12000;
const CLIENT_TIMEOUT_MS = 10000;
const DIAL_TIMEOUT_MS = 8000;
const RETRY_MS = 2500;
const MAX_CLAIM_TRIES = 30;

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export const normalizeRoom = (text) => (text ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

export class HostLink {
  constructor(room, { onStatus, onMessage, onClose }) {
    this.peerId = PEER_PREFIX + room;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.conns = new Set();
    this.tries = 0;
  }

  start() {
    this.lastTick = Date.now();
    this.claim();
    setInterval(() => this.tick(), PING_MS);
    const heal = () => {
      if (!document.hidden) this.heal();
    };
    document.addEventListener('visibilitychange', heal);
    addEventListener('online', heal);
  }

  heal() {
    if (this.gaveUp || this.claimTimer) return;
    if (this.peer.destroyed) {
      this.claim();
    } else if (this.peer.disconnected) {
      this.onStatus('connecting');
      this.peer.reconnect();
    }
  }

  claim() {
    clearTimeout(this.claimTimer);
    this.claimTimer = null;
    this.onStatus('connecting');
    const peer = new Peer(this.peerId, { debug: 1 });
    this.peer = peer;
    peer.on('open', () => {
      this.tries = 0;
      this.onStatus('online');
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => this.onStatus('connecting'));
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // 새로고침 직후에는 이전 연결이 잠시 ID를 쥐고 있다.
        this.tries += 1;
        peer.destroy();
        if (this.tries >= MAX_CLAIM_TRIES) {
          this.gaveUp = true;
          this.onStatus('taken');
        } else {
          this.claimTimer = setTimeout(() => this.claim(), RETRY_MS);
        }
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        this.onStatus('connecting');
      }
    });
  }

  accept(conn) {
    conn.lastSeen = Date.now();
    conn.on('open', () => this.conns.add(conn));
    conn.on('data', (msg) => {
      conn.lastSeen = Date.now();
      if (msg && typeof msg === 'object' && msg.t !== 'pong') this.onMessage(conn, msg);
    });
    conn.on('close', () => this.drop(conn));
    conn.on('error', () => this.drop(conn));
  }

  drop(conn) {
    if (!this.conns.delete(conn)) return;
    this.onClose(conn);
  }

  send(conn, msg) {
    if (conn.open) conn.send(msg);
  }

  tick() {
    const now = Date.now();
    // 화면이 꺼졌다 돌아오면 그동안 못 받은 응답을 끊김으로 치지 않는다.
    if (now - this.lastTick > HOST_TIMEOUT_MS) {
      for (const conn of this.conns) conn.lastSeen = now;
    }
    this.lastTick = now;
    this.heal();
    for (const conn of [...this.conns]) {
      if (now - conn.lastSeen > HOST_TIMEOUT_MS) {
        this.drop(conn);
        conn.close();
      } else {
        this.send(conn, { t: 'ping' });
      }
    }
  }
}

export class ClientLink {
  constructor(room, { onStatus, onOpen, onMessage }) {
    this.hostId = PEER_PREFIX + room;
    this.onStatus = onStatus;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.conn = null;
    this.dialedAt = 0;
    this.lastData = 0;
  }

  start() {
    this.openPeer();
    setInterval(() => this.watch(), 2000);
    const wake = () => {
      if (!document.hidden) this.watch();
    };
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
  }

  get connected() {
    return Boolean(this.conn?.open);
  }

  send(msg) {
    if (this.connected) this.conn.send(msg);
  }

  openPeer() {
    this.onStatus('connecting');
    const peer = new Peer({ debug: 1 });
    this.peer = peer;
    peer.on('open', () => this.dial());
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        this.onStatus('searching');
        this.hangUp();
        setTimeout(() => this.conn === null && this.dial(), RETRY_MS);
      }
    });
  }

  hangUp() {
    const conn = this.conn;
    this.conn = null;
    if (conn) conn.close();
  }

  dial() {
    if (!this.peer.open) return;
    this.hangUp();
    this.dialedAt = Date.now();
    const conn = this.peer.connect(this.hostId, { reliable: true, serialization: 'json' });
    this.conn = conn;
    conn.on('open', () => {
      if (this.conn !== conn) return;
      this.lastData = Date.now();
      this.onStatus('online');
      this.onOpen();
    });
    conn.on('data', (msg) => {
      if (this.conn !== conn) return;
      this.lastData = Date.now();
      if (msg.t === 'ping') conn.send({ t: 'pong' });
      else this.onMessage(msg);
    });
    const lost = () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.onStatus('connecting');
    };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  watch() {
    const now = Date.now();
    if (!this.peer || this.peer.destroyed) {
      this.openPeer();
      return;
    }
    if (this.peer.disconnected) this.peer.reconnect();
    if (this.connected) {
      if (now - this.lastData > CLIENT_TIMEOUT_MS) {
        this.onStatus('connecting');
        this.dial();
      }
      return;
    }
    if (this.peer.open && now - this.dialedAt > (this.conn ? DIAL_TIMEOUT_MS : RETRY_MS)) this.dial();
  }
}
