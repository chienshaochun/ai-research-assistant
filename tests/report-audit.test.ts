import { describe, expect, it } from 'vitest';
import { auditResearchReport } from '../electron/research/report-audit.js';
import type { EvidenceSource, ResearchReport } from '../electron/research/report.js';

function source(id: string, publishedDate: string | null, truncated = false): EvidenceSource {
  return {
    id,
    title: `Paper ${id}`,
    url: `https://arxiv.org/abs/${id}`,
    authorOrOrganization: 'Example Lab',
    publishedDate,
    updatedDate: null,
    sourceType: 'paper',
    evidenceLevel: 'abstract',
    retrievedAt: '2026-10-01T12:00:00.000Z',
    contentHash: 'a'.repeat(64),
    content: 'Abstract evidence.',
    contentTruncated: truncated,
  };
}

const first = source('2610.00001', '2026-09-30');
const second = source('2610.00002', null, true);
const statement = (text: string, sourceIds: string[]) => ({ text, sourceIds });
const report: ResearchReport = {
  id: 'rpt_audit',
  topic: 'AI Agent',
  publishedFrom: '2026-09-25',
  publishedTo: '2026-10-01',
  searchScope: 'fixture',
  generatedAt: '2026-10-01T12:05:00.000Z',
  summary: [statement('Summary', [first.id])],
  items: [{
    id: 'item_01', name: 'Method', primarySourceId: first.id,
    relatedSourceIds: [second.id],
    problem: statement('Problem', [first.id]),
    method: statement('Method', [first.id, second.id]),
    evidence: [statement('Evidence', [first.id])],
    limitations: [statement('Limitation', [second.id])],
    analysis: {
      applicationValue: 'Value', smallExperiment: 'Experiment',
      unverified: ['Not reproduced'],
    },
  }],
  citedSources: [first, second],
  markdown: '# Report',
};

describe('research report deterministic audit', () => {
  it('separates structural metrics from unmeasured semantic support', () => {
    expect(auditResearchReport(report)).toMatchObject({
      sourceClaimCount: 5,
      citationReferenceCount: 6,
      citedSourceCount: 2,
      knownPublicationDateCount: 1,
      unknownPublicationDateCount: 1,
      abstractOnlySourceCount: 2,
      fullTextSourceCount: 0,
      truncatedSourceCount: 1,
      structuralCitationStatus: 'passed',
      semanticSupportStatus: 'not_evaluated',
    });
  });

  it('rejects an item claim that cites a source outside that item', () => {
    const invalid = structuredClone(report);
    invalid.items[0].relatedSourceIds = [];

    expect(() => auditResearchReport(invalid)).toThrow('超出範圍的來源');
  });

  it('reports cited papers outside the requested publication range', () => {
    const outside = structuredClone(report);
    outside.citedSources[0].publishedDate = '2026-09-01';

    expect(auditResearchReport(outside).outsideDateRangeSourceCount).toBe(1);
  });

  it('flags exact numbers that do not occur in the cited saved evidence', () => {
    const numeric = structuredClone(report);
    numeric.citedSources[0].content = 'The benchmark improves accuracy by 12.5% on 1,000 tasks.';
    numeric.items[0].evidence = [statement(
      '作者報告在 1,000 個任務上提升 18%。', [first.id],
    )];

    expect(auditResearchReport(numeric)).toMatchObject({
      numericClaimCount: 1,
      numericGroundingWarningCount: 1,
      numericGroundingIssues: [{ label: 'item_01 證據[0]', unsupportedTokens: ['18%'] }],
    });
  });

  it('normalizes full-width digits, thousands separators, and percent symbols', () => {
    const numeric = structuredClone(report);
    numeric.citedSources[0].content = 'Evaluated on 100k tasks with a 12.5 percent gain.';
    numeric.items[0].evidence = [statement(
      '作者在 １００,０００ 個任務上報告 12.5％ 增益。', [first.id],
    )];

    expect(auditResearchReport(numeric)).toMatchObject({
      numericClaimCount: 1,
      numericGroundingWarningCount: 0,
      numericGroundingIssues: [],
    });
  });
});
