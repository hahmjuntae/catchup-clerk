# Catch-up Clerk

Catch-up Clerk gives late arrivals context from the last 20 minutes of Twitch chat and stream events. A viewer types `!catchup` and gets a threaded chat reply of at most 450 characters, a 12-second overlay welcome with three bullets, and an entry in the streamer's Clerk panel.

The panel shows the current topic, timestamped key moments, open questions and running jokes, recent events, recent catch-up requesters, and a short line the streamer can read aloud. It receives state updates twice per second and refreshes its summary every 15 seconds. Broadcasters and moderators can use `!recap` to request a summary immediately.

Node 26, ES modules, native HTTP/fetch/WebSocket, and browser JavaScript. No runtime packages or UI frameworks. Wrangler is the only direct development dependency.

## Quick start

With Node 26 installed, run from this directory:

```sh
npm run demo
```

No install, API key, or Twitch account is needed for the Node demo. Open **http://localhost:3101/demo**. The landing page is at `/`, the streamer panel at `/panel`, and the transparent OBS source at `/overlay`.

The demo uses a fictional channel, LanternLark, playing a fictional roguelike, Ember Vault. The fixture has 404 chat messages and 20 stream events over 25 minutes. It includes a 120-viewer raid, subscriptions, a gift-sub bomb, cheers, a boss fight, an emotional support pot, and a repeated lantern question.

The replay opens at minute 18 with earlier context loaded. Use **Restart** to replay from zero or **Jump to catch-up** to reach the three scripted requests at 21:30, 23:00, and 24:30. At the default 20× speed, those requests arrive 4.5 seconds apart; overlay cards queue and each stays visible for 12 real seconds. The replay waits 45 real seconds at the end before looping. **Join the conversation** inserts a simulated `!catchup` request.

Use `/demo?speed=50`, the replay speed selector, or `DEMO_SPEED=50 npm run demo` to change speed (1–100×). Cooldowns use the simulated stream clock in demo mode and real time in live mode. Pause stops the replay clock; visible cards still expire in real time. In the Node demo, controls affect all connected views.

Replies in demo mode are labeled **would post in chat**. No Twitch requests are made.

## Live setup

