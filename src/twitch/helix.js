import { setTimeout as delay } from 'node:timers/promises';
import { trimReply } from '../core/text.js';
export class Helix {
  constructor({ auth, clientId, fetchImpl = fetch }) {
    Object.assign(this, { auth, clientId, fetchImpl });
  }
  async request(
    path,
    { method = 'GET', body, beforeAttempt } = {},
    retry = true
  ) {
    const token = await this.auth.token();
    await beforeAttempt?.();
    const response = await this.fetchImpl(
      `https://api.twitch.tv/helix/${path}`,
      {
        method,
        signal: AbortSignal.timeout(8000),
        headers: {
          'Client-Id': this.clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      }
    );
    if (response.status === 401 && retry) {
      await this.auth.refresh(token);
      return this.request(path, { method, body, beforeAttempt }, false);
    }
    if (!response.ok) {
      const error = new Error(`Helix HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? {} : response.json();
  }
}
export class ChatSender {
  constructor({
    helix,
    broadcasterId,
    senderId,
    now = Date.now,
    sleep = delay,
    onSent = () => {}
  }) {
    Object.assign(this, { helix, broadcasterId, senderId, now, sleep, onSent });
    this.queue = Promise.resolve();
    this.last = -Infinity;
    this.stopped = false;
  }
  send({ text, parentId, broadcasterId = this.broadcasterId }) {
    if (broadcasterId !== this.broadcasterId)
      return Promise.reject(new Error('Channel not allowed'));
    if (!parentId) return Promise.reject(new Error('Reply parent required'));
    const task = async () => {
      if (this.stopped) throw new Error('Chat sender stopped');
      const beforeAttempt = async () => {
        await this.sleep(Math.max(0, 2000 - (this.now() - this.last)));
        // User tokens cannot opt out of Shared Chat fan-out. Fail closed.
        const shared = await this.helix.request(
          `shared_chat/session?broadcaster_id=${encodeURIComponent(this.broadcasterId)}`
        );
        if (!Array.isArray(shared.data) || shared.data.length)
          throw Object.assign(new Error('Chat paused during Shared Chat'), {
            code: 'SHARED_CHAT'
          });
        if (this.stopped) throw new Error('Chat sender stopped');
        this.last = this.now();
      };
      const data = await this.helix.request('chat/messages', {
        method: 'POST',
        beforeAttempt,
        body: {
          broadcaster_id: this.broadcasterId,
          sender_id: this.senderId,
          message: trimReply(text, 450),
          reply_parent_message_id: parentId
        }
      });
      if (!data.data?.[0]?.is_sent)
        throw new Error('Twitch did not deliver chat message');
      this.onSent(data.data[0].message_id);
      return data;
    };
    this.queue = this.queue.catch(() => {}).then(task);
    return this.queue;
  }
  stop() {
    this.stopped = true;
  }
}
