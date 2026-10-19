import type { ContentReader } from './content-reader.js';
import {
  buildEvidenceBundle,
  type EvidenceBundle,
  type ResearchReport,
} from './report.js';
import {
  generateResearchReport,
  type ReportDraftProvider,
} from './report-provider.js';
import {
  describeResearchTask,
  type ResolvedResearchTask,
} from './research-task.js';
import {
  runReading,
  type ReadingRunResult,
} from './run-reading.js';
import {
  type SearchRunResult,
} from './run-search.js';
import { runOrchestratedSearch } from './search-orchestrator.js';
import type { SearchProvider, SearchRequest } from './search-provider.js';

export const RESEARCH_STAGES = [
  'planning', 'searching', 'reading', 'generating', 'completed', 'no_results', 'no_evidence',
] as const;
export type ResearchStage = typeof RESEARCH_STAGES[number];

export interface ResearchProgress {
  stage: ResearchStage;
  message: string;
  completedSources?: number;
  totalSources?: number;
  eligibleSourceCount?: number;
  supplementarySourceCount?: number;
}

interface ResearchPipelineBase {
  task: ResolvedResearchTask;
  understanding: string;
  searchRequest: SearchRequest;
  search: SearchRunResult;
}

export interface CompletedResearchPipeline extends ResearchPipelineBase {
  status: 'completed';
  reading: ReadingRunResult;
  evidence: EvidenceBundle;
  report: ResearchReport;
}

export interface NoResultsResearchPipeline extends ResearchPipelineBase {
  status: 'no_results';
  reason: 'no_date_eligible_sources' | 'no_eligible_sources';
}

export interface NoEvidenceResearchPipeline extends ResearchPipelineBase {
  status: 'no_evidence';
  reason: 'all_selected_sources_failed_or_deferred';
  reading: ReadingRunResult;
  evidence: EvidenceBundle;
}

export type ResearchPipelineResult =
  | CompletedResearchPipeline
  | NoResultsResearchPipeline
  | NoEvidenceResearchPipeline;

export interface ResearchPipelineDependencies {
  searchProvider: SearchProvider;
  contentReader: ContentReader;
  reportProvider: ReportDraftProvider;
}

