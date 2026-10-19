import { createHash } from 'node:crypto';
import { normalizePublicHttpUrl } from '../security/public-url.js';

export const SOURCE_TYPES = [
  'paper', 'official_documentation', 'official_blog', 'repository', 'article', 'rss', 'other',
] as const;
export type SourceType = typeof SOURCE_TYPES[number];

export const EVIDENCE_LEVELS = ['metadata', 'snippet', 'abstract', 'full_text'] as const;
export type EvidenceLevel = typeof EVIDENCE_LEVELS[number];

export interface SearchRequest {
  query: string;
  maxResults: number;
  publishedFrom?: string;
  publishedTo?: string;
  paperFirst?: boolean;
  preferOpenSource?: boolean;
}

export interface SearchCandidateInput {
  title: string;
  url: string;
  authorOrOrganization?: string | null;
  publishedDate?: string | null;
  updatedDate?: string | null;
  sourceType: SourceType;
  evidenceLevel: EvidenceLevel;
  excerpt?: string | null;
}

export interface SearchCandidate {
  id: string;
  providerId: string;
  title: string;
  url: string;
  authorOrOrganization: string | null;
  publishedDate: string | null;
  updatedDate: string | null;
  sourceType: SourceType;
  evidenceLevel: EvidenceLevel;
  excerpt: string | null;
  discoveredAt: string;
}

export type SearchCandidateMergeField =
  | 'authorOrOrganization'
  | 'publishedDate'
  | 'updatedDate'
  | 'sourceType'
  | 'evidenceLevel'
  | 'excerpt';

export interface SearchCandidateMergeAudit {
  targetIndex: number;
  duplicateIndex: number;
  sourceId: string;
  enrichedFields: SearchCandidateMergeField[];
  conflictingFields: SearchCandidateMergeField[];
}

export interface MergeSearchCandidatesResult {
  candidates: SearchCandidate[];
  merges: SearchCandidateMergeAudit[];
}

export interface SearchProvider {
  readonly id: string;
  readonly scopeDescription: string;
  readonly publicationDateSupport?: 'verified' | 'unknown';
  search(request: SearchRequest, signal: AbortSignal): Promise<readonly SearchCandidateInput[]>;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必須是文字。`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f]/.test(text)) {
    throw new Error(`${label} 必須是 1 到 ${maxLength} 個可顯示字元。`);
  }
  return text;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maxLength);
}

function optionalIsoDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} 必須是 YYYY-MM-DD。`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} 不是有效日期。`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} 不在允許的值中。`);
  }
  return value as T;
}

export function validateSearchRequest(input: SearchRequest): SearchRequest {
  const query = requiredText(input.query, '搜尋查詢', 500);
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 25) {
    throw new Error('搜尋結果上限必須是 1 到 25 的整數。');
  }
  const publishedFrom = optionalIsoDate(input.publishedFrom, '開始日期');
  const publishedTo = optionalIsoDate(input.publishedTo, '結束日期');
  if (publishedFrom && publishedTo && publishedFrom > publishedTo) {
    throw new Error('開始日期不能晚於結束日期。');
  }
  if (input.paperFirst !== undefined && typeof input.paperFirst !== 'boolean') {
    throw new Error('論文優先設定必須是布林值。');
  }
  if (input.preferOpenSource !== undefined && typeof input.preferOpenSource !== 'boolean') {
    throw new Error('開源優先設定必須是布林值。');
  }
  return {
    query,
    maxResults: input.maxResults,
    ...(publishedFrom ? { publishedFrom } : {}),
    ...(publishedTo ? { publishedTo } : {}),
    ...(input.paperFirst !== undefined ? { paperFirst: input.paperFirst } : {}),
    ...(input.preferOpenSource !== undefined ? { preferOpenSource: input.preferOpenSource } : {}),
  };
}

export function sourceIdForUrl(url: string): string {
  const normalized = normalizePublicHttpUrl(url);
  if (!normalized) throw new Error('來源 URL 必須是公開 HTTP(S) 位址。');
  return `src_${createHash('sha256').update(normalized).digest('hex').slice(0, 20)}`;
}

