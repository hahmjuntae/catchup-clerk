export const DEFAULT_WINDOW_MS = 20 * 60_000;

// Fixed-capacity ring. Snapshot sorting handles late EventSub deliveries.
export class Timeline {
  constructor({ windowMs = DEFAULT_WINDOW_MS, maxItems = 5000 } = {}) {
    if (!(windowMs > 0) || !Number.isInteger(maxItems) || maxItems < 1) throw new Error('Invalid timeline limits');
    this.windowMs = windowMs;
    this.maxItems = maxItems;
    this.clear();
  }
  clear() { this.buffer = new Array(this.maxItems); this.head = 0; this.size = 0; }
  add(item, now = Date.now()) {
    const ts = Number(item.ts);
    if (!Number.isFinite(ts) || !['chat', 'event'].includes(item.kind) || ts < now - this.windowMs || ts > now + 30_000) return false;
    this.prune(now);
    const normalized = { ts, kind: item.kind, user: String(item.user || '').slice(0, 50), text: String(item.text || '').slice(0, 1000), eventType: String(item.eventType || '').slice(0, 80), meta: item.meta || {} };
    this.buffer[(this.head + this.size) % this.maxItems] = normalized;
    if (this.size === this.maxItems) this.head = (this.head + 1) % this.maxItems;
    else this.size++;
    return true;
  }
  prune(now = Date.now()) {
    // Most arrivals are chronological; compact only when any expired entry exists.
    const kept = [];
    for (let i = 0; i < this.size; i++) {
      const item = this.buffer[(this.head + i) % this.maxItems];
      if (item.ts >= now - this.windowMs) kept.push(item);
    }
    if (kept.length !== this.size) {
      this.clear();
      for (const item of kept) this.buffer[this.size++] = item;
    }
  }
  snapshot(now = Date.now()) {
    this.prune(now);
    return Array.from({ length: this.size }, (_, i) => this.buffer[(this.head + i) % this.maxItems]).sort((a, b) => a.ts - b.ts);
  }
}