1. Register an application in the [Twitch developer console](https://dev.twitch.tv/console/apps). Use OAuth client type **Confidential** and category **Chat Bot**.
2. Register this exact OAuth redirect URL: `http://localhost:3101/auth/callback`.
3. Copy `.env.example` to `.env`. Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_CHANNEL` (the channel login, without `#` or a URL).
4. Run `npm run dev` and open `http://localhost:3101/auth/login`.
5. Authorize as the channel owner for the full set of events. Open `/panel`. From a different viewer account, send `!catchup` in that channel.
6. Add an OBS Browser Source with URL `http://localhost:3101/overlay`, width **1920**, height **1080**. Its background is transparent. The panel includes a smaller preview over an illustrated backdrop; it is not actual game footage.

For a **single-account live test**, set `ALLOW_SELF_COMMANDS=1` in `.env` and restart `npm run dev`. Authorize as the broadcaster, then type `!catchup` from that same account. It uses the normal cooldowns and sends a threaded reply, updates the panel, and shows the overlay. `!recap` still requires broadcaster or moderator privileges. This flag is a testing aid and is **off by default**; unset it or set it to `0` after testing.

When no token file exists, startup prints `Live: open http://localhost:3101/auth/login to authorize` (using your configured port). Once connected, a startup summary lists the resolved channel login and every EventSub subscription result. These logs contain no tokens or keys.

The authorized account is also the chat sender. A dedicated bot/moderator account can read and send chat, but subscriptions and cheers generally need authorization from the broadcaster; unavailable subscriptions are logged individually and do not prevent the rest from running. This small version stores one authorization, not separate broadcaster and bot grants.

OAuth requests these scopes:

```text
user:read:chat user:write:chat moderator:read:followers channel:read:subscriptions bits:read
```

`/auth/login` creates an expiring, single-use state token bound to an HttpOnly, SameSite cookie. `/auth/callback` exchanges the authorization code on the server. Access and refresh tokens are written atomically to `.data/tokens.json` with mode `600`. The directory is gitignored. Tokens are validated on startup and hourly, refreshed before expiration and once on HTTP 401. Keys, tokens, authorization codes, and chat contents are not logged.

The broadcaster's ordinary chat stays in the timeline as context, whether or not `ALLOW_SELF_COMMANDS` is enabled. Non-command messages never enter command processing. The app records message IDs returned by Helix and excludes those outgoing replies from both the timeline and commands. Own-account notifications that arrive while a send is pending wait for its result before that check, so an early echo cannot bypass the reply-ID guard. IDs are held only in bounded memory and survive connection resets until their window expires.

With the flag off, the sender's `!catchup` is ignored; the existing privileged `!recap` remains available when the channel owner is also the sending account. `!catchup` has a 60-second per-user cooldown and a 15-second global cooldown; blocked requests are shown in the panel without generating another chat reply. Privileged `!recap` requests have a two-second debounce.

## Twitch integration

`src/twitch/eventsub.js` connects to `wss://eventsub.wss.twitch.tv/ws`. After `session_welcome`, it creates Helix EventSub subscriptions with `transport: {method: 'websocket', session_id}`:

| Type | Version | Condition |
| --- | --- | --- |
| `channel.chat.message` | 1 | broadcaster and authorized user |
| `channel.follow` | 2 | broadcaster and authorized moderator |
| `channel.raid` | 1 | `to_broadcaster_user_id` |
| `channel.subscribe` | 1 | broadcaster |
| `channel.subscription.gift` | 1 | broadcaster |
| `channel.subscription.message` | 1 | broadcaster |
| `channel.cheer` | 1 | broadcaster |
| `channel.update` | 2 | broadcaster |
| `stream.online` | 1 | broadcaster |
| `stream.offline` | 1 | broadcaster |

Each result is logged by type and status, including missing permission/scope failures. Notifications are normalized into timeline items. Delivery IDs are deduplicated. Keepalives reset a watchdog. A server-directed reconnect opens the supplied Twitch URL and retires the old socket only after welcome, preserving subscriptions. An unexpected disconnect reconnects with backoff and creates fresh subscriptions. Revocations are reported to the panel and logs. This follows [Twitch's WebSocket lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/).

`src/twitch/helix.js` sends `POST /helix/chat/messages` with `broadcaster_id`, `sender_id`, `message`, and `reply_parent_message_id`. A serialized queue spaces attempts by at least two seconds, including 401 retries, and checks Twitch's `is_sent` response. The broadcaster ID is resolved once from `TWITCH_CHANNEL`; other channel IDs are rejected.

**Shared Chat is unsupported for outgoing replies.** Twitch user tokens broadcast across a Shared Chat session and reject the app-token-only `for_source_only` flag. The sender checks `GET /helix/shared_chat/session` immediately before each attempt and blocks delivery when a shared session is active or cannot be checked. Keep Shared Chat disabled while using live replies; the check and send are separate API operations, so a session starting between them cannot be made atomic. The overlay still appears when chat delivery fails. See the [Send Chat Message reference](https://dev.twitch.tv/docs/api/reference/#send-chat-message).

## Summarization

The ring buffer keeps a 20-minute window with a default cap of 5,000 total items. Late deliveries are sorted when read. Raw chat lines are truncated to 1,000 characters. Old items expire even when no new messages arrive.

The digest counts top chatters, collapses repeated text, counts emote-only floods, and samples up to 70 distinct chat lines evenly across the window. Every event still present in the ring is retained, with compact text. The usual prompt target is 14,000 characters; the event section can exceed this in an unusually event-heavy window. The overall timeline cap still applies.

The summarizer sends that digest to an OpenAI-compatible Chat Completions endpoint with JSON output requested. Defaults:

```text
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-3.1-flash-lite
```

Set `LLM_API_KEY` in `.env` for Node or as a Worker secret for the hosted demo. The key stays server-side. The system prompt treats chat as untrusted data, asks for evidence-based claims, and avoids inventing unseen gameplay. Output has this shape:

```text
{ topic, bullets[3], moments[{t, label}], jokes[], tellNewcomers, chatReply }
```

Markdown fences and trailing JSON commas are repaired. Fields are validated, missing fields filled from a local result, and text lengths capped. Missing keys, network failures, non-2xx responses, invalid JSON, and the eight-second deadline all fall back to a deterministic keyword/event summarizer. The UI identifies AI summaries, local summaries, and fallbacks. The mock is intentionally tuned to the fixture's vocabulary; unfamiliar streams receive a more general event/chat recap.

## Architecture

```text
Twitch OAuth + Helix users
    -> EventSub WebSocket
        -> normalized chat and events
            -> Timeline ring buffer
                -> digest -> LLM JSON or deterministic mock
                    -> Clerk state -> SSE -> panel and overlay
                    -> chat queue -> Helix threaded reply

Node demo fixture -> Replay clock -> same Timeline and Clerk -> SSE

Hosted demo fixture -> browser Replay + Timeline + Clerk
    -> Worker POST /api/summarize -> same summarizer
    -> panel and overlay in the browser
    -> BroadcastChannel + Web Locks for same-browser tab sharing
```

- `src/core/`: runtime-independent timeline, digest, summarizer, commands, Clerk orchestration, and replay clock.
- `src/twitch/`: OAuth, Helix client/chat queue, event normalization, WebSocket lifecycle.
- `src/server.js`: native Node HTTP server, SSE, static files, and live/demo startup.
- `public/`: shared HTML, CSS, and JavaScript for all views. No external fonts, CDNs, or trackers.
- `worker/index.js`: hosted demo API and assets routing.
- `fixtures/demo-stream.json`: generated, reviewable fixture; keep it in version control.
- `scripts/make-demo-fixture.js`: seeded fixture generator.
- `scripts/build-assets.js`: copies shared modules and the fixture into ignored `public/core/` and `public/fixtures/` for Worker assets.
- `test/`: native Node tests with fake fetch/WebSocket and virtual replay time.

Node routes: `/`, `/demo`, `/panel`, `/overlay`, `/events` (SSE events `state` and `catchup`), `/api/state`, `/api/config`, `/api/demo` (demo controls), `/healthz`, `/auth/login`, `/auth/callback`.

## Hosted Cloudflare demo

The hosted demo needs zero Twitch credentials. Install the local development dependency and start Wrangler:

```sh
npm ci
npm run worker:dev
```

Open the local URL Wrangler prints, followed by `/demo`. The build script copies the shared core and fixture into `public/`; the Worker serves them through the `ASSETS` binding. `/panel` and `/overlay` use the same UI as Node. The browser owns the replay, window, cooldowns, and panel state; the Worker only summarizes posted windows. `/api/state` explains that state lives in the browser; hosted mode does not offer server SSE or Twitch OAuth.

Optional AI setup and deployment, when you are ready:

```sh
npx wrangler login
npx wrangler secret put LLM_API_KEY
npm run deploy
```

`wrangler.toml` names the Worker `catchup-clerk`. No deployment or Twitch authorization is performed by tests. A build-only check is `npm run assets && npx wrangler deploy --dry-run`.

The endpoint accepts at most 256 KiB and 5,000 validated items, filters to a 20-minute window, checks same-origin requests, and applies a best-effort in-memory limit of 12 requests per IP per minute. The browser falls back locally if the API is unavailable or limited. This is not a distributed quota or a spending cap; add a Cloudflare rate-limiting rule for a larger public deployment.

Tabs in the same origin/browser share one replay with Web Locks and BroadcastChannel. An overlay in a separate OBS browser process has its own hosted replay; use the Node live server for synchronized OBS production output. Closing the leading tab lets another tab start a new replay. Background browser throttling can affect timing.

## Configuration

All supported environment variables are listed with empty values in `.env.example`. Empty values use defaults unless marked required.

| Variable | Default / purpose |
| --- | --- |
| `MODE` | Scripts select `demo` or `live`; direct server launch defaults to `demo` |
| `PORT` | `3101`; `npm run demo` fixes this port |
| `HOST` | `127.0.0.1` (loopback) |
| `DEMO_SPEED` | `20`, clamped to 1–100 |
| `WINDOW_MINUTES` | `20` (Node) |
| `MAX_ITEMS` | `5000` (Node) |
| `LLM_BASE_URL` | Gemini OpenAI-compatible URL above |
| `LLM_API_KEY` | Optional; absent means local mock |
| `LLM_MODEL` | `gemini-3.1-flash-lite` |
| `TWITCH_CLIENT_ID` | Required in live mode |
| `TWITCH_CLIENT_SECRET` | Required in live mode |
| `TWITCH_CHANNEL` | Required channel login in live mode |
| `TWITCH_REDIRECT_URI` | `http://localhost:3101/auth/callback` |
| `ALLOW_SELF_COMMANDS` | Off by default; exactly `1` enables authorized-account commands for live testing |

For a local Worker key, use an ignored `.dev.vars` file containing `LLM_API_KEY=...`. Do not put secrets in `wrangler.toml`, browser files, or the fixture.

## Tests and recording

```sh
npm test
npm run fixture
npm run demo
```

Tests cover timeline expiration and capacity, a 5,000-message flood, commands and cooldowns, deterministic summaries, JSON repair, LLM failure/timeout, the complete three-viewer replay, stale async results, Worker validation/limits/assets routes, EventSub welcome/notification/reconnect, event normalization, token permissions/refresh, OAuth state rejection, channel-bound chat throttling, self-command testing, broadcaster context, outgoing reply-ID filtering (including early echoes), and startup logs.

For a recording, open `/demo` at 1920×1080, click **Jump to catch-up**, and let all three welcome cards play. The on-page game scene is a CSS illustration. `/panel` is also suitable as an OBS custom browser dock. `Ctrl+C` stops a foreground server.

## Privacy and limitations

- Live chat is held in process memory for the configured window and item cap, never written to disk. Recent replies and joiners expire with the window too. The committed fixture contains only synthetic data. Derived summaries update periodically and may briefly describe recently expired context; idle summaries are cleared after a window.
- With no AI key, summarization makes no external requests. With a key, a compressed selection of usernames, chat, and event text goes to the configured provider and is subject to that provider's data policy. Hosted clients send their synthetic window to the Worker. No API key reaches the browser.
- Tokens are the only application data persisted locally. `.env`, `.data/`, `.dev.vars`, `.wrangler/`, and `node_modules/` are ignored.
- This uses chat and stream events, not audio, video, VODs, or speech recognition. Chat claims may be wrong. Summaries are not authoritative game state.
- Very busy streams may hit the 5,000-item cap before 20 minutes. In that case the recap represents less history. Disconnects lose events; Twitch does not replay missed WebSocket notifications.
- There is no durable state, moderation dashboard, user database, distributed Worker rate limit, or multi-channel support. Deleted/moderated messages are not retroactively removed because deletion subscriptions are outside this version's event set.
- Keep the local server on loopback. The panel and control endpoints are not a multi-user authenticated service. Remote hosting of the live Node app would need an access-control layer.
- Unit tests use fake Twitch/LLM services. Real OAuth, account-specific scopes, chat posting, and provider model access require your credentials and a live-channel check.

## Built with Codex

Implemented with Codex: shared logic, deterministic fixture, Node and Worker runtimes, Twitch integration, UI, tests, and documentation.

Codex session ID: <SESSION_ID>

## License

MIT. Copyright 2026 hahmjuntae.
