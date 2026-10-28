import { subscriptions, normalizeNotification } from './events.js';
const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';
export class EventSub {
  constructor({
    helix,
    broadcasterId,
    channelLogin = broadcasterId,
    userId,
    WebSocketImpl = WebSocket,
    onItem = () => {},
    onStatus = () => {},
    log = console.log,
    retryMs = 1000
  }) {
    Object.assign(this, {
      helix,
      broadcasterId,
      channelLogin,
      userId,
      WebSocketImpl,
      onItem,
      onStatus,
      log,
      retryMs
    });
    this.sockets = new Set();
    this.seen = new Map();
    this.stopped = false;
    this.attempt = 0;
  }
  start() {
    this.stopped = false;
    return this.connect(ENDPOINT, false);
  }
  connect(url, migrating) {
    if (this.stopped) return;
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'wss:' ||
      parsed.hostname !== 'eventsub.wss.twitch.tv'
    )
      throw new Error('Invalid reconnect host');
    const socket = new this.WebSocketImpl(url);
    this.sockets.add(socket);
    socket.migrating = migrating;
    socket.addEventListener('message', (event) => {
      this.handle(event.data, socket).catch(() =>
        this.log('EventSub message could not be processed')
      );
    });
    socket.addEventListener('error', () =>
      this.onStatus('EventSub connection interrupted')
    );
    socket.addEventListener('close', () => {
      clearTimeout(socket.watchdog);
      this.sockets.delete(socket);
      if (
        !socket.retired &&
        !this.stopped &&
        (!this.current || socket === this.current || socket === this.pending)
      ) {
        this.current = null;
        this.pending = null;
        this.schedule();
      }
    });
    // Covers a connection that never receives a welcome.
    socket.watchdog = setTimeout(() => {
      socket.close();
    }, 12000);
    return socket;
  }
  watch(socket, seconds) {
    clearTimeout(socket.watchdog);
    socket.timeout = seconds || socket.timeout || 10;
    socket.watchdog = setTimeout(
      () => {
        this.onStatus('EventSub heartbeat lost; reconnecting');
        socket.close();
      },
      (socket.timeout + 1) * 1000
    );
  }
  schedule() {
    if (this.retryTimer || this.stopped) return;
    for (const socket of this.sockets) {
      socket.retired = true;
      clearTimeout(socket.watchdog);
      socket.close();
    }
    this.sockets.clear();
    this.onStatus('Reconnecting to Twitch');
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        if (!this.stopped) this.connect(ENDPOINT, false);
      },
      Math.min(30000, this.retryMs * 2 ** Math.min(this.attempt++, 5))
    );
  }
  async handle(raw, socket = this.current) {
    if (this.stopped || socket?.retired) return;
    let message;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    const kind = message.metadata?.message_type;
    if (kind === 'session_welcome') {
      const old = this.current;
      this.current = socket;
      this.pending = null;
      this.attempt = 0;
      this.watch(socket, message.payload.session.keepalive_timeout_seconds);
      this.onStatus('Connected to Twitch');
      if (socket.migrating) {
        if (old && old !== socket) {
          old.retired = true;
          clearTimeout(old.watchdog);
          old.close();
        }
        return;
      }
      const results = await Promise.all(
        subscriptions(this.broadcasterId, this.userId).map(
          async (subscription) => {
            let result;
            try {
              await this.helix.request('eventsub/subscriptions', {
                method: 'POST',
                body: {
                  ...subscription,
                  transport: {
                    method: 'websocket',
                    session_id: message.payload.session.id
                  }
                }
              });
              result = 'subscribed';
            } catch (error) {
              result = `failed (${error.status || 'network'}${[401, 403].includes(error.status) ? '; check account permissions and scopes' : ''})`;
            }
            this.log(`EventSub ${subscription.type}: ${result}`);
            return `${subscription.type} v${subscription.version}: ${result}`;
          }
        )
      );
      this.log(
        `Live: channel ${this.channelLogin}; EventSub results: ${results.join(' | ')}`
      );
      return;
    }
    if (kind === 'session_keepalive' || kind === 'notification')
      this.watch(socket);
    if (kind === 'session_reconnect') {
      if (this.pending) return;
      this.onStatus('Moving Twitch connection');
      this.pending = this.connect(message.payload.session.reconnect_url, true);
      return;
    }
    if (kind === 'revocation') {
      const sub = message.payload.subscription;
      this.log(`EventSub ${sub.type}: revoked (${sub.status})`);
      this.onStatus(`Subscription revoked: ${sub.type}`);
      return;
    }
    if (kind !== 'notification') return;
    const id = message.metadata.message_id;
    if (id && this.seen.has(id)) return;
    if (id) this.seen.set(id, Date.now());
    for (const [key, time] of this.seen)
      if (time < Date.now() - 600_000) this.seen.delete(key);
    while (this.seen.size > 2000)
      this.seen.delete(this.seen.keys().next().value);
    const item = normalizeNotification(message, this.broadcasterId);
    if (item) await this.onItem(item);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const socket of this.sockets) {
      socket.retired = true;
      clearTimeout(socket.watchdog);
      socket.close();
    }
    this.sockets.clear();
    this.current = null;
    this.pending = null;
  }
}
