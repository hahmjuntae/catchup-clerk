export function parseCommand(text) {
  const match = String(text || '').trim().match(/^!(catchup|recap)\s*$/i);
  return match?.[1].toLowerCase() || null;
}
export class Commands {
  constructor({ userMs = 60_000, globalMs = 15_000, ownUserId = '', ownLogin = '' } = {}) {
    Object.assign(this, { userMs, globalMs, ownUserId, ownLogin });
    this.users = new Map(); this.lastGlobal = -Infinity; this.lastRecap = -Infinity;
  }
  check(item, now = Date.now()) {
    const privilegedRecap = parseCommand(item.text) === 'recap' && (item.meta?.isMod || item.meta?.isBroadcaster);
    if (!privilegedRecap && ((this.ownUserId && item.meta?.userId === this.ownUserId) || (this.ownLogin && item.user.toLowerCase() === this.ownLogin.toLowerCase()))) return { ignored: true };
    const command = parseCommand(item.text);
    if (!command) return { ignored: true };
    if (command === 'recap') {
      if (!item.meta?.isMod && !item.meta?.isBroadcaster) return { command, allowed: false, reason: 'Moderators only' };
      if (now - this.lastRecap < 2000) return { command, allowed: false, reason: 'Refresh already requested' };
      this.lastRecap = now;
      return { command, allowed: true };
    }
    for (const [user, ts] of this.users) if (now - ts >= this.userMs) this.users.delete(user);
    const key = item.meta?.userId || item.user.toLowerCase();
    const wait = Math.max(this.userMs - (now - (this.users.get(key) ?? -Infinity)), this.globalMs - (now - this.lastGlobal));
    if (wait > 0) return { command, allowed: false, reason: 'Cooldown', retryAfter: Math.ceil(wait / 1000) };
    this.users.set(key, now); this.lastGlobal = now;
    return { command, allowed: true };
  }
}
