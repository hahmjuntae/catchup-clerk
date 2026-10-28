export function subscriptions(broadcasterId, userId) {
  const base = { broadcaster_user_id: broadcasterId };
  return [
    {
      type: 'channel.chat.message',
      version: '1',
      condition: { ...base, user_id: userId }
    },
    {
      type: 'channel.follow',
      version: '2',
      condition: { ...base, moderator_user_id: userId }
    },
    {
      type: 'channel.raid',
      version: '1',
      condition: { to_broadcaster_user_id: broadcasterId }
    },
    ...[
      'channel.subscribe',
      'channel.subscription.gift',
      'channel.subscription.message',
      'channel.cheer',
      'stream.online',
      'stream.offline'
    ].map((type) => ({ type, version: '1', condition: base })),
    { type: 'channel.update', version: '2', condition: base }
  ];
}
export function normalizeNotification(message, broadcasterId) {
  const event = message.payload?.event,
    type =
      message.payload?.subscription?.type ||
      message.metadata?.subscription_type;
  if (!event) return null;
  const channel =
    type === 'channel.raid'
      ? event.to_broadcaster_user_id
      : event.broadcaster_user_id;
  if (
    channel !== broadcasterId ||
    (event.source_broadcaster_user_id &&
      event.source_broadcaster_user_id !== broadcasterId)
  )
    return null;
  const parsed = Date.parse(message.metadata?.message_timestamp),
    ts = Number.isFinite(parsed) ? parsed : Date.now();
  const user =
    event.chatter_user_login ||
    event.user_login ||
    event.from_broadcaster_user_login ||
    event.broadcaster_user_login ||
    'anonymous';
  const item = {
    ts,
    kind: type === 'channel.chat.message' ? 'chat' : 'event',
    user,
    text: '',
    eventType: type,
    meta: {}
  };
  switch (type) {
    case 'channel.chat.message':
      item.text = event.message?.text || '';
      item.meta = {
        messageId: event.message_id,
        userId: event.chatter_user_id,
        isBroadcaster: event.chatter_user_id === broadcasterId,
        isMod:
          event.badges?.some(
            (x) => x.set_id === 'moderator' || x.set_id === 'broadcaster'
          ) || false
      };
      break;
    case 'channel.follow':
      item.text = `${user} followed`;
      break;
    case 'channel.raid':
      item.text = `${user} raided with ${event.viewers} viewers`;
      item.meta = { viewers: event.viewers };
      break;
    case 'channel.subscribe':
      item.text = `${user} ${event.is_gift ? 'received a gift subscription' : 'subscribed'} (Tier ${Number(event.tier) / 1000})`;
      item.meta = { tier: event.tier, isGift: event.is_gift };
      break;
    case 'channel.subscription.gift':
      item.text = `${event.is_anonymous ? 'An anonymous viewer' : user} gifted ${event.total} subscriptions`;
      item.meta = { total: event.total };
      break;
    case 'channel.subscription.message':
      item.text = `${user} celebrated ${event.cumulative_months} months${event.message?.text ? `: ${event.message.text}` : ''}`;
      break;
    case 'channel.cheer':
      item.text = `${event.is_anonymous ? 'An anonymous viewer' : user} cheered ${event.bits} bits${event.message ? `: ${event.message}` : ''}`;
      item.meta = { bits: event.bits };
      break;
    case 'channel.update':
      item.text = `Category: ${event.category_name}. Title: ${event.title}`;
      item.meta = { category: event.category_name, title: event.title };
      break;
    case 'stream.online':
      item.text = `${user} went live`;
      break;
    case 'stream.offline':
      item.text = `${user} went offline`;
      break;
    default:
      return null;
  }
  return item;
}
