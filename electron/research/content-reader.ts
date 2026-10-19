import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicIpAddress, normalizePublicHttpUrl } from '../security/public-url.js';
import {
  sourceIdForUrl,
  type EvidenceLevel,
  type SearchCandidate,
} from './search-provider.js';

export const CONTENT_READ_ERROR_CODES = [
  'unsafe_url',
  'source_id_mismatch',
  'dns_lookup_failed',
  'non_public_address',
  'redirect_missing_location',
  'redirect_limit_exceeded',
  'redirect_loop',
  'http_status',
  'unsupported_content_type',
  'unsupported_content_encoding',
  'content_too_large',
  'empty_content',
  'network_error',
  'timeout',
] as const;
export type ContentReadErrorCode = typeof CONTENT_READ_ERROR_CODES[number];

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface HttpHopResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;
export type HttpHopTransport = (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
  maxBytes: number,
) => Promise<HttpHopResponse>;

export interface ContentReadSuccess {
  status: 'read';
  sourceId: string;
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
  retrievedAt: string;
  contentType: string;
  contentHash: string;
  text: string;
  textTruncated: boolean;
  evidenceLevel?: EvidenceLevel;
}

export interface ContentReadFailure {
  status: 'failed';
  sourceId: string;
  requestedUrl: string;
  finalUrl: string | null;
  redirects: string[];
  retrievedAt: string;
  errorCode: ContentReadErrorCode;
  errorMessage: string;
}

export type ContentReadResult = ContentReadSuccess | ContentReadFailure;

export interface ContentReader {
  read(candidate: SearchCandidate, signal: AbortSignal): Promise<ContentReadResult>;
}

export interface SafeHttpContentReaderOptions {
  resolver?: AddressResolver;
  transport?: HttpHopTransport;
  now?: () => Date;
  maxRedirects?: number;
  maxBytes?: number;
  maxTextCharacters?: number;
  timeoutMs?: number;
}

class ContentReadError extends Error {
  constructor(readonly code: ContentReadErrorCode, message: string) {
    super(message);
    this.name = 'ContentReadError';
  }
}

const defaultResolver: AddressResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

export const nodeHttpTransport: HttpHopTransport = (
  url,
  address,
  signal,
  maxBytes,
) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET',
    signal,
    lookup: pinnedLookup(address),
    headers: {
      Accept: 'text/html, application/xhtml+xml, application/atom+xml, application/rss+xml, application/xml, text/xml, text/plain;q=0.9',
      'Accept-Encoding': 'identity',
      'User-Agent': 'AI-Research-Assistant/0.1 (local research reader)',
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    response.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        response.destroy(new ContentReadError(
          'content_too_large', `回應內容超過 ${maxBytes} bytes。`,
        ));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }
      resolve({
        status: response.statusCode ?? 0,
        headers,
        body: Buffer.concat(chunks),
      });
    });
    response.on('error', reject);
  });
  request.on('error', reject);
  request.end();
});

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

async function resolvePublicAddress(
  url: URL,
  resolver: AddressResolver,
): Promise<ResolvedAddress> {
  const hostname = normalizedHostname(url.hostname);
  let addresses: readonly ResolvedAddress[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new ContentReadError('dns_lookup_failed', '無法解析來源網域。');
    }
  }
  if (addresses.length === 0) {
    throw new ContentReadError('dns_lookup_failed', '來源網域沒有可用的 IP 位址。');
  }
  if (addresses.some(({ address, family }) =>
    !isPublicIpAddress(address) || isIP(normalizedHostname(address)) !== family
  )) {
    throw new ContentReadError('non_public_address', '來源網域解析到非公開 IP 位址。');
  }
  return addresses[0];
}