export function normalizeSearchCandidate(
  input: SearchCandidateInput,
  providerId: string,
  discoveredAt: string,
): SearchCandidate {
  const safeProviderId = requiredText(providerId, 'Provider ID', 64);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(safeProviderId)) {
    throw new Error('Provider ID 只能包含小寫英數字、句點、底線或連字號。');
  }
  const url = normalizePublicHttpUrl(input.url);
  if (!url) throw new Error('來源 URL 必須是公開 HTTP(S) 位址。');
  const timestamp = new Date(discoveredAt);
  if (Number.isNaN(timestamp.valueOf())) throw new Error('擷取時間必須是有效時間。');
  const evidenceLevel = enumValue(input.evidenceLevel, EVIDENCE_LEVELS, '內容層級');
  const excerpt = optionalText(input.excerpt, '搜尋摘錄', 4_000);
  if (evidenceLevel !== 'metadata' && !excerpt) {
    throw new Error(`${evidenceLevel} 來源必須保存實際取得的摘錄。`);
  }
  return {
    id: sourceIdForUrl(url),
    providerId: safeProviderId,
    title: requiredText(input.title, '來源標題', 500),
    url,
    authorOrOrganization: optionalText(input.authorOrOrganization, '作者或組織', 300),
    publishedDate: optionalIsoDate(input.publishedDate, '發布日期'),
    updatedDate: optionalIsoDate(input.updatedDate, '更新日期'),
    sourceType: enumValue(input.sourceType, SOURCE_TYPES, '來源種類'),
    evidenceLevel,
    excerpt,
    discoveredAt: timestamp.toISOString(),
  };
}

export function matchesPublishedDateRange(
  candidate: SearchCandidate,
  request: SearchRequest,
): boolean {
  if (!request.publishedFrom && !request.publishedTo) return true;
  if (!candidate.publishedDate) return false;
  if (request.publishedFrom && candidate.publishedDate < request.publishedFrom) return false;
  if (request.publishedTo && candidate.publishedDate > request.publishedTo) return false;
  return true;
}

export function deduplicateSearchCandidates(
  candidates: readonly SearchCandidate[],
): SearchCandidate[] {
  return mergeSearchCandidates(candidates).candidates;
}

const EVIDENCE_LEVEL_RANK: Record<EvidenceLevel, number> = {
  metadata: 0,
  snippet: 1,
  abstract: 2,
  full_text: 3,
};

function mergeCandidate(
  target: SearchCandidate,
  incoming: SearchCandidate,
): {
  candidate: SearchCandidate;
  enrichedFields: SearchCandidateMergeField[];
  conflictingFields: SearchCandidateMergeField[];
} {
  const candidate = { ...target };
  const enrichedFields: SearchCandidateMergeField[] = [];
  const conflictingFields: SearchCandidateMergeField[] = [];
  const nullableFields = [
    'authorOrOrganization', 'publishedDate', 'updatedDate',
  ] as const;

  for (const field of nullableFields) {
    if (!candidate[field] && incoming[field]) {
      candidate[field] = incoming[field];
      enrichedFields.push(field);
    } else if (candidate[field] && incoming[field] && candidate[field] !== incoming[field]) {
      conflictingFields.push(field);
    }
  }

  if (candidate.sourceType === 'other' && incoming.sourceType !== 'other') {
    candidate.sourceType = incoming.sourceType;
    enrichedFields.push('sourceType');
  } else if (
    incoming.sourceType !== 'other' &&
    candidate.sourceType !== incoming.sourceType
  ) {
    conflictingFields.push('sourceType');
  }

  const targetRank = EVIDENCE_LEVEL_RANK[candidate.evidenceLevel];
  const incomingRank = EVIDENCE_LEVEL_RANK[incoming.evidenceLevel];
  if (incomingRank > targetRank) {
    candidate.evidenceLevel = incoming.evidenceLevel;
    candidate.excerpt = incoming.excerpt;
    enrichedFields.push('evidenceLevel');
    if (incoming.excerpt !== target.excerpt) enrichedFields.push('excerpt');
  } else if (
    incomingRank === targetRank &&
    incoming.excerpt &&
    (!candidate.excerpt || incoming.excerpt.length > candidate.excerpt.length)
  ) {
    candidate.excerpt = incoming.excerpt;
    enrichedFields.push('excerpt');
  }

  return { candidate, enrichedFields, conflictingFields };
}

export function mergeSearchCandidates(
  candidates: readonly SearchCandidate[],
): MergeSearchCandidatesResult {
  const mergedCandidates: SearchCandidate[] = [];
  const targetById = new Map<string, { mergedIndex: number; inputIndex: number }>();
  const merges: SearchCandidateMergeAudit[] = [];

  for (const [duplicateIndex, candidate] of candidates.entries()) {
    const target = targetById.get(candidate.id);
    if (!target) {
      targetById.set(candidate.id, {
        mergedIndex: mergedCandidates.length,
        inputIndex: duplicateIndex,
      });
      mergedCandidates.push(candidate);
      continue;
    }

    const merged = mergeCandidate(mergedCandidates[target.mergedIndex], candidate);
    mergedCandidates[target.mergedIndex] = merged.candidate;
    merges.push({
      targetIndex: target.inputIndex,
      duplicateIndex,
      sourceId: candidate.id,
      enrichedFields: merged.enrichedFields,
      conflictingFields: merged.conflictingFields,
    });
  }
  return { candidates: mergedCandidates, merges };
}
