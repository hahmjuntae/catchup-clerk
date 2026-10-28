import { startHosted } from './hosted.js';
import { OverlayPresenter } from './overlay.js';
import { formatClock, previewInfo, speedOptions } from '/core/presentation.js';
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]
  );
const clock = (ts, seconds = true) =>
  formatClock(ts, { mode: current?.mode || 'live', seconds });
const elapsed = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const overlayOnly = location.pathname === '/overlay';
const demoView = location.pathname === '/demo';
let control = async () => {},
  current;
const overlayHTML = `<div class="overlay-root" aria-live="polite"><article id="overlay-card" class="overlay-card"><div class="overlay-body"><div class="overlay-heading"><span class="avatar" id="overlay-avatar"></span><div><small>CATCH-UP CLERK · LAST 20 MINUTES</small><h2 id="overlay-welcome"></h2><p>Here’s what you missed.</p></div></div><ul id="overlay-bullets" class="overlay-bullets"></ul></div><div class="topic-footer"><span>CURRENT TOPIC</span><span id="overlay-topic" style="font:inherit;letter-spacing:normal;color:inherit"></span></div><div class="overlay-timer"></div></article></div>`;
if (overlayOnly) {
  document.body.className = 'overlay-page';
  $('app').innerHTML = overlayHTML;
  document.title = 'OBS overlay · Catch-up Clerk';
} else
  $('app').innerHTML = `
<header class="topbar"><a class="brand" href="/"><span class="brand-icon">c<span>c</span></span>Catch-up Clerk <span class="tag">STREAM COMPANION</span></a><div class="top-meta"><span><span class="status-dot"></span><span id="connection">Connecting</span></span><a class="text-link" href="/overlay" target="_blank" rel="noopener">Open OBS overlay ↗</a></div></header>
<main class="shell"><div class="page-heading"><div><div class="eyebrow" id="channel-label">YOUR STREAM, IN CONTEXT</div><h1>${demoView ? 'A seat in the middle of the story.' : 'Clerk panel'}</h1></div><div class="controls" id="demo-controls"><label>Replay <select id="speed" aria-label="Replay speed"><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option><option value="20" selected>20×</option><option value="50">50×</option><option value="100">100×</option></select></label><button data-action="pause" id="pause">Pause</button><button data-action="restart">Restart</button><button data-action="jump" class="primary">Jump to catch-up →</button></div></div>
<div id="notice" class="notice hidden" role="status"></div>
<div class="workspace"><section class="panel-stack" aria-label="Clerk panel">
<article class="card card-pad topic-card"><div class="eyebrow">CURRENT TOPIC <span id="refreshing"></span></div><h2 id="topic">Listening for the first moment.</h2><div class="topic-meta"><span id="topic-status">The last 20 minutes, kept in view</span><span class="backend" id="backend">LOCAL SUMMARY</span></div><div class="metrics"><div class="metric"><strong id="messages">0</strong><span>messages</span></div><div class="metric"><strong id="viewers">0</strong><span>chatters</span></div><div class="metric"><strong id="event-count">0</strong><span>events</span></div></div></article>
<article class="card timeline-card"><div class="section-head"><h2>The last 20 minutes</h2><span id="window-label">Rolling window</span></div><div class="timeline-labels"><span id="timeline-start">−20:00</span><span>NOW</span></div><div class="timeline-track" id="timeline"></div><div class="timeline-caption"><span>Every arrival is part of the story.</span><div class="legend"><span><i class="raid-key"></i>Raid</span><span><i></i>Stream event</span></div></div></article>
<div class="two-col"><article class="card card-pad"><div class="section-head"><h2>Key moments</h2><span>IN ORDER</span></div><ol class="moments" id="moments"></ol></article><article class="card card-pad"><div class="section-head"><h2>Still in the chat</h2><span>QUESTIONS & JOKES</span></div><ul class="notes" id="jokes"></ul></article></div>
<article class="card card-pad tell-card"><div class="eyebrow">WHAT TO TELL NEWCOMERS RIGHT NOW</div><p id="tell">A little context is on its way.</p><span class="read-hint">Your read-aloud cue. Refreshed as the story moves.</span></article>
<div class="two-col"><article class="card card-pad"><div class="section-head"><h2>Recent events</h2><span>LIVE FEED</span></div><div class="event-list" id="events-list"></div></article><article class="card card-pad"><div class="section-head"><h2>Back in the loop</h2><span id="joiner-count">0 JOINERS</span></div><div class="joiners" id="joiners"></div></article></div>
</section><aside class="stage-stack" aria-label="Overlay preview and stream chat"><article class="card"><div class="preview-header"><strong>On-stream overlay</strong><span>OBS BROWSER SOURCE</span></div><div class="stage live-stage" id="preview-stage"><div id="demo-art" hidden><div class="stage-grid"></div><div class="game-hud">LANTERN / SHIELD<div class="health-bar"></div>FLOOR 04</div><div class="game-room" aria-hidden="true"><span class="player"></span><span class="pot"></span></div></div><div class="stage-title"><strong id="preview-heading">Your stream</strong><small id="preview-detail"></small></div><div class="preview-idle">Waiting for someone to type !catchup</div>${overlayHTML}</div><div class="stage-caption"><span id="preview-caption">Stream placeholder</span><span>12-second card</span></div></article>
<article class="card chat-card"><div class="section-head"><h2 id="chat-title">Stream chat</h2><span id="chat-mode">SIMULATED</span></div><div id="chat-feed" class="chat-feed" aria-label="Recent chat"></div><div class="chat-bottom" id="chat-controls"><code>!catchup</code><button data-action="catchup">Join the conversation →</button></div></article></aside></div>
<div class="session-progress"><div id="progress"></div></div><div class="bottom-note"><span id="session-time">Demo session · 25 minutes</span><span id="privacy-note">Chat stays in the rolling window. Local summary needs no API key.</span></div></main>`;