function parseContentType(value: string | undefined): { mime: string; charset: string } {
  const [mimePart = '', ...parameters] = (value ?? '').split(';');
  const mime = mimePart.trim().toLowerCase();
  const supported = new Set([
    'text/html', 'application/xhtml+xml', 'text/plain',
    'application/atom+xml', 'application/rss+xml', 'application/xml', 'text/xml',
  ]);
  if (!supported.has(mime)) {
    throw new ContentReadError('unsupported_content_type', `不支援的內容類型：${mime || 'missing'}。`);
  }
  const charsetParameter = parameters
    .map((parameter) => parameter.trim())
    .find((parameter) => parameter.toLowerCase().startsWith('charset='));
  return {
    mime,
    charset: charsetParameter?.slice('charset='.length).trim().replace(/^['"]|['"]$/g, '') || 'utf-8',
  };
}

function decodeBody(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    throw new ContentReadError('unsupported_content_type', `不支援的文字編碼：${charset}。`);
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const point = Number.parseInt(code.startsWith('#x') ? code.slice(2) : code.slice(1),
        code.startsWith('#x') ? 16 : 10);
      if (point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) {
        return String.fromCodePoint(point);
      }
      return entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function sanitizeExtractedText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
}

export function htmlToPlainText(html: string): string {
  const withoutInactiveContent = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|article|section|header|footer|main|aside|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withoutInactiveContent)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function failure(
  candidate: SearchCandidate,
  retrievedAt: string,
  redirects: string[],
  finalUrl: string | null,
  error: ContentReadError,
): ContentReadFailure {
  return {
    status: 'failed',
    sourceId: candidate.id,
    requestedUrl: candidate.url,
    finalUrl,
    redirects,
    retrievedAt,
    errorCode: error.code,
    errorMessage: error.message,
  };
}

export class SafeHttpContentReader implements ContentReader {
  private readonly resolver: AddressResolver;
  private readonly transport: HttpHopTransport;
  private readonly now: () => Date;
  private readonly maxRedirects: number;
  private readonly maxBytes: number;
  private readonly maxTextCharacters: number;
  private readonly timeoutMs: number;

  constructor(options: SafeHttpContentReaderOptions = {}) {
    this.resolver = options.resolver ?? defaultResolver;
    this.transport = options.transport ?? nodeHttpTransport;
    this.now = options.now ?? (() => new Date());
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.maxTextCharacters = options.maxTextCharacters ?? 100_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.maxRedirects) || this.maxRedirects < 0 || this.maxRedirects > 10) {
      throw new Error('重新導向上限必須是 0 到 10 的整數。');
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 5_000_000) {
      throw new Error('內容大小上限必須是 1 到 5,000,000 bytes。');
    }
    if (!Number.isInteger(this.maxTextCharacters) || this.maxTextCharacters < 1 ||
        this.maxTextCharacters > 500_000) {
      throw new Error('文字長度上限必須是 1 到 500,000 字元。');
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error('讀取逾時必須介於 100 到 60,000 ms。');
    }
  }

  async read(candidate: SearchCandidate, signal: AbortSignal): Promise<ContentReadResult> {
    const retrievedAt = this.now().toISOString();
    const redirects: string[] = [];
    let currentUrl: string | null = candidate.url;
    const visited = new Set<string>();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        signal.throwIfAborted();
        const normalized = normalizePublicHttpUrl(currentUrl);
        if (!normalized) throw new ContentReadError('unsafe_url', '來源不是安全的公開 HTTP(S) URL。');
        currentUrl = normalized;
        if (redirectCount === 0 && sourceIdForUrl(currentUrl) !== candidate.id) {
          throw new ContentReadError('source_id_mismatch', '來源 ID 與要求讀取的 URL 不一致。');
        }
        if (visited.has(currentUrl)) {
          throw new ContentReadError('redirect_loop', '來源重新導向形成循環。');
        }
        visited.add(currentUrl);

        const url = new URL(currentUrl);
        const address = await resolvePublicAddress(url, this.resolver);
        requestSignal.throwIfAborted();
        const response = await this.transport(url, address, requestSignal, this.maxBytes);
        requestSignal.throwIfAborted();

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirectCount >= this.maxRedirects) {
            throw new ContentReadError('redirect_limit_exceeded', '來源超過重新導向次數上限。');
          }
          const location = response.headers.location;
          if (!location) {
            throw new ContentReadError('redirect_missing_location', '重新導向回應缺少 Location。');
          }
          redirects.push(currentUrl);
          currentUrl = new URL(location, currentUrl).href;
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new ContentReadError('http_status', `來源回應 HTTP ${response.status}。`);
        }
        const encoding = response.headers['content-encoding']?.trim().toLowerCase();
        if (encoding && encoding !== 'identity') {
          throw new ContentReadError('unsupported_content_encoding', `不支援的內容編碼：${encoding}。`);
        }
        if (response.body.byteLength > this.maxBytes) {
          throw new ContentReadError('content_too_large', `回應內容超過 ${this.maxBytes} bytes。`);
        }
        const { mime, charset } = parseContentType(response.headers['content-type']);
        const decoded = decodeBody(response.body, charset);
        const extracted = [
          'text/plain', 'application/atom+xml', 'application/rss+xml', 'application/xml', 'text/xml',
        ]
          .includes(mime) ? decoded : htmlToPlainText(decoded);
        const plainText = sanitizeExtractedText(extracted);
        if (!plainText) {
          throw new ContentReadError('empty_content', '來源沒有可讀取的文字內容。');
        }
        const textTruncated = plainText.length > this.maxTextCharacters;
        const text = plainText.slice(0, this.maxTextCharacters);
        return {
          status: 'read',
          sourceId: candidate.id,
          requestedUrl: candidate.url,
          finalUrl: currentUrl,
          redirects,
          retrievedAt,
          contentType: mime,
          contentHash: createHash('sha256').update(response.body).digest('hex'),
          text,
          textTruncated,
        };
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeoutSignal.aborted) {
        return failure(candidate, retrievedAt, redirects, currentUrl, new ContentReadError(
          'timeout', `來源讀取超過 ${this.timeoutMs} ms。`,
        ));
      }
      if (error instanceof ContentReadError) {
        return failure(candidate, retrievedAt, redirects, currentUrl, error);
      }
      return failure(candidate, retrievedAt, redirects, currentUrl, new ContentReadError(
        'network_error', '來源讀取發生網路錯誤。',
      ));
    }
  }
}

