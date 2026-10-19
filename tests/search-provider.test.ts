import { describe, expect, it } from 'vitest';
import {
  deduplicateSearchCandidates,
  matchesPublishedDateRange,
  mergeSearchCandidates,
  normalizeSearchCandidate,
  sourceIdForUrl,
  validateSearchRequest,
  type SearchCandidateInput,
} from '../electron/research/search-provider.js';

const discoveredAt = '2026-10-01T12:00:00.000Z';
const paper: SearchCandidateInput = {
  title: 'A useful paper',
  url: 'https://arxiv.org/abs/2610.00001#abstract',
  authorOrOrganization: 'Example Lab',
  publishedDate: '2026-10-01',
  sourceType: 'paper',
  evidenceLevel: 'abstract',
  excerpt: 'A short abstract obtained from the provider.',
};

describe('SearchProvider boundary', () => {
  it('normalizes a request and rejects invalid ranges', () => {
    expect(validateSearchRequest({
      query: '  agent evaluation  ', maxResults: 3,
      publishedFrom: '2026-09-24', publishedTo: '2026-10-01',
    })).toEqual({
      query: 'agent evaluation', maxResults: 3,
      publishedFrom: '2026-09-24', publishedTo: '2026-10-01',
    });
    expect(() => validateSearchRequest({
      query: 'agent evaluation', maxResults: 3,
      publishedFrom: '2026-10-02', publishedTo: '2026-10-01',
    })).toThrow('開始日期不能晚於結束日期');
  });

  it('creates the same stable ID for URL fragments of one source', () => {
    expect(sourceIdForUrl('https://arxiv.org/abs/2610.00001#abstract'))
      .toBe(sourceIdForUrl('https://arxiv.org/abs/2610.00001#references'));
  });

  it('normalizes explicit metadata without pretending an abstract is full text', () => {
    expect(normalizeSearchCandidate(paper, 'fixture-arxiv', discoveredAt)).toMatchObject({
      providerId: 'fixture-arxiv',
      url: 'https://arxiv.org/abs/2610.00001',
      evidenceLevel: 'abstract',
      publishedDate: '2026-10-01',
      updatedDate: null,
    });
  });

  it('blocks unsafe source URLs at the provider boundary', () => {
    expect(() => normalizeSearchCandidate(
      { ...paper, url: 'http://127.0.0.1/private' }, 'fixture-arxiv', discoveredAt,
    )).toThrow('公開 HTTP(S)');
  });

  it('does not treat an unknown publication date as inside a requested range', () => {
    const unknownDate = normalizeSearchCandidate(
      { ...paper, publishedDate: null }, 'fixture-arxiv', discoveredAt,
    );
    expect(matchesPublishedDateRange(unknownDate, {
      query: 'agent evaluation', maxResults: 3, publishedFrom: '2026-09-24',
    })).toBe(false);
  });

  it('merges missing metadata from exact canonical URL duplicates', () => {
    const first = normalizeSearchCandidate({
      ...paper,
      authorOrOrganization: null,
      publishedDate: null,
      sourceType: 'other',
      evidenceLevel: 'metadata',
      excerpt: null,
    }, 'fixture-arxiv', discoveredAt);
    const duplicate = normalizeSearchCandidate(
      {
        ...paper,
        title: 'Duplicate title',
        url: `${paper.url}#references`,
        updatedDate: '2026-10-02',
      },
      'fixture-arxiv', discoveredAt,
    );
    const repository = normalizeSearchCandidate({
      title: 'Reference implementation',
      url: 'https://github.com/example/research-agent',
      sourceType: 'repository',
      evidenceLevel: 'metadata',
    }, 'fixture-github', discoveredAt);

    const result = mergeSearchCandidates([first, duplicate, repository]);
    expect(result.candidates).toEqual([{
      ...first,
      authorOrOrganization: 'Example Lab',
      publishedDate: '2026-10-01',
      updatedDate: '2026-10-02',
      sourceType: 'paper',
      evidenceLevel: 'abstract',
      excerpt: 'A short abstract obtained from the provider.',
    }, repository]);
    expect(result.merges).toEqual([{
      targetIndex: 0,
      duplicateIndex: 1,
      sourceId: first.id,
      enrichedFields: [
        'authorOrOrganization', 'publishedDate', 'updatedDate',
        'sourceType', 'evidenceLevel', 'excerpt',
      ],
      conflictingFields: [],
    }]);
    expect(deduplicateSearchCandidates([first, duplicate, repository]))
      .toEqual(result.candidates);
  });

  it('keeps the first non-empty date and audits conflicting duplicate metadata', () => {
    const first = normalizeSearchCandidate(paper, 'fixture-arxiv', discoveredAt);
    const duplicate = normalizeSearchCandidate({
      ...paper,
      url: `${paper.url}#history`,
      publishedDate: '2026-09-30',
    }, 'fixture-arxiv', discoveredAt);

    const result = mergeSearchCandidates([first, duplicate]);
    expect(result.candidates[0].publishedDate).toBe('2026-10-01');
    expect(result.merges[0].conflictingFields).toContain('publishedDate');
  });

  it('keeps merge audit indexes tied to the original input positions', () => {
    const firstPaper = normalizeSearchCandidate(paper, 'fixture-arxiv', discoveredAt);
    const duplicatePaper = normalizeSearchCandidate(
      { ...paper, url: `${paper.url}#history` }, 'fixture-arxiv', discoveredAt,
    );
    const repository = normalizeSearchCandidate({
      title: 'Reference implementation',
      url: 'https://github.com/example/research-agent',
      sourceType: 'repository',
      evidenceLevel: 'metadata',
    }, 'fixture-github', discoveredAt);
    const duplicateRepository = { ...repository, title: 'Repository mirror result' };

    const result = mergeSearchCandidates([
      firstPaper, duplicatePaper, repository, duplicateRepository,
    ]);
    expect(result.merges.map(({ targetIndex, duplicateIndex }) => ({
      targetIndex, duplicateIndex,
    }))).toEqual([
      { targetIndex: 0, duplicateIndex: 1 },
      { targetIndex: 2, duplicateIndex: 3 },
    ]);
  });
});
