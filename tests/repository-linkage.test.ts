import { describe, expect, it } from 'vitest';
import { assessRepositoryLinkage } from '../electron/research/repository-linkage.js';
import type { EvidenceSource, ResearchReport } from '../electron/research/report.js';

const paper: EvidenceSource = {
  id: 'paper', title: 'Grounded Agents for Reliable Retrieval',
  url: 'https://arxiv.org/abs/2610.00001v2', authorOrOrganization: 'Lab',
  publishedDate: '2026-10-01', updatedDate: null, sourceType: 'paper',
  evidenceLevel: 'full_text', retrievedAt: '2026-10-04T00:00:00.000Z',
  contentHash: 'a'.repeat(64), content: 'Paper body.', contentTruncated: false,
};
const report: ResearchReport = {
  id: 'r', topic: 'Agents', publishedFrom: null, publishedTo: null, searchScope: 'Fixture',
  generatedAt: '2026-10-04T00:00:00.000Z', summary: [], items: [{
    id: 'item_01', name: paper.title, primarySourceId: paper.id, relatedSourceIds: [],
    problem: { text: 'p', sourceIds: [paper.id] },
    method: { text: 'm', sourceIds: [paper.id] }, evidence: [], limitations: [],
    analysis: { applicationValue: 'v', smallExperiment: 'e', unverified: ['u'] },
  }], citedSources: [paper], markdown: '# r',
};
const repository = (content: string): EvidenceSource => ({
  ...paper, id: 'repo', title: 'Implementation', url: 'https://github.com/lab/project',
  sourceType: 'repository', content, contentHash: 'b'.repeat(64),
});

describe('repository linkage evidence', () => {
  it('verifies an explicit arXiv identifier in repository content', () => {
    expect(assessRepositoryLinkage(report, 'item_01', [
      repository('Code for https://arxiv.org/abs/2610.00001'),
    ])).toEqual([{ sourceId: 'repo', status: 'verified', reason: 'arxiv_id_match' }]);
  });

  it('verifies an exact normalized paper title', () => {
    expect(assessRepositoryLinkage(report, 'item_01', [
      repository('# Grounded Agents for Reliable Retrieval'),
    ])[0]).toMatchObject({ status: 'verified', reason: 'paper_title_match' });
  });

  it('does not treat search relevance or a generic similar name as proof', () => {
    expect(assessRepositoryLinkage(report, 'item_01', [
      repository('A grounded agent toolkit with retrieval examples.'),
    ])[0]).toMatchObject({ status: 'unverified', reason: 'insufficient_evidence' });
  });

  it('verifies when the paper itself links to the exact repository URL', () => {
    const linkedReport = { ...report, citedSources: [{
      ...paper, content: 'Implementation: https://github.com/lab/project',
    }] };
    expect(assessRepositoryLinkage(linkedReport, 'item_01', [repository('README')])[0])
      .toMatchObject({ status: 'verified', reason: 'paper_links_repository' });
  });
});