export interface EvidenceAwareContentReaderOptions {
  now?: () => Date;
  preferArxivHtmlFullText?: boolean;
  minimumFullTextCharacters?: number;
}

export function arxivHtmlUrl(sourceUrl: string): string | null {
  const normalized = normalizePublicHttpUrl(sourceUrl);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (parsed.hostname !== 'arxiv.org') return null;
  const match = parsed.pathname.match(/^\/abs\/([A-Za-z0-9._/-]+)$/);
  if (!match || match[1].includes('..')) return null;
  return `https://arxiv.org/html/${match[1]}`;
}

/**
 * An arXiv API abstract is already retrieved source evidence. Reusing it avoids
 * a second request while retaining its weaker evidence level in the report.
 */
export class EvidenceAwareContentReader implements ContentReader {
  private readonly now: () => Date;
  private readonly preferArxivHtmlFullText: boolean;
  private readonly minimumFullTextCharacters: number;

  constructor(
    private readonly fallback: ContentReader,
    options: EvidenceAwareContentReaderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.preferArxivHtmlFullText = options.preferArxivHtmlFullText ?? false;
    this.minimumFullTextCharacters = options.minimumFullTextCharacters ?? 3_000;
    if (!Number.isInteger(this.minimumFullTextCharacters) ||
        this.minimumFullTextCharacters < 500 || this.minimumFullTextCharacters > 50_000) {
      throw new Error('全文最小字元數必須是 500 到 50,000 的整數。');
    }
  }

  private abstractResult(candidate: SearchCandidate): ContentReadSuccess | null {
    if (candidate.evidenceLevel !== 'abstract' || !candidate.excerpt) return null;
    const text = sanitizeExtractedText(candidate.excerpt);
    if (!text) return null;
    return {
      status: 'read',
      sourceId: candidate.id,
      requestedUrl: candidate.url,
      finalUrl: candidate.url,
      redirects: [],
      retrievedAt: this.now().toISOString(),
      contentType: 'application/vnd.ai-research-assistant.abstract+text',
      contentHash: createHash('sha256').update(text).digest('hex'),
      text,
      textTruncated: false,
      evidenceLevel: 'abstract',
    };
  }

  async read(candidate: SearchCandidate, signal: AbortSignal): Promise<ContentReadResult> {
    signal.throwIfAborted();
    const abstract = this.abstractResult(candidate);
    const htmlUrl = this.preferArxivHtmlFullText ? arxivHtmlUrl(candidate.url) : null;
    if (abstract && htmlUrl) {
      const htmlCandidate: SearchCandidate = {
        ...candidate,
        id: sourceIdForUrl(htmlUrl),
        url: htmlUrl,
        evidenceLevel: 'metadata',
        excerpt: null,
      };
      const fullText = await this.fallback.read(htmlCandidate, signal);
      signal.throwIfAborted();
      if (fullText.status === 'read' && fullText.text.length >= this.minimumFullTextCharacters) {
        return {
          ...fullText,
          sourceId: candidate.id,
          requestedUrl: candidate.url,
          evidenceLevel: 'full_text',
        };
      }
      return abstract;
    }
    if (abstract) return abstract;
    return this.fallback.read(candidate, signal);
  }
}
