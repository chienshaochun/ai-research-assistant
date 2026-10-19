import { describe, expect, it, vi } from 'vitest';
import type { ContentReader } from '../electron/research/content-reader.js';
import {
  OfficialFeedSearchProvider,
  parseOfficialFeed,
  type OfficialFeedDefinition,
} from '../electron/research/official-feed-search-provider.js';

const definition: OfficialFeedDefinition = {
  id: 'fixture', name: 'Fixture feed', organization: 'Fixture Labs',
  url: 'https://blog.example.com/feed.xml', allowedHost: 'example.com',
};

const rss = `<?xml version="1.0"?><rss><channel>
  <item>
    <title><![CDATA[Agent &amp; RAG Runtime]]></title>
    <link>https://blog.example.com/agent-runtime</link>
    <pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate>
    <dc:creator>Research Team</dc:creator>
    <description><![CDATA[<p>A tool-calling agent with grounded retrieval.</p>]]></description>
  </item>
  <item>
    <title>Untrusted host</title><link>https://evil.example.net/post</link>
    <pubDate>2026-10-05</pubDate><description>Should be excluded.</description>
  </item>
</channel></rss>`;

describe('official public feed provider', () => {
  it('constructs with the production safe-reader limits', () => {
    expect(() => new OfficialFeedSearchProvider()).not.toThrow();
  });

  it('parses bounded official entries, HTML excerpts, authors, and dates', () => {
    expect(parseOfficialFeed(rss, definition, 10)).toEqual([{
      title: 'Agent & RAG Runtime',
      url: 'https://blog.example.com/agent-runtime',
      authorOrOrganization: 'Research Team',
      publishedDate: '2026-10-05',
      updatedDate: null,
      sourceType: 'official_blog',
      evidenceLevel: 'snippet',
      excerpt: 'A tool-calling agent with grounded retrieval.',
    }]);
  });

  it('reads every configured feed and tolerates one failed endpoint', async () => {
    const second = {
      ...definition, id: 'broken', name: 'Broken',
      url: 'https://news.example.org/rss', allowedHost: 'example.org',
    };
    const reader: ContentReader = {
      read: vi.fn(async (candidate) => candidate.url === definition.url ? {
        status: 'read' as const,
        sourceId: candidate.id,
        requestedUrl: candidate.url,
        finalUrl: candidate.url,
        redirects: [],
        retrievedAt: '2026-10-06T00:00:00.000Z',
        contentType: 'application/rss+xml',
        contentHash: '0'.repeat(64),
        text: rss,
        textTruncated: false,
      } : {
        status: 'failed' as const,
        sourceId: candidate.id,
        requestedUrl: candidate.url,
        finalUrl: candidate.url,
        redirects: [],
        retrievedAt: '2026-10-06T00:00:00.000Z',
        errorCode: 'http_status' as const,
        errorMessage: 'HTTP 503',
      }),
    };
    const provider = new OfficialFeedSearchProvider({
      reader, feeds: [definition, second], now: () => new Date('2026-10-06T00:00:00Z'),
    });

    const result = await provider.search(
      { query: 'Agent RAG', maxResults: 3 }, new AbortController().signal,
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Agent & RAG Runtime');
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it('does not treat malformed or missing dates as recent dates', () => {
    const xml = '<rss><channel><item><title>Post</title>' +
      '<link>https://example.com/post</link><pubDate>unknown</pubDate>' +
      '<description>Evidence</description></item></channel></rss>';
    expect(parseOfficialFeed(xml, definition, 2)[0].publishedDate).toBeNull();
  });
});
