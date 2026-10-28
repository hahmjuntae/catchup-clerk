// One welcome at a time: a new requester is visible immediately. Enrichment
// changes only the active card and never restarts its twelve-second lifetime.
export class OverlayPresenter {
  constructor({
    show,
    hide,
    now = Date.now,
    setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimer = (timer) => globalThis.clearTimeout(timer)
  }) {
    Object.assign(this, { show, hide, now, setTimer, clearTimer });
    this.seen = new Set();
    this.active = null;
  }
  receive(data) {
    if (data.phase === 'update') {
      if (this.active?.id === data.id && this.now() < this.active.expiresAt) {
        this.show(data, { update: true });
      }
      return;
    }
    if (this.seen.has(data.id)) return;
    this.seen.add(data.id);
    if (this.seen.size > 100) this.seen.delete(this.seen.values().next().value);
    this.clearTimer(this.timer);
    this.active = { id: data.id, expiresAt: this.now() + data.durationMs };
    this.show(data, { update: false });
    this.timer = this.setTimer(() => {
      this.active = null;
      this.hide();
    }, data.durationMs);
  }
  reset() {
    this.clearTimer(this.timer);
    this.active = null;
    this.seen.clear();
    this.hide();
  }
}
