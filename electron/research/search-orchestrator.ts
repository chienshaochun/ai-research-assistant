import {
  matchesPublishedDateRange,
  mergeSearchCandidates,
  type SearchCandidate,
  type SearchProvider,
  type SearchRequest,
} from './search-provider.js';
import {
  runSearch,
  type RunSearchOptions,
  type SearchExclusion,
  type SearchMerge,
  type SearchQueryExecution,
  type SearchRunResult,
} from './run-search.js';

export const MAX_SEARCH_CALLS = 2;

export interface SearchOrchestratorOptions extends RunSearchOptions {
  minimumCandidateCount: number;
  maxSearchCalls?: number;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必須是 ${minimum} 到 ${maximum} 的整數。`);
  }
  return value;
}

function normalizedForCoverage(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function extractTopicConcepts(topic: string): string[] {
  const concepts = topic
    .split(/\s*(?:、|，|,|\/|\||\+|與|和|及|\band\b|&)\s*/iu)
    .map((value) => value.trim())
    .filter((value) => value.length >= 2 && value.length <= 100);
  return [...new Set(concepts)].slice(0, 6);
}

export function uncoveredTopicConcepts(
  topic: string,
  candidates: readonly SearchCandidate[],
): string[] {
  const concepts = extractTopicConcepts(topic);
  if (concepts.length < 2) return [];
  const evidenceText = candidates.map((candidate) =>
    normalizedForCoverage(`${candidate.title} ${candidate.excerpt ?? ''}`));
  return concepts.filter((concept) => {
    const normalized = normalizedForCoverage(concept);
    return !evidenceText.some((text) => text.includes(normalized));
  });
}

function supplementalQuery(
  request: SearchRequest,
  search: SearchRunResult,
  missingConcepts: readonly string[],
  minimumCandidateCount: number,
): string | null {
  if (missingConcepts.length > 0) return missingConcepts[0];
  if (search.candidates.length >= minimumCandidateCount) return null;
  const suffix = ' methods evaluation';
  return `${request.query.slice(0, 500 - suffix.length)}${suffix}`;
}

function execution(
  kind: SearchQueryExecution['kind'],
  query: string,
  search: SearchRunResult,
): SearchQueryExecution {
  return {
    kind,
    query,
    rawCandidateCount: search.rawCandidateCount,
    eligibleCandidateCount: search.candidates.length,
    supplementaryCandidateCount: search.supplementaryCandidates.length,
  };
}

function offsetMerges(merges: readonly SearchMerge[], offset: number): SearchMerge[] {
  return merges.map((merge) => ({
    ...merge,
    inputIndex: merge.inputIndex + offset,
    targetInputIndex: merge.targetInputIndex + offset,
  }));
}

function offsetExclusions(
  exclusions: readonly SearchExclusion[],
  offset: number,
): SearchExclusion[] {
  return exclusions.map((exclusion) => ({
    ...exclusion,
    inputIndex: exclusion.inputIndex + offset,
  }));
}

function combineSearchRuns(
  request: SearchRequest,
  primary: SearchRunResult,
  secondary: SearchRunResult,
  queryExecutions: SearchQueryExecution[],
  topic: string,
  minimumCandidateCount: number,
): SearchRunResult {
  const combinedInputs = [
    ...primary.candidates,
    ...primary.supplementaryCandidates,
    ...secondary.candidates,
    ...secondary.supplementaryCandidates,
  ];
  const merged = mergeSearchCandidates(combinedInputs);
  const eligible: SearchCandidate[] = [];
  const supplementaryCandidates: SearchCandidate[] = [];

  for (const candidate of merged.candidates) {
    if ((request.publishedFrom || request.publishedTo) && !candidate.publishedDate) {
      supplementaryCandidates.push(candidate);
    } else if (matchesPublishedDateRange(candidate, request)) {
      eligible.push(candidate);
    }
  }

  const candidates = eligible.slice(0, request.maxResults);
  const overflowExclusions: SearchExclusion[] = eligible
    .slice(request.maxResults)
    .map((candidate, index) => ({
      inputIndex: combinedInputs.findIndex(({ id }) => id === candidate.id),
      reason: 'over_result_limit',
      sourceId: candidate.id,
      detail: `超過最多 ${request.maxResults} 筆正式候選的限制。`,
    }));
  const crossRunMerges: SearchMerge[] = merged.merges.map((merge) => ({
    inputIndex: merge.duplicateIndex,
    targetInputIndex: merge.targetIndex,
    sourceId: merge.sourceId,
    enrichedFields: merge.enrichedFields,
    conflictingFields: merge.conflictingFields,
  }));
  const secondaryOffset = primary.processedCandidateCount;
  const uncoveredConcepts = uncoveredTopicConcepts(topic, candidates);
  const candidateShortfall = Math.max(0, minimumCandidateCount - candidates.length);

  return {
    status: 'completed',
    providerId: primary.providerId,
    scopeDescription: primary.scopeDescription,
    request,
    startedAt: primary.startedAt,
    completedAt: secondary.completedAt,
    rawCandidateCount: primary.rawCandidateCount + secondary.rawCandidateCount,
    processedCandidateCount:
      primary.processedCandidateCount + secondary.processedCandidateCount,
    rawLimitReached: primary.rawLimitReached || secondary.rawLimitReached,
    candidates,
    supplementaryCandidates,
    merges: [
      ...primary.merges,
      ...offsetMerges(secondary.merges, secondaryOffset),
      ...crossRunMerges,
    ],
    exclusions: [
      ...primary.exclusions,
      ...offsetExclusions(secondary.exclusions, secondaryOffset),
      ...overflowExclusions,
    ],
    queryExecutions,
    uncoveredConcepts,
    candidateShortfall,
    searchCallLimitReached: uncoveredConcepts.length > 0 || candidateShortfall > 0,
  };
}

export async function runOrchestratedSearch(
  provider: SearchProvider,
  request: SearchRequest,
  signal: AbortSignal,
  options: SearchOrchestratorOptions,
): Promise<SearchRunResult> {
  const minimumCandidateCount = boundedInteger(
    options.minimumCandidateCount, 1, request.maxResults, '最低候選數',
  );
  const maxSearchCalls = boundedInteger(
    options.maxSearchCalls ?? MAX_SEARCH_CALLS, 1, MAX_SEARCH_CALLS, '搜尋呼叫上限',
  );
  const primary = await runSearch(provider, request, signal, options);
  const primaryMissing = uncoveredTopicConcepts(request.query, primary.candidates);
  const queryExecutions = [execution('primary', request.query, primary)];
  const nextQuery = supplementalQuery(
    request, primary, primaryMissing, minimumCandidateCount,
  );

  if (!nextQuery || maxSearchCalls === 1) {
    const candidateShortfall = Math.max(
      0, minimumCandidateCount - primary.candidates.length,
    );
    return {
      ...primary,
      queryExecutions,
      uncoveredConcepts: primaryMissing,
      candidateShortfall,
      searchCallLimitReached: Boolean(nextQuery && maxSearchCalls === 1),
    };
  }

  signal.throwIfAborted();
  const supplementalRequest = { ...request, query: nextQuery };
  const secondary = await runSearch(provider, supplementalRequest, signal, options);
  queryExecutions.push(execution('supplemental', nextQuery, secondary));
  return combineSearchRuns(
    request,
    primary,
    secondary,
    queryExecutions,
    request.query,
    minimumCandidateCount,
  );
}
