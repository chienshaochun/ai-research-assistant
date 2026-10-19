import { describe, expect, it, vi } from 'vitest';
import type { ContentReader } from '../electron/research/content-reader.js';
import {
  augmentReportForFollowUp,
  buildFollowUpSearchRequest,
  runFollowUpSearch,
} from '../electron/research/follow-up-search.js';
import type { EvidenceSource, ResearchReport } from '../electron/research/report.js';
import { generateFollowUpAnswer } from '../electron/research/report-follow-up.js';
import type { SearchProvider } from '../electron/research/search-provider.js';

const nowValue = new Date('2026-10-04T12:00:00.000Z');
const originalSource: EvidenceSource = {
  id: 'src_original',
  title: 'Original Paper',
  url: 'https://arxiv.org/abs/2610.00001',
  authorOrOrganization: 'Fixture Lab',
  publishedDate: '2026-10-01',
  updatedDate: null,
  sourceType: 'paper',
  evidenceLevel: 'abstract',
  retrievedAt: nowValue.toISOString(),
  contentHash: 'a'.repeat(64),
  content: 'Original abstract.',
  contentTruncated: false,
};
const cited = (text: string) => ({ text, sourceIds: [originalSource.id] });
const report: ResearchReport = {
  id: 'rpt_follow_up_fixture',
  topic: 'AI Agent 與 RAG',
  publishedFrom: '2026-09-28',
  publishedTo: '2026-10-04',
  searchScope: 'Fixture.',
  generatedAt: nowValue.toISOString(),
  summary: [cited('Summary')],
  items: [{
    id: 'item_01', name: 'Grounded Agent', primarySourceId: originalSource.id,
    relatedSourceIds: [], problem: cited('Problem'), method: cited('Method'),
    evidence: [cited('Evidence')], limitations: [],
    analysis: { applicationValue: 'Value', smallExperiment: 'Experiment',
      unverified: ['Not reproduced'] },
  }],
  citedSources: [originalSource],
  markdown: '# Report',
};

function reader(): ContentReader {
  return {
    async read(candidate) {
      return {
        status: 'read', sourceId: candidate.id, requestedUrl: candidate.url,
        finalUrl: candidate.url, redirects: [], retrievedAt: nowValue.toISOString(),
        contentType: 'text/html', contentHash: 'b'.repeat(64),
        text: `Read evidence from ${candidate.title}.`, textTruncated: false,
        evidenceLevel: 'full_text',
      };
    },
  };
}

describe('follow-up evidence search', () => {
  it('removes publication boundaries for an implementation lookup', () => {
    const request = buildFollowUpSearchRequest(
      report, 'item_01', '第一篇找 GitHub 實作', false,
    );
    expect(request.query).toContain('GitHub source code implementation');
    expect(request).not.toHaveProperty('publishedFrom');
    expect(request).not.toHaveProperty('publishedTo');
    expect(request).toMatchObject({ paperFirst: false, preferOpenSource: true });
  });

  it('uses a fresh bounded date window when a historical follow-up asks for latest evidence', () => {
    const historical = {
      ...report,
      publishedFrom: '2025-01-01',
      publishedTo: '2025-01-07',
    };
    const request = buildFollowUpSearchRequest(
      historical, 'item_01', '第一篇補查最新證據', true, '2026-10-04',
    );
    expect(request).toMatchObject({
      publishedFrom: '2026-09-05',
      publishedTo: '2026-10-04',
    });
  });

  it('searches, reads, and adds evidence only to the fixed target item', async () => {
    const search = vi.fn<SearchProvider['search']>().mockResolvedValue([{
      title: 'Grounded Agent repository',
      url: 'https://github.com/example/grounded-agent',
      sourceType: 'repository',
      evidenceLevel: 'metadata',
      publishedDate: null,
    }]);
    const result = await runFollowUpSearch({
      searchProvider: {
        id: 'fixture-web', scopeDescription: 'Fixture web.',
        publicationDateSupport: 'unknown', search,
      },
      contentReader: reader(),
    }, report, 'item_01', '第一篇找 GitHub 實作', new AbortController().signal,
    { now: () => nowValue });

    expect(search).toHaveBeenCalledTimes(1);
    expect(result.addedSources).toEqual([
      expect.objectContaining({ sourceType: 'repository', evidenceLevel: 'full_text' }),
    ]);
    expect(result.reportWithEvidence.items[0].relatedSourceIds).toHaveLength(1);
    expect(result.reportWithEvidence.citedSources).toHaveLength(2);
    expect(result.searchContext).toMatchObject({ performed: true, queries: [
      'Grounded Agent GitHub source code implementation',
    ], repositoryLinkage: [{
      sourceId: result.addedSources[0].id,
      status: 'unverified',
      reason: 'insufficient_evidence',
    }] });
    expect(report.items[0].relatedSourceIds).toEqual([]);

    const supplementalSource = result.addedSources[0];
    const answer = await generateFollowUpAnswer({
      id: 'fixture-answer',
      async generateDraft() {
        return {
          sourceGroundedDetails: [{
            text: 'The repository provides an inspectable implementation.',
            sourceIds: [supplementalSource.id],
          }],
          analysis: {
            interpretation: 'The implementation can support a local trial.',
            suggestedExperiment: 'Run one bounded fixture task.',
            unverified: ['Repository-paper identity still needs manual confirmation.'],
          },
        };
      },
    }, result.reportWithEvidence, 'item_01', '第一篇找 GitHub 實作',
    nowValue.toISOString(), new AbortController().signal, result.searchContext);
    expect(answer.citedSources.map(({ id }) => id)).toEqual([supplementalSource.id]);
    expect(answer.analysis.unverified[0]).toContain('不能視為官方實作');
    expect(answer.markdown).toContain('已執行受控補查');
  });

  it('replaces duplicate abstract evidence only when the new evidence is richer', () => {
    const upgraded = {
      ...originalSource,
      evidenceLevel: 'full_text' as const,
      content: 'Full paper body.',
      contentHash: 'c'.repeat(64),
    };
    const augmented = augmentReportForFollowUp(report, 'item_01', [upgraded]);
    expect(augmented.citedSources).toEqual([
      expect.objectContaining({ evidenceLevel: 'full_text', content: 'Full paper body.' }),
    ]);
    expect(augmented.items[0].relatedSourceIds).toEqual([]);
  });

  it('fails before model generation when no supplemental candidate is found', async () => {
    await expect(runFollowUpSearch({
      searchProvider: {
        id: 'fixture-empty', scopeDescription: 'Fixture.',
        publicationDateSupport: 'verified', async search() { return []; },
      },
      contentReader: { read: vi.fn<ContentReader['read']>() },
    }, report, 'item_01', '第一篇補查最新證據', new AbortController().signal,
    { now: () => nowValue })).rejects.toThrow('沒有找到符合條件');
  });
});
