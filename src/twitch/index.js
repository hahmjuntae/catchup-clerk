import { Auth } from './auth.js';
import { Helix, ChatSender } from './helix.js';
import { EventSub } from './eventsub.js';
export class Twitch {
  constructor({
    env,
    clerk,
    fetchImpl = fetch,
    WebSocketImpl = WebSocket,
    log = console.log
  }) {
    Object.assign(this, { env, clerk, WebSocketImpl, log });
    this.auth = new Auth({ env, fetchImpl, onLogin: () => this.connect() });
    this.helix = new Helix({
      auth: this.auth,
      clientId: env.TWITCH_CLIENT_ID,
      fetchImpl
    });
  }
  async start() {
    try {
      await this.auth.load();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.clerk.status = 'Connect Twitch to start';
      this.clerk.publish();
      this.log(
        `Live: open http://localhost:${Number(this.env.PORT) || 3101}/auth/login to authorize`
      );
      return;
    }
    await this.connect();
  }
  async connect() {
    this.stop();
    const channel = (this.env.TWITCH_CHANNEL || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(channel))
      throw new Error('Set a Twitch channel login');
    const users = await this.helix.request(
        `users?login=${encodeURIComponent(channel)}`
      ),
      broadcaster = users.data?.[0];
    if (!broadcaster) throw new Error('Channel not found');
    const user = this.auth.identity;
    this.clerk.ownUserId = user.user_id;
    this.clerk.ownLogin = user.login;
    this.clerk.channel = broadcaster.display_name;
    this.clerk.allowSelfCommands = this.env.ALLOW_SELF_COMMANDS === '1';
    this.clerk.reset();
    this.sender = new ChatSender({
      helix: this.helix,
      broadcasterId: broadcaster.id,
      senderId: user.user_id,
      onSent: (id) => this.clerk.rememberReply(id)
    });
    const sender = this.sender;
    this.clerk.sendChat = (reply) => sender.send(reply);
    this.events = new EventSub({
      helix: this.helix,
      broadcasterId: broadcaster.id,
      channelLogin: broadcaster.login || channel,
      userId: user.user_id,
      WebSocketImpl: this.WebSocketImpl,
      log: this.log,
      onItem: async (item) => {
        // Helix's response and the chat echo can arrive in either order. Wait for
        // pending sends to register their IDs before admitting own-account input.
        if (item.kind === 'chat' && this.clerk.commands.isOwnMessage(item))
          await sender.queue.catch(() => {});
        if (sender.stopped) return;
        return this.clerk.ingest(item);
      },
      onStatus: (status) => {
        this.clerk.status = status;
        this.clerk.publish();
      }
    });
    this.events.start();
    this.validation = setInterval(
      () =>
        this.auth.validate().catch(() => {
          this.stop();
          this.clerk.status =
            'Twitch authorization expired. Reconnect at /auth/login';
          this.clerk.publish();
        }),
      60 * 60_000
    );
  }
  stop() {
    this.events?.stop();
    this.sender?.stop();
    clearInterval(this.validation);
  }
}
