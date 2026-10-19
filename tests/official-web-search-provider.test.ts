import { describe, expect, it, vi } from 'vitest';
import { OfficialWebSearchProvider } from
  '../electron/research/official-web-search-provider.js';

describe('OfficialWebSearchProvider', () => {
  it('maps safe tool sources to bounded metadata-only candidates', async () => {
    const controller = new AbortController();
    const streamWebSearch = vi.fn().mockResolvedValue({
      text: 'Search complete.',
      usedWebSearch: true,
      sources: [
        { url: 'http://127.0.0.1/private', title: 'Unsafe' },
        { url: 'https://arxiv.org/abs/2610.00001#abstract', title: ' Agent Paper ' },
        { url: 'https://github.com/example/agent', title: 'Implementation' },
        { url: 'https://example.org/extra', title: 'Extra result' },
      ],
    });
    const provider = new OfficialWebSearchProvider({ streamWebSearch }, 'gpt-5.6-luna');

    expect(provider.publicationDateSupport).toBe('unknown');

    await expect(provider.search({
      query: 'recent agent evaluation', maxResults: 2,
      publishedFrom: '2026-09-24', publishedTo: '2026-10-01',
    }, controller.signal)).resolves.toEqual([
      {
        title: 'Agent Paper',
        url: 'https://arxiv.org/abs/2610.00001',
        sourceType: 'paper', evidenceLevel: 'metadata',
        authorOrOrganization: null, publishedDate: null, updatedDate: null, excerpt: null,
      },
      {
        title: 'Implementation',
        url: 'https://github.com/example/agent',
        sourceType: 'repository', evidenceLevel: 'metadata',
        authorOrOrganization: null, publishedDate: null, updatedDate: null, excerpt: null,
      },
    ]);
    expect(streamWebSearch).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-luna',
      input: 'recent agent evaluation',
      signal: controller.signal,
      instructions: expect.stringContaining('2026-09-24 through 2026-10-01'),
    }));
  });

  it('does not accept generated text without a web search call', async () => {
    const streamWebSearch = vi.fn().mockResolvedValue({
      text: 'Answer from memory.', usedWebSearch: false, sources: [],
    });
    const provider = new OfficialWebSearchProvider({ streamWebSearch }, 'gpt-5.6-luna');
    await expect(provider.search(
      { query: 'agent evaluation', maxResults: 3 }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'web_search_not_used' });
  });

  it('rejects a result set containing no safe public sources', async () => {
    const streamWebSearch = vi.fn().mockResolvedValue({
      text: 'Search complete.', usedWebSearch: true,
      sources: [{ url: 'file:///C:/secret.txt', title: 'Local file' }],
    });
    const provider = new OfficialWebSearchProvider({ streamWebSearch }, 'gpt-5.6-luna');
    await expect(provider.search(
      { query: 'agent evaluation', maxResults: 3 }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'web_search_sources_missing' });
  });

  it('forwards cancellation without replacing the caller signal', async () => {
    const controller = new AbortController();
    const streamWebSearch = vi.fn(({ signal }) =>
      new Promise<{ text: string; usedWebSearch: boolean; sources: [] }>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }));
    const provider = new OfficialWebSearchProvider({ streamWebSearch }, 'gpt-5.6-luna');
    const pending = provider.search(
      { query: 'agent evaluation', maxResults: 3 }, controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
