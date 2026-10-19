import { describe, expect, it } from 'vitest';
import { ArxivSearchProvider } from '../electron/research/arxiv-search-provider.js';
import {
  EvidenceAwareContentReader,
  SafeHttpContentReader,
} from '../electron/research/content-reader.js';
import { normalizeSearchCandidate } from '../electron/research/search-provider.js';
import { runOrchestratedSearch } from '../electron/research/search-orchestrator.js';

const liveIt = process.env.RUN_ARXIV_E2E === '1' ? it : it.skip;

describe('arXiv live E2E (explicit opt-in)', () => {
  liveIt('retrieves real dated paper abstracts through the safe reader', async () => {
    const provider = new ArxivSearchProvider();
    const results = await provider.search({
      query: 'AI Agent',
      maxResults: 2,
    }, AbortSignal.timeout(30_000));

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results[0]).toMatchObject({
      sourceType: 'paper',
      evidenceLevel: 'abstract',
    });
    expect(results[0].publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(results[0].url).toMatch(/^https:\/\/arxiv\.org\/abs\//);
    expect(results[0].excerpt?.length).toBeGreaterThan(20);
  }, 35_000);

  liveIt('upgrades at least one current arXiv result to official HTML full text', async () => {
    const provider = new ArxivSearchProvider();
    const discovered = await provider.search({
      query: 'large language model agent',
      maxResults: 5,
    }, AbortSignal.timeout(30_000));
    const discoveredAt = new Date().toISOString();
    const candidates = discovered.map((candidate) =>
      normalizeSearchCandidate(candidate, provider.id, discoveredAt));
    const reader = new EvidenceAwareContentReader(new SafeHttpContentReader({
      timeoutMs: 20_000,
      maxBytes: 2_000_000,
    }), {
      preferArxivHtmlFullText: true,
      minimumFullTextCharacters: 3_000,
    });

    const results = [];
    for (const candidate of candidates) {
      results.push(await reader.read(candidate, AbortSignal.timeout(25_000)));
      const latest = results.at(-1);
      if (latest?.status === 'read' && latest.evidenceLevel === 'full_text') break;
    }

    expect(results.some((result) =>
      result.status === 'read' &&
      result.evidenceLevel === 'full_text' &&
      result.finalUrl.startsWith('https://arxiv.org/html/'))).toBe(true);
  }, 120_000);

  liveIt('runs the bounded primary-and-gap-search loop against current arXiv data', async () => {
    const provider = new ArxivSearchProvider();
    const result = await runOrchestratedSearch(provider, {
      query: 'AI Agent 與 RAG',
      maxResults: 6,
      publishedFrom: '2026-09-28',
      publishedTo: '2026-10-04',
      paperFirst: true,
    }, AbortSignal.timeout(90_000), {
      minimumCandidateCount: 3,
    });

    expect(result.queryExecutions?.length).toBeGreaterThanOrEqual(1);
    expect(result.queryExecutions?.length).toBeLessThanOrEqual(2);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every(({ publishedDate }) =>
      publishedDate !== null && publishedDate >= '2026-09-28' &&
      publishedDate <= '2026-10-04')).toBe(true);
  }, 100_000);
});
