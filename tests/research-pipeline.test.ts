import { describe, expect, it, vi } from 'vitest';
import type { ContentReadFailure, ContentReader } from '../electron/research/content-reader.js';
import type { ReportDraftProvider } from '../electron/research/report-provider.js';
import {
  describeExecutedSearchScope,
  runResearchPipeline,
} from '../electron/research/research-pipeline.js';
import { resolveResearchTask } from '../electron/research/research-task.js';
import type {
  SearchCandidate,
  SearchCandidateInput,
  SearchProvider,
} from '../electron/research/search-provider.js';

const nowValue = new Date('2026-10-01T12:00:00.000Z');
const task = resolveResearchTask({}, { topic: 'AI Agent', maxItems: 2 }, '2026-10-01');

function candidateInput(suffix: string, publishedDate: string | null): SearchCandidateInput {
  return {
    title: `Paper ${suffix}`,
    url: `https://papers-${suffix}.example.org/paper`,
    authorOrOrganization: 'Example Lab',
    publishedDate,
    sourceType: 'paper',
    evidenceLevel: 'metadata',
  };
}

function searchProvider(results: SearchCandidateInput[]): SearchProvider {
  return {
    id: 'fixture-search',
    scopeDescription: 'Fixture research sources.',
    async search() { return results; },
  };
}

function successfulReader(failIds = new Set<string>()): ContentReader {
  return {
    async read(candidate) {
      if (failIds.has(candidate.id)) {
        const failed: ContentReadFailure = {
          status: 'failed',
          sourceId: candidate.id,
          requestedUrl: candidate.url,
          finalUrl: candidate.url,
          redirects: [],
          retrievedAt: nowValue.toISOString(),
          errorCode: 'unsupported_content_type',
          errorMessage: 'Unsupported fixture.',
        };
        return failed;
      }
      return {
        status: 'read',
        sourceId: candidate.id,
        requestedUrl: candidate.url,
        finalUrl: candidate.url,
        redirects: [],
        retrievedAt: nowValue.toISOString(),
        contentType: 'text/plain',
        contentHash: 'a'.repeat(64),
        text: `Evidence for ${candidate.title}`,
        textTruncated: false,
      };
    },
  };
}

function reportDraftProvider(): ReportDraftProvider {
  return {
    id: 'fixture-report',
    async generateDraft(_context, evidence) {
      const primary = evidence.sources[0];
      const cited = (text: string) => ({ text, sourceIds: [primary.id] });
      return {
        summary: [cited('以工具軌跡改善 Agent 評估。')],
        items: [{
          name: primary.title,
          primarySourceId: primary.id,
          relatedSourceIds: [],
          problem: cited('現有評估難以定位失敗步驟。'),
          method: cited('保存並評分工具軌跡。'),
          evidence: [cited('來源提供一組實驗結果。')],
          limitations: [],
          analysis: {
            applicationValue: '可建立工具呼叫回歸測試。',
            smallExperiment: '以固定任務比較兩種評分方式。',
            unverified: ['尚未在本專案重現。'],
          },
        }],
      };
    },
  };
}

