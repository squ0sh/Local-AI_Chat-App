export function isLoopbackPeer(req) {
  if (req?.headers?.['cf-connecting-ip']) return false;
  let address = String(req?.socket?.remoteAddress || '').toLowerCase();
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  if (address === '::1') return true;
  const match = address.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
}

export function isSameOriginRequest(req) {
  const origin = String(req?.headers?.origin || '');
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.host.toLowerCase() === String(req?.headers?.host || '').toLowerCase();
  } catch {
    return false;
  }
}
