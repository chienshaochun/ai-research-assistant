import { describe, expect, it, vi } from 'vitest';
import type {
  ContentReadFailure,
  ContentReadResult,
  ContentReader,
  ContentReadSuccess,
} from '../electron/research/content-reader.js';
import { runReading } from '../electron/research/run-reading.js';
import {
  normalizeSearchCandidate,
  type SearchCandidate,
  type SourceType,
} from '../electron/research/search-provider.js';

const discoveredAt = '2026-10-01T12:00:00.000Z';
const fixedTimes = [
  new Date('2026-10-01T12:01:00.000Z'),
  new Date('2026-10-01T12:01:01.000Z'),
];

function source(suffix: string, sourceType: SourceType): SearchCandidate {
  return normalizeSearchCandidate({
    title: `Source ${suffix}`,
    url: `https://${suffix}.research.example.org/content`,
    sourceType,
    evidenceLevel: 'metadata',
  }, 'fixture-search', discoveredAt);
}

function success(candidate: SearchCandidate): ContentReadSuccess {
  return {
    status: 'read',
    sourceId: candidate.id,
    requestedUrl: candidate.url,
    finalUrl: candidate.url,
    redirects: [],
    retrievedAt: '2026-10-01T12:01:00.000Z',
    contentType: 'text/plain',
    contentHash: 'a'.repeat(64),
    text: `Content for ${candidate.title}`,
    textTruncated: false,
  };
}

function failure(
  candidate: SearchCandidate,
  errorCode: ContentReadFailure['errorCode'],
): ContentReadFailure {
  return {
    status: 'failed',
    sourceId: candidate.id,
    requestedUrl: candidate.url,
    finalUrl: candidate.url,
    redirects: [],
    retrievedAt: '2026-10-01T12:01:00.000Z',
    errorCode,
    errorMessage: `Fixture ${errorCode}`,
  };
}

function now() {
  let index = 0;
  return () => fixedTimes[Math.min(index++, fixedTimes.length - 1)];
}

function successfulReader(onRead?: (candidate: SearchCandidate) => void): ContentReader {
  return {
    async read(candidate) {
      onRead?.(candidate);
      return success(candidate);
    },
  };
}

describe('runReading', () => {
  it('reads papers first and defers repositories by default', async () => {
    const repository = source('repository', 'repository');
    const documentation = source('documentation', 'official_documentation');
    const paper = source('paper', 'paper');
    const readOrder: string[] = [];

    const result = await runReading(
      successfulReader((candidate) => readOrder.push(candidate.id)),
      [repository, documentation, paper],
      new AbortController().signal,
      { maxSources: 2, now: now() },
    );

    expect(readOrder).toEqual([paper.id, documentation.id]);
    expect(result.records.map(({ sourceId }) => sourceId)).toEqual(readOrder);
    expect(result.deferredSources).toContainEqual({
      sourceId: repository.id,
      inputIndex: 0,
      reason: 'repository_deferred',
    });
  });

  it('applies the read limit independently from the number of candidates', async () => {
    const papers = [source('paper-a', 'paper'), source('paper-b', 'paper'), source('paper-c', 'paper')];
    const result = await runReading(
      successfulReader(), papers, new AbortController().signal, { maxSources: 2, now: now() },
    );

    expect(result).toMatchObject({ inputCount: 3, selectedCount: 2 });
    expect(result.records).toHaveLength(2);
    expect(result.deferredSources).toContainEqual({
      sourceId: papers[2].id,
      inputIndex: 2,
      reason: 'read_limit',
    });
  });

  it('retries a transient failure up to the configured attempt limit', async () => {
    const paper = source('retry-paper', 'paper');
    const read = vi.fn<ContentReader['read']>()
      .mockResolvedValueOnce(failure(paper, 'network_error'))
      .mockResolvedValueOnce(success(paper));
    const waitBeforeRetry = vi.fn(async () => undefined);

    const result = await runReading(
      { read }, [paper], new AbortController().signal,
      { maxSources: 1, maxAttemptsPerSource: 2, waitBeforeRetry, now: now() },
    );

    expect(read).toHaveBeenCalledTimes(2);
    expect(waitBeforeRetry).toHaveBeenCalledWith(250, expect.any(AbortSignal));
    expect(result.records[0]).toMatchObject({ attempts: 2, result: { status: 'read' } });
  });

  it('does not retry a permanent content failure and continues to the next source', async () => {
    const unsupported = source('unsupported', 'paper');
    const readable = source('readable', 'paper');
    const read = vi.fn<ContentReader['read']>(async (candidate) =>
      candidate.id === unsupported.id
        ? failure(candidate, 'unsupported_content_type')
        : success(candidate)
    );

    const result = await runReading(
      { read }, [unsupported, readable], new AbortController().signal,
      { maxSources: 2, maxAttemptsPerSource: 3, now: now() },
    );

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.records.map(({ attempts, result: itemResult }) => ({
      attempts, status: itemResult.status,
    }))).toEqual([
      { attempts: 1, status: 'failed' },
      { attempts: 1, status: 'read' },
    ]);
  });

  it('defers duplicate source IDs without reading them twice', async () => {
    const paper = source('same-paper', 'paper');
    const read = vi.fn<ContentReader['read']>(async (candidate) => success(candidate));

    const result = await runReading(
      { read }, [paper, { ...paper, title: 'Duplicate title' }],
      new AbortController().signal,
      { maxSources: 2, now: now() },
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(result.deferredSources).toContainEqual({
      sourceId: paper.id,
      inputIndex: 1,
      reason: 'duplicate',
    });
  });

  it('rejects a reader result assigned to the wrong source ID', async () => {
    const paper = source('paper', 'paper');
    const other = source('other-paper', 'paper');
    const reader: ContentReader = {
      async read() {
        return { ...success(paper), sourceId: other.id };
      },
    };

    await expect(runReading(
      reader, [paper], new AbortController().signal, { maxSources: 1, now: now() },
    )).rejects.toThrow('來源 ID');
  });

  it('propagates cancellation while a source is being read', async () => {
    const paper = source('slow-paper', 'paper');
    const controller = new AbortController();
    const reader: ContentReader = {
      read(_candidate, signal): Promise<ContentReadResult> {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };

    const pending = runReading(reader, [paper], controller.signal, { maxSources: 1, now: now() });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
