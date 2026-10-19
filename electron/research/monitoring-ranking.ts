import type { MonitoringRule } from './background-monitor.js';
import type { MonitoringInboxItem } from './research-store.js';

export interface RankedMonitoringItem {
  item: MonitoringInboxItem;
  score: number;
  reasons: string[];
}

const FEEDBACK_WEIGHT = {
  worth_investigating: 3,
  later: 1,
  not_relevant: -3,
  already_known: -1,
  not_actionable: -2,
} as const;

const STOP_WORDS = new Set([
  'about', 'after', 'agent', 'agents', 'application', 'applications', 'based', 'from',
  'into', 'large', 'model', 'models', 'paper', 'research', 'system', 'systems', 'that',
  'their', 'this', 'using', 'with',
]);

export function monitoringTokens(value: string): string[] {
  const normalized = value.toLocaleLowerCase('en-US');
  const latin = normalized.match(/[a-z0-9][a-z0-9+#.-]{2,}/g) ?? [];
  const chineseRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const characters = [...run];
    return characters.slice(0, -1).map((character, index) =>
      `${character}${characters[index + 1]}`);
  });
  return [...new Set([...latin, ...chinese].filter((token) => !STOP_WORDS.has(token)))];
}

function itemTokens(item: MonitoringInboxItem): Set<string> {
  return new Set(monitoringTokens(
    `${item.candidate.title} ${item.candidate.excerpt ?? ''}`,
  ));
}

function learnedWeights(history: readonly MonitoringInboxItem[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const item of history) {
    if (!item.feedback) continue;
    const weight = FEEDBACK_WEIGHT[item.feedback];
    for (const token of itemTokens(item)) {
      weights.set(token, (weights.get(token) ?? 0) + weight);
    }
  }
  return weights;
}

function dateScore(publishedDate: string | null, now: Date): number {
  if (!publishedDate) return 0;
  const ageDays = Math.floor(
    (now.valueOf() - new Date(`${publishedDate}T00:00:00.000Z`).valueOf()) / 86_400_000,
  );
  if (ageDays <= 7) return 2;
  if (ageDays <= 30) return 1;
  return 0;
}

export function rankMonitoringItems(
  rule: MonitoringRule,
  items: readonly MonitoringInboxItem[],
  feedbackHistory: readonly MonitoringInboxItem[],
  now = new Date(),
): RankedMonitoringItem[] {
  const queryTokens = new Set(monitoringTokens(rule.query));
  const weights = learnedWeights(feedbackHistory);
  const ranked = items.map((item) => {
    const tokens = itemTokens(item);
    const queryMatches = [...queryTokens].filter((token) => tokens.has(token));
    const learned = [...tokens].reduce((sum, token) => sum + (weights.get(token) ?? 0), 0);
    const boundedLearned = Math.max(-8, Math.min(8, learned));
    const recency = dateScore(item.candidate.publishedDate, now);
    const evidence = item.candidate.evidenceLevel === 'full_text' ? 2
      : item.candidate.evidenceLevel === 'abstract' ? 1 : 0;
    const score = queryMatches.length * 2 + boundedLearned + recency + evidence;
    const reasons: string[] = [];
    if (queryMatches.length) reasons.push(`符合監測主題：${queryMatches.slice(0, 3).join('、')}`);
    if (boundedLearned > 0) reasons.push('接近過去標為值得深入的內容');
    if (boundedLearned < 0) reasons.push('接近過去降低優先度的內容');
    if (recency > 0) reasons.push(recency === 2 ? '最近七天發布' : '最近三十天發布');
    if (evidence > 0) reasons.push(item.candidate.evidenceLevel === 'full_text'
      ? '已有全文證據' : '已有摘要證據');
    return { item, score, reasons: reasons.slice(0, 3) };
  });
  return ranked.sort((left, right) =>
    right.score - left.score ||
    (right.item.candidate.publishedDate ?? '').localeCompare(
      left.item.candidate.publishedDate ?? '',
    ) ||
    right.item.firstSeenAt.localeCompare(left.item.firstSeenAt) ||
    left.item.sourceId.localeCompare(right.item.sourceId));
}
