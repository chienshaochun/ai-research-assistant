import type { ContentReader } from './content-reader.js';
import { SafeHttpContentReader } from './content-reader.js';
import {
  normalizeSearchCandidate,
  validateSearchRequest,
  type SearchCandidateInput,
  type SearchProvider,
  type SearchRequest,
} from './search-provider.js';

const ARXIV_QUERY_ENDPOINT = 'https://export.arxiv.org/api/query';
const ARXIV_MINIMUM_INTERVAL_MS = 3_000;
const ARXIV_MAX_ATTEMPTS = 2;
const ARXIV_RETRY_DELAY_MS = 5_000;

export interface ArxivSearchProviderOptions {
  reader?: ContentReader;
  minimumIntervalMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  now?: () => Date;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeXmlText(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', quot: '"',
  };
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return withoutCdata.replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    (entity, code: string) => {
      if (!code.startsWith('#')) return named[code.toLowerCase()] ?? entity;
      const hexadecimal = code.toLowerCase().startsWith('#x');
      const point = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    },
  );
}

function elementText(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(
    `<(?:[a-z][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z][\\w.-]*:)?${name}\\s*>`,
    'i',
  ));
  return match ? normalizeWhitespace(decodeXmlText(match[1])) : undefined;
}

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function canonicalArxivUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['arxiv.org', 'www.arxiv.org'].includes(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/abs\/(.+)$/);
    if (!match) return null;
    const identifier = match[1].replace(/v\d+$/i, '');
    if (!identifier || !/^[a-z0-9./-]+$/i.test(identifier)) return null;
    return `https://arxiv.org/abs/${identifier}`;
  } catch {
    return null;
  }
}

function authorLabel(entry: string): string | null {
  const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author\s*>/gi)]
    .map((match) => elementText(match[1], 'name'))
    .filter((name): name is string => Boolean(name));
  if (authors.length === 0) return null;
  let label = '';
  for (const author of authors) {
    const next = label ? `${label}, ${author}` : author;
    if (next.length > 300) return `${label.slice(0, 297)}...`;
    label = next;
  }
  return label;
}

export function parseArxivAtomFeed(xml: string, maxResults: number): SearchCandidateInput[] {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 25) {
    throw new Error('arXiv 解析結果上限必須是 1 到 25 的整數。');
  }
  const candidates: SearchCandidateInput[] = [];
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi)) {
    const entry = match[1];
    const url = canonicalArxivUrl(elementText(entry, 'id'));
    const title = elementText(entry, 'title');
    const abstract = elementText(entry, 'summary');
    const publishedDate = isoDate(elementText(entry, 'published'));
    if (!url || !title || !abstract || !publishedDate) continue;
    candidates.push({
      title: title.slice(0, 500),
      url,
      authorOrOrganization: authorLabel(entry),
      publishedDate,
      updatedDate: isoDate(elementText(entry, 'updated')),
      sourceType: 'paper',
      evidenceLevel: 'abstract',
      excerpt: abstract.slice(0, 4_000),
    });
    if (candidates.length === maxResults) break;
  }
  return candidates;
}

const TOPIC_ALIASES: ReadonlyArray<[RegExp, string]> = [
  [/AI\s*Agent|AI\s*智慧體|智慧體|Agent/i, 'AI agent'],
  [/RAG|檢索增強生成|檢索式生成/i, 'retrieval augmented generation'],
  [/LLM\s*Evaluation|LLM\s*評估|大型語言模型評估/i, 'large language model evaluation'],
  [/推論效率/i, 'large language model inference efficiency'],
  [/AI\s*Application|AI\s*應用/i, 'large language model application'],
];

const RESULT_PATTERNS_BY_TERM: Readonly<Record<string, readonly RegExp[]>> = {
  'AI agent': [
    /\bAI\s+agents?\b/i,
    /\bartificial\s+intelligence\s+agents?\b/i,
    /\bagentic\b/i,
    /\bagents?\b/i,
  ],
  'retrieval augmented generation': [
    /\bRAG\b/i,
    /\bretrieval[-\s]+augmented\s+generation\b/i,
  ],
  'large language model evaluation': [
    /\bLLM\s+evaluation\b/i,
    /\blarge\s+language\s+model\s+evaluation\b/i,
    /\bevaluat(?:e|es|ed|ing|ion)\b.{0,40}\b(?:LLM|large\s+language\s+model)/i,
  ],
  'large language model inference efficiency': [
    /\binference\s+(?:efficiency|optimization|acceleration)\b/i,
    /\b(?:efficient|fast)\s+(?:LLM|large\s+language\s+model)\s+inference\b/i,
  ],
  'large language model application': [
    /\b(?:LLM|large\s+language\s+model)\s+applications?\b/i,
  ],
};

