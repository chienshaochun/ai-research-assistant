import { describe, expect, it, vi } from 'vitest';
import { CompositeSearchProvider } from '../electron/research/composite-search-provider.js';
import type { SearchProvider } from '../electron/research/search-provider.js';

function provider(id: string, title: string): SearchProvider {
  return {
    id,
    scopeDescription: `${id} scope.`,
    publicationDateSupport: 'verified',
    search: vi.fn(async () => [{
      title,
      url: `https://${id}.example.com/item`,
      sourceType: 'official_blog' as const,
      evidenceLevel: 'snippet' as const,
      excerpt: 'Evidence',
      publishedDate: '2026-10-05',
    }]),
  };
}

describe('CompositeSearchProvider', () => {
  it('combines providers and exposes their actual scope', async () => {
    const composite = new CompositeSearchProvider([provider('one', 'One'), provider('two', 'Two')]);
    const result = await composite.search(
      { query: 'agent', maxResults: 3 }, new AbortController().signal,
    );
    expect(result.map(({ title }) => title)).toEqual(['One', 'Two']);
    expect(composite.scopeDescription).toContain('one scope');
    expect(composite.publicationDateSupport).toBe('verified');
  });

  it('continues when one provider fails, but reports total failure', async () => {
    const broken: SearchProvider = {
      id: 'broken', scopeDescription: 'broken scope.',
      search: vi.fn(async () => { throw new Error('offline'); }),
    };
    const partial = new CompositeSearchProvider([broken, provider('working', 'Working')]);
    await expect(partial.search(
      { query: 'agent', maxResults: 3 }, new AbortController().signal,
    )).resolves.toHaveLength(1);

    const failed = new CompositeSearchProvider([broken]);
    await expect(failed.search(
      { query: 'agent', maxResults: 3 }, new AbortController().signal,
    )).rejects.toThrow('offline');
  });
});
