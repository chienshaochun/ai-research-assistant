import type { ContentReader } from './content-reader.js';
import { SafeHttpContentReader, htmlToPlainText } from './content-reader.js';
import {
  normalizeSearchCandidate,
  validateSearchRequest,
  type SearchCandidateInput,
  type SearchProvider,
  type SearchRequest,
} from './search-provider.js';

export interface OfficialFeedDefinition {
  id: string;
  name: string;
  organization: string;
  url: string;
  allowedHost: string;
}

export const DEFAULT_OFFICIAL_FEEDS: readonly OfficialFeedDefinition[] = [
  {
    id: 'openai-news',
    name: 'OpenAI News',
    organization: 'OpenAI',
    url: 'https://openai.com/news/rss.xml',
    allowedHost: 'openai.com',
  },
  {
    id: 'hugging-face-blog',
    name: 'Hugging Face Blog',
    organization: 'Hugging Face',
    url: 'https://huggingface.co/blog/feed.xml',
    allowedHost: 'huggingface.co',
  },
  {
    id: 'google-blog',
    name: 'Google Blog',
    organization: 'Google',
    url: 'https://blog.google/rss/',
    allowedHost: 'blog.google',
  },
];

export interface OfficialFeedSearchProviderOptions {
  reader?: ContentReader;
  feeds?: readonly OfficialFeedDefinition[];
  now?: () => Date;
  maxEntriesPerFeed?: number;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeXml(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code: string) => {
      if (!code.startsWith('#')) return named[code.toLowerCase()] ?? entity;
      const hexadecimal = code.toLowerCase().startsWith('#x');
      const point = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    });
}

function elementText(xml: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const match = xml.match(new RegExp(
      `<(?:[a-z][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z][\\w.-]*:)?${name}\\s*>`,
      'i',
    ));
    if (match) {
      const plain = normalizeWhitespace(htmlToPlainText(decodeXml(match[1])));
      if (plain) return plain;
    }
  }
  return undefined;
}

function entryUrl(xml: string): string | undefined {
  for (const match of xml.matchAll(/<link\b([^>]*)>([\s\S]*?)<\/link\s*>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const relation = match[1].match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (href && (!relation || relation === 'alternate')) return decodeXml(href).trim();
    const body = normalizeWhitespace(decodeXml(match[2]));
    if (body) return body;
  }
  for (const match of xml.matchAll(/<link\b([^>]*)\/?\s*>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const relation = match[1].match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (href && (!relation || relation === 'alternate')) return decodeXml(href).trim();
  }
  return elementText(xml, ['guid', 'id']);
}

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function isAllowedFeedItemUrl(value: string | undefined, allowedHost: string): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const expected = allowedHost.toLowerCase();
    return url.protocol === 'https:' &&
      (hostname === expected || hostname.endsWith(`.${expected}`));
  } catch {
    return false;
  }
}

/** Parse only bounded, displayable metadata. Feed markup is always treated as untrusted data. */
export function parseOfficialFeed(
  xml: string,
  feed: OfficialFeedDefinition,
  maxEntries: number,
): SearchCandidateInput[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 50) {
    throw new Error('Official feed entry limit must be between 1 and 50.');
  }
  const candidates: SearchCandidateInput[] = [];
  const blocks = [
    ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi),
    ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi),
  ];
  for (const match of blocks) {
    const entry = match[1];
    const title = elementText(entry, ['title']);
    const url = entryUrl(entry);
    const excerpt = elementText(entry, ['description', 'summary', 'content', 'encoded']);
    if (!title || !excerpt || !isAllowedFeedItemUrl(url, feed.allowedHost)) continue;
    candidates.push({
      title: title.slice(0, 500),
      url,
      authorOrOrganization: elementText(entry, ['creator', 'author', 'name'])
        ?.slice(0, 300) ?? feed.organization,
      publishedDate: isoDate(elementText(entry, ['pubDate', 'published', 'date'])),
      updatedDate: isoDate(elementText(entry, ['updated', 'modified'])),
      sourceType: 'official_blog',
      evidenceLevel: 'snippet',
      excerpt: excerpt.slice(0, 4_000),
    });
    if (candidates.length === maxEntries) break;
  }
  return candidates;
}

function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._+-]{1,}|[\u3400-\u9fff]{2,}/g) ?? [])]
    .slice(0, 24);
}

function relevance(candidate: SearchCandidateInput, tokens: readonly string[]): number {
  const title = candidate.title.toLowerCase();
  const excerpt = (candidate.excerpt ?? '').toLowerCase();
  return tokens.reduce((score, token) =>
    score + (title.includes(token) ? 3 : 0) + (excerpt.includes(token) ? 1 : 0), 0);
}

export class OfficialFeedSearchProvider implements SearchProvider {
  readonly id = 'official-public-feeds';
  readonly publicationDateSupport = 'verified' as const;
  readonly scopeDescription: string;
  private readonly reader: ContentReader;
  private readonly feeds: readonly OfficialFeedDefinition[];
  private readonly now: () => Date;
  private readonly maxEntriesPerFeed: number;

  constructor(options: OfficialFeedSearchProviderOptions = {}) {
    this.reader = options.reader ?? new SafeHttpContentReader({
      maxBytes: 1_500_000,
      maxTextCharacters: 500_000,
      timeoutMs: 20_000,
    });
    this.feeds = options.feeds ?? DEFAULT_OFFICIAL_FEEDS;
    this.now = options.now ?? (() => new Date());
    this.maxEntriesPerFeed = options.maxEntriesPerFeed ?? 30;
    if (!Number.isInteger(this.maxEntriesPerFeed) ||
        this.maxEntriesPerFeed < 1 || this.maxEntriesPerFeed > 50) {
      throw new Error('Official feed entry limit must be between 1 and 50.');
    }
    this.scopeDescription = `Official public feeds: ${this.feeds.map(({ name }) => name).join(', ')}.`;
  }

  async search(request: SearchRequest, signal: AbortSignal): Promise<readonly SearchCandidateInput[]> {
    const validated = validateSearchRequest(request);
    const all: SearchCandidateInput[] = [];
    for (const feed of this.feeds) {
      signal.throwIfAborted();
      const candidate = normalizeSearchCandidate({
        title: feed.name,
        url: feed.url,
        authorOrOrganization: feed.organization,
        sourceType: 'rss',
        evidenceLevel: 'metadata',
      }, this.id, this.now().toISOString());
      const result = await this.reader.read(candidate, signal);
      signal.throwIfAborted();
      if (result.status === 'read') {
        all.push(...parseOfficialFeed(result.text, feed, this.maxEntriesPerFeed));
      }
    }
    const tokens = queryTokens(validated.query);
    return all.map((candidate, index) => ({ candidate, index, score: relevance(candidate, tokens) }))
      .sort((left, right) =>
        right.score - left.score ||
        (right.candidate.publishedDate ?? '').localeCompare(left.candidate.publishedDate ?? '') ||
        left.index - right.index)
      .slice(0, validated.maxResults * 2)
      .map(({ candidate }) => candidate);
  }
}