export function arxivSearchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const [pattern, alias] of TOPIC_ALIASES) {
    if (pattern.test(query) && !terms.includes(alias)) terms.push(alias);
  }
  if (terms.length > 0) return terms;
  const fallback = normalizeWhitespace(query.replace(/["\\]/g, ' ')).slice(0, 200);
  return fallback ? [fallback] : [];
}

/**
 * arXiv returns newest-first results for our query. Within that bounded result
 * set, prefer papers covering more requested concepts before title and abstract
 * matches. Equal scores preserve arXiv's original order.
 */
export function rankArxivCandidates(
  candidates: readonly SearchCandidateInput[],
  query: string,
): SearchCandidateInput[] {
  const conceptPatterns = arxivSearchTerms(query)
    .map((term) => RESULT_PATTERNS_BY_TERM[term])
    .filter((patterns): patterns is readonly RegExp[] => Boolean(patterns));
  if (conceptPatterns.length === 0) return [...candidates];

  return candidates.map((candidate, index) => {
    const title = candidate.title;
    const excerpt = candidate.excerpt ?? '';
    let coverage = 0;
    let titleMatches = 0;
    let abstractMatches = 0;
    for (const patterns of conceptPatterns) {
      const titleMatched = patterns.some((pattern) => pattern.test(title));
      const abstractMatched = patterns.some((pattern) => pattern.test(excerpt));
      if (titleMatched || abstractMatched) coverage += 1;
      if (titleMatched) titleMatches += 1;
      if (abstractMatched) abstractMatches += 1;
    }
    return { candidate, index, coverage, titleMatches, abstractMatches };
  }).sort((left, right) =>
    right.coverage - left.coverage ||
    right.titleMatches - left.titleMatches ||
    right.abstractMatches - left.abstractMatches ||
    left.index - right.index
  ).map(({ candidate }) => candidate);
}

export function buildArxivApiUrl(request: SearchRequest): string {
  const validated = validateSearchRequest(request);
  const terms = arxivSearchTerms(validated.query);
  if (terms.length === 0) throw new Error('arXiv 搜尋主題不可為空。');
  const url = new URL(ARXIV_QUERY_ENDPOINT);
  url.searchParams.set('search_query', terms.map((term) => `all:"${term}"`).join(' OR '));
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(validated.maxResults));
  url.searchParams.set('sortBy', 'submittedDate');
  url.searchParams.set('sortOrder', 'descending');
  return url.href;
}

export class ArxivSearchProvider implements SearchProvider {
  readonly id = 'arxiv-public-api';
  readonly publicationDateSupport = 'verified' as const;
  readonly scopeDescription = 'arXiv 公開 metadata API（論文標題、作者、首次提交日、更新日與摘要；非全文；有界結果依主題涵蓋度本機排序）';
  private readonly reader: ContentReader;
  private readonly minimumIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private lastRequestStartedAt = Number.NEGATIVE_INFINITY;

  constructor(options: ArxivSearchProviderOptions = {}) {
    this.reader = options.reader ?? new SafeHttpContentReader({
      maxBytes: 1_000_000,
      maxTextCharacters: 500_000,
      timeoutMs: 20_000,
    });
    this.minimumIntervalMs = options.minimumIntervalMs ?? ARXIV_MINIMUM_INTERVAL_MS;
    this.maxAttempts = options.maxAttempts ?? ARXIV_MAX_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? ARXIV_RETRY_DELAY_MS;
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? abortableDelay;
    if (!Number.isInteger(this.minimumIntervalMs) ||
        this.minimumIntervalMs < 0 || this.minimumIntervalMs > 60_000) {
      throw new Error('arXiv 請求間隔必須是 0 到 60,000 ms 的整數。');
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 3) {
      throw new Error('arXiv 嘗試次數必須是 1 到 3 的整數。');
    }
    if (!Number.isInteger(this.retryDelayMs) ||
        this.retryDelayMs < 0 || this.retryDelayMs > 60_000) {
      throw new Error('arXiv 重試等待必須是 0 到 60,000 ms 的整數。');
    }
  }

  async search(
    request: SearchRequest,
    signal: AbortSignal,
  ): Promise<readonly SearchCandidateInput[]> {
    const validated = validateSearchRequest(request);
    signal.throwIfAborted();
    const url = buildArxivApiUrl(validated);
    const feedCandidate = normalizeSearchCandidate({
      title: 'arXiv API query feed',
      url,
      authorOrOrganization: 'arXiv',
      sourceType: 'rss',
      evidenceLevel: 'metadata',
    }, this.id, this.now().toISOString());
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const waitMs = Math.max(
        0,
        this.lastRequestStartedAt + this.minimumIntervalMs - this.now().valueOf(),
      );
      if (waitMs > 0) await this.wait(waitMs, signal);
      signal.throwIfAborted();
      this.lastRequestStartedAt = this.now().valueOf();

      const result = await this.reader.read(feedCandidate, signal);
      signal.throwIfAborted();
      if (result.status === 'read') {
        return rankArxivCandidates(
          parseArxivAtomFeed(result.text, validated.maxResults),
          validated.query,
        );
      }
      const httpStatus = result.errorCode === 'http_status'
        ? Number.parseInt(result.errorMessage.match(/HTTP\s+(\d{3})/i)?.[1] ?? '', 10)
        : Number.NaN;
      const retryable = ['timeout', 'network_error', 'dns_lookup_failed'].includes(result.errorCode) ||
        (result.errorCode === 'http_status' &&
          ([408, 425, 429].includes(httpStatus) || httpStatus >= 500));
      if (!retryable || attempt === this.maxAttempts) {
        throw new Error(
          `arXiv API 讀取失敗（${result.errorCode}）：${result.errorMessage}` +
          (attempt > 1 ? `（已嘗試 ${attempt} 次）` : ''),
        );
      }
      if (this.retryDelayMs > 0) await this.wait(this.retryDelayMs, signal);
    }
    throw new Error('arXiv API 讀取失敗。');
  }
}
