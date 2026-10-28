import { Timeline } from './timeline.js';
import { Commands } from './commands.js';
import {
  summarize,
  mockSummarize,
  personalizeSummary,
  validateSummary
} from './summarizer.js';

export class Clerk {
  constructor({
    mode = 'demo',
    channel = 'LanternLark',
    windowMs,
    maxItems,
    ownUserId,
    ownLogin,
    allowSelfCommands = false,
    now = () => Date.now(),
    wallNow = () => Date.now(),
    summarizeFn = summarize,
    sendChat = async () => {},
    emit = () => {}
  } = {}) {
    Object.assign(this, {
      mode,
      channel,
      now,
      wallNow,
      summarizeFn,
      sendChat,
      emit,
      ownUserId,
      ownLogin,
      allowSelfCommands
    });
    this.timeline = new Timeline({ windowMs, maxItems });
    this.sentMessageIds = new Map();
    this.generation = 0;
    this.queue = Promise.resolve();
    this.reset();
  }
  reset() {
    this.generation++;
    this.queue = Promise.resolve();
    this.pendingSummary = null;
    this.summaryWallAt = null;
    this.streamInfo = {};
    this.timeline.clear();
    this.commands = new Commands({
      ownUserId: this.ownUserId,
      ownLogin: this.ownLogin,
      allowSelfCommands: this.allowSelfCommands
    });
    this.updatedAt = null;
    this.summary = mockSummarize([]);
    this.backend = 'mock';
    this.joiners = [];
    this.replies = [];
    this.status = this.mode === 'demo' ? 'Demo replay' : 'Connecting to Twitch';
    this.refreshing = false;
  }
  rememberReply(messageId) {
    if (typeof messageId !== 'string' || !messageId) return;
    this.sentMessageIds.set(messageId, this.now());
    this.pruneReplyIds();
  }
  pruneReplyIds() {
    const cutoff = this.now() - this.timeline.windowMs - 60_000;
    for (const [id, ts] of this.sentMessageIds) {
      if (ts < cutoff) this.sentMessageIds.delete(id);
    }
    // Allow for the sender's two-second spacing plus late EventSub delivery.
    const capacity = Math.max(
      1024,
      Math.ceil(this.timeline.windowMs / 2000) + 30
    );
    while (this.sentMessageIds.size > capacity) {
      this.sentMessageIds.delete(this.sentMessageIds.keys().next().value);
    }
  }
  ingest(item, { commands = true } = {}) {
    this.pruneReplyIds();
    if (item.kind === 'chat' && this.sentMessageIds.has(item.meta?.messageId))
      return;
    // Human broadcaster chat is part of the stream, including when sender = owner.
    if (!this.timeline.add(item, this.now())) return;
    if (item.eventType === 'channel.update') {
      this.streamInfo = {
        category: item.meta?.category ?? this.streamInfo.category,
        title: item.meta?.title ?? this.streamInfo.title,
        updatedAt: item.ts
      };
    }
    if (!commands || item.kind !== 'chat') return;
    const command = this.commands.check(item, this.now());
    if (command.command === 'catchup') {
      const joiner = {
        user: item.user,
        ts: this.now(),
        status: command.allowed
          ? 'Recap ready; preparing chat'
          : `Wait ${command.retryAfter}s`
      };
      this.joiners.unshift(joiner);
      this.joiners = this.joiners.slice(0, 12);
      this.publish();
      if (command.allowed) return this.catchUp(item.user, item, joiner);
      return command;
    }
    if (command.allowed && command.command === 'recap') return this.refresh();
  }
  track(work) {
    // Expose completion for replay/tests without serializing independent work.
    this.queue = Promise.allSettled([this.queue, work]).then(() => {});
    return work;
  }
  refresh() {
    return this.track(this.requestSummary('newcomer'));
  }
  requestSummary(viewer) {
    if (this.pendingSummary) return this.pendingSummary;
    const generation = this.generation;
    const now = this.now();
    const startedAt = this.wallNow();
    const items = this.timeline.snapshot(now);
    this.refreshing = true;
    this.publish();
    const work = Promise.resolve()
      .then(async () => {
        let backend = 'mock';
        let result;
        const fallback = mockSummarize(items, { viewer, now });
        try {
          result = validateSummary(
            await this.summarizeFn(items, {
              viewer,
              now,
              onBackend: (name) => {
                backend = name;
              }
            }),
            fallback,
            { now }
          );
        } catch {
          backend = 'mock fallback';
          result = fallback;
        }
        if (generation !== this.generation) return null;
        this.summary = result;
        this.backend = backend;
        this.updatedAt = now;
        this.summaryWallAt = startedAt;
        return { summary: result, viewer };
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.pendingSummary = null;
        this.refreshing = false;
        this.publish();
      });
    this.pendingSummary = work;
    return work;
  }
  catchUp(viewer, parent, joiner) {
    const generation = this.generation;
    const now = this.now();
    const startedAt = this.wallNow();
    const fresh =
      this.updatedAt !== null &&
      this.summaryWallAt !== null &&
      startedAt - this.summaryWallAt <= 30_000 &&
      now - this.updatedAt >= 0 &&
      now - this.updatedAt <= 60_000;
    const preview = personalizeSummary(
      fresh
        ? this.summary
        : mockSummarize(this.timeline.snapshot(now), { viewer, now }),
      viewer
    );
    const card = {
      viewer,
      summary: preview,
      ts: now,
      id: `${generation}-${now}-${viewer}`,
      durationMs: 12000,
      phase: 'initial'
    };
    // Never wait for a model, another refresh, or chat delivery to welcome someone.
    this.emit('catchup', card);
    const work = this.requestSummary(viewer).then(async (result) => {
      if (!result || generation !== this.generation) return;
      const summary =
        result.viewer === viewer
          ? result.summary
          : personalizeSummary(result.summary, viewer);
      if (this.wallNow() - startedAt < card.durationMs) {
        this.emit('catchup', { ...card, summary, phase: 'update' });
      }
      const reply = {
        ts: this.now(),
        user: viewer,
        text: summary.chatReply,
        parentId: parent?.meta?.messageId,
        status: this.mode === 'demo' ? 'would post in chat' : 'sending'
      };
      this.replies.unshift(reply);
      this.replies = this.replies.slice(0, 12);
      joiner.status =
        this.mode === 'demo' ? 'Caught up' : 'Recap ready; sending chat';
      this.publish();
      try {
        await this.sendChat(reply);
        if (generation !== this.generation) return;
        if (this.mode !== 'demo') reply.status = 'posted in chat';
        joiner.status = 'Caught up';
      } catch (error) {
        if (generation !== this.generation) return;
        reply.status =
          error.code === 'SHARED_CHAT'
            ? 'Chat paused during Shared Chat'
            : 'Chat delivery failed';
        joiner.status = 'Recap ready; chat not sent';
      }
      this.publish();
    });
    return this.track(work);
  }
  state() {
    const now = this.now(),
      items = this.timeline.snapshot(now),
      cutoff = now - this.timeline.windowMs;
    this.joiners = this.joiners.filter((x) => x.ts >= cutoff);
    this.replies = this.replies.filter((x) => x.ts >= cutoff);
    // Expire derived summaries too when the stream is silent.
    if (this.updatedAt && this.updatedAt < cutoff) {
      this.summary = mockSummarize(items);
      this.updatedAt = null;
    }
    return {
      generation: this.generation,
      mode: this.mode,
      channel: this.channel,
      streamInfo: this.streamInfo,
      now,
      windowMs: this.timeline.windowMs,
      status: this.status,
      backend: this.backend,
      refreshing: this.refreshing,
      updatedAt: this.updatedAt,
      summary: this.summary,
      joiners: this.joiners,
      replies: this.replies,
      events: items.filter((x) => x.kind === 'event'),
      chat: items.filter((x) => x.kind === 'chat').slice(-45),
      stats: {
        messages: items.filter((x) => x.kind === 'chat').length,
        viewers: new Set(
          items.filter((x) => x.kind === 'chat').map((x) => x.user)
        ).size,
        events: items.filter((x) => x.kind === 'event').length
      },
      replay: this.replay || null
    };
  }
  publish() {
    this.emit('state', this.state());
  }
}
