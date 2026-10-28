export const normalizeText = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Keep whole words and reserve room for an explicit ellipsis. If even the
// first word cannot fit, an ellipsis is more honest than a broken word.
export function trimWords(value, max = 80) {
  const text = normalizeText(value);
  if (text.length <= max) return text;
  const budget = Math.max(0, max - 1);
  const boundary = text.lastIndexOf(' ', budget);
  if (boundary < 0) return max > 0 ? '…' : '';
  return `${text.slice(0, boundary).trimEnd()}…`;
}

export function trimReply(value, max = 450, { maxSentences = Infinity } = {}) {
  const text = normalizeText(value);
  if (text.length <= max && maxSentences === Infinity) return text;
  let boundary = 0;
  let sentences = 0;
  // Inspect the original text so a decimal or punctuation at the truncation
  // point is not mistaken for the end of a sentence. Keep closing quotes.
  for (const match of text.matchAll(/[.!?。！？]["'”’»\])}]*(?=\s|$)/gu)) {
    const end = match.index + match[0].length;
    if (end > max) break;
    boundary = end;
    if (++sentences === maxSentences) return text.slice(0, boundary);
  }
  if (text.length <= max) return text;
  return boundary ? text.slice(0, boundary) : trimWords(text, max);
}
