import { Timeline } from './timeline.js';
import { Commands, parseCommand } from './commands.js';
import { summarize, mockSummarize } from './summarizer.js';

export class Clerk {
  constructor({ mode = 'demo', channel = 'LanternLark', windowMs, maxItems, ownUserId, ownLogin, now = () => Date.now(), summarizeFn = summarize, sendChat = async () => {}, emit = () => {} } = {}) {
    Object.assign(this, { mode, channel, now, summarizeFn, sendChat, emit, ownUserId, ownLogin });
    this.timeline = new Timeline({ windowMs, maxItems });
    this.generation = 0; this.queue = Promise.resolve(); this.reset();
  }
  reset() {
    this.generation++;
    this.timeline.clear(); this.commands = new Commands({ ownUserId: this.ownUserId, ownLogin: this.ownLogin });
    this.updatedAt = null; this.summary = mockSummarize([]); this.backend = 'mock'; this.joiners = []; this.replies = [];
    this.status = this.mode === 'demo' ? 'Demo replay' : 'Connecting to Twitch'; this.refreshing = false;
  }
  ingest(item, { commands = true } = {}) {
    const privilegedRecap = parseCommand(item.text) === 'recap' && (item.meta?.isMod || item.meta?.isBroadcaster);
    if (!privilegedRecap && ((this.ownUserId && item.meta?.userId === this.ownUserId) || (this.ownLogin && item.user?.toLowerCase() === this.ownLogin.toLowerCase()))) return;
    if (!this.timeline.add(item, this.now()) || !commands || item.kind !== 'chat') return;
    const command = this.commands.check(item, this.now());
    if (command.command === 'catchup') {
      const joiner = { user: item.user, ts: this.now(), status: command.allowed ? 'Preparing recap' : `Wait ${command.retryAfter}s` };
      this.joiners.unshift(joiner); this.joiners = this.joiners.slice(0,12);
      this.publish();
      if (command.allowed) return this.refresh(item.user, item, joiner);
      return command;
    }
    if (command.allowed && command.command === 'recap') return this.refresh();
  }
  refresh(viewer, parent, joiner) {
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation) return;
      this.refreshing = true; this.publish();
      try {
        const items = this.timeline.snapshot(this.now());
        let backend = 'mock';
        const result = await this.summarizeFn(items, { viewer: viewer || 'newcomer', now: this.now(), onBackend: name => { backend = name; } });
        if (generation !== this.generation) return;
        this.summary = result; this.backend = backend; this.updatedAt = this.now();
        if (viewer) {
          const reply = { ts: this.now(), user: viewer, text: result.chatReply, parentId: parent?.meta?.messageId, status: this.mode === 'demo' ? 'would post in chat' : 'sending' };
          this.replies.unshift(reply); this.replies = this.replies.slice(0,12);
          try {
            await this.sendChat(reply);
            if (generation !== this.generation) return;
            if (this.mode !== 'demo') reply.status = 'posted in chat';
            joiner.status = 'Caught up';
          } catch (error) { reply.status = error.code === 'SHARED_CHAT' ? 'Chat paused during Shared Chat' : 'Chat delivery failed'; joiner.status = 'Recap ready; chat not sent'; }
          if (generation !== this.generation) return;
          this.emit('catchup', { viewer, summary: result, ts: this.now(), id: `${generation}-${this.now()}-${viewer}`, durationMs: 12000 });
        }
      } finally { if (generation === this.generation) { this.refreshing = false; this.publish(); } }
    };
    this.queue = this.queue.catch(()=>{}).then(run);
    return this.queue;
  }
  state() {
    const now = this.now(), items = this.timeline.snapshot(now), cutoff = now - this.timeline.windowMs;
    this.joiners = this.joiners.filter(x=>x.ts>=cutoff); this.replies = this.replies.filter(x=>x.ts>=cutoff);
    // Expire derived summaries too when the stream is silent.
    if (this.updatedAt && this.updatedAt < cutoff) { this.summary = mockSummarize(items); this.updatedAt = null; }
    return { generation: this.generation, mode: this.mode, channel: this.channel, now, windowMs: this.timeline.windowMs, status: this.status, backend: this.backend, refreshing: this.refreshing, updatedAt: this.updatedAt, summary: this.summary, joiners: this.joiners, replies: this.replies, events: items.filter(x=>x.kind==='event'), chat: items.filter(x=>x.kind==='chat').slice(-45), stats: { messages: items.filter(x=>x.kind==='chat').length, viewers: new Set(items.filter(x=>x.kind==='chat').map(x=>x.user)).size, events: items.filter(x=>x.kind==='event').length }, replay: this.replay || null };
  }
  publish() { this.emit('state', this.state()); }
}
