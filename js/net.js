// 연결 계층. 공개 MQTT 중계 서버를 웹소켓으로 거쳐 관리자 브라우저와 휴대폰을 잇는다.
// WebRTC 직결은 통신사 NAT 뒤의 휴대폰에서 실패하므로 쓰지 않는다.

const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://public.cloud.shiftr.io:443', username: 'public', password: 'public' },
  { url: 'wss://demo.tbmq.io:443/mqtt', username: 'demo' },
];
const NAMESPACE = 'chip-betting-v2';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PING_MS = 4000;
const WATCH_MS = 1500;
const HOST_TIMEOUT_MS = 12000;
const CLIENT_TIMEOUT_MS = 10000;
const HELLO_MS = 2000;
const ROTATE_MS = 8000;
const RECONNECT_MS = 2000;
const CONNECT_TIMEOUT_MS = 6000;

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export const normalizeRoom = (text) => (text ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

/* 중계 서버는 공개되어 있으므로 토픽과 내용을 방 코드에서 만든 값으로 가린다. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function openRoom(room) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${NAMESPACE}:topic:${room}`));
  const base = [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const material = await crypto.subtle.importKey('raw', encoder.encode(room), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(NAMESPACE), iterations: 100000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return {
    hostTopic: `${NAMESPACE}/${base}/h`,
    clientTopic: (cid) => `${NAMESPACE}/${base}/c/${cid}`,
    async seal(frame) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(frame)));
      const out = new Uint8Array(iv.length + body.byteLength);
      out.set(iv);
      out.set(new Uint8Array(body), iv.length);
      return toBase64(out);
    },
    async unseal(text) {
      const bytes = fromBase64(text);
      const body = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
      return JSON.parse(decoder.decode(body));
    },
  };
}

// 암호화는 비동기라서 도착 순서가 뒤집히지 않게 한 줄로 처리한다.
function serialQueue() {
  let tail = Promise.resolve();
  return (job) => {
    tail = tail.then(job).catch(() => {});
  };
}

class Relay {
  constructor(broker, secrets, topic, { onFrame, onState }) {
    this.topic = topic;
    this.secrets = secrets;
    this.onState = onState;
    this.isUp = false;
    this.enqueueIn = serialQueue();
    const { url, ...login } = broker;
    this.client = mqtt.connect(url, {
      ...login,
      protocolVersion: 4,
      keepalive: 20,
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectPeriod: RECONNECT_MS,
      resubscribe: false,
    });
    this.client.on('connect', () => {
      this.client.subscribe(topic, { qos: 0 }, (err) => {
        if (!err) this.setUp(true);
      });
    });
    this.client.on('close', () => this.setUp(false));
    this.client.on('error', () => {});
    this.client.on('message', (_topic, payload) => {
      this.enqueueIn(async () => onFrame(await secrets.unseal(payload.toString()), this));
    });
  }

  setUp(next) {
    if (this.isUp === next) return;
    this.isUp = next;
    this.onState();
  }

  publish(topic, text) {
    if (this.isUp) this.client.publish(topic, text, { qos: 0 });
  }

  stop() {
    this.isUp = false;
    this.client.end(true);
  }
}

class VirtualConn {
  constructor(link, cid, relay) {
    this.link = link;
    this.cid = cid;
    this.relay = relay;
    this.open = true;
    this.lastSeen = Date.now();
    this.playerId = null;
    this.token = null;
  }

  close() {
    if (!this.open) return;
    this.link.sendFrame(this, { k: 'bye' });
    this.link.drop(this);
  }
}

export class HostLink {
  constructor(room, { onStatus, onMessage, onClose }) {
    this.room = room;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.conns = new Map();
    this.relays = [];
    this.enqueueOut = serialQueue();
  }

  async start() {
    this.onStatus('connecting');
    this.secrets = await openRoom(this.room);
    this.lastTick = Date.now();
    this.relays = BROKERS.map(
      (broker) =>
        new Relay(broker, this.secrets, this.secrets.hostTopic, {
          onFrame: (frame, relay) => this.handleFrame(frame, relay),
          onState: () => this.onStatus(this.relays.some((r) => r.isUp) ? 'online' : 'connecting'),
        }),
    );
    setInterval(() => this.tick(), PING_MS);
  }

  handleFrame(frame, relay) {
    if (typeof frame?.c !== 'string') return;
    let conn = this.conns.get(frame.c);
    if (frame.k === 'hi') {
      if (!conn) {
        conn = new VirtualConn(this, frame.c, relay);
        this.conns.set(frame.c, conn);
      }
      conn.relay = relay;
      conn.lastSeen = Date.now();
      this.sendFrame(conn, { k: 'ok' });
    } else if (!conn) {
      // 관리자 화면을 새로 연 경우라 접속을 처음부터 다시 맺게 한다.
      this.sendFrame({ cid: frame.c, relay, open: true }, { k: 'reset' });
    } else if (frame.k === 'bye') {
      this.drop(conn);
    } else if (frame.k === 'msg') {
      conn.lastSeen = Date.now();
      conn.relay = relay;
      if (frame.m && typeof frame.m === 'object' && frame.m.t !== 'pong') this.onMessage(conn, frame.m);
    }
  }

  sendFrame(conn, frame) {
    const { relay, cid } = conn;
    this.enqueueOut(async () => relay.publish(this.secrets.clientTopic(cid), await this.secrets.seal(frame)));
  }

  send(conn, msg) {
    if (conn.open) this.sendFrame(conn, { k: 'msg', m: msg });
  }

  drop(conn) {
    if (!conn.open) return;
    conn.open = false;
    this.conns.delete(conn.cid);
    this.onClose(conn);
  }

  tick() {
    const now = Date.now();
    const conns = [...this.conns.values()];
    // 화면이 꺼졌다 돌아오면 그동안 못 받은 응답을 끊김으로 치지 않는다.
    if (now - this.lastTick > HOST_TIMEOUT_MS) {
      for (const conn of conns) conn.lastSeen = now;
    }
    this.lastTick = now;
    for (const conn of conns) {
      if (now - conn.lastSeen > HOST_TIMEOUT_MS) conn.close();
      else this.send(conn, { t: 'ping' });
    }
  }
}

export class ClientLink {
  constructor(room, { onStatus, onOpen, onMessage }) {
    this.room = room;
    this.onStatus = onStatus;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.cid = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    this.brokerIndex = 0;
    this.linked = false;
    this.relay = null;
    this.attemptAt = 0;
    this.helloAt = 0;
    this.lastData = 0;
    this.enqueueOut = serialQueue();
  }

  async start() {
    this.onStatus('connecting');
    this.secrets = await openRoom(this.room);
    this.topic = this.secrets.clientTopic(this.cid);
    this.openRelay();
    setInterval(() => this.watch(), WATCH_MS);
    const wake = () => {
      if (!document.hidden) this.watch();
    };
    document.addEventListener('visibilitychange', wake);
    addEventListener('online', wake);
  }

  get connected() {
    return this.linked;
  }

  openRelay() {
    this.relay?.stop();
    this.linked = false;
    this.attemptAt = Date.now();
    this.helloAt = 0;
    this.onStatus('connecting');
    const relay = new Relay(BROKERS[this.brokerIndex], this.secrets, this.topic, {
      onFrame: (frame) => this.handleFrame(frame),
      onState: () => {
        if (relay !== this.relay) return;
        if (relay.isUp) {
          this.onStatus('searching');
          this.sayHello();
        } else {
          this.unlink('connecting');
        }
      },
    });
    this.relay = relay;
  }

  sendFrame(frame) {
    const { relay } = this;
    this.enqueueOut(async () => relay.publish(this.secrets.hostTopic, await this.secrets.seal({ ...frame, c: this.cid })));
  }

  send(msg) {
    if (this.linked) this.sendFrame({ k: 'msg', m: msg });
  }

  sayHello() {
    this.helloAt = Date.now();
    this.sendFrame({ k: 'hi' });
  }

  unlink(status) {
    this.linked = false;
    this.attemptAt = Date.now();
    this.onStatus(status);
  }

  handleFrame(frame) {
    this.lastData = Date.now();
    if (frame.k === 'ok') {
      if (this.linked) return;
      this.linked = true;
      this.onStatus('online');
      this.onOpen();
    } else if (frame.k === 'reset' || frame.k === 'bye') {
      this.unlink('searching');
      this.sayHello();
    } else if (frame.k === 'msg') {
      if (frame.m.t === 'ping') this.send({ t: 'pong' });
      else this.onMessage(frame.m);
    }
  }

  watch() {
    if (!this.relay) return;
    const now = Date.now();
    if (this.linked) {
      if (now - this.lastData > CLIENT_TIMEOUT_MS) {
        this.unlink('searching');
      } else if (now - this.helloAt >= PING_MS) {
        // 새로 열린 관리자 화면이 이 신호에 reset으로 답해 재접속이 빨라진다.
        this.helloAt = now;
        this.send({ t: 'pong' });
      }
      return;
    }
    if (now - this.attemptAt > ROTATE_MS) {
      this.brokerIndex = (this.brokerIndex + 1) % BROKERS.length;
      this.openRelay();
    } else if (this.relay.isUp && now - this.helloAt >= HELLO_MS) {
      this.sayHello();
    }
  }
}
