import type { EvidenceSource, ResearchReport } from './report.js';

export type RepositoryLinkageReason =
  | 'paper_links_repository'
  | 'arxiv_id_match'
  | 'paper_title_match'
  | 'insufficient_evidence';

export interface RepositoryLinkageAssessment {
  sourceId: string;
  status: 'verified' | 'unverified';
  reason: RepositoryLinkageReason;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function arxivId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'arxiv.org') return null;
    const match = parsed.pathname.match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?$/i);
    return match?.[1]?.replace(/v\d+$/i, '').toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * This verifies only an evidence link, not authorship or repository ownership.
 * Search rank and a similar repository name are deliberately insufficient.
 */
export function assessRepositoryLinkage(
  report: ResearchReport,
  targetItemId: string,
  sources: readonly EvidenceSource[],
): RepositoryLinkageAssessment[] {
  const item = report.items.find(({ id }) => id === targetItemId);
  if (!item) throw new Error(`報告中找不到項目 ${targetItemId}。`);
  const paper = report.citedSources.find(({ id }) => id === item.primarySourceId);
  if (!paper) throw new Error(`找不到項目 ${targetItemId} 的主要論文來源。`);

  const paperTitle = normalizedText(paper.title);
  const paperArxivId = arxivId(paper.url);
  return sources.filter(({ sourceType }) => sourceType === 'repository').map((source) => {
    if (paper.content.includes(source.url)) {
      return { sourceId: source.id, status: 'verified', reason: 'paper_links_repository' };
    }
    const repositoryText = normalizedText(`${source.title}\n${source.content}\n${source.url}`);
    if (paperArxivId && repositoryText.includes(normalizedText(paperArxivId))) {
      return { sourceId: source.id, status: 'verified', reason: 'arxiv_id_match' };
    }
    if (paperTitle.length >= 16 && repositoryText.includes(paperTitle)) {
      return { sourceId: source.id, status: 'verified', reason: 'paper_title_match' };
    }
    return { sourceId: source.id, status: 'unverified', reason: 'insufficient_evidence' };
  });
}
