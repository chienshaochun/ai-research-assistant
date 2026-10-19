import { describe, expect, it, vi } from 'vitest';
import {
  extractTopicConcepts,
  runOrchestratedSearch,
} from '../electron/research/search-orchestrator.js';
import type {
  SearchCandidateInput,
  SearchProvider,
  SearchRequest,
} from '../electron/research/search-provider.js';

const fixedNow = new Date('2026-10-04T12:00:00.000Z');
const baseRequest: SearchRequest = {
  query: 'AI Agent 與 RAG',
  maxResults: 6,
  publishedFrom: '2026-09-28',
  publishedTo: '2026-10-04',
};

function paper(suffix: string, title: string): SearchCandidateInput {
  return {
    title,
    url: `https://arxiv.org/abs/2610.${suffix}`,
    authorOrOrganization: 'Fixture Lab',
    publishedDate: '2026-10-01',
    sourceType: 'paper',
    evidenceLevel: 'metadata',
  };
}

function provider(search: SearchProvider['search']): SearchProvider {
  return {
    id: 'fixture-orchestrated-search',
    scopeDescription: 'Fixture bounded search.',
    publicationDateSupport: 'verified',
    search,
  };
}

describe('bounded search orchestrator', () => {
  it('extracts distinct topic concepts without treating the whole command as a query plan', () => {
    expect(extractTopicConcepts('AI Application、AI Agent、RAG 與 LLM Evaluation'))
      .toEqual(['AI Application', 'AI Agent', 'RAG', 'LLM Evaluation']);
    expect(extractTopicConcepts('retrieval and generation')).toEqual(['retrieval', 'generation']);
  });

  it('stops after one search when candidate count and topic coverage are sufficient', async () => {
    const search = vi.fn<SearchProvider['search']>().mockResolvedValue([
      paper('00001', 'AI Agent planning'),
      paper('00002', 'RAG retrieval evaluation'),
    ]);

    const result = await runOrchestratedSearch(
      provider(search), baseRequest, new AbortController().signal,
      { minimumCandidateCount: 2, now: () => fixedNow },
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.queryExecutions).toEqual([
      expect.objectContaining({ kind: 'primary', query: baseRequest.query }),
    ]);
    expect(result.uncoveredConcepts).toEqual([]);
    expect(result.searchCallLimitReached).toBe(false);
  });

  it('performs one targeted supplemental search and merges its unique candidates', async () => {
    const search = vi.fn<SearchProvider['search']>(async (request) =>
      request.query === 'RAG'
        ? [paper('00002', 'RAG grounded retrieval')]
        : [paper('00001', 'AI Agent planning')]);

    const result = await runOrchestratedSearch(
      provider(search), baseRequest, new AbortController().signal,
      { minimumCandidateCount: 2, now: () => fixedNow },
    );

    expect(search.mock.calls.map(([request]) => request.query))
      .toEqual(['AI Agent 與 RAG', 'RAG']);
    expect(result.candidates.map(({ title }) => title))
      .toEqual(['AI Agent planning', 'RAG grounded retrieval']);
    expect(result.queryExecutions).toEqual([
      expect.objectContaining({ kind: 'primary', query: 'AI Agent 與 RAG' }),
      expect.objectContaining({ kind: 'supplemental', query: 'RAG' }),
    ]);
    expect(result.uncoveredConcepts).toEqual([]);
  });

  it('reports remaining coverage gaps after the hard two-call limit', async () => {
    const request = { ...baseRequest, query: 'AI Agent 與 RAG 與 LLM Evaluation' };
    const search = vi.fn<SearchProvider['search']>(async ({ query }) =>
      query === 'RAG'
        ? [paper('00002', 'RAG grounded retrieval')]
        : [paper('00001', 'AI Agent planning')]);

    const result = await runOrchestratedSearch(
      provider(search), request, new AbortController().signal,
      { minimumCandidateCount: 3, now: () => fixedNow },
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(result.uncoveredConcepts).toEqual(['LLM Evaluation']);
    expect(result.candidateShortfall).toBe(1);
    expect(result.searchCallLimitReached).toBe(true);
  });

  it('can disable supplemental calls while preserving the detected gap', async () => {
    const search = vi.fn<SearchProvider['search']>().mockResolvedValue([
      paper('00001', 'AI Agent planning'),
    ]);

    const result = await runOrchestratedSearch(
      provider(search), baseRequest, new AbortController().signal,
      { minimumCandidateCount: 2, maxSearchCalls: 1, now: () => fixedNow },
    );

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.uncoveredConcepts).toEqual(['RAG']);
    expect(result.candidateShortfall).toBe(1);
    expect(result.searchCallLimitReached).toBe(true);
  });

  it('propagates cancellation while the supplemental search is pending', async () => {
    const controller = new AbortController();
    let calls = 0;
    const search: SearchProvider['search'] = async (_request, signal) => {
      calls += 1;
      if (calls === 1) return [paper('00001', 'AI Agent planning')];
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        queueMicrotask(() => controller.abort());
      });
    };

    await expect(runOrchestratedSearch(
      provider(search), baseRequest, controller.signal,
      { minimumCandidateCount: 2, now: () => fixedNow },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(2);
  });
});
