import test from 'node:test';
import assert from 'node:assert/strict';
import { Clerk } from '../src/core/clerk.js';
import {
  mockSummarize,
  summarize,
  validateSummary
} from '../src/core/summarizer.js';
import { digest } from '../src/core/digest.js';
import {
  formatClock,
  momentEpoch,
  previewInfo,
  speedOptions
} from '../src/core/presentation.js';
import { OverlayPresenter } from '../public/overlay.js';

const now = Date.UTC(2026, 9, 28, 11, 47, 51);
const chat = (text, user = 'new_viewer', ts = now) => ({
  ts,
  kind: 'chat',
  user,
  text,
  meta: { messageId: `${user}-${ts}` }
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('live clocks use browser local time; demo clocks consistently use UTC', () => {
  assert.equal(formatClock(now, { timeZone: 'Asia/Seoul' }), '20:47:51');
  assert.equal(formatClock(now, { timeZone: 'America/New_York' }), '07:47:51');
  assert.equal(
    formatClock(now, { mode: 'demo', timeZone: 'Asia/Seoul' }),
    '11:47:51'
  );
  assert.equal(
    formatClock(now, {
      mode: 'demo',
      timeZone: 'America/New_York',
      seconds: false
    }),
    '11:47'
  );
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Seoul';
    assert.equal(formatClock(now), '20:47:51');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('digest and summary moments stay in epoch milliseconds, including across midnight', () => {
  const midnight = Date.UTC(2026, 9, 29, 0, 2);
  const beforeMidnight = midnight - 180_000;
  const items = [
    {
      ts: beforeMidnight,
      kind: 'event',
      user: 'raider',
      text: 'Raided with 120 viewers',
      eventType: 'channel.raid'
    }
  ];
  const fallback = mockSummarize(items);
  assert.equal(digest(items).events[0].t, beforeMidnight);
  assert.equal(fallback.moments[0].t, beforeMidnight);
  assert.equal(momentEpoch('23:59:00', midnight), beforeMidnight);
  const legacy = validateSummary(
    { moments: [{ t: '23:59:00', label: 'A raid' }] },
    fallback,
    { now: midnight }
  );
  assert.equal(legacy.moments[0].t, beforeMidnight);
  assert.equal(
    formatClock(legacy.moments[0].t, { timeZone: 'Asia/Seoul' }),
    '08:59:00'
  );
  assert.equal(momentEpoch('25:90:99', midnight), null);
});

test('live preview uses channel metadata and never fictional game artwork', () => {
  const live = { mode: 'live', channel: 'hahmjuntae' };
  assert.deepEqual(previewInfo(live), {
    demo: false,
    heading: 'hahmjuntae',
    detail: 'Your stream',
    caption: 'Stream placeholder · your OBS scene provides the backdrop'
  });
  assert.equal(
    previewInfo({
      ...live,
      streamInfo: {
        category: 'Software and Game Development',
        title: 'Testing Clerk'
      }
    }).detail,
    'Software and Game Development · Testing Clerk'
  );
  assert.equal(previewInfo({ mode: 'demo' }).heading, 'EMBER VAULT');
});

test('current channel metadata remains known after the update leaves the timeline', () => {
  let time = now;
  const clerk = new Clerk({ now: () => time });
  clerk.ingest({
    ts: now,
    kind: 'event',
    user: 'owner',
    text: 'Channel updated',
    eventType: 'channel.update',
    meta: { category: 'Development', title: 'Live test' }
  });
  time += 21 * 60_000;
  assert.equal(clerk.state().events.length, 0);
  assert.deepEqual(clerk.state().streamInfo, {
    category: 'Development',
    title: 'Live test',
    updatedAt: now
  });
});

test('speed choices include common values and custom URL values', () => {
  assert.deepEqual(speedOptions(5), [1, 2, 5, 10, 20, 50, 100]);
  assert.deepEqual(speedOptions(7), [1, 2, 5, 7, 10, 20, 50, 100]);
  assert.ok(speedOptions(2.5).includes(2.5));
  assert.equal(speedOptions(5).filter((value) => value === 5).length, 1);
});

test('catchup is immediate and shares an in-flight panel summary instead of queueing a duplicate', async () => {
  const pending = deferred();
  const events = [];
  const replies = [];
  let calls = 0;
  const clerk = new Clerk({
    now: () => now,
    emit: (type, data) => events.push({ type, data }),
    sendChat: async (reply) => replies.push(reply),
    summarizeFn: async () => {
      calls++;
      return pending.promise;
    }
  });
  clerk.ingest(chat('The boss was defeated with one heart left.'));
  const refresh = clerk.refresh();
  await Promise.resolve();
  const catchup = clerk.ingest(chat('!catchup'));
  const initial = events.filter((x) => x.type === 'catchup');
  assert.equal(initial.length, 1);
  assert.equal(initial[0].data.phase, 'initial');
  assert.equal(initial[0].data.viewer, 'new_viewer');
  assert.equal(initial[0].data.summary.bullets.length, 3);
  assert.equal(calls, 1);
  assert.equal(replies.length, 0);
  pending.resolve({
    ...mockSummarize([]),
    topic: 'AI context',
    chatReply: '@newcomer Generic reply'
  });
  await Promise.all([refresh, catchup]);
  assert.equal(calls, 1);
  assert.ok(replies[0].text.startsWith('@new_viewer '));
  assert.ok(!replies[0].text.includes('@newcomer'));
  assert.deepEqual(
    events.filter((x) => x.type === 'catchup').map((x) => x.data.phase),
    ['initial', 'update']
  );
});

test('fresh panel summary supplies the first card and slow chat delivery does not hold it', async () => {
  const summary = deferred();
  const delivery = deferred();
  const events = [];
  let clock = 100;
  const clerk = new Clerk({
    now: () => now,
    wallNow: () => clock,
    emit: (type, data) => {
      if (type === 'catchup') events.push(data);
    },
    summarizeFn: () => summary.promise,
    sendChat: () => delivery.promise
  });
  clerk.summary = { ...mockSummarize([]), topic: 'Fresh cached topic' };
  clerk.updatedAt = now - 1000;
  clerk.summaryWallAt = clock - 1000;
  const work = clerk.ingest(chat('!catchup'));
  assert.equal(events[0].summary.topic, 'Fresh cached topic');
  assert.ok(events[0].summary.chatReply.startsWith('@new_viewer '));
  clock += 3000;
  summary.resolve({ ...mockSummarize([]), topic: 'New AI topic' });
  await clerk.pendingSummary;
  assert.equal(events[1].summary.topic, 'New AI topic');
  assert.equal(clerk.replies[0].status, 'would post in chat');
  delivery.resolve();
  await work;
});

test('stale cache and failed AI calls fall back deterministically; late AI cannot reopen a card', async () => {
  let clock = 100_000;
  const pending = deferred();
  const cards = [];
  const clerk = new Clerk({
    now: () => now,
    wallNow: () => clock,
    emit: (type, data) => {
      if (type === 'catchup') cards.push(data);
    },
    summarizeFn: () => pending.promise
  });
  clerk.summary = { ...mockSummarize([]), topic: 'Stale topic' };
  clerk.updatedAt = now - 120_000;
  clerk.summaryWallAt = clock - 120_000;
  const work = clerk.ingest(chat('!catchup'));
  assert.notEqual(cards[0].summary.topic, 'Stale topic');
  clock += 13_000;
  pending.reject(new Error('Provider failed'));
  await work;
  assert.equal(cards.length, 1);
  assert.equal(clerk.backend, 'mock fallback');
  assert.equal(clerk.replies.length, 1);
});

test('overlay enrichment keeps its deadline, ignores hidden cards, and a new request is immediate', () => {
  let clock = 0;
  let callback;
  const shown = [];
  let hides = 0;
  let timers = 0;
  const presenter = new OverlayPresenter({
    now: () => clock,
    show: (data, options) => shown.push({ ...data, ...options }),
    hide: () => hides++,
    setTimer: (fn) => {
      callback = fn;
      return ++timers;
    },
    clearTimer: () => {}
  });
  presenter.receive({ id: 'one', phase: 'initial', durationMs: 12000 });
  clock = 3000;
  presenter.receive({ id: 'one', phase: 'update' });
  assert.equal(timers, 1);
  assert.equal(presenter.active.expiresAt, 12000);
  presenter.receive({ id: 'two', phase: 'initial', durationMs: 12000 });
  assert.equal(shown.at(-1).id, 'two');
  assert.equal(presenter.active.expiresAt, 15000);
  presenter.receive({ id: 'one', phase: 'update' });
  assert.equal(shown.length, 3);
  clock = 15000;
  callback();
  presenter.receive({ id: 'two', phase: 'update' });
  assert.equal(shown.length, 3);
  assert.equal(hides, 1);
});

test('LLM prompt treats broadcaster requesters as newcomers and requests epoch moments', async () => {
  let prompt;
  await summarize([], {
    viewer: 'hahmjuntae',
    now,
    env: { LLM_API_KEY: 'test-only' },
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[0].content;
      return Response.json({
        choices: [{ message: { content: JSON.stringify(mockSummarize([])) } }]
      });
    }
  });
  assert.match(
    prompt,
    /recap for a newcomer even when the viewer is the broadcaster/
  );
  assert.match(prompt, /epoch milliseconds copied from input/);
});

test('overlay uses the global receiver for browser timer methods', (t) => {
  let installed = 0;
  t.mock.method(globalThis, 'setTimeout', function () {
    assert.equal(this, globalThis);
    installed++;
    return 1;
  });
  t.mock.method(globalThis, 'clearTimeout', function () {
    assert.equal(this, globalThis);
  });
  const presenter = new OverlayPresenter({ show: () => {}, hide: () => {} });
  presenter.receive({ id: 'browser', phase: 'initial', durationMs: 12000 });
  presenter.reset();
  assert.equal(installed, 1);
});
