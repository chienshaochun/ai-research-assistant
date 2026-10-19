import type { ContentReader } from './content-reader.js';
import { buildEvidenceBundle, type EvidenceSource, type ResearchReport } from './report.js';
import type { FollowUpSearchContext } from './report-follow-up.js';
import { describeExecutedSearchScope } from './research-pipeline.js';
import { runReading, type ReadingRunResult } from './run-reading.js';
import { runOrchestratedSearch } from './search-orchestrator.js';
import type { SearchProvider, SearchRequest } from './search-provider.js';
import type { SearchRunResult } from './run-search.js';
import { assessRepositoryLinkage } from './repository-linkage.js';

export interface FollowUpSearchDependencies {
  searchProvider: SearchProvider;
  contentReader: ContentReader;
}

export interface FollowUpSearchResult {
  reportWithEvidence: ResearchReport;
  search: SearchRunResult;
  reading: ReadingRunResult;
  addedSources: EvidenceSource[];
  searchContext: FollowUpSearchContext;
}

const EVIDENCE_RANK: Record<EvidenceSource['evidenceLevel'], number> = {
  metadata: 0,
  snippet: 1,
  abstract: 2,
  full_text: 3,
};

export function isImplementationFollowUp(command: string): boolean {
  return /GitHub|GitLab|repo|repository|程式碼|原始碼|開源|實作/i.test(command);
}

export function buildFollowUpSearchRequest(
  report: ResearchReport,
  targetItemId: string,
  command: string,
  publicationDatesSupported: boolean,
  today?: string,
): SearchRequest {
  const item = report.items.find(({ id }) => id === targetItemId);
  if (!item) throw new Error(`報告中找不到項目 ${targetItemId}。`);
  const implementation = isImplementationFollowUp(command);
  const suffix = implementation ? ' GitHub source code implementation' : ' research evidence';
  const asksForCurrentEvidence = /最新|目前|近期/.test(command);
  let publishedFrom = report.publishedFrom;
  let publishedTo = report.publishedTo;
  if (publicationDatesSupported && asksForCurrentEvidence && today) {
    const end = new Date(`${today}T00:00:00.000Z`);
    if (Number.isNaN(end.valueOf()) || end.toISOString().slice(0, 10) !== today) {
      throw new Error('補查日期無效。');
    }
    end.setUTCDate(end.getUTCDate() - 29);
    publishedFrom = end.toISOString().slice(0, 10);
    publishedTo = today;
  }
  return {
    query: `${item.name.slice(0, 500 - suffix.length)}${suffix}`,
    maxResults: 6,
    paperFirst: !implementation,
    preferOpenSource: implementation,
    ...(publicationDatesSupported && publishedFrom ? { publishedFrom } : {}),
    ...(publicationDatesSupported && publishedTo ? { publishedTo } : {}),
  };
}

function mergeEvidenceSources(
  existing: readonly EvidenceSource[],
  additions: readonly EvidenceSource[],
): EvidenceSource[] {
  const merged = [...existing];
  const indexById = new Map(merged.map(({ id }, index) => [id, index]));
  for (const source of additions) {
    const index = indexById.get(source.id);
    if (index === undefined) {
      indexById.set(source.id, merged.length);
      merged.push(source);
      continue;
    }
    const current = merged[index];
    if (EVIDENCE_RANK[source.evidenceLevel] > EVIDENCE_RANK[current.evidenceLevel] ||
        (source.evidenceLevel === current.evidenceLevel &&
          source.content.length > current.content.length)) {
      merged[index] = source;
    }
  }
  return merged;
}

export function augmentReportForFollowUp(
  report: ResearchReport,
  targetItemId: string,
  additions: readonly EvidenceSource[],
): ResearchReport {
  if (additions.length === 0) throw new Error('補查沒有取得可用的已讀證據。');
  const target = report.items.find(({ id }) => id === targetItemId);
  if (!target) throw new Error(`報告中找不到項目 ${targetItemId}。`);
  const additionalIds = additions
    .map(({ id }) => id)
    .filter((id) => id !== target.primarySourceId && !target.relatedSourceIds.includes(id));
  return {
    ...report,
    items: report.items.map((item) => item.id === targetItemId
      ? { ...item, relatedSourceIds: [...item.relatedSourceIds, ...additionalIds] }
      : item),
    citedSources: mergeEvidenceSources(report.citedSources, additions),
  };
}

export async function runFollowUpSearch(
  dependencies: FollowUpSearchDependencies,
  report: ResearchReport,
  targetItemId: string,
  command: string,
  signal: AbortSignal,
  options: { now?: () => Date } = {},
): Promise<FollowUpSearchResult> {
  const now = options.now ?? (() => new Date());
  const request = buildFollowUpSearchRequest(
    report,
    targetItemId,
    command,
    dependencies.searchProvider.publicationDateSupport !== 'unknown',
    now().toISOString().slice(0, 10),
  );
  const search = await runOrchestratedSearch(
    dependencies.searchProvider,
    request,
    signal,
    { minimumCandidateCount: 1, now },
  );
  if (search.candidates.length === 0) {
    throw new Error('補查沒有找到符合條件且日期可接受的來源。');
  }
  const reading = await runReading(
    dependencies.contentReader,
    search.candidates,
    signal,
    {
      maxSources: 4,
      maxAttemptsPerSource: 2,
      includeRepositories: isImplementationFollowUp(command),
      now,
    },
  );
  const evidence = buildEvidenceBundle(search.candidates, reading.records);
  if (evidence.sources.length === 0) {
    throw new Error('補查找到候選來源，但都無法安全讀取。');
  }
  const scope = describeExecutedSearchScope(search);
  const repositoryLinkage = isImplementationFollowUp(command)
    ? assessRepositoryLinkage(report, targetItemId, evidence.sources)
    : [];
  return {
    reportWithEvidence: augmentReportForFollowUp(report, targetItemId, evidence.sources),
    search,
    reading,
    addedSources: evidence.sources,
    searchContext: {
      performed: true,
      scope,
      queries: (search.queryExecutions ?? []).map(({ query }) => query),
      ...(repositoryLinkage.length > 0 ? { repositoryLinkage } : {}),
    },
  };
}
