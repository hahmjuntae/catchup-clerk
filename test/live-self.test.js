import test from 'node:test';
import assert from 'node:assert/strict';
import { Clerk } from '../src/core/clerk.js';
import { Commands } from '../src/core/commands.js';
import { mockSummarize } from '../src/core/summarizer.js';
import { Twitch } from '../src/twitch/index.js';
import { subscriptions } from '../src/twitch/events.js';

const START = Date.UTC(2026, 9, 28, 19, 20);
const ownChat = (text, messageId = 'human-message', ts = START) => ({
  ts,
  kind: 'chat',
  user: 'lanternlark',
  text,
  meta: { userId: 'owner', isBroadcaster: true, messageId }
});

class FakeSocket {
  constructor() {
    this.listeners = {};
  }
  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
  close() {
    this.listeners.close?.();
  }
}

async function liveFixture({
  flag,
  sendResponse,
  summary,
  failFollow = false
} = {}) {
  let now = START;
  const logs = [];
  const sends = [];
  const cards = [];
  const clerk = new Clerk({
    mode: 'live',
    now: () => now,
    summarizeFn:
      summary || (async (items, options) => mockSummarize(items, options)),
    emit: (type, data) => {
      if (type === 'catchup' && data.phase === 'initial') cards.push(data);
    }
  });
  const twitch = new Twitch({
    env: {
      TWITCH_CHANNEL: 'LanternLark',
      TWITCH_CLIENT_ID: 'test-app',
      ALLOW_SELF_COMMANDS: flag
    },
    clerk,
    WebSocketImpl: FakeSocket,
    log: (line) => logs.push(line),
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/helix/users') {
        return Response.json({
          data: [
            { id: 'owner', login: 'lanternlark', display_name: 'LanternLark' }
          ]
        });
      }
      if (path === '/helix/shared_chat/session')
        return Response.json({ data: [] });
      if (path === '/helix/eventsub/subscriptions') {
        const body = JSON.parse(options.body);
        return Response.json(
          {},
          { status: failFollow && body.type === 'channel.follow' ? 403 : 202 }
        );
      }
      if (path === '/helix/chat/messages') {
        sends.push(JSON.parse(options.body));
        return sendResponse
          ? sendResponse()
          : Response.json({
              data: [{ is_sent: true, message_id: 'reply-from-helix' }]
            });
      }
      throw new Error(`Unexpected test request: ${path}`);
    }
  });
  // Keep the integration test entirely offline; never read the real token file.
  twitch.auth.identity = { user_id: 'owner', login: 'lanternlark' };
  twitch.auth.tokens = {
    access_token: 'test-token-do-not-log',
    expires_at: Date.now() + 3_600_000
  };
  await twitch.connect();
  const socket = [...twitch.events.sockets][0];
  await twitch.events.handle(
    {
      metadata: { message_type: 'session_welcome' },
      payload: {
        session: { id: 'test-session', keepalive_timeout_seconds: 30 }
      }
    },
    socket
  );
  const receive = (text, messageId) =>
    twitch.events.handle(
      {
        metadata: {
          message_type: 'notification',
          message_id: `delivery-${messageId}`,
          message_timestamp: new Date(now).toISOString()
        },
        payload: {
          subscription: { type: 'channel.chat.message' },
          event: {
            broadcaster_user_id: 'owner',
            chatter_user_id: 'owner',
            chatter_user_login: 'lanternlark',
            message_id: messageId,
            message: { text },
            badges: [{ set_id: 'broadcaster' }]
          }
        }
      },
      socket
    );
  return {
    twitch,
    clerk,
    sends,
    cards,
    logs,
    receive,
    advance: (ms) => {
      now += ms;
    }
  };
}

for (const allowSelfCommands of [false, true]) {
  test(`broadcaster context and events survive with self commands ${allowSelfCommands ? 'on' : 'off'}`, async () => {
    const clerk = new Clerk({
      now: () => START,
      ownUserId: 'owner',
      ownLogin: 'lanternlark',
      allowSelfCommands
    });
    clerk.ingest(ownChat('The lantern shield build is working.'));
    clerk.ingest({
      ts: START,
      kind: 'event',
      user: 'lanternlark',
      text: 'Category: Ember Vault',
      eventType: 'channel.update'
    });
    assert.equal(clerk.timeline.size, 2);
    assert.equal(
      clerk.timeline.snapshot(START)[0].text,
      'The lantern shield build is working.'
    );
    assert.equal(clerk.joiners.length, 0);
    assert.equal(clerk.updatedAt, null);
    assert.deepEqual(clerk.commands.check(ownChat('hello !catchup')), {
      ignored: true
    });
  });
}

test('self commands retain cooldowns, strict parsing, and recap privileges', () => {
  const commands = new Commands({
    ownUserId: 'owner',
    ownLogin: 'lanternlark',
    allowSelfCommands: true
  });
  assert.equal(commands.check(ownChat('!catchup'), 0).allowed, true);
  assert.equal(commands.check(ownChat('!catchup'), 59_999).allowed, false);
  assert.equal(
    commands.check({ user: 'viewer', text: '!catchup', meta: {} }, 14_999)
      .allowed,
    false
  );
  assert.equal(commands.check(ownChat('!catchup'), 60_000).allowed, true);
  assert.equal(commands.check(ownChat('!recap'), 60_000).allowed, true);
  assert.equal(
    commands.check(ownChat('!catchup please'), 120_000).ignored,
    true
  );
  assert.equal(
    commands.check(
      { user: 'lanternlark', text: '!recap', meta: { userId: 'owner' } },
      120_000
    ).allowed,
    false
  );
  const disabled = new Commands({ ownLogin: 'LanternLark' });
  assert.equal(
    disabled.check({ user: 'LANTERNLARK', text: '!catchup' }).ignored,
    true
  );
});

