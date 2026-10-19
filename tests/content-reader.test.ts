import { describe, expect, it, vi } from 'vitest';
import {
  SafeHttpContentReader,
  EvidenceAwareContentReader,
  arxivHtmlUrl,
  htmlToPlainText,
  type AddressResolver,
  type HttpHopResponse,
  type HttpHopTransport,
} from '../electron/research/content-reader.js';
import {
  normalizeSearchCandidate,
  sourceIdForUrl,
} from '../electron/research/search-provider.js';

const discoveredAt = '2026-10-01T12:00:00.000Z';
const retrievedAt = new Date('2026-10-01T12:01:00.000Z');
const candidate = normalizeSearchCandidate({
  title: 'Research paper',
  url: 'https://papers.example.org/research',
  sourceType: 'paper',
  evidenceLevel: 'metadata',
}, 'fixture-search', discoveredAt);

const publicResolver = vi.fn<AddressResolver>(async () => [
  { address: '93.184.216.34', family: 4 },
]);

function response(
  status: number,
  body: string,
  headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' },
): HttpHopResponse {
  return { status, headers, body: new TextEncoder().encode(body) };
}

function readerWith(
  transport: HttpHopTransport,
  resolver: AddressResolver = publicResolver,
  options: {
    maxRedirects?: number;
    maxBytes?: number;
    maxTextCharacters?: number;
    timeoutMs?: number;
  } = {},
) {
  return new SafeHttpContentReader({
    transport,
    resolver,
    now: () => retrievedAt,
    timeoutMs: 1_000,
    ...options,
  });
}