function render(state) {
  if (current && current.generation !== state.generation) {
    presenter.reset();
  }
  current = state;
  if (overlayOnly) return;
  const preview = previewInfo(state);
  $('preview-stage').classList.toggle('live-stage', !preview.demo);
  $('demo-art').hidden = !preview.demo;
  $('preview-heading').textContent = preview.heading;
  $('preview-detail').textContent = preview.detail;
  $('preview-caption').textContent = preview.caption;
  $('connection').textContent = state.status;
  $('channel-label').textContent =
    `${state.mode === 'demo' ? 'FICTIONAL DEMO' : 'LIVE CHANNEL'} / ${state.channel}`;
  $('demo-controls').classList.toggle('hidden', state.mode !== 'demo');
  $('chat-controls').classList.toggle('hidden', state.mode !== 'demo');
  $('topic').textContent = state.summary.topic;
  $('tell').textContent = state.summary.tellNewcomers;
  $('refreshing').textContent = state.refreshing ? ' · UPDATING' : '';
  $('topic-status').textContent = state.updatedAt
    ? `Updated ${clock(state.updatedAt)} · ${Math.round(state.windowMs / 60000)}-minute context`
    : 'Listening to the stream';
  $('backend').textContent =
    state.backend === 'llm'
      ? 'AI SUMMARY'
      : state.backend === 'mock fallback'
        ? 'LOCAL FALLBACK'
        : 'LOCAL SUMMARY';
  $('messages').textContent = state.stats.messages.toLocaleString();
  $('viewers').textContent = state.stats.viewers;
  $('event-count').textContent = state.stats.events;
  $('window-label').textContent =
    `${Math.round(state.windowMs / 60000)}-minute rolling window`;
  $('timeline-start').textContent = clock(state.now - state.windowMs);
  $('timeline').innerHTML = state.events
    .map(
      (x) =>
        `<span class="marker ${x.eventType === 'channel.raid' ? 'raid' : x.eventType === 'channel.follow' ? 'follow' : ''}" style="left:${Math.max(0, Math.min(100, ((x.ts - state.now + state.windowMs) / state.windowMs) * 100))}%" title="${escape(clock(x.ts) + ' · ' + x.text)}"></span>`
    )
    .join('');
  $('moments').innerHTML =
    state.summary.moments
      .map(
        (x) =>
          `<li class="moment"><time>${escape(clock(x.t, false))}</time><span>${escape(x.label)}</span></li>`
      )
      .join('') ||
    '<li class="empty">Moments will appear as the stream unfolds.</li>';
  $('jokes').innerHTML =
    state.summary.jokes.map((x) => `<li>${escape(x)}</li>`).join('') ||
    '<li class="empty">No open questions yet.</li>';
  $('events-list').innerHTML =
    state.events
      .slice(-5)
      .reverse()
      .map(
        (x) =>
          `<div class="event"><i></i><span>${escape(x.text)}</span><time>${clock(x.ts, false)}</time></div>`
      )
      .join('') || '<p class="empty">Waiting for stream events.</p>';
  $('joiner-count').textContent = `${state.joiners.length} JOINERS`;
  $('joiners').innerHTML =
    state.joiners
      .slice(0, 5)
      .map(
        (x) =>
          `<div class="joiner"><span class="avatar">${escape(x.user[0]?.toUpperCase())}</span><span>${escape(x.user)}</span><small>${escape(x.status)}</small></div>`
      )
      .join('') ||
    '<p class="empty">The next !catchup gets a personal welcome.</p>';
  const feed = $('chat-feed'),
    wasBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 45;
  const lines = [
    ...state.chat.map((x) => ({ ...x, reply: false })),
    ...state.replies.map((x) => ({ ...x, reply: true }))
  ]
    .sort((a, b) => a.ts - b.ts)
    .slice(-45);
  feed.innerHTML = lines
    .map((x) =>
      x.reply
        ? `<div class="reply-line"><small>CLERK → @${escape(x.user)} · ${escape(x.status.toUpperCase())}</small>${escape(x.text)}</div>`
        : `<div class="chat-line ${x.text === '!catchup' ? 'command' : ''}"><strong>${escape(x.user)}</strong>${escape(x.text)}</div>`
    )
    .join('');
  if (wasBottom || !feed.dataset.ready) feed.scrollTop = feed.scrollHeight;
  feed.dataset.ready = '1';
  $('chat-mode').textContent = state.mode === 'demo' ? 'SIMULATED' : 'LIVE';
  $('privacy-note').textContent =
    state.backend === 'llm'
      ? 'Compressed chat is sent to the configured AI provider.'
      : 'Local summary · no chat sent to an AI provider.';
  if (state.replay) {
    const speed = String(state.replay.speed);
    if (!$('speed').querySelector(`option[value="${speed}"]`))
      $('speed').innerHTML = speedOptions(state.replay.speed)
        .map((value) => `<option value="${value}">${value}×</option>`)
        .join('');
    $('speed').value = speed;
    $('pause').textContent = state.replay.paused ? 'Resume' : 'Pause';
    $('progress').style.width =
      `${(state.replay.elapsed / state.replay.duration) * 100}%`;
    $('session-time').textContent =
      `Demo session · ${elapsed(state.replay.elapsed)} / 25:00 · ${state.replay.speed}×${state.replay.looping ? ' · looping after the welcome cards' : ''}`;
  } else
    $('session-time').textContent =
      'Connected to Twitch EventSub · !recap refreshes the panel';
}
const presenter = new OverlayPresenter({
  show: (data, { update }) => {
    $('overlay-avatar').textContent = data.viewer[0].toUpperCase();
    $('overlay-welcome').textContent = `Welcome @${data.viewer}`;
    $('overlay-bullets').innerHTML = data.summary.bullets
      .map((x) => `<li>${escape(x)}</li>`)
      .join('');
    $('overlay-topic').textContent = data.summary.topic;
    if (!update) {
      const timer = $('overlay-card').querySelector('.overlay-timer');
      timer.style.animation = 'none';
      void timer.offsetWidth;
      timer.style.animation = '';
      $('overlay-card').classList.add('visible');
    }
  },
  hide: () => $('overlay-card').classList.remove('visible')
});
const catchup = (data) => presenter.receive(data);
function notice(text) {
  if (!overlayOnly) {
    $('notice').textContent = text;
    $('notice').classList.toggle('hidden', !text);
  }
}
let stop = () => {};
try {
  const config = await fetch('/api/config').then((r) => r.json());
  if (config.runtime === 'hosted') {
    const hosted = await startHosted({ render, catchup, notice });
    control = hosted.control;
    stop = hosted.stop;
  } else {
    control = async (action, value) => {
      const r = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value })
      });
      if (!r.ok) throw new Error('Demo control failed');
    };
    const source = new EventSource('/events');
    source.addEventListener('state', (e) => {
      render(JSON.parse(e.data));
      notice('');
    });
    source.addEventListener('catchup', (e) => catchup(JSON.parse(e.data)));
    source.onerror = () => notice('Reconnecting to the local server…');
    stop = () => source.close();
    const speed = new URLSearchParams(location.search).get('speed');
    if (speed && config.mode === 'demo' && !overlayOnly)
      await control('speed', speed);
  }
  document.querySelectorAll('[data-action]').forEach((button) =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await control(button.dataset.action);
      } catch {
        notice('Could not apply the demo control. Please try again.');
      } finally {
        button.disabled = false;
      }
    })
  );
  $('speed')?.addEventListener('change', (e) =>
    control('speed', e.target.value).catch(() =>
      notice('Could not change replay speed.')
    )
  );
} catch {
  notice(
    'Could not start the demo. Check that the server is running, then reload.'
  );
}
window.addEventListener('pagehide', () => {
  stop();
  presenter.reset();
});
