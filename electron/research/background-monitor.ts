export interface MonitoringRuleInput {
  id: string;
  name: string;
  query: string;
  enabled: boolean;
  intervalHours: number;
  lookbackDays: number;
  maxItems: number;
  autoBrief: boolean;
  digestHourLocal?: number;
}

export interface MonitoringRule extends Omit<MonitoringRuleInput, 'digestHourLocal'> {
  digestHourLocal: number;
  createdAt: string;
  updatedAt: string;
  lastSucceededAt: string | null;
  nextRunAt: string | null;
  lastDigestAt: string | null;
}

export interface MonitoringBrief {
  sourceId: string;
  problem: string;
  coreMethod: string;
  workValue: string;
  unverified: string[];
}

export const MONITORING_FEEDBACK_VALUES = [
  'worth_investigating',
  'later',
  'not_relevant',
  'already_known',
  'not_actionable',
] as const;
export type MonitoringFeedback = typeof MONITORING_FEEDBACK_VALUES[number];

export function validateMonitoringFeedback(value: unknown): MonitoringFeedback {
  if (typeof value !== 'string' ||
      !MONITORING_FEEDBACK_VALUES.includes(value as MonitoringFeedback)) {
    throw new Error('監測回饋不在允許的值中。');
  }
  return value as MonitoringFeedback;
}

export function validMonitoringTime(value: string, label: string): string {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.valueOf())) throw new Error(`${label} 無效。`);
  return parsed.toISOString();
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum ||
      /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} 必須是 1 到 ${maximum} 個可顯示字元。`);
  }
  return value.trim();
}

export function validateMonitoringRuleInput(input: MonitoringRuleInput): MonitoringRuleInput {
  const id = text(input.id, '監測規則 ID', 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error('監測規則 ID 只能包含小寫英數字、底線或連字號。');
  }
  if (typeof input.enabled !== 'boolean' || typeof input.autoBrief !== 'boolean') {
    throw new Error('監測啟用與自動摘要設定必須是布林值。');
  }
  if (!Number.isInteger(input.intervalHours) || input.intervalHours < 1 ||
      input.intervalHours > 168) {
    throw new Error('監測間隔必須是 1 到 168 小時的整數。');
  }
  if (!Number.isInteger(input.lookbackDays) || input.lookbackDays < 1 ||
      input.lookbackDays > 30) {
    throw new Error('監測回溯範圍必須是 1 到 30 天的整數。');
  }
  if (!Number.isInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 3) {
    throw new Error('主動摘要上限必須是 1 到 3 項。');
  }
  const digestHourLocal = input.digestHourLocal ?? 9;
  if (!Number.isInteger(digestHourLocal) || digestHourLocal < 0 || digestHourLocal > 23) {
    throw new Error('每日匯報時間必須是 0 到 23 時。');
  }
  return {
    id,
    name: text(input.name, '監測名稱', 100),
    query: text(input.query, '監測主題', 500),
    enabled: input.enabled,
    intervalHours: input.intervalHours,
    lookbackDays: input.lookbackDays,
    maxItems: input.maxItems,
    autoBrief: input.autoBrief,
    digestHourLocal,
  };
}

function localDay(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

export function shouldDeliverMonitoringDigest(rule: MonitoringRule, now: Date): boolean {
  if (Number.isNaN(now.valueOf()) || !rule.enabled || now.getHours() < rule.digestHourLocal) {
    return false;
  }
  return !rule.lastDigestAt || localDay(new Date(rule.lastDigestAt)) < localDay(now);
}

export function nextMonitoringRunAt(from: string, intervalHours: number): string {
  const base = new Date(validMonitoringTime(from, '排程基準時間'));
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
    throw new Error('監測間隔必須是 1 到 168 小時的整數。');
  }
  base.setUTCHours(base.getUTCHours() + intervalHours);
  return base.toISOString();
}

export function isMonitoringRuleDue(rule: MonitoringRule, now: string): boolean {
  const current = validMonitoringTime(now, '目前時間');
  return rule.enabled && rule.nextRunAt !== null && rule.nextRunAt <= current;
}

export function buildMonitoringSearchRequest(rule: MonitoringRule, now: string) {
  const current = new Date(validMonitoringTime(now, '監測搜尋時間'));
  const earliest = new Date(current);
  earliest.setUTCDate(earliest.getUTCDate() - (rule.lookbackDays - 1));
  const lastSucceededDate = rule.lastSucceededAt?.slice(0, 10) ?? null;
  const lookbackDate = earliest.toISOString().slice(0, 10);
  return {
    query: rule.query,
    maxResults: 12,
    publishedFrom: lastSucceededDate && lastSucceededDate > lookbackDate
      ? lastSucceededDate : lookbackDate,
    publishedTo: current.toISOString().slice(0, 10),
    paperFirst: true,
    preferOpenSource: false,
  };
}
