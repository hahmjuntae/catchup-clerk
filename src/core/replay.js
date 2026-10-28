export const DEMO_EPOCH = Date.UTC(2026, 9, 28, 19, 0, 0);
export const validSpeed = (value) =>
  Math.max(1, Math.min(100, Number(value) || 20));
export class Replay {
  constructor(clerk, fixture, { speed = 20, wallNow = () => Date.now() } = {}) {
    Object.assign(this, { clerk, fixture, wallNow });
    this.speed = validSpeed(speed);
    this.elapsed = 0;
    this.index = 0;
    this.paused = false;
    this.loopAt = null;
    clerk.now = () => DEMO_EPOCH + this.elapsed;
  }
  start(offset = 18 * 60_000) {
    this.clerk.reset();
    this.elapsed = Math.min(Math.max(0, offset), this.fixture.durationMs);
    this.index = 0;
    this.loopAt = null;
    this.lastWall = this.wallNow();
    this.paused = false;
    while (
      this.index < this.fixture.items.length &&
      this.fixture.items[this.index].ts <= this.elapsed
    )
      this.ingest(this.fixture.items[this.index++], false);
    this.clerk.seedSummary();
    this.update();
    void this.clerk.refresh();
  }
  ingest(item, commands = true) {
    const pending = this.clerk.ingest(
      { ...item, ts: DEMO_EPOCH + item.ts },
      { commands }
    );
    if (pending?.catch)
      pending.catch(() => {
        this.clerk.status = 'Summary unavailable; replay continues';
      });
  }
  tick() {
    const wall = this.wallNow(),
      delta = Math.max(0, wall - this.lastWall);
    this.lastWall = wall;
    if (this.paused) return;
    if (this.loopAt) {
      if (wall >= this.loopAt) this.start(0);
      return;
    }
    this.elapsed = Math.min(
      this.fixture.durationMs,
      this.elapsed + delta * this.speed
    );
    while (
      this.index < this.fixture.items.length &&
      this.fixture.items[this.index].ts <= this.elapsed
    )
      this.ingest(this.fixture.items[this.index++]);
    if (this.elapsed >= this.fixture.durationMs) this.loopAt = wall + 45000; // Let all three 12-second overlay cards finish.
    this.update();
  }
  action(action, value) {
    if (action === 'speed') {
      this.tick();
      this.speed = validSpeed(value);
    }
    if (action === 'pause') this.paused = !this.paused;
    if (action === 'restart') this.start(0);
    if (action === 'jump') this.start(1280 * 1000);
    if (action === 'catchup')
      this.ingest({
        ts: this.elapsed,
        kind: 'chat',
        user: 'you_in_chat',
        text: '!catchup',
        meta: { userId: 'you_in_chat', messageId: `manual-${this.elapsed}` }
      });
    this.lastWall = this.wallNow();
    this.update();
  }
  update() {
    this.clerk.replay = {
      elapsed: this.elapsed,
      duration: this.fixture.durationMs,
      speed: this.speed,
      paused: this.paused,
      looping: Boolean(this.loopAt)
    };
    this.clerk.publish();
  }
}
