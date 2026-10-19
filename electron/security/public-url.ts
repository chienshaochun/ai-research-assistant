import { isIP } from 'node:net';

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) =>
    !Number.isInteger(value) || value < 0 || value > 255
  )) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 88 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') ||
      host.endsWith('.test') || host.endsWith('.invalid') || host.endsWith('.example')) return true;
  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) {
    const firstGroup = Number.parseInt(host.split(':', 1)[0] || '0', 16);
    const globalUnicast = firstGroup >= 0x2000 && firstGroup <= 0x3fff;
    return !globalUnicast || host.startsWith('2001:db8:') || host.startsWith('2001:2:') ||
      host.startsWith('2001:0:') || /^2001:(?:1[0-9a-f]|2[0-9a-f]):/.test(host);
  }
  return !host.includes('.');
}

export function isPublicIpAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return isIP(host) !== 0 && !isPrivateHostname(host);
}

export function normalizePublicHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        isPrivateHostname(url.hostname)) return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}
