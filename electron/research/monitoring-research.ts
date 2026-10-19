import type { MonitoringInboxItem } from './research-store.js';
import type { ResolvedResearchTask } from './research-task.js';
import type {
  SearchCandidateInput,
  SearchProvider,
  SearchRequest,
} from './search-provider.js';

export class MonitoringItemSearchProvider implements SearchProvider {
  readonly id = 'monitoring-item';
  readonly publicationDateSupport = 'verified' as const;
  readonly scopeDescription: string;

  constructor(private readonly item: MonitoringInboxItem) {
    this.scopeDescription =
      `監測收件匣固定來源「${item.candidate.title}」；不重新選擇其他論文。`;
  }

  async search(
    _request: SearchRequest,
    signal: AbortSignal,
  ): Promise<readonly SearchCandidateInput[]> {
    signal.throwIfAborted();
    const source = this.item.candidate;
    return [{
      title: source.title,
      url: source.url,
      authorOrOrganization: source.authorOrOrganization,
      publishedDate: source.publishedDate,
      updatedDate: source.updatedDate,
      sourceType: source.sourceType,
      evidenceLevel: source.evidenceLevel,
      excerpt: source.excerpt,
    }];
  }
}

export function monitoringResearchTask(item: MonitoringInboxItem): ResolvedResearchTask {
  return {
    topic: item.candidate.title,
    lookbackDays: 7,
    publicationDateMode: 'any',
    searchMode: 'arxiv',
    maxItems: 1,
    summaryPoints: 3,
    reportFormat: 'detailed',
    paperFirst: true,
    preferOpenSource: false,
    requireOpenSource: false,
    language: 'zh-Hant',
    publishedFrom: null,
    publishedTo: null,
  };
}