for (const flag of [undefined, '0', 'true']) {
  test(`live self catchup stays disabled for ALLOW_SELF_COMMANDS=${String(flag)}`, async () => {
    const fixture = await liveFixture({ flag });
    try {
      await fixture.receive('I am choosing the shield path.', 'context');
      await fixture.receive('!catchup', 'request');
      assert.equal(fixture.sends.length, 0);
      assert.equal(fixture.clerk.joiners.length, 0);
      assert.ok(
        fixture.clerk.timeline
          .snapshot(START)
          .some((item) => item.meta.messageId === 'context')
      );
    } finally {
      fixture.twitch.stop();
    }
  });
}

test('single-account catchup posts a threaded reply and filters its Helix message ID', async () => {
  const fixture = await liveFixture({ flag: '1' });
  try {
    await fixture.receive('!catchup', 'viewer-request');
    assert.equal(fixture.sends.length, 1);
    assert.equal(fixture.sends[0].sender_id, 'owner');
    assert.equal(fixture.sends[0].broadcaster_id, 'owner');
    assert.equal(fixture.sends[0].reply_parent_message_id, 'viewer-request');
    assert.equal(fixture.clerk.replies[0].status, 'posted in chat');
    assert.equal(fixture.cards.length, 1);
    assert.ok(fixture.clerk.sentMessageIds.has('reply-from-helix'));
    await fixture.receive(fixture.sends[0].message, 'reply-from-helix');
    await fixture.receive('That was my best parry yet.', 'human-context');
    assert.deepEqual(
      fixture.clerk.timeline.snapshot(START).map((item) => item.meta.messageId),
      ['viewer-request', 'human-context']
    );
    assert.equal(fixture.sends.length, 1);
  } finally {
    fixture.twitch.stop();
  }
});

test('an early command-looking echo waits for Helix, then cannot trigger a second reply', async () => {
  let resolveResponse;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const fixture = await liveFixture({
    flag: '1',
    summary: async () => ({ ...mockSummarize([]), chatReply: '!catchup' }),
    sendResponse: () =>
      new Promise((resolve) => {
        resolveResponse = resolve;
        markStarted();
      })
  });
  try {
    const request = fixture.receive('!catchup', 'viewer-request');
    await started;
    // Move past both cooldowns so only the loop guard can stop this echo.
    fixture.advance(61_000);
    const echo = fixture.receive('!catchup', 'reply-from-helix');
    const context = fixture.receive(
      'Now heading to the next floor.',
      'human-context'
    );
    await Promise.resolve();
    assert.equal(fixture.clerk.timeline.size, 1);
    resolveResponse(
      Response.json({
        data: [{ is_sent: true, message_id: 'reply-from-helix' }]
      })
    );
    await Promise.all([request, echo, context]);
    assert.equal(fixture.sends.length, 1);
    assert.equal(fixture.cards.length, 1);
    assert.equal(fixture.clerk.joiners.length, 1);
    assert.deepEqual(
      fixture.clerk.timeline
        .snapshot(START + 61_000)
        .map((item) => item.meta.messageId),
      ['viewer-request', 'human-context']
    );
  } finally {
    fixture.twitch.stop();
  }
});

test('reply guard survives resets, blocks command echoes even when command handling is disabled, and expires', () => {
  let now = START;
  const clerk = new Clerk({
    ownUserId: 'owner',
    allowSelfCommands: true,
    windowMs: 1000,
    now: () => now
  });
  clerk.rememberReply('sent-reply');
  clerk.reset();
  clerk.ingest(ownChat('!recap', 'sent-reply'), { commands: false });
  clerk.ingest(ownChat('!catchup', 'sent-reply'));
  assert.equal(clerk.timeline.size, 0);
  assert.equal(clerk.joiners.length, 0);
  now += 61_001;
  clerk.ingest(ownChat('Human context', 'human-message', now));
  assert.equal(clerk.sentMessageIds.size, 0);
  assert.equal(clerk.timeline.size, 1);
});

test('startup summary lists resolved channel and each subscription result without tokens', async () => {
  const fixture = await liveFixture({ failFollow: true });
  try {
    const summary = fixture.logs.find((line) =>
      line.startsWith('Live: channel ')
    );
    assert.ok(
      summary.startsWith('Live: channel lanternlark; EventSub results: ')
    );
    for (const subscription of subscriptions('owner', 'owner')) {
      assert.ok(
        summary.includes(
          `${subscription.type} v${subscription.version}: ${subscription.type === 'channel.follow' ? 'failed (403' : 'subscribed'}`
        )
      );
    }
    assert.ok(!fixture.logs.join('\n').includes('test-token-do-not-log'));
  } finally {
    fixture.twitch.stop();
  }
});

test('missing token prints the live authorization URL without opening a WebSocket', async () => {
  const logs = [];
  const clerk = new Clerk({ mode: 'live' });
  const twitch = new Twitch({ env: {}, clerk, log: (line) => logs.push(line) });
  twitch.auth.load = async () => {
    throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
  };
  await twitch.start();
  assert.deepEqual(logs, [
    'Live: open http://localhost:3101/auth/login to authorize'
  ]);
  assert.equal(clerk.status, 'Connect Twitch to start');
  assert.equal(twitch.events, undefined);
});