describe('research pipeline', () => {
  it('describes actual search queries and unresolved bounded-search gaps', () => {
    expect(describeExecutedSearchScope({
      status: 'completed',
      providerId: 'fixture-search',
      scopeDescription: 'Fixture scope.',
      request: { query: 'AI Agent 與 RAG', maxResults: 3 },
      startedAt: nowValue.toISOString(),
      completedAt: nowValue.toISOString(),
      rawCandidateCount: 2,
      processedCandidateCount: 2,
      rawLimitReached: false,
      candidates: [],
      supplementaryCandidates: [],
      merges: [],
      exclusions: [],
      queryExecutions: [
        { kind: 'primary', query: 'AI Agent 與 RAG', rawCandidateCount: 1,
          eligibleCandidateCount: 1, supplementaryCandidateCount: 0 },
        { kind: 'supplemental', query: 'RAG', rawCandidateCount: 1,
          eligibleCandidateCount: 1, supplementaryCandidateCount: 0 },
      ],
      uncoveredConcepts: ['LLM Evaluation'],
      candidateShortfall: 1,
      searchCallLimitReached: true,
    })).toBe(
      'Fixture scope. 實際查詢：主查詢「AI Agent 與 RAG」；缺口補查「RAG」。 ' +
      '尚未涵蓋：LLM Evaluation。 符合條件的候選仍少 1 筆，未以不合格來源湊數。',
    );
  });

  it('runs search, bounded reading, evidence validation, and report generation', async () => {
    const progress = vi.fn();
    const result = await runResearchPipeline({
      searchProvider: searchProvider([
        candidateInput('one', '2026-09-30'),
        candidateInput('two', '2026-09-29'),
      ]),
      contentReader: successfulReader(),
      reportProvider: reportDraftProvider(),
    }, task, new AbortController().signal, { now: () => nowValue, onProgress: progress });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.report.items).toHaveLength(1);
      expect(result.report.items[0].id).toBe('item_01');
      expect(result.evidence.sources).toHaveLength(2);
    }
    expect(progress.mock.calls.map(([event]) => event.stage)).toEqual([
      'planning', 'searching', 'reading', 'generating', 'completed',
    ]);
    expect(progress.mock.calls.find(([event]) => event.stage === 'reading')?.[0])
      .toMatchObject({ eligibleSourceCount: 2, supplementarySourceCount: 0 });
  });

  it('returns the actual zero count when only unknown-date candidates exist', async () => {
    const reader = { read: vi.fn<ContentReader['read']>() };
    const reportProvider = { id: 'fixture-report', generateDraft: vi.fn() };
    const result = await runResearchPipeline({
      searchProvider: searchProvider([candidateInput('unknown', null)]),
      contentReader: reader,
      reportProvider,
    }, task, new AbortController().signal, { now: () => nowValue });

    expect(result).toMatchObject({
      status: 'no_results',
      reason: 'no_date_eligible_sources',
      search: { candidates: [], supplementaryCandidates: [{ publishedDate: null }] },
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(reportProvider.generateDraft).not.toHaveBeenCalled();
  });

  it('runs an explicitly date-unbounded task with an unknown-date source', async () => {
    const unboundedTask = resolveResearchTask(
      {}, { topic: 'AI Agent', maxItems: 1, publicationDateMode: 'any' }, '2026-10-01',
    );
    const result = await runResearchPipeline({
      searchProvider: searchProvider([candidateInput('unknown', null)]),
      contentReader: successfulReader(),
      reportProvider: reportDraftProvider(),
    }, unboundedTask, new AbortController().signal, { now: () => nowValue });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Unbounded fixture did not complete.');
    expect(result.searchRequest).not.toHaveProperty('publishedFrom');
    expect(result.searchRequest).not.toHaveProperty('publishedTo');
    expect(result.search.supplementaryCandidates).toEqual([]);
    expect(result.report).toMatchObject({ publishedFrom: null, publishedTo: null });
  });

  it('rejects a recent-date provider with unknown date metadata before searching', async () => {
    const search = vi.fn<SearchProvider['search']>();
    await expect(runResearchPipeline({
      searchProvider: {
        id: 'unknown-date-search',
        scopeDescription: 'Fixture web search.',
        publicationDateSupport: 'unknown',
        search,
      },
      contentReader: successfulReader(),
      reportProvider: reportDraftProvider(),
    }, task, new AbortController().signal, { now: () => nowValue }))
      .rejects.toThrow('明確加入「日期不限」');
    expect(search).not.toHaveBeenCalled();
  });

  it('allows an unknown-date provider for an explicit date-unbounded task', async () => {
    const unboundedTask = resolveResearchTask(
      {}, { topic: 'AI Agent', maxItems: 1, publicationDateMode: 'any', searchMode: 'web' },
      '2026-10-01',
    );
    const provider = searchProvider([candidateInput('web', null)]);
    Object.assign(provider, { publicationDateSupport: 'unknown' as const });
    const result = await runResearchPipeline({
      searchProvider: provider,
      contentReader: successfulReader(),
      reportProvider: reportDraftProvider(),
    }, unboundedTask, new AbortController().signal, { now: () => nowValue });

    expect(result.status).toBe('completed');
  });

  it('reports a generic no-result reason for a date-unbounded task', async () => {
    const unboundedTask = resolveResearchTask(
      {}, { topic: 'AI Agent', publicationDateMode: 'any', searchMode: 'web' }, '2026-10-01',
    );
    const progress = vi.fn();
    const result = await runResearchPipeline({
      searchProvider: {
        ...searchProvider([]),
        publicationDateSupport: 'unknown',
      },
      contentReader: successfulReader(),
      reportProvider: reportDraftProvider(),
    }, unboundedTask, new AbortController().signal, { now: () => nowValue, onProgress: progress });

    expect(result).toMatchObject({ status: 'no_results', reason: 'no_eligible_sources' });
    expect(progress.mock.calls.at(-1)?.[0].message).toBe('沒有符合搜尋條件的來源。');
  });

  it('does not call the report model when every selected source fails', async () => {
    const reportProvider = { id: 'fixture-report', generateDraft: vi.fn() };
    const sourceId = (await import('../electron/research/search-provider.js'))
      .sourceIdForUrl('https://papers-one.example.org/paper');
    const result = await runResearchPipeline({
      searchProvider: searchProvider([candidateInput('one', '2026-09-30')]),
      contentReader: successfulReader(new Set([sourceId])),
      reportProvider,
    }, task, new AbortController().signal, { now: () => nowValue });

    expect(result).toMatchObject({ status: 'no_evidence' });
    expect(reportProvider.generateDraft).not.toHaveBeenCalled();
  });

  it('retains search counts in progress when report generation fails', async () => {
    const progress = vi.fn();
    const onSearchCompleted = vi.fn();
    const onEvidenceBuilt = vi.fn();
    const failingReportProvider: ReportDraftProvider = {
      id: 'failing-report',
      async generateDraft() { throw new Error('Fixture generation failed.'); },
    };
    await expect(runResearchPipeline({
      searchProvider: searchProvider([
        candidateInput('known', '2026-09-30'),
        candidateInput('unknown', null),
      ]),
      contentReader: successfulReader(),
      reportProvider: failingReportProvider,
    }, task, new AbortController().signal, {
      now: () => nowValue,
      onProgress: progress,
      onSearchCompleted,
      onEvidenceBuilt,
    }))
      .rejects.toThrow('Fixture generation failed');

    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      stage: 'generating', eligibleSourceCount: 1, supplementarySourceCount: 1,
    });
    expect(onSearchCompleted).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({ title: 'Paper known' })],
      supplementaryCandidates: [expect.objectContaining({ title: 'Paper unknown' })],
    }));
    expect(onEvidenceBuilt).toHaveBeenCalledWith(expect.objectContaining({
      evidence: { sources: [expect.objectContaining({ title: 'Paper known' })], failures: [] },
    }));
  });

  it('rejects strict open-source filtering until paper-repository linking exists', async () => {
    const strictTask = { ...task, requireOpenSource: true };
    await expect(runResearchPipeline({
      searchProvider: searchProvider([]),
      contentReader: successfulReader(),
      reportProvider: reportDraftProvider(),
    }, strictTask, new AbortController().signal, { now: () => nowValue }))
      .rejects.toThrow('不能保證「只看有開源程式碼」');
  });

  it('propagates cancellation from the search provider', async () => {
    const controller = new AbortController();
    const provider: SearchProvider = {
      id: 'slow-search',
      scopeDescription: 'Fixture.',
      search(_request, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const pending = runResearchPipeline({
      searchProvider: provider,
      contentReader: successfulReader(),
      reportProvider: reportDraftProvider(),
    }, task, controller.signal, { now: () => nowValue });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
