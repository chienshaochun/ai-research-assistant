import { describe, expect, it } from 'vitest';
import {
  MAX_RAW_SEARCH_CANDIDATES,
  runSearch,
} from '../electron/research/run-search.js';
import type {
  SearchCandidateInput,
  SearchProvider,
  SearchRequest,
} from '../electron/research/search-provider.js';

const fixedTimes = [
  new Date('2026-10-01T12:00:00.000Z'),
  new Date('2026-10-01T12:00:01.000Z'),
];

function paper(
  suffix: string,
  publishedDate: string | null,
  overrides: Partial<SearchCandidateInput> = {},
): SearchCandidateInput {
  return {
    title: `Paper ${suffix}`,
    url: `https://arxiv.org/abs/2610.${suffix}`,
    authorOrOrganization: 'Example Lab',
    publishedDate,
    updatedDate: null,
    sourceType: 'paper',
    evidenceLevel: 'metadata',
    excerpt: null,
    ...overrides,
  };
}

function providerWith(results: readonly SearchCandidateInput[]): SearchProvider {
  return {
    id: 'fixture-search',
    scopeDescription: 'Fixture paper index; no network access.',
    async search(_request: SearchRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      return results;
    },
  };
}

function now() {
  let index = 0;
  return () => fixedTimes[Math.min(index++, fixedTimes.length - 1)];
}

const recentRequest: SearchRequest = {
  query: 'recent agent research',
  maxResults: 3,
  publishedFrom: '2026-09-25',
  publishedTo: '2026-10-01',
};

describe('runSearch', () => {
  it('keeps unknown-date papers as supplementary instead of counting them as recent', async () => {
    const result = await runSearch(providerWith([
      paper('00001', '2026-09-30'),
      paper('00002', '2026-09-29'),
      paper('00003', null),
    ]), recentRequest, new AbortController().signal, { now: now() });

    expect(result.candidates.map(({ title }) => title)).toEqual(['Paper 00001', 'Paper 00002']);
    expect(result.supplementaryCandidates.map(({ title }) => title)).toEqual(['Paper 00003']);
    expect(result.candidates).toHaveLength(2);
  });

  it('accepts unknown publication dates when the request has no date boundary', async () => {
    const result = await runSearch(providerWith([
      paper('00001', null),
      paper('00002', '2020-01-01'),
    ]), { query: 'timeless agent research', maxResults: 3 },
    new AbortController().signal, { now: now() });

    expect(result.candidates.map(({ title }) => title)).toEqual([
      'Paper 00001', 'Paper 00002',
    ]);
    expect(result.supplementaryCandidates).toEqual([]);
  });

  it('uses richer duplicate metadata before applying the date requirement', async () => {
    const result = await runSearch(providerWith([
      paper('00001', null, { authorOrOrganization: null }),
      paper('00001', '2026-09-30', {
        url: 'https://arxiv.org/abs/2610.00001#history',
        evidenceLevel: 'abstract',
        excerpt: 'Abstract obtained from a richer duplicate result.',
      }),
    ]), recentRequest, new AbortController().signal, { now: now() });

    expect(result.candidates).toHaveLength(1);
    expect(result.supplementaryCandidates).toHaveLength(0);
    expect(result.candidates[0]).toMatchObject({
      publishedDate: '2026-09-30',
      evidenceLevel: 'abstract',
      excerpt: 'Abstract obtained from a richer duplicate result.',
    });
    expect(result.merges).toEqual([expect.objectContaining({
      inputIndex: 1,
      targetInputIndex: 0,
      enrichedFields: [
        'authorOrOrganization', 'publishedDate', 'evidenceLevel', 'excerpt',
      ],
      conflictingFields: [],
    })]);
  });

  it('records merges separately from invalid, outside-range, and over-limit candidates', async () => {
    const request = { ...recentRequest, maxResults: 1 };
    const result = await runSearch(providerWith([
      paper('00001', '2026-09-30'),
      paper('00001', '2026-09-30', { url: 'https://arxiv.org/abs/2610.00001#abstract' }),
      paper('00002', '2026-09-01'),
      paper('00003', '2026-09-29'),
      paper('00004', '2026-09-28', { url: 'http://127.0.0.1/private' }),
    ]), request, new AbortController().signal, { now: now() });

    expect(result.candidates.map(({ title }) => title)).toEqual(['Paper 00001']);
    expect(result.merges).toHaveLength(1);
    expect(result.exclusions.map(({ reason }) => reason)).toEqual([
      'invalid_candidate',
      'outside_published_date_range',
      'over_result_limit',
    ]);
  });

  it('returns a completed empty result when the provider finds nothing', async () => {
    const result = await runSearch(
      providerWith([]), recentRequest, new AbortController().signal, { now: now() },
    );
    expect(result).toMatchObject({
      status: 'completed',
      rawCandidateCount: 0,
      candidates: [],
      supplementaryCandidates: [],
      merges: [],
      exclusions: [],
    });
  });

  it('stops processing at the raw candidate safety limit', async () => {
    const results = Array.from(
      { length: MAX_RAW_SEARCH_CANDIDATES + 1 },
      (_, index) => paper(String(index).padStart(5, '0'), '2026-09-30'),
    );
    const result = await runSearch(
      providerWith(results), recentRequest, new AbortController().signal, { now: now() },
    );
    expect(result).toMatchObject({
      rawCandidateCount: MAX_RAW_SEARCH_CANDIDATES + 1,
      processedCandidateCount: MAX_RAW_SEARCH_CANDIDATES,
      rawLimitReached: true,
    });
  });

  it('rejects immediately when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runSearch(
      providerWith([paper('00001', '2026-09-30')]),
      recentRequest,
      controller.signal,
      { now: now() },
    )).rejects.toMatchObject({ name: 'AbortError' });
  });
});
