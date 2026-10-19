import type {
  ContentReadFailure,
  ContentReadResult,
  ContentReader,
} from './content-reader.js';
import type { SearchCandidate, SourceType } from './search-provider.js';

export const READING_DEFER_REASONS = [
  'duplicate',
  'repository_deferred',
  'read_limit',
] as const;
export type ReadingDeferReason = typeof READING_DEFER_REASONS[number];

export interface ReadingDeferredSource {
  sourceId: string;
  inputIndex: number;
  reason: ReadingDeferReason;
}

export interface SourceReadRecord {
  sourceId: string;
  inputIndex: number;
  sourceType: SourceType;
  attempts: number;
  result: ContentReadResult;
}

export interface ReadingRunResult {
  status: 'completed';
  startedAt: string;
  completedAt: string;
  inputCount: number;
  selectedCount: number;
  records: SourceReadRecord[];
  deferredSources: ReadingDeferredSource[];
}

export interface RunReadingOptions {
  maxSources: number;
  maxAttemptsPerSource?: number;
  includeRepositories?: boolean;
  now?: () => Date;
  waitBeforeRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface IndexedCandidate {
  inputIndex: number;
  candidate: SearchCandidate;
}

const SOURCE_PRIORITY: Record<SourceType, number> = {
  paper: 0,
  official_documentation: 1,
  official_blog: 2,
  article: 3,
  rss: 4,
  repository: 5,
  other: 6,
};

const RETRYABLE_ERROR_CODES: ReadonlySet<ContentReadFailure['errorCode']> = new Set([
  'network_error',
  'timeout',
]);

function validateInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必須是 ${minimum} 到 ${maximum} 的整數。`);
  }
  return value;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function retryDelayMs(completedAttempts: number): number {
  return Math.min(250 * (2 ** (completedAttempts - 1)), 2_000);
}

function isRetryable(result: ContentReadResult): result is ContentReadFailure {
  return result.status === 'failed' && RETRYABLE_ERROR_CODES.has(result.errorCode);
}

export async function runReading(
  reader: ContentReader,
  candidates: readonly SearchCandidate[],
  signal: AbortSignal,
  options: RunReadingOptions,
): Promise<ReadingRunResult> {
  const maxSources = validateInteger(options.maxSources, 1, 25, '閱讀來源上限');
  const maxAttempts = validateInteger(
    options.maxAttemptsPerSource ?? 2, 1, 3, '每個來源嘗試上限',
  );
  const includeRepositories = options.includeRepositories ?? false;
  const now = options.now ?? (() => new Date());
  const waitBeforeRetry = options.waitBeforeRetry ?? abortableDelay;
  const startedAt = now().toISOString();
  const deferredSources: ReadingDeferredSource[] = [];
  const uniqueCandidates: IndexedCandidate[] = [];
  const seenSourceIds = new Set<string>();

  signal.throwIfAborted();
  for (const [inputIndex, candidate] of candidates.entries()) {
    if (seenSourceIds.has(candidate.id)) {
      deferredSources.push({ sourceId: candidate.id, inputIndex, reason: 'duplicate' });
      continue;
    }
    seenSourceIds.add(candidate.id);
    if (candidate.sourceType === 'repository' && !includeRepositories) {
      deferredSources.push({
        sourceId: candidate.id,
        inputIndex,
        reason: 'repository_deferred',
      });
      continue;
    }
    uniqueCandidates.push({ inputIndex, candidate });
  }

  const prioritized = [...uniqueCandidates].sort((left, right) =>
    SOURCE_PRIORITY[left.candidate.sourceType] - SOURCE_PRIORITY[right.candidate.sourceType] ||
    left.inputIndex - right.inputIndex
  );
  const selected = prioritized.slice(0, maxSources);
  for (const { inputIndex, candidate } of prioritized.slice(maxSources)) {
    deferredSources.push({ sourceId: candidate.id, inputIndex, reason: 'read_limit' });
  }

  const records: SourceReadRecord[] = [];
  for (const { inputIndex, candidate } of selected) {
    signal.throwIfAborted();
    let attempts = 0;
    let result: ContentReadResult;
    do {
      signal.throwIfAborted();
      attempts += 1;
      result = await reader.read(candidate, signal);
      signal.throwIfAborted();
      if (result.sourceId !== candidate.id) {
        throw new Error('ContentReader 回傳的來源 ID 與要求讀取的來源不一致。');
      }
      if (!isRetryable(result) || attempts >= maxAttempts) break;
      await waitBeforeRetry(retryDelayMs(attempts), signal);
    } while (attempts < maxAttempts);

    records.push({
      sourceId: candidate.id,
      inputIndex,
      sourceType: candidate.sourceType,
      attempts,
      result,
    });
  }

  signal.throwIfAborted();
  return {
    status: 'completed',
    startedAt,
    completedAt: now().toISOString(),
    inputCount: candidates.length,
    selectedCount: selected.length,
    records,
    deferredSources,
  };
}