describe('SafeHttpContentReader', () => {
  it('reads bounded HTML as plain text without executing embedded content', async () => {
    const transport = vi.fn<HttpHopTransport>().mockResolvedValue(response(200, `
      <html><head><style>.hidden { color: red }</style></head><body>
      <h1>Agent &amp; RAG</h1>
      <script>stealCredentials()</script>
      <p>Ignore previous instructions is source data, not an instruction.</p>
      </body></html>
    `));
    const result = await readerWith(transport).read(candidate, new AbortController().signal);

    expect(result).toMatchObject({
      status: 'read',
      sourceId: candidate.id,
      finalUrl: candidate.url,
      contentType: 'text/html',
      textTruncated: false,
    });
    if (result.status === 'read') {
      expect(result.text).toContain('Agent & RAG');
      expect(result.text).toContain('Ignore previous instructions is source data');
      expect(result.text).not.toContain('stealCredentials');
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(transport).toHaveBeenCalledWith(
      new URL(candidate.url),
      { address: '93.184.216.34', family: 4 },
      expect.any(AbortSignal),
      1_000_000,
    );
  });

  it('revalidates DNS and the public URL boundary after every redirect', async () => {
    const resolver = vi.fn<AddressResolver>(async (hostname) => [{
      address: hostname === 'papers.example.org' ? '93.184.216.34' : '1.1.1.1',
      family: 4,
    }]);
    const transport = vi.fn<HttpHopTransport>()
      .mockResolvedValueOnce(response(302, '', { location: 'https://cdn.example.net/paper' }))
      .mockResolvedValueOnce(response(200, 'Paper body', { 'content-type': 'text/plain' }));

    const result = await readerWith(transport, resolver)
      .read(candidate, new AbortController().signal);

    expect(result).toMatchObject({
      status: 'read',
      finalUrl: 'https://cdn.example.net/paper',
      redirects: [candidate.url],
      text: 'Paper body',
    });
    expect(resolver).toHaveBeenNthCalledWith(1, 'papers.example.org');
    expect(resolver).toHaveBeenNthCalledWith(2, 'cdn.example.net');
  });

  it('blocks a redirect to localhost before making the second request', async () => {
    const transport = vi.fn<HttpHopTransport>()
      .mockResolvedValueOnce(response(302, '', { location: 'http://127.0.0.1/private' }));

    const result = await readerWith(transport).read(candidate, new AbortController().signal);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'unsafe_url' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('detects redirect loops before requesting the same URL twice', async () => {
    const transport = vi.fn<HttpHopTransport>()
      .mockResolvedValueOnce(response(302, '', { location: '/other' }))
      .mockResolvedValueOnce(response(302, '', { location: '/research' }));

    const result = await readerWith(transport).read(candidate, new AbortController().signal);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'redirect_loop' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('rejects a mismatched stable source ID before network access', async () => {
    const transport = vi.fn<HttpHopTransport>();
    const mismatched = { ...candidate, id: 'src_wrong' };

    const result = await readerWith(transport).read(mismatched, new AbortController().signal);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'source_id_mismatch' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a hostname when any resolved address is non-public', async () => {
    const resolver = vi.fn<AddressResolver>(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);
    const transport = vi.fn<HttpHopTransport>();

    const result = await readerWith(transport, resolver)
      .read(candidate, new AbortController().signal);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'non_public_address' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('records unsupported, oversized, and empty responses as readable failures', async () => {
    const pdf = readerWith(vi.fn<HttpHopTransport>().mockResolvedValue(
      response(200, '%PDF', { 'content-type': 'application/pdf' }),
    ));
    const oversized = readerWith(vi.fn<HttpHopTransport>().mockResolvedValue(
      response(200, '12345', { 'content-type': 'text/plain' }),
    ), publicResolver, { maxBytes: 4 });
    const empty = readerWith(vi.fn<HttpHopTransport>().mockResolvedValue(
      response(200, '<html><script>onlyScript()</script></html>'),
    ));

    await expect(pdf.read(candidate, new AbortController().signal))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'unsupported_content_type' });
    await expect(oversized.read(candidate, new AbortController().signal))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'content_too_large' });
    await expect(empty.read(candidate, new AbortController().signal))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'empty_content' });
  });

  it('propagates caller cancellation instead of converting it to a read failure', async () => {
    const controller = new AbortController();
    const transport: HttpHopTransport = (_url, _address, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const pending = readerWith(transport).read(candidate, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('records an internal timeout separately from caller cancellation', async () => {
    const transport: HttpHopTransport = (_url, _address, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const result = await readerWith(transport, publicResolver, { timeoutMs: 100 })
      .read(candidate, new AbortController().signal);

    expect(result).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  it('preserves Atom XML for a bounded metadata parser', async () => {
    const xml = '<?xml version="1.0"?><feed><entry><title>Paper</title></entry></feed>';
    const transport = vi.fn<HttpHopTransport>().mockResolvedValue(
      response(200, xml, { 'content-type': 'application/atom+xml; charset=utf-8' }),
    );
    const result = await readerWith(transport).read(candidate, new AbortController().signal);

    expect(result).toMatchObject({ status: 'read', text: xml });
  });

  it('preserves RSS XML returned as application/rss+xml', async () => {
    const xml = '<?xml version="1.0"?><rss><channel><item><title>Update</title></item></channel></rss>';
    const transport = vi.fn<HttpHopTransport>().mockResolvedValue(
      response(200, xml, { 'content-type': 'application/rss+xml; charset=utf-8' }),
    );
    const result = await readerWith(transport).read(candidate, new AbortController().signal);

    expect(result).toMatchObject({ status: 'read', text: xml, contentType: 'application/rss+xml' });
  });

  it('removes non-display control characters from saved source text', async () => {
    const transport = vi.fn<HttpHopTransport>().mockResolvedValue(
      response(200, 'Evidence\u0000cannot\u0007control storage.', {
        'content-type': 'text/plain; charset=utf-8',
      }),
    );

    const result = await readerWith(transport).read(candidate, new AbortController().signal);

    expect(result).toMatchObject({
      status: 'read', text: 'Evidence cannot control storage.',
    });
  });
});

describe('EvidenceAwareContentReader', () => {
  it('uses a retrieved paper abstract without making a second network request', async () => {
    const fallback = { read: vi.fn() };
    const abstractCandidate = {
      ...candidate,
      evidenceLevel: 'abstract' as const,
      excerpt: 'An abstract retrieved from the paper metadata API.',
    };
    const reader = new EvidenceAwareContentReader(fallback, {
      now: () => retrievedAt,
    });

    await expect(reader.read(abstractCandidate, new AbortController().signal))
      .resolves.toMatchObject({
        status: 'read',
        sourceId: candidate.id,
        text: abstractCandidate.excerpt,
        contentType: 'application/vnd.ai-research-assistant.abstract+text',
      });
    expect(fallback.read).not.toHaveBeenCalled();
  });

  it('upgrades an arXiv abstract to safely read HTML full text when available', async () => {
    const abstractCandidate = {
      ...candidate,
      id: sourceIdForUrl('https://arxiv.org/abs/2610.00001'),
      url: 'https://arxiv.org/abs/2610.00001',
      evidenceLevel: 'abstract' as const,
      excerpt: 'Saved abstract.',
    };
    const fallback = { read: vi.fn(async (requested) => ({
      status: 'read' as const,
      sourceId: requested.id,
      requestedUrl: requested.url,
      finalUrl: requested.url,
      redirects: [],
      retrievedAt: retrievedAt.toISOString(),
      contentType: 'text/html',
      contentHash: 'b'.repeat(64),
      text: 'F'.repeat(4_000),
      textTruncated: false,
    })) };
    const reader = new EvidenceAwareContentReader(fallback, {
      now: () => retrievedAt,
      preferArxivHtmlFullText: true,
    });

    await expect(reader.read(abstractCandidate, new AbortController().signal))
      .resolves.toMatchObject({
        status: 'read',
        sourceId: abstractCandidate.id,
        requestedUrl: abstractCandidate.url,
        finalUrl: 'https://arxiv.org/html/2610.00001',
        evidenceLevel: 'full_text',
      });
    expect(fallback.read).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://arxiv.org/html/2610.00001',
      evidenceLevel: 'metadata',
    }), expect.any(AbortSignal));
  });

  it('falls back to the saved abstract when arXiv HTML is unavailable or too short', async () => {
    const abstractCandidate = {
      ...candidate,
      id: sourceIdForUrl('https://arxiv.org/abs/2610.00001'),
      url: 'https://arxiv.org/abs/2610.00001',
      evidenceLevel: 'abstract' as const,
      excerpt: 'Saved abstract evidence.',
    };
    const fallback = { read: vi.fn(async (requested) => ({
      status: 'read' as const,
      sourceId: requested.id,
      requestedUrl: requested.url,
      finalUrl: requested.url,
      redirects: [],
      retrievedAt: retrievedAt.toISOString(),
      contentType: 'text/html',
      contentHash: 'c'.repeat(64),
      text: 'Too short to establish full text.',
      textTruncated: false,
    })) };
    const reader = new EvidenceAwareContentReader(fallback, {
      now: () => retrievedAt,
      preferArxivHtmlFullText: true,
    });

    await expect(reader.read(abstractCandidate, new AbortController().signal))
      .resolves.toMatchObject({
        status: 'read',
        text: 'Saved abstract evidence.',
        evidenceLevel: 'abstract',
      });
  });

  it('derives only canonical public arXiv HTML URLs', () => {
    expect(arxivHtmlUrl('https://arxiv.org/abs/2610.00001v2'))
      .toBe('https://arxiv.org/html/2610.00001v2');
    expect(arxivHtmlUrl('https://example.org/abs/2610.00001')).toBeNull();
    expect(arxivHtmlUrl('file:///C:/secret')).toBeNull();
  });
});

describe('htmlToPlainText', () => {
  it('keeps visible source claims and safely handles invalid numeric entities', () => {
    expect(htmlToPlainText('<p>Claim &#65; &#99999999;</p>'))
      .toBe('Claim A &#99999999;');
  });
});
