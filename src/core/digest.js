import { normalizeText } from './text.js';

export const clip = (value, max) => normalizeText(value).slice(0, max);
const emotes =
  /^(?:(?:KEKW|PogChamp|LUL|Kappa|MonkaS|Pog|EZ|F|OMEGALUL|GG|HYPE)[\s!,.]*)+$/i;
export function digest(items, { maxChat = 70, maxChars = 14000 } = {}) {
  const events = [],
    unique = new Map(),
    counts = new Map();
  let chatCount = 0,
    emoteCount = 0;
  for (const item of items) {
    if (item.kind === 'event') {
      events.push({
        t: item.ts,
        type: item.eventType,
        text: clip(item.text, 180)
      });
      continue;
    }
    chatCount++;
    counts.set(item.user, (counts.get(item.user) || 0) + 1);
    if (emotes.test(item.text.trim())) {
      emoteCount++;
      continue;
    }
    if (/^!\w+/.test(item.text)) continue;
    const key = item.text
      .toLowerCase()
      .replace(/(.)\1{3,}/g, '$1$1')
      .replace(/[^\p{L}\p{N}\s?]/gu, '')
      .trim();
    if (!key) continue;
    const prior = unique.get(key);
    if (prior) prior.repeats++;
    else
      unique.set(key, {
        t: item.ts,
        user: clip(item.user, 30),
        text: clip(item.text, 150),
        repeats: 1
      });
  }
  const candidates = [...unique.values()];
  const result = {
    chatCount,
    emoteCount,
    topChatters: [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([user, count]) => ({ user, count })),
    events,
    chat: []
  };
  // All retained events survive compression. Chat is sampled across the whole window.
  // maxChars is a chat budget; unusually event-heavy windows may exceed it.
  const budget = Math.max(0, maxChars - JSON.stringify(result).length);
  const count = Math.min(maxChat, candidates.length, Math.floor(budget / 240));
  for (let i = 0; i < count; i++)
    result.chat.push(
      candidates[
        Math.floor((i * (candidates.length - 1)) / Math.max(1, count - 1))
      ]
    );
  return result;
}