export interface ResearchPipelineOptions {
  now?: () => Date;
  onProgress?: (progress: ResearchProgress) => void;
  onSearchCompleted?: (search: SearchRunResult) => void;
  onEvidenceBuilt?: (checkpoint: {
    search: SearchRunResult;
    reading: ReadingRunResult;
    evidence: EvidenceBundle;
  }) => void;
  maxSearchCandidates?: number;
  maxReadSources?: number;
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必須是 ${minimum} 到 ${maximum} 的整數。`);
  }
  return value;
}

function emit(options: ResearchPipelineOptions, progress: ResearchProgress): void {
  try { options.onProgress?.(progress); } catch { /* UI progress cannot interrupt research. */ }
}

function checkpoint(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* Observability cannot interrupt research. */ }
}

export function buildResearchSearchQuery(task: ResolvedResearchTask): string {
  return task.topic.trim();
}

export function describeExecutedSearchScope(search: SearchRunResult): string {
  const executions = search.queryExecutions ?? [];
  const queryText = executions.length > 0
    ? `實際查詢：${executions.map(({ kind, query }) =>
      `${kind === 'primary' ? '主查詢' : '缺口補查'}「${query}」`).join('；')}。`
    : '';
  const gaps = search.uncoveredConcepts?.length
    ? `尚未涵蓋：${search.uncoveredConcepts.join('、')}。`
    : '';
  const shortfall = search.candidateShortfall
    ? `符合條件的候選仍少 ${search.candidateShortfall} 筆，未以不合格來源湊數。`
    : '';
  return [search.scopeDescription, queryText, gaps, shortfall].filter(Boolean).join(' ');
}

export async function runResearchPipeline(
  dependencies: ResearchPipelineDependencies,
  task: ResolvedResearchTask,
  signal: AbortSignal,
  options: ResearchPipelineOptions = {},
): Promise<ResearchPipelineResult> {
  if (task.requireOpenSource) {
    throw new Error('目前尚未完成論文與 repository 的可靠關聯，不能保證「只看有開源程式碼」。');
  }
  const now = options.now ?? (() => new Date());
  const understanding = describeResearchTask(task);
  const maxSearchCandidates = bounded(
    options.maxSearchCandidates ?? Math.min(task.maxItems * 4, 25),
    task.maxItems,
    25,
    '搜尋候選上限',
  );
  const maxReadSources = bounded(
    options.maxReadSources ?? Math.min(task.maxItems * 2, 10),
    task.maxItems,
    25,
    '閱讀來源上限',
  );
  if (
    task.publicationDateMode === 'recent' &&
    dependencies.searchProvider.publicationDateSupport === 'unknown'
  ) {
    throw new Error(
      '官方 Web Search 候選目前沒有可驗證的發布日期；請在指令中明確加入「日期不限」，或改用 arXiv。',
    );
  }
  const searchRequest: SearchRequest = {
    query: buildResearchSearchQuery(task),
    maxResults: maxSearchCandidates,
    ...(task.publishedFrom ? { publishedFrom: task.publishedFrom } : {}),
    ...(task.publishedTo ? { publishedTo: task.publishedTo } : {}),
    paperFirst: task.paperFirst,
    preferOpenSource: task.preferOpenSource,
  };

  signal.throwIfAborted();
  emit(options, { stage: 'planning', message: understanding });
  emit(options, { stage: 'searching', message: '正在搜尋候選來源；資料不足時最多補查一次。' });
  const search = await runOrchestratedSearch(
    dependencies.searchProvider,
    searchRequest,
    signal,
    { now, minimumCandidateCount: task.maxItems },
  );
  checkpoint(() => options.onSearchCompleted?.(search));
  if (search.candidates.length === 0) {
    const hasDateBoundary = task.publicationDateMode === 'recent';
    emit(options, {
      stage: 'no_results',
      message: hasDateBoundary
        ? `沒有日期已確認且符合範圍的來源；另有 ${search.supplementaryCandidates.length} 筆日期待核對。`
        : '沒有符合搜尋條件的來源。',
      eligibleSourceCount: 0,
      supplementarySourceCount: search.supplementaryCandidates.length,
    });
    return {
      status: 'no_results',
      reason: hasDateBoundary ? 'no_date_eligible_sources' : 'no_eligible_sources',
      task,
      understanding,
      searchRequest,
      search,
    };
  }

  emit(options, {
    stage: 'reading',
    message: '正在讀取並驗證來源內容。',
    completedSources: 0,
    totalSources: Math.min(search.candidates.length, maxReadSources),
    eligibleSourceCount: search.candidates.length,
    supplementarySourceCount: search.supplementaryCandidates.length,
  });
  const reading = await runReading(
    dependencies.contentReader,
    search.candidates,
    signal,
    { maxSources: maxReadSources, maxAttemptsPerSource: 2, now },
  );
  const evidence = buildEvidenceBundle(search.candidates, reading.records);
  checkpoint(() => options.onEvidenceBuilt?.({ search, reading, evidence }));
  if (evidence.sources.length === 0) {
    emit(options, {
      stage: 'no_evidence',
      message: '候選來源均未成功讀取，無法產生有證據的報告。',
      completedSources: reading.records.length,
      totalSources: reading.selectedCount,
      eligibleSourceCount: search.candidates.length,
      supplementarySourceCount: search.supplementaryCandidates.length,
    });
    return {
      status: 'no_evidence',
      reason: 'all_selected_sources_failed_or_deferred',
      task,
      understanding,
      searchRequest,
      search,
      reading,
      evidence,
    };
  }

  emit(options, {
    stage: 'generating',
    message: '正在依已讀證據整理報告並驗證引用。',
    completedSources: evidence.sources.length,
    totalSources: reading.selectedCount,
    eligibleSourceCount: search.candidates.length,
    supplementarySourceCount: search.supplementaryCandidates.length,
  });
  const report = await generateResearchReport(
    dependencies.reportProvider,
    {
      topic: task.topic,
      ...(task.publishedFrom ? { publishedFrom: task.publishedFrom } : {}),
      ...(task.publishedTo ? { publishedTo: task.publishedTo } : {}),
      searchScope: describeExecutedSearchScope(search),
      generatedAt: now().toISOString(),
      maxItems: Math.min(task.maxItems, evidence.sources.length),
      summaryPoints: task.summaryPoints,
    },
    evidence,
    signal,
  );
  emit(options, {
    stage: 'completed',
    message: `完成 ${report.items.length} 項研究整理。`,
    completedSources: evidence.sources.length,
    totalSources: reading.selectedCount,
    eligibleSourceCount: search.candidates.length,
    supplementarySourceCount: search.supplementaryCandidates.length,
  });
  return {
    status: 'completed',
    task,
    understanding,
    searchRequest,
    search,
    reading,
    evidence,
    report,
  };
}
