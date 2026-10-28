import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { trimReply, trimWords } from '../src/core/text.js';
import {
  mockSummarize,
  personalizeSummary,
  summarize,
  validateSummary
} from '../src/core/summarizer.js';
import { Clerk } from '../src/core/clerk.js';
import { Replay, DEMO_EPOCH } from '../src/core/replay.js';
import { ChatSender } from '../src/twitch/helix.js';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/demo-stream.json', import.meta.url))
);
const sentences =
  '@viewer The Glass Warden was defeated. A raid brought 120 viewers.';
const longReply = `${sentences} Now: ${'The streamer is currently attempting the Glass Warden and protecting the pot '.repeat(8)}`;
const longTopic =
  'The streamer is currently attempting the Glass Warden while protecting an emotional support pot and planning the next run';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('oversized replies end at the last complete sentence that fits', () => {
  assert.equal(trimReply(longReply), sentences);
  const first = `@viewer ${'A lantern room '.repeat(12)}was cleared.`;
  const second = `${'The shield build '.repeat(10)}held up!`;
  const complete = `${first} ${second}`;
  assert.ok(complete.length < 450);
  assert.equal(
    trimReply(`${complete} ${'A very long final thought '.repeat(30)}.`),
    complete
  );
  assert.equal(trimReply(sentences), sentences);
  assert.equal(
    trimReply('One. Two. Three. Four.', 280, { maxSentences: 3 }),
    'One. Two. Three.'
  );
  assert.equal(trimReply('x'.repeat(450)), 'x'.repeat(450));
});

test('sentence trimming keeps closing quotes and does not split on decimal punctuation', () => {
  const quoted = '@viewer Chat said “protect the pot!”';
  assert.equal(
    trimReply(`${quoted} ${'And the run continues '.repeat(50)}`),
    quoted
  );
  const noSentence = `@viewer Version 1.2 has ${'many interesting changes '.repeat(40)}`;
  assert.ok(trimReply(noSentence).startsWith('@viewer Version 1.2 has '));
  assert.ok(trimReply(noSentence).endsWith('…'));
});

test('no fitting sentence falls back to whole words and a length-budgeted ellipsis', () => {
  const result = trimReply(`@viewer ${'lantern '.repeat(100)}`);
  assert.ok(result.length <= 450);
  assert.ok(result.startsWith('@viewer '));
  assert.ok(result.endsWith('lantern…'));
  assert.equal(trimReply('oversizedword', 5), '…');
  assert.equal(trimWords('café lantern shimmer', 13), 'café lantern…');
});

test('topic validation caps at 80 characters on a word boundary with an ellipsis', () => {
  const fallback = mockSummarize([]);
  const summary = validateSummary(
    { topic: longTopic, chatReply: longReply },
    fallback
  );
  const topic = summary.topic;
  assert.ok(topic.length <= 80);
  assert.ok(topic.endsWith('…'));
  assert.ok(longTopic.startsWith(topic.slice(0, -1)));
  assert.equal(longTopic[topic.length - 1], ' ');
  assert.equal(summary.chatReply, sentences);
  assert.equal(trimWords('t'.repeat(80), 80), 't'.repeat(80));
});

test('local and personalized replies target 280 characters without a dangling Now clause', async () => {
  const items = fixture.items.filter((x) => x.ts <= 1400_000);
  items.push({
    ts: 1400_000,
    kind: 'event',
    user: 'streamer',
    eventType: 'channel.update',
    text: longTopic,
    meta: { category: longTopic }
  });
  const mock = mockSummarize(items, { viewer: 'new_viewer' });
  const shared = personalizeSummary(
    {
      ...mock,
      topic: longTopic,
      bullets: [
        sentences,
        'A complete second thought.',
        'more detail '.repeat(60)
      ]
    },
    'other_viewer'
  );
  const failed = await summarize(items, {
    viewer: 'new_viewer',
    env: { LLM_API_KEY: 'test' },
    fetchImpl: async () => {
      throw new Error('Provider unavailable');
    }
  });
  for (const summary of [mock, shared, failed]) {
    assert.ok(summary.chatReply.length <= 280);
    assert.match(summary.chatReply, /^@(?:new_viewer|other_viewer) /);
    assert.match(summary.chatReply, /[.!?…]$/u);
    assert.ok(!summary.chatReply.includes('Now:'));
    assert.ok(summary.topic.length <= 80);
  }
});

test('LLM prompt asks for concise complete replies and validation repairs oversized output', async () => {
  let prompt;
  const result = await summarize([], {
    viewer: 'viewer',
    env: { LLM_API_KEY: 'test' },
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[0].content;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                topic: longTopic,
                chatReply: longReply
              })
            }
          }
        ]
      });
    }
  });
  assert.match(prompt, /at most 280 characters/);
  assert.match(prompt, /2-3 short complete sentences/);
  assert.match(prompt, /start with @ followed by the supplied viewer name/);
  assert.match(prompt, /topic: string \(at most 80 characters/);
  assert.equal(result.chatReply, sentences);
  assert.ok(result.topic.endsWith('…'));
});

test('the final Helix send also preserves complete sentences', async () => {
  let sent;
  const sender = new ChatSender({
    broadcasterId: 'channel',
    senderId: 'bot',
    sleep: async () => {},
    helix: {
      request: async (path, options) => {
        if (path.startsWith('shared_chat/')) return { data: [] };
        await options.beforeAttempt();
        sent = options.body;
        return { data: [{ is_sent: true, message_id: 'reply' }] };
      }
    }
  });
  await sender.send({ text: longReply, parentId: 'viewer-message' });
  assert.equal(sent.message, sentences);
  assert.equal(sent.reply_parent_message_id, 'viewer-message');
});

test('jump publishes a seeded new-position summary while AI is pending, with no placeholder flash', async () => {
  const requests = [];
  const states = [];
  const clerk = new Clerk({
    summarizeFn: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    emit: (type, state) => {
      if (type === 'state') states.push(state);
    }
  });
  const replay = new Replay(clerk, fixture, { wallNow: () => 0 });
  replay.start();
  const oldWork = clerk.queue;
  await Promise.resolve();
  states.length = 0;
  replay.action('jump');
  const seed = clerk.summary;
  const expected = mockSummarize(clerk.timeline.snapshot(clerk.now()));
  assert.deepEqual(seed, expected);
  assert.ok(seed.moments.length >= 3);
  assert.equal(clerk.updatedAt, DEMO_EPOCH + 1280_000);
  assert.ok(states.length >= 2);
  assert.ok(
    states.every(
      (state) =>
        state.summary.moments.length >= 3 &&
        state.summary.topic !== 'Catching up with the stream'
    )
  );
  await Promise.resolve();
  requests[0].resolve({
    ...mockSummarize([]),
    topic: 'Stale result from before jump'
  });
  await oldWork;
  assert.equal(clerk.summary, seed);
  requests[1].resolve({
    ...seed,
    topic: 'Updated AI summary for the new position'
  });
  await clerk.queue;
  assert.equal(clerk.summary.topic, 'Updated AI summary for the new position');
});

test('a failed AI refresh after a jump retains useful local context', async () => {
  const clerk = new Clerk({
    summarizeFn: async () => {
      throw new Error('Unavailable');
    }
  });
  const replay = new Replay(clerk, fixture);
  replay.action('jump');
  const seeded = clerk.summary;
  assert.ok(seeded.moments.length >= 3);
  await clerk.queue;
  assert.deepEqual(clerk.summary, seeded);
  assert.equal(clerk.backend, 'mock fallback');
});
