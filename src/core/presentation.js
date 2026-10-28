// Store timestamps as epoch milliseconds. Only the UI chooses a time zone.
export function formatClock(
  ts,
  { mode = 'live', timeZone, seconds = true } = {}
) {
  if (!Number.isFinite(ts)) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
    timeZone: mode === 'demo' ? 'UTC' : timeZone
  }).format(new Date(ts));
}

// Compatibility with older Worker responses containing UTC HH:MM:SS strings.
// The most recent matching instant also handles a window crossing midnight.
export function momentEpoch(value, now) {
  if (Number.isFinite(value) && value >= 0 && value <= 8.64e15) return value;
  if (
    typeof value !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)
  )
    return null;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  const day = new Date(now);
  let ts = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    hours,
    minutes,
    seconds
  );
  if (ts > now) ts -= 86_400_000;
  return ts >= 0 ? ts : null;
}

export function previewInfo(state) {
  if (state.mode === 'demo') {
    return {
      demo: true,
      heading: 'EMBER VAULT',
      detail: 'THE ASHEN LIBRARY',
      caption: 'Illustrated demo backdrop · not game footage'
    };
  }
  const { category, title } = state.streamInfo || {};
  return {
    demo: false,
    heading: state.channel || 'Your stream',
    detail: [category, title].filter(Boolean).join(' · ') || 'Your stream',
    caption: 'Stream placeholder · your OBS scene provides the backdrop'
  };
}

export function speedOptions(value) {
  const speed = Number(value);
  const options = [1, 2, 5, 10, 20, 50, 100];
  if (
    Number.isFinite(speed) &&
    speed >= 1 &&
    speed <= 100 &&
    !options.includes(speed)
  )
    options.push(speed);
  return options.sort((a, b) => a - b);
}
