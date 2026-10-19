import {
  matchesPublishedDateRange,
  mergeSearchCandidates,
  normalizeSearchCandidate,
  validateSearchRequest,
  type SearchCandidate,
  type SearchCandidateMergeField,
  type SearchProvider,
  type SearchRequest,
} from './search-provider.js';

export const MAX_RAW_SEARCH_CANDIDATES = 100;

export const SEARCH_EXCLUSION_REASONS = [
  'invalid_candidate',
  'outside_published_date_range',
  'over_result_limit',
] as const;
export type SearchExclusionReason = typeof SEARCH_EXCLUSION_REASONS[number];

export interface SearchExclusion {
  inputIndex: number;
  reason: SearchExclusionReason;
  sourceId: string | null;
  detail: string;
}

export interface SearchMerge {
  inputIndex: number;
  targetInputIndex: number;
  sourceId: string;
  enrichedFields: SearchCandidateMergeField[];
  conflictingFields: SearchCandidateMergeField[];
}

export interface SearchQueryExecution {
  kind: 'primary' | 'supplemental';
  query: string;
  rawCandidateCount: number;
  eligibleCandidateCount: number;
  supplementaryCandidateCount: number;
}

export interface SearchRunResult {
  status: 'completed';
  providerId: string;
  scopeDescription: string;
  request: SearchRequest;
  startedAt: string;
  completedAt: string;
  rawCandidateCount: number;
  processedCandidateCount: number;
  rawLimitReached: boolean;
  candidates: SearchCandidate[];
  supplementaryCandidates: SearchCandidate[];
  merges: SearchMerge[];
  exclusions: SearchExclusion[];
  queryExecutions?: SearchQueryExecution[];
  uncoveredConcepts?: string[];
  candidateShortfall?: number;
  searchCallLimitReached?: boolean;
}

export interface RunSearchOptions {
  now?: () => Date;
}

interface IndexedCandidate {
  inputIndex: number;
  candidate: SearchCandidate;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : '候選來源驗證失敗。';
}

function hasPublishedDateRange(request: SearchRequest): boolean {
  return Boolean(request.publishedFrom || request.publishedTo);
}

export async function runSearch(
  provider: SearchProvider,
  request: SearchRequest,
  signal: AbortSignal,
  options: RunSearchOptions = {},
): Promise<SearchRunResult> {
  const validatedRequest = validateSearchRequest(request);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  signal.throwIfAborted();
  const rawCandidates = await provider.search(validatedRequest, signal);
  signal.throwIfAborted();

  const exclusions: SearchExclusion[] = [];
  const normalized: IndexedCandidate[] = [];
  const candidatesToProcess = rawCandidates.slice(0, MAX_RAW_SEARCH_CANDIDATES);

  for (const [inputIndex, input] of candidatesToProcess.entries()) {
    signal.throwIfAborted();
    try {
      normalized.push({
        inputIndex,
        candidate: normalizeSearchCandidate(input, provider.id, startedAt),
      });
    } catch (error) {
      exclusions.push({
        inputIndex,
        reason: 'invalid_candidate',
        sourceId: null,
        detail: errorDetail(error),
      });
    }
  }

  const mergeResult = mergeSearchCandidates(
    normalized.map(({ candidate }) => candidate),
  );
  const firstInputById = new Map<string, number>();
  for (const { inputIndex, candidate } of normalized) {
    if (!firstInputById.has(candidate.id)) firstInputById.set(candidate.id, inputIndex);
  }
  const mergedCandidates = mergeResult.candidates.map((candidate) => ({
    inputIndex: firstInputById.get(candidate.id)!,
    candidate,
  }));
  const merges: SearchMerge[] = mergeResult.merges.map((merge) => ({
    inputIndex: normalized[merge.duplicateIndex].inputIndex,
    targetInputIndex: normalized[merge.targetIndex].inputIndex,
    sourceId: merge.sourceId,
    enrichedFields: merge.enrichedFields,
    conflictingFields: merge.conflictingFields,
  }));
  const included: IndexedCandidate[] = [];
  const supplementaryCandidates: SearchCandidate[] = [];

  for (const indexed of mergedCandidates) {
    signal.throwIfAborted();
    const { candidate, inputIndex } = indexed;
    if (hasPublishedDateRange(validatedRequest) && !candidate.publishedDate) {
      supplementaryCandidates.push(candidate);
      continue;
    }
    if (!matchesPublishedDateRange(candidate, validatedRequest)) {
      exclusions.push({
        inputIndex,
        reason: 'outside_published_date_range',
        sourceId: candidate.id,
        detail: '發布日期不在要求的時間範圍內。',
      });
      continue;
    }
    included.push(indexed);
  }

  const candidates = included.slice(0, validatedRequest.maxResults).map(({ candidate }) => candidate);
  for (const { inputIndex, candidate } of included.slice(validatedRequest.maxResults)) {
    exclusions.push({
      inputIndex,
      reason: 'over_result_limit',
      sourceId: candidate.id,
      detail: `超過最多 ${validatedRequest.maxResults} 筆正式候選的限制。`,
    });
  }

  signal.throwIfAborted();
  return {
    status: 'completed',
    providerId: provider.id,
    scopeDescription: provider.scopeDescription,
    request: validatedRequest,
    startedAt,
    completedAt: now().toISOString(),
    rawCandidateCount: rawCandidates.length,
    processedCandidateCount: candidatesToProcess.length,
    rawLimitReached: rawCandidates.length > MAX_RAW_SEARCH_CANDIDATES,
    candidates,
    supplementaryCandidates,
    merges,
    exclusions,
  };
}
