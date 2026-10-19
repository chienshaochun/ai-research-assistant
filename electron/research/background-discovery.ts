import type { MonitoringRule } from './background-monitor.js';
import { buildMonitoringSearchRequest } from './background-monitor.js';
import type { MonitoringInboxItem } from './research-store.js';
import { runSearch, type SearchRunResult } from './run-search.js';
import type { SearchCandidate, SearchProvider } from './search-provider.js';

export interface BackgroundDiscoveryStore {
  recordMonitoringCandidates(
    ruleId: string,
    candidates: readonly SearchCandidate[],
    firstSeenAt?: string,
  ): MonitoringInboxItem[];
  completeMonitoringRule(ruleId: string, succeededAt?: string): MonitoringRule;
  deferMonitoringRule(ruleId: string, attemptedAt?: string, retryHours?: number): MonitoringRule;
}

export interface BackgroundDiscoveryResult {
  rule: MonitoringRule;
  search: SearchRunResult;
  newItems: MonitoringInboxItem[];
  briefing?: {
    status: 'completed' | 'skipped' | 'failed';
    message: string;
  };
}

export async function runBackgroundDiscovery(
  provider: SearchProvider,
  store: BackgroundDiscoveryStore,
  rule: MonitoringRule,
  signal: AbortSignal,
  options: { now?: () => Date } = {},
): Promise<BackgroundDiscoveryResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  try {
    const search = await runSearch(
      provider,
      buildMonitoringSearchRequest(rule, startedAt),
      signal,
      { now },
    );
    signal.throwIfAborted();
    const completedAt = now().toISOString();
    const newItems = store.recordMonitoringCandidates(rule.id, search.candidates, completedAt);
    const updatedRule = store.completeMonitoringRule(rule.id, completedAt);
    return { rule: updatedRule, search, newItems };
  } catch (error) {
    if (!signal.aborted) store.deferMonitoringRule(rule.id, now().toISOString(), 1);
    throw error;
  }
}
