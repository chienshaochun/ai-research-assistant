import { describe, expect, it, vi } from 'vitest';
import {
  ArxivSearchProvider,
  arxivSearchTerms,
  buildArxivApiUrl,
  parseArxivAtomFeed,
  rankArxivCandidates,
} from '../electron/research/arxiv-search-provider.js';
import type { ContentReader } from '../electron/research/content-reader.js';

const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2610.00002v2</id>
    <updated>2026-10-01T04:00:00Z</updated>
    <published>2026-09-29T03:00:00Z</published>
    <title>  Trace &amp; Tool Evaluation  </title>
    <summary>We evaluate &lt;agent&gt; trajectories.\nThe method preserves evidence.</summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2610.00003v1</id>
    <updated>2026-10-01T05:00:00Z</updated>
    <published>2026-10-01T05:00:00Z</published>
    <title>Retrieval Study</title>
    <summary><![CDATA[A grounded RAG abstract.]]></summary>
    <author><name>Carol Example</name></author>
  </entry>
</feed>`;

function feedReader(xml = feed): ContentReader {
  return {
    read: vi.fn(async (candidate) => ({
      status: 'read' as const,
      sourceId: candidate.id,
      requestedUrl: candidate.url,
      finalUrl: candidate.url,
      redirects: [],
      retrievedAt: '2026-10-01T12:00:00.000Z',
      contentType: 'application/atom+xml',
      contentHash: '0'.repeat(64),
      text: xml,
      textTruncated: false,
    })),
  };
}

describe('arXiv public metadata provider', () => {
  it('maps the primary Chinese AI topics to useful English paper terms', () => {
    expect(arxivSearchTerms('AI Agent 與 RAG、LLM Evaluation')).toEqual([
      'AI agent',
      'retrieval augmented generation',
      'large language model evaluation',
    ]);
    expect(arxivSearchTerms('這次改看推論效率')).toEqual([
      'large language model inference efficiency',
    ]);
  });

  it('builds one bounded newest-first API request', () => {
    const url = new URL(buildArxivApiUrl({
      query: 'AI Agent 與 RAG',
      maxResults: 6,
      publishedFrom: '2026-09-25',
      publishedTo: '2026-10-01',
    }));

    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(url.searchParams.get('search_query')).toBe(
      'all:"AI agent" OR all:"retrieval augmented generation"',
    );
    expect(url.searchParams.get('max_results')).toBe('6');
    expect(url.searchParams.get('sortBy')).toBe('submittedDate');
    expect(url.searchParams.get('sortOrder')).toBe('descending');
  });

  it('parses dates, authors, abstracts, entities, and canonical paper URLs', () => {
    expect(parseArxivAtomFeed(feed, 1)).toEqual([{
      title: 'Trace & Tool Evaluation',
      url: 'https://arxiv.org/abs/2610.00002',
      authorOrOrganization: 'Alice Example, Bob Example',
      publishedDate: '2026-09-29',
      updatedDate: '2026-10-01',
      sourceType: 'paper',
      evidenceLevel: 'abstract',
      excerpt: 'We evaluate <agent> trajectories. The method preserves evidence.',
    }]);
  });

  it('skips malformed entries rather than inventing missing publication dates', () => {
    const malformed = '<feed><entry><id>http://arxiv.org/abs/2610.12345</id>' +
      '<title>No date</title><summary>Abstract</summary></entry></feed>';
    expect(parseArxivAtomFeed(malformed, 3)).toEqual([]);
  });

  it('ranks coverage of all requested concepts before recency within the bounded feed', () => {
    const candidates = [
      {
        title: 'A New AI Agent Runtime', url: 'https://arxiv.org/abs/2610.00001',
        sourceType: 'paper' as const, evidenceLevel: 'abstract' as const,
        excerpt: 'A runtime for autonomous agents.',
      },
      {
        title: 'A New RAG Retriever', url: 'https://arxiv.org/abs/2610.00002',
        sourceType: 'paper' as const, evidenceLevel: 'abstract' as const,
        excerpt: 'Retrieval-augmented generation with a sparse index.',
      },
      {
        title: 'Grounded Agents', url: 'https://arxiv.org/abs/2610.00003',
        sourceType: 'paper' as const, evidenceLevel: 'abstract' as const,
        excerpt: 'AI agents use RAG for retrieval-augmented generation.',
      },
    ];

    expect(rankArxivCandidates(candidates, 'AI Agent 與 RAG').map(({ url }) => url)).toEqual([
      'https://arxiv.org/abs/2610.00003',
      'https://arxiv.org/abs/2610.00001',
      'https://arxiv.org/abs/2610.00002',
    ]);
  });

  it('preserves the provider order when no known topic concept can be scored', () => {
    const candidates = parseArxivAtomFeed(feed, 2);
    expect(rankArxivCandidates(candidates, '量子拓撲').map(({ url }) => url))
      .toEqual(candidates.map(({ url }) => url));
  });

  it('uses one safe reader call and returns abstract-level candidates', async () => {
    const reader = feedReader();
    const provider = new ArxivSearchProvider({ reader, minimumIntervalMs: 0 });
    const signal = new AbortController().signal;

    await expect(provider.search({ query: 'AI Agent', maxResults: 2 }, signal))
      .resolves.toHaveLength(2);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'arxiv-public-api',
        sourceType: 'rss',
      }),
      signal,
    );
  });

  it('keeps the official request interval across searches on one provider', async () => {
    let now = new Date('2026-10-02T00:00:00.000Z').valueOf();
    const wait = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const provider = new ArxivSearchProvider({
      reader: feedReader(), minimumIntervalMs: 3_000,
      now: () => new Date(now), wait,
    });
    const signal = new AbortController().signal;

    await provider.search({ query: 'AI Agent', maxResults: 2 }, signal);
    await provider.search({ query: 'RAG', maxResults: 2 }, signal);

    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(3_000, signal);
  });

  it('turns a safe-reader failure into an explicit provider failure', async () => {
    const reader: ContentReader = {
      read: vi.fn(async (candidate) => ({
        status: 'failed' as const,
        sourceId: candidate.id,
        requestedUrl: candidate.url,
        finalUrl: candidate.url,
        redirects: [],
        retrievedAt: '2026-10-01T12:00:00.000Z',
        errorCode: 'http_status' as const,
        errorMessage: 'HTTP 503',
      })),
    };
    const provider = new ArxivSearchProvider({
      reader, minimumIntervalMs: 0, maxAttempts: 1, retryDelayMs: 0,
    });

    await expect(provider.search(
      { query: 'RAG', maxResults: 3 }, new AbortController().signal,
    )).rejects.toThrow('http_status');
  });

  it('retries one transient failure and then returns the feed', async () => {
    const reader: ContentReader = {
      read: vi.fn()
        .mockResolvedValueOnce({
          status: 'failed' as const,
          sourceId: 'ignored', requestedUrl: 'https://export.arxiv.org/api/query',
          finalUrl: 'https://export.arxiv.org/api/query', redirects: [],
          retrievedAt: '2026-10-01T12:00:00.000Z',
          errorCode: 'timeout' as const, errorMessage: 'Fixture timeout.',
        })
        .mockImplementationOnce(async (candidate) => ({
          status: 'read' as const,
          sourceId: candidate.id, requestedUrl: candidate.url, finalUrl: candidate.url,
          redirects: [], retrievedAt: '2026-10-01T12:00:05.000Z',
          contentType: 'application/atom+xml', contentHash: '0'.repeat(64),
          text: feed, textTruncated: false,
        })),
    };
    const wait = vi.fn(async () => undefined);
    const provider = new ArxivSearchProvider({
      reader, minimumIntervalMs: 0, maxAttempts: 2, retryDelayMs: 5_000, wait,
    });

    await expect(provider.search(
      { query: 'AI Agent', maxResults: 2 }, new AbortController().signal,
    )).resolves.toHaveLength(2);
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
  });

  it('does not retry a permanent HTTP client error', async () => {
    const reader: ContentReader = {
      read: vi.fn(async (candidate) => ({
        status: 'failed' as const,
        sourceId: candidate.id, requestedUrl: candidate.url, finalUrl: candidate.url,
        redirects: [], retrievedAt: '2026-10-01T12:00:00.000Z',
        errorCode: 'http_status' as const, errorMessage: '來源回應 HTTP 400。',
      })),
    };
    const provider = new ArxivSearchProvider({
      reader, minimumIntervalMs: 0, maxAttempts: 2, retryDelayMs: 0,
    });

    await expect(provider.search(
      { query: 'RAG', maxResults: 2 }, new AbortController().signal,
    )).rejects.toThrow('HTTP 400');
    expect(reader.read).toHaveBeenCalledOnce();
  });
});
