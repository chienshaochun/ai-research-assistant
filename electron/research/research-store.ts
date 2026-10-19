import { DatabaseSync } from 'node:sqlite';
import { normalizePublicHttpUrl } from '../security/public-url.js';
import type { EvidenceBundle, ResearchReport } from './report.js';
import {
  EVIDENCE_LEVELS,
  SOURCE_TYPES,
  type SearchCandidate,
} from './search-provider.js';
import {
  CITATION_SUPPORT_LABELS,
  listEvaluationClaims,
  type CitationEvaluationSummary,
} from './evaluation-worksheet.js';
import {
  applyPreferencePatch,
  type LongTermPreferences,
} from './research-task.js';
import {
  validateStoredFollowUpAnswer,
  type FollowUpAnswer,
} from './report-follow-up.js';
import {
  nextMonitoringRunAt,
  validateMonitoringFeedback,
  validateMonitoringRuleInput,
  validMonitoringTime,
  type MonitoringRule,
  type MonitoringRuleInput,
  type MonitoringBrief,
  type MonitoringFeedback,
} from './background-monitor.js';
import { normalizeSearchCandidate } from './search-provider.js';

export interface MonitoringInboxItem {
  ruleId: string;
  sourceId: string;
  status: 'new' | 'read' | 'dismissed';
  firstSeenAt: string;
  candidate: SearchCandidate;
  brief: MonitoringBrief | null;
  briefedAt: string | null;
  briefModelSlug: string | null;
  feedback: MonitoringFeedback | null;
  feedbackAt: string | null;
  linkedReportId: string | null;
  notifiedAt: string | null;
}

export interface MonitoringRunSummary {
  id: number;
  ruleId: string;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  discoveredCount: number;
  briefedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

const PREFERENCE_KEYS = new Set([
  'topic', 'lookbackDays', 'publicationDateMode', 'searchMode', 'maxItems', 'summaryPoints', 'reportFormat',
  'paperFirst', 'preferOpenSource', 'requireOpenSource',
]);

export interface SaveCompletedResearchInput {
  command: string;
  modelSlug: string;
  understanding: string;
  report: ResearchReport;
  evidence: EvidenceBundle;
}

export interface ReportHistorySummary {
  id: string;
  topic: string;
  generatedAt: string;
  publishedFrom: string | null;
  publishedTo: string | null;
  itemCount: number;
  citedSourceCount: number;
}

export type ResearchAttemptStatus = 'no_results' | 'no_evidence' | 'failed' | 'cancelled';
export type ResearchAttemptStage = 'planning' | 'searching' | 'reading' | 'generating';

export interface SaveResearchAttemptInput {
  status: ResearchAttemptStatus;
  stage: ResearchAttemptStage;
  command: string;
  modelSlug: string;
  understanding: string;
  startedAt: string;
  finishedAt: string;
  errorCode?: string;
  errorMessage?: string;
  eligibleSourceCount?: number;
  supplementarySourceCount?: number;
  failures?: EvidenceBundle['failures'];
  readSourceIds?: readonly string[];
  eligibleSources?: readonly SearchCandidate[];
  supplementarySources?: readonly SearchCandidate[];
}

export interface ResearchAttemptSource {
  attemptId: number;
  sourceId: string;
  sourceOrder: number;
  bucket: 'eligible' | 'supplementary';
  title: string;
  url: string;
  authorOrOrganization: string | null;
  publishedDate: string | null;
  updatedDate: string | null;
  sourceType: SearchCandidate['sourceType'];
  evidenceLevel: SearchCandidate['evidenceLevel'];
  excerpt: string | null;
  readStatus: 'not_attempted' | 'read' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ResearchAttemptSummary {
  id: number;
  status: ResearchAttemptStatus;
  stage: ResearchAttemptStage;
  command: string;
  modelSlug: string;
  understanding: string;
  startedAt: string;
  finishedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  eligibleSourceCount: number;
  supplementarySourceCount: number;
  failureCount: number;
  sources: ResearchAttemptSource[];
}

export interface ConversationMessage {
  id: number;
  reportId: string | null;
  targetItemId: string | null;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必須是物件。`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${label} 必須是非空且不含控制字元的文字。`);
  }
  return value;
}

function validIsoTime(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (Number.isNaN(new Date(text).valueOf())) throw new Error(`${label} 無效。`);
  return new Date(text).toISOString();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必須是非負整數。`);
  }
  return Number(value);
}

function monitoringBriefText(value: unknown, label: string, maximum = 1_000): string {
  const text = requiredString(value, label).trim();
  if (text.length > maximum) throw new Error(`${label} 不可超過 ${maximum} 字。`);
  return text;
}

function validateMonitoringBrief(value: unknown, expectedSourceId: string): MonitoringBrief {
  const brief = asObject(value, '主動摘要');
  const sourceId = monitoringBriefText(brief.sourceId, '主動摘要來源 ID', 100);
  if (sourceId !== expectedSourceId || !/^src_[a-f0-9]{20}$/.test(sourceId)) {
    throw new Error('主動摘要來源 ID 無效。');
  }
  if (!Array.isArray(brief.unverified) || brief.unverified.length < 1 ||
      brief.unverified.length > 3) {
    throw new Error('主動摘要必須包含 1 到 3 項未驗證事項。');
  }
  return {
    sourceId,
    problem: monitoringBriefText(brief.problem, '主動摘要問題'),
    coreMethod: monitoringBriefText(brief.coreMethod, '主動摘要核心方法'),
    workValue: monitoringBriefText(brief.workValue, '主動摘要工作價值'),
    unverified: brief.unverified.map((entry, index) =>
      monitoringBriefText(entry, `主動摘要未驗證[${index}]`, 500)),
  };
}

function validateStoredStatement(
  value: unknown,
  label: string,
  allowedSourceIds: ReadonlySet<string>,
): string[] {
  const statement = asObject(value, label);
  requiredString(statement.text, `${label}文字`);
  if (!Array.isArray(statement.sourceIds) || statement.sourceIds.length < 1 ||
      statement.sourceIds.length > 6) {
    throw new Error(`${label} 必須引用 1 到 6 個來源。`);
  }
  const sourceIds = statement.sourceIds.map((sourceId) =>
    requiredString(sourceId, `${label}來源 ID`)
  );
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error(`${label} 的來源 ID 不可重複。`);
  }
  for (const sourceId of sourceIds) {
    if (!allowedSourceIds.has(sourceId)) {
      throw new Error(`${label} 引用了不屬於該項目的來源：${sourceId}。`);
    }
  }
  return sourceIds;
}

function validateStoredStatementArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  allowedSourceIds: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} 必須包含 ${minimum} 到 ${maximum} 項。`);
  }
  return value.flatMap((statement, index) =>
    validateStoredStatement(statement, `${label}[${index}]`, allowedSourceIds)
  );
}

function validatePreferences(value: unknown): LongTermPreferences {
  const object = asObject(value, '長期偏好');
  for (const key of Object.keys(object)) {
    if (!PREFERENCE_KEYS.has(key)) throw new Error(`不支援的長期偏好欄位：${key}。`);
  }
  return applyPreferencePatch({}, object as LongTermPreferences);
}

function validateStoredReport(value: unknown, expectedId: string): ResearchReport {
  const report = asObject(value, '歷史報告');
  if (requiredString(report.id, '報告 ID') !== expectedId) {
    throw new Error('歷史報告 ID 與資料庫不一致。');
  }
  requiredString(report.topic, '報告主題');
  requiredString(report.generatedAt, '報告產出時間');
  requiredString(report.markdown, 'Markdown 報告');
  if (!Array.isArray(report.items) || !Array.isArray(report.citedSources)) {
    throw new Error('歷史報告缺少項目或來源。');
  }
  const sourceIds = new Set<string>();
  for (const rawSource of report.citedSources) {
    const source = asObject(rawSource, '報告來源');
    const id = requiredString(source.id, '來源 ID');
    if (sourceIds.has(id)) throw new Error(`歷史報告來源 ID 重複：${id}。`);
    sourceIds.add(id);
    const url = requiredString(source.url, '來源 URL');
    if (!normalizePublicHttpUrl(url)) throw new Error(`來源 ${id} 不是安全公開 HTTP(S) URL。`);
    requiredString(source.title, '來源標題');
    requiredString(source.content, '來源內容');
    const contentHash = requiredString(source.contentHash, '來源內容 hash');
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error(`來源 ${id} 的內容 hash 無效。`);
  }
  validateStoredStatementArray(report.summary, '重點摘要', 1, 3, sourceIds);
  const itemIds = new Set<string>();
  const orderedItemSourceIds: string[] = [];
  const seenItemSourceIds = new Set<string>();
  for (const [index, rawItem] of report.items.entries()) {
    const item = asObject(rawItem, '報告項目');
    const itemId = requiredString(item.id, '項目 ID');
    const expectedItemId = `item_${String(index + 1).padStart(2, '0')}`;
    if (itemId !== expectedItemId) throw new Error(`歷史報告項目 ID 順序錯誤：${itemId}。`);
    if (itemIds.has(itemId)) throw new Error(`歷史報告項目 ID 重複：${itemId}。`);
    itemIds.add(itemId);
    requiredString(item.name, `報告項目 ${itemId} 名稱`);
    const primarySourceId = requiredString(item.primarySourceId, '主要來源 ID');
    if (!sourceIds.has(primarySourceId)) {
      throw new Error(`歷史報告項目 ${itemId} 的主要來源不存在。`);
    }
    if (!Array.isArray(item.relatedSourceIds) ||
        item.relatedSourceIds.some((id) => typeof id !== 'string' || !sourceIds.has(id))) {
      throw new Error(`歷史報告項目 ${itemId} 的相關來源不存在。`);
    }
    const relatedSourceIds = item.relatedSourceIds as string[];
    if (relatedSourceIds.length > 5 || new Set(relatedSourceIds).size !== relatedSourceIds.length ||
        relatedSourceIds.includes(primarySourceId)) {
      throw new Error(`歷史報告項目 ${itemId} 的相關來源重複或超過上限。`);
    }
    const allowedSourceIds = new Set([primarySourceId, ...relatedSourceIds]);
    for (const sourceId of allowedSourceIds) {
      if (!seenItemSourceIds.has(sourceId)) {
        seenItemSourceIds.add(sourceId);
        orderedItemSourceIds.push(sourceId);
      }
    }
    const usedSourceIds = new Set([
      ...validateStoredStatement(item.problem, `${itemId} 問題`, allowedSourceIds),
      ...validateStoredStatement(item.method, `${itemId} 方法`, allowedSourceIds),
      ...validateStoredStatementArray(item.evidence, `${itemId} 證據`, 1, 5, allowedSourceIds),
      ...validateStoredStatementArray(item.limitations, `${itemId} 限制`, 0, 5, allowedSourceIds),
    ]);
    for (const sourceId of allowedSourceIds) {
      if (!usedSourceIds.has(sourceId)) {
        throw new Error(`歷史報告項目 ${itemId} 的來源沒有支持任何主張：${sourceId}。`);
      }
    }
    const analysis = asObject(item.analysis, `${itemId} 助理分析`);
    requiredString(analysis.applicationValue, `${itemId} 應用價值`);
    requiredString(analysis.smallExperiment, `${itemId} 小型實驗`);
    if (!Array.isArray(analysis.unverified) || analysis.unverified.length < 1 ||
        analysis.unverified.length > 5 ||
        analysis.unverified.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error(`${itemId} 必須包含 1 到 5 項尚未驗證事項。`);
    }
  }
  if (JSON.stringify(orderedItemSourceIds) !== JSON.stringify([...sourceIds])) {
    throw new Error('歷史報告引用來源與項目來源的順序或內容不一致。');
  }
  return value as ResearchReport;
}

function validateSaveInput(input: SaveCompletedResearchInput): void {
  requiredString(input.command, '研究指令');
  requiredString(input.modelSlug, '模型名稱');
  requiredString(input.understanding, '任務理解');
  validateStoredReport(input.report, input.report.id);
  const evidenceIds = new Set(input.evidence.sources.map(({ id }) => id));
  for (const source of input.report.citedSources) {
    if (!evidenceIds.has(source.id)) {
      throw new Error(`報告引用了不在證據集合中的來源：${source.id}。`);
    }
  }
}

function validateCitationEvaluation(
  value: unknown,
  reportId: string,
  expectedClaimIds: readonly string[],
): CitationEvaluationSummary {
  const summary = asObject(value, 'citation 評估');
  if (requiredString(summary.reportId, '評估報告 ID') !== reportId) {
    throw new Error('citation 評估的報告 ID 不一致。');
  }
  const total = nonNegativeInteger(summary.total, '評估主張總數');
  const evaluated = nonNegativeInteger(summary.evaluated, '已評估主張數');
  const unlabeled = nonNegativeInteger(summary.unlabeled, '未標註主張數');
  if (total !== expectedClaimIds.length || evaluated + unlabeled !== total) {
    throw new Error('citation 評估的主張數與報告不一致。');
  }
  const rawCounts = asObject(summary.counts, '評估標籤統計');
  const counts = Object.fromEntries(CITATION_SUPPORT_LABELS.map((label) => [
    label, nonNegativeInteger(rawCounts[label], `評估標籤 ${label}`),
  ])) as CitationEvaluationSummary['counts'];
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== evaluated) {
    throw new Error('citation 評估的標籤統計與已評估數不一致。');
  }
  if (!Array.isArray(summary.annotations) || summary.annotations.length !== total) {
    throw new Error('citation 評估缺少逐主張標註。');
  }
  const expected = new Set(expectedClaimIds);
  const seen = new Set<string>();
  const annotations = summary.annotations.map((raw) => {
    const annotation = asObject(raw, '逐主張標註');
    const claimId = requiredString(annotation.claimId, '評估主張 ID');
    if (!expected.has(claimId) || seen.has(claimId)) {
      throw new Error(`citation 評估主張不存在或重複：${claimId}。`);
    }
    seen.add(claimId);
    const label = annotation.label;
    if (label !== null &&
        (typeof label !== 'string' || !CITATION_SUPPORT_LABELS.includes(
          label as typeof CITATION_SUPPORT_LABELS[number],
        ))) {
      throw new Error(`citation 評估標籤無效：${String(label)}。`);
    }
    return { claimId, label } as CitationEvaluationSummary['annotations'][number];
  });
  const annotationCounts = Object.fromEntries(CITATION_SUPPORT_LABELS.map((label) => [
    label, annotations.filter((item) => item.label === label).length,
  ]));
  if (JSON.stringify(annotationCounts) !== JSON.stringify(counts) ||
      annotations.filter(({ label }) => label === null).length !== unlabeled) {
    throw new Error('citation 評估的逐主張標註與統計不一致。');
  }
  const strictSupportedRate = evaluated === 0 ? null : counts.supported / evaluated;
  const supportedOrPartialRate = evaluated === 0
    ? null : (counts.supported + counts.partially_supported) / evaluated;
  if (summary.strictSupportedRate !== strictSupportedRate ||
      summary.supportedOrPartialRate !== supportedOrPartialRate) {
    throw new Error('citation 評估的比率與標籤統計不一致。');
  }
  return {
    reportId, total, evaluated, unlabeled, counts,
    strictSupportedRate, supportedOrPartialRate, annotations,
  };
}

export class ResearchStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (!path) throw new Error('SQLite 路徑不可為空。');
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  schemaVersion(): number {
    const row = this.database.prepare('PRAGMA user_version').get() as
      { user_version: number } | undefined;
    return row?.user_version ?? 0;
  }

  checkIntegrity(): void {
    const rows = this.database.prepare('PRAGMA quick_check').all() as
      Array<Record<string, unknown>>;
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') {
      throw new Error('SQLite integrity check failed.');
    }
  }

  createSnapshot(destinationPath: string): void {
    if (!destinationPath) throw new Error('Snapshot destination is required.');
    const escaped = destinationPath.replace(/'/g, "''");
    this.database.exec(`VACUUM INTO '${escaped}'`);
  }

  private migrate(): void {
    const row = this.database.prepare('PRAGMA user_version').get() as
      { user_version: number } | undefined;
    const version = row?.user_version ?? 0;
    if (version > 10) throw new Error(`資料庫版本 ${version} 高於應用支援的版本。`);
    if (version === 10) return;
    if (version === 9) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE monitoring_rules ADD COLUMN digest_hour_local INTEGER NOT NULL DEFAULT 9
          CHECK (digest_hour_local BETWEEN 0 AND 23);
        ALTER TABLE monitoring_rules ADD COLUMN last_digest_at TEXT;
        ALTER TABLE monitoring_items ADD COLUMN notified_at TEXT;
        CREATE TABLE monitoring_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id TEXT NOT NULL REFERENCES monitoring_rules(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
          briefed_count INTEGER NOT NULL DEFAULT 0 CHECK (briefed_count >= 0),
          error_code TEXT,
          error_message TEXT
        );
        CREATE INDEX monitoring_runs_rule_started_idx
          ON monitoring_runs(rule_id, started_at DESC);
        PRAGMA user_version = 10;
        COMMIT;
      `);
      return;
    }
    if (version === 8) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE monitoring_items ADD COLUMN feedback TEXT
          CHECK (feedback IS NULL OR feedback IN (
            'worth_investigating', 'later', 'not_relevant', 'already_known', 'not_actionable'
          ));
        ALTER TABLE monitoring_items ADD COLUMN feedback_at TEXT;
        ALTER TABLE monitoring_items ADD COLUMN linked_report_id TEXT
          REFERENCES reports(id) ON DELETE SET NULL;
        CREATE INDEX monitoring_items_feedback_idx
          ON monitoring_items(rule_id, feedback, feedback_at DESC);
        PRAGMA user_version = 9;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    if (version === 7) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE monitoring_rules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          query TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          interval_hours INTEGER NOT NULL CHECK (interval_hours BETWEEN 1 AND 168),
          lookback_days INTEGER NOT NULL CHECK (lookback_days BETWEEN 1 AND 30),
          max_items INTEGER NOT NULL CHECK (max_items BETWEEN 1 AND 3),
          auto_brief INTEGER NOT NULL CHECK (auto_brief IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_succeeded_at TEXT,
          next_run_at TEXT
        );
        CREATE TABLE monitoring_items (
          rule_id TEXT NOT NULL REFERENCES monitoring_rules(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('new', 'read', 'dismissed')),
          first_seen_at TEXT NOT NULL,
          candidate_json TEXT NOT NULL,
          brief_json TEXT,
          briefed_at TEXT,
          brief_model_slug TEXT,
          PRIMARY KEY (rule_id, source_id)
        );
        CREATE TABLE monitoring_model_usage (
          usage_date TEXT PRIMARY KEY,
          request_count INTEGER NOT NULL CHECK (request_count BETWEEN 0 AND 1),
          updated_at TEXT NOT NULL
        );
        CREATE INDEX monitoring_rules_due_idx ON monitoring_rules(enabled, next_run_at);
        CREATE INDEX monitoring_items_status_idx
          ON monitoring_items(rule_id, status, first_seen_at DESC);
        PRAGMA user_version = 8;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    if (version === 6) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE follow_ups (
          id TEXT PRIMARY KEY,
          report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
          target_item_id TEXT NOT NULL,
          assistant_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          answer_json TEXT NOT NULL
        );
        CREATE TABLE follow_up_sources (
          follow_up_id TEXT NOT NULL REFERENCES follow_ups(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          source_order INTEGER NOT NULL,
          source_json TEXT NOT NULL,
          PRIMARY KEY (follow_up_id, source_id)
        );
        CREATE INDEX follow_ups_report_created_idx
          ON follow_ups(report_id, created_at DESC, id DESC);
        PRAGMA user_version = 7;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    if (version === 5) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE research_attempt_sources
          ADD COLUMN read_succeeded INTEGER NOT NULL DEFAULT 0
          CHECK (read_succeeded IN (0, 1));
        PRAGMA user_version = 6;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    if (version === 4) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE report_evaluations (
          report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
          imported_at TEXT NOT NULL,
          evaluation_json TEXT NOT NULL
        );
        ALTER TABLE research_attempt_sources
          ADD COLUMN read_succeeded INTEGER NOT NULL DEFAULT 0
          CHECK (read_succeeded IN (0, 1));
        PRAGMA user_version = 6;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    if (version === 3) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE research_attempt_sources (
          attempt_id INTEGER NOT NULL REFERENCES research_attempts(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          source_order INTEGER NOT NULL,
          bucket TEXT NOT NULL CHECK (bucket IN ('eligible', 'supplementary')),
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          author_or_organization TEXT,
          published_date TEXT,
          updated_date TEXT,
          source_type TEXT NOT NULL,
          evidence_level TEXT NOT NULL,
          excerpt TEXT,
          read_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (read_succeeded IN (0, 1)),
          read_status TEXT NOT NULL CHECK (read_status IN ('not_attempted', 'failed')),
          error_code TEXT,
          error_message TEXT,
          PRIMARY KEY (attempt_id, source_id)
        );
        CREATE TABLE report_evaluations (
          report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
          imported_at TEXT NOT NULL,
          evaluation_json TEXT NOT NULL
        );
        PRAGMA user_version = 6;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    if (version === 1 || version === 2) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        ${version === 1 ? 'ALTER TABLE messages ADD COLUMN target_item_id TEXT;' : ''}
        CREATE TABLE research_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL CHECK (status IN ('no_results', 'no_evidence', 'failed', 'cancelled')),
          stage TEXT NOT NULL CHECK (stage IN ('planning', 'searching', 'reading', 'generating')),
          command TEXT NOT NULL,
          model_slug TEXT NOT NULL,
          understanding TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          error_code TEXT,
          error_message TEXT,
          eligible_source_count INTEGER NOT NULL CHECK (eligible_source_count >= 0),
          supplementary_source_count INTEGER NOT NULL CHECK (supplementary_source_count >= 0)
        );
        CREATE TABLE research_attempt_failures (
          attempt_id INTEGER NOT NULL REFERENCES research_attempts(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          error_code TEXT NOT NULL,
          error_message TEXT NOT NULL,
          PRIMARY KEY (attempt_id, source_id)
        );
        CREATE TABLE research_attempt_sources (
          attempt_id INTEGER NOT NULL REFERENCES research_attempts(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          source_order INTEGER NOT NULL,
          bucket TEXT NOT NULL CHECK (bucket IN ('eligible', 'supplementary')),
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          author_or_organization TEXT,
          published_date TEXT,
          updated_date TEXT,
          source_type TEXT NOT NULL,
          evidence_level TEXT NOT NULL,
          excerpt TEXT,
          read_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (read_succeeded IN (0, 1)),
          read_status TEXT NOT NULL CHECK (read_status IN ('not_attempted', 'failed')),
          error_code TEXT,
          error_message TEXT,
          PRIMARY KEY (attempt_id, source_id)
        );
        CREATE TABLE report_evaluations (
          report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
          imported_at TEXT NOT NULL,
          evaluation_json TEXT NOT NULL
        );
        CREATE INDEX research_attempts_finished_at_idx
          ON research_attempts(finished_at DESC, id DESC);
        PRAGMA user_version = 6;
        COMMIT;
      `);
      this.migrate();
      return;
    }
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE preferences (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        published_from TEXT,
        published_to TEXT,
        search_scope TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        command TEXT NOT NULL,
        model_slug TEXT NOT NULL,
        understanding TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        cited_source_count INTEGER NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE report_sources (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        source_order INTEGER NOT NULL,
        cited INTEGER NOT NULL CHECK (cited IN (0, 1)),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        author_or_organization TEXT,
        published_date TEXT,
        updated_date TEXT,
        source_type TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        content_truncated INTEGER NOT NULL CHECK (content_truncated IN (0, 1)),
        PRIMARY KEY (report_id, source_id)
      );
      CREATE TABLE source_failures (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        error_code TEXT NOT NULL,
        error_message TEXT NOT NULL,
        PRIMARY KEY (report_id, source_id)
      );
      CREATE TABLE report_items (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        item_order INTEGER NOT NULL,
        primary_source_id TEXT NOT NULL,
        item_json TEXT NOT NULL,
        PRIMARY KEY (report_id, item_id)
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
        target_item_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE research_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL CHECK (status IN ('no_results', 'no_evidence', 'failed', 'cancelled')),
        stage TEXT NOT NULL CHECK (stage IN ('planning', 'searching', 'reading', 'generating')),
        command TEXT NOT NULL,
        model_slug TEXT NOT NULL,
        understanding TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        eligible_source_count INTEGER NOT NULL CHECK (eligible_source_count >= 0),
        supplementary_source_count INTEGER NOT NULL CHECK (supplementary_source_count >= 0)
      );
      CREATE TABLE research_attempt_failures (
        attempt_id INTEGER NOT NULL REFERENCES research_attempts(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        error_code TEXT NOT NULL,
        error_message TEXT NOT NULL,
        PRIMARY KEY (attempt_id, source_id)
      );
      CREATE TABLE research_attempt_sources (
        attempt_id INTEGER NOT NULL REFERENCES research_attempts(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        source_order INTEGER NOT NULL,
        bucket TEXT NOT NULL CHECK (bucket IN ('eligible', 'supplementary')),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        author_or_organization TEXT,
        published_date TEXT,
        updated_date TEXT,
        source_type TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        excerpt TEXT,
        read_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (read_succeeded IN (0, 1)),
        read_status TEXT NOT NULL CHECK (read_status IN ('not_attempted', 'failed')),
        error_code TEXT,
        error_message TEXT,
        PRIMARY KEY (attempt_id, source_id)
      );
      CREATE TABLE report_evaluations (
        report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
        imported_at TEXT NOT NULL,
        evaluation_json TEXT NOT NULL
      );
      CREATE INDEX reports_generated_at_idx ON reports(generated_at DESC);
      CREATE INDEX research_attempts_finished_at_idx
        ON research_attempts(finished_at DESC, id DESC);
      PRAGMA user_version = 6;
      COMMIT;
    `);
    this.migrate();
  }

  getPreferences(): LongTermPreferences {
    const row = this.database.prepare(
      'SELECT value_json FROM preferences WHERE singleton = 1',
    ).get() as { value_json: string } | undefined;
    if (!row) return {};
    try {
      return validatePreferences(JSON.parse(row.value_json) as unknown);
    } catch (error) {
      throw new Error(`無法讀取長期偏好：${error instanceof Error ? error.message : '格式錯誤'}`);
    }
  }

  replacePreferences(preferences: LongTermPreferences, updatedAt = new Date().toISOString()): void {
    const validated = validatePreferences(preferences);
    if (Number.isNaN(new Date(updatedAt).valueOf())) throw new Error('偏好更新時間無效。');
    this.database.prepare(`
      INSERT INTO preferences(singleton, value_json, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(validated), new Date(updatedAt).toISOString());
  }

  patchPreferences(patch: LongTermPreferences, updatedAt?: string): LongTermPreferences {
    const next = applyPreferencePatch(this.getPreferences(), validatePreferences(patch));
    this.replacePreferences(next, updatedAt);
    return next;
  }

  clearPreferences(): void {
    this.database.prepare('DELETE FROM preferences WHERE singleton = 1').run();
  }

  deletePreference(key: string, updatedAt?: string): LongTermPreferences {
    if (!PREFERENCE_KEYS.has(key)) throw new Error(`不支援的長期偏好欄位：${key}。`);
    const next = { ...this.getPreferences() } as Record<string, unknown>;
    delete next[key];
    this.replacePreferences(next as LongTermPreferences, updatedAt);
    return next as LongTermPreferences;
  }

  saveCompletedResearch(input: SaveCompletedResearchInput): void {
    validateSaveInput(input);
    const report = input.report;
    const citedIds = new Set(report.citedSources.map(({ id }) => id));
    const citedOrder = new Map(report.citedSources.map(({ id }, index) => [id, index]));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO reports(
          id, topic, published_from, published_to, search_scope, generated_at,
          command, model_slug, understanding, item_count, cited_source_count, report_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.id, report.topic, report.publishedFrom, report.publishedTo,
        report.searchScope, report.generatedAt, input.command, input.modelSlug,
        input.understanding, report.items.length, report.citedSources.length,
        JSON.stringify(report),
      );
      const sourceStatement = this.database.prepare(`
        INSERT INTO report_sources(
          report_id, source_id, source_order, cited, title, url,
          author_or_organization, published_date, updated_date, source_type,
          evidence_level, retrieved_at, content_hash, content, content_truncated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, source] of input.evidence.sources.entries()) {
        sourceStatement.run(
          report.id, source.id, citedOrder.get(source.id) ?? report.citedSources.length + index,
          citedIds.has(source.id) ? 1 : 0, source.title, source.url,
          source.authorOrOrganization, source.publishedDate, source.updatedDate,
          source.sourceType, source.evidenceLevel, source.retrievedAt, source.contentHash,
          source.content, source.contentTruncated ? 1 : 0,
        );
      }
      const failureStatement = this.database.prepare(`
        INSERT INTO source_failures(report_id, source_id, error_code, error_message)
        VALUES (?, ?, ?, ?)
      `);
      for (const failure of input.evidence.failures) {
        failureStatement.run(
          report.id, failure.sourceId, failure.errorCode, failure.errorMessage,
        );
      }
      const itemStatement = this.database.prepare(`
        INSERT INTO report_items(report_id, item_id, item_order, primary_source_id, item_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const [index, item] of report.items.entries()) {
        itemStatement.run(
          report.id, item.id, index, item.primarySourceId, JSON.stringify(item),
        );
      }
      this.database.prepare(`
        INSERT INTO messages(report_id, role, content, created_at) VALUES (?, 'user', ?, ?)
      `).run(report.id, input.command, report.generatedAt);
      this.database.prepare(`
        INSERT INTO messages(report_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)
      `).run(report.id, report.markdown, report.generatedAt);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  saveResearchAttempt(input: SaveResearchAttemptInput): number {
    const statuses = new Set<ResearchAttemptStatus>([
      'no_results', 'no_evidence', 'failed', 'cancelled',
    ]);
    const stages = new Set<ResearchAttemptStage>([
      'planning', 'searching', 'reading', 'generating',
    ]);
    if (!statuses.has(input.status)) throw new Error('研究執行結果狀態無效。');
    if (!stages.has(input.stage)) throw new Error('研究失敗階段無效。');
    const command = requiredString(input.command, '研究指令');
    const modelSlug = requiredString(input.modelSlug, '模型名稱');
    const understanding = requiredString(input.understanding, '任務理解');
    const startedAt = validIsoTime(input.startedAt, '開始時間');
    const finishedAt = validIsoTime(input.finishedAt, '完成時間');
    if (new Date(finishedAt).valueOf() < new Date(startedAt).valueOf()) {
      throw new Error('完成時間不可早於開始時間。');
    }
    const eligibleSourceCount = nonNegativeInteger(
      input.eligibleSourceCount ?? 0, '符合日期來源數',
    );
    const supplementarySourceCount = nonNegativeInteger(
      input.supplementarySourceCount ?? 0, '待核對來源數',
    );
    const errorCode = input.errorCode === undefined
      ? null : requiredString(input.errorCode, '錯誤代碼');
    const errorMessage = input.errorMessage === undefined
      ? null : requiredString(input.errorMessage, '錯誤訊息');
    const failures = input.failures ?? [];
    const readSourceIds = new Set(
      (input.readSourceIds ?? []).map((sourceId) => requiredString(sourceId, '已讀來源 ID')),
    );
    if (readSourceIds.size !== (input.readSourceIds ?? []).length) {
      throw new Error('已讀來源 ID 不可重複。');
    }
    const failureIds = new Set<string>();
    for (const failure of failures) {
      const sourceId = requiredString(failure.sourceId, '失敗來源 ID');
      if (failureIds.has(sourceId)) throw new Error(`失敗來源 ID 重複：${sourceId}。`);
      failureIds.add(sourceId);
      requiredString(failure.errorCode, '來源錯誤代碼');
      requiredString(failure.errorMessage, '來源錯誤訊息');
    }
    const attemptSources = [
      ...(input.eligibleSources ?? []).map((candidate) => ({ candidate, bucket: 'eligible' as const })),
      ...(input.supplementarySources ?? []).map((candidate) => ({
        candidate, bucket: 'supplementary' as const,
      })),
    ];
    if (input.eligibleSources && input.eligibleSources.length !== eligibleSourceCount) {
      throw new Error('符合日期來源明細數與統計不一致。');
    }
    if (input.supplementarySources &&
        input.supplementarySources.length !== supplementarySourceCount) {
      throw new Error('待核對來源明細數與統計不一致。');
    }
    const attemptSourceIds = new Set<string>();
    for (const { candidate } of attemptSources) {
      const sourceId = requiredString(candidate.id, '候選來源 ID');
      if (attemptSourceIds.has(sourceId)) throw new Error(`候選來源 ID 重複：${sourceId}。`);
      attemptSourceIds.add(sourceId);
      requiredString(candidate.title, '候選來源標題');
      const normalizedUrl = normalizePublicHttpUrl(candidate.url);
      if (!normalizedUrl || normalizedUrl !== candidate.url) {
        throw new Error(`候選來源 ${sourceId} 的 URL 未通過公開位址正規化。`);
      }
      if (!SOURCE_TYPES.includes(candidate.sourceType) ||
          !EVIDENCE_LEVELS.includes(candidate.evidenceLevel)) {
        throw new Error(`候選來源 ${sourceId} 的類型或內容層級無效。`);
      }
      if (candidate.authorOrOrganization !== null) {
        requiredString(candidate.authorOrOrganization, '候選來源作者或組織');
      }
      if (candidate.excerpt !== null) requiredString(candidate.excerpt, '候選來源摘錄');
    }
    if (attemptSources.length > 0) {
      for (const sourceId of failureIds) {
        if (!attemptSourceIds.has(sourceId)) {
          throw new Error(`來源錯誤 ${sourceId} 沒有對應的候選來源明細。`);
        }
      }
    }
    for (const sourceId of readSourceIds) {
      if (!attemptSourceIds.has(sourceId)) {
        throw new Error(`已讀來源 ${sourceId} 沒有對應的候選來源明細。`);
      }
      if (failureIds.has(sourceId)) {
        throw new Error(`來源 ${sourceId} 不可同時標示讀取成功與失敗。`);
      }
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database.prepare(`
        INSERT INTO research_attempts(
          status, stage, command, model_slug, understanding, started_at, finished_at,
          error_code, error_message, eligible_source_count, supplementary_source_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.status, input.stage, command, modelSlug, understanding, startedAt, finishedAt,
        errorCode, errorMessage, eligibleSourceCount, supplementarySourceCount,
      );
      const attemptId = Number(result.lastInsertRowid);
      const failureStatement = this.database.prepare(`
        INSERT INTO research_attempt_failures(
          attempt_id, source_id, error_code, error_message
        ) VALUES (?, ?, ?, ?)
      `);
      for (const failure of failures) {
        failureStatement.run(
          attemptId, failure.sourceId, failure.errorCode, failure.errorMessage,
        );
      }
      const failureBySourceId = new Map(failures.map((failure) => [failure.sourceId, failure]));
      const sourceStatement = this.database.prepare(`
        INSERT INTO research_attempt_sources(
          attempt_id, source_id, source_order, bucket, title, url,
          author_or_organization, published_date, updated_date, source_type,
          evidence_level, excerpt, read_succeeded, read_status, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, { candidate, bucket }] of attemptSources.entries()) {
        const failure = failureBySourceId.get(candidate.id);
        sourceStatement.run(
          attemptId, candidate.id, index, bucket, candidate.title, candidate.url,
          candidate.authorOrOrganization, candidate.publishedDate, candidate.updatedDate,
          candidate.sourceType, candidate.evidenceLevel, candidate.excerpt,
          readSourceIds.has(candidate.id) ? 1 : 0,
          failure ? 'failed' : 'not_attempted',
          failure?.errorCode ?? null, failure?.errorMessage ?? null,
        );
      }
      this.database.exec('COMMIT');
      return attemptId;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listResearchAttempts(limit = 20): ResearchAttemptSummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('執行紀錄數量必須是 1 到 100 的整數。');
    }
    const attempts = this.database.prepare(`
      SELECT a.id, a.status, a.stage, a.command, a.model_slug, a.understanding,
        a.started_at, a.finished_at, a.error_code, a.error_message,
        a.eligible_source_count, a.supplementary_source_count,
        COUNT(f.source_id) AS failure_count
      FROM research_attempts a
      LEFT JOIN research_attempt_failures f ON f.attempt_id = a.id
      GROUP BY a.id
      ORDER BY a.finished_at DESC, a.id DESC
      LIMIT ?
    `).all(limit).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: Number(row.id),
        status: String(row.status) as ResearchAttemptStatus,
        stage: String(row.stage) as ResearchAttemptStage,
        command: String(row.command),
        modelSlug: String(row.model_slug),
        understanding: String(row.understanding),
        startedAt: String(row.started_at),
        finishedAt: String(row.finished_at),
        errorCode: row.error_code === null ? null : String(row.error_code),
        errorMessage: row.error_message === null ? null : String(row.error_message),
        eligibleSourceCount: Number(row.eligible_source_count),
        supplementarySourceCount: Number(row.supplementary_source_count),
        failureCount: Number(row.failure_count),
        sources: [],
      };
    });
    return attempts.map((attempt) => ({
      ...attempt,
      sources: this.listResearchAttemptSources(attempt.id),
    }));
  }

  listResearchAttemptSources(attemptId: number): ResearchAttemptSource[] {
    if (!Number.isInteger(attemptId) || attemptId < 1) throw new Error('執行紀錄 ID 無效。');
    return this.database.prepare(`
      SELECT attempt_id, source_id, source_order, bucket, title, url,
        author_or_organization, published_date, updated_date, source_type,
        evidence_level, excerpt, read_succeeded, read_status, error_code, error_message
      FROM research_attempt_sources
      WHERE attempt_id = ?
      ORDER BY source_order ASC
    `).all(attemptId).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        attemptId: Number(row.attempt_id),
        sourceId: String(row.source_id),
        sourceOrder: Number(row.source_order),
        bucket: String(row.bucket) as ResearchAttemptSource['bucket'],
        title: String(row.title),
        url: String(row.url),
        authorOrOrganization: row.author_or_organization === null
          ? null : String(row.author_or_organization),
        publishedDate: row.published_date === null ? null : String(row.published_date),
        updatedDate: row.updated_date === null ? null : String(row.updated_date),
        sourceType: String(row.source_type) as ResearchAttemptSource['sourceType'],
        evidenceLevel: String(row.evidence_level) as ResearchAttemptSource['evidenceLevel'],
        excerpt: row.excerpt === null ? null : String(row.excerpt),
        readStatus: Number(row.read_succeeded) === 1
          ? 'read'
          : String(row.read_status) as ResearchAttemptSource['readStatus'],
        errorCode: row.error_code === null ? null : String(row.error_code),
        errorMessage: row.error_message === null ? null : String(row.error_message),
      };
    });
  }

  listReports(limit = 50): ReportHistorySummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('歷史報告數量必須是 1 到 100 的整數。');
    }
    return this.database.prepare(`
      SELECT id, topic, generated_at, published_from, published_to,
        item_count, cited_source_count
      FROM reports ORDER BY generated_at DESC, id DESC LIMIT ?
    `).all(limit).map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: String(value.id),
        topic: String(value.topic),
        generatedAt: String(value.generated_at),
        publishedFrom: value.published_from === null ? null : String(value.published_from),
        publishedTo: value.published_to === null ? null : String(value.published_to),
        itemCount: Number(value.item_count),
        citedSourceCount: Number(value.cited_source_count),
      };
    });
  }

  getReport(id: string): ResearchReport | null {
    const reportId = requiredString(id, '報告 ID');
    const row = this.database.prepare(
      'SELECT report_json FROM reports WHERE id = ?',
    ).get(reportId) as { report_json: string } | undefined;
    if (!row) return null;
    let report: ResearchReport;
    try {
      report = validateStoredReport(JSON.parse(row.report_json) as unknown, reportId);
    } catch (error) {
      throw new Error(`無法讀取歷史報告：${error instanceof Error ? error.message : '格式錯誤'}`);
    }
    const rows = this.database.prepare(`
      SELECT source_id, title, url, content_hash, content FROM report_sources
      WHERE report_id = ? AND cited = 1 ORDER BY source_order ASC
    `).all(reportId) as Array<{
      source_id: string;
      title: string;
      url: string;
      content_hash: string;
      content: string;
    }>;
    const relationalIds = rows.map(({ source_id }) => source_id);
    const jsonIds = report.citedSources.map(({ id: sourceId }) => sourceId);
    if (JSON.stringify(relationalIds) !== JSON.stringify(jsonIds)) {
      throw new Error('歷史報告的引用順序與來源紀錄不一致。');
    }
    for (const [index, source] of report.citedSources.entries()) {
      const row = rows[index];
      if (row.title !== source.title || row.url !== source.url ||
          row.content_hash !== source.contentHash || row.content !== source.content) {
        throw new Error(`歷史報告來源 ${source.id} 與證據紀錄不一致。`);
      }
    }
    const itemRows = this.database.prepare(`
      SELECT item_id, item_order, primary_source_id, item_json
      FROM report_items WHERE report_id = ? ORDER BY item_order ASC
    `).all(reportId) as Array<{
      item_id: string;
      item_order: number;
      primary_source_id: string;
      item_json: string;
    }>;
    if (itemRows.length !== report.items.length) {
      throw new Error('歷史報告的項目數量與關聯紀錄不一致。');
    }
    for (const [index, item] of report.items.entries()) {
      const row = itemRows[index];
      let relationalItem: unknown;
      try { relationalItem = JSON.parse(row.item_json) as unknown; }
      catch { throw new Error(`歷史報告項目 ${item.id} 的關聯紀錄不是有效 JSON。`); }
      if (row.item_order !== index || row.item_id !== item.id ||
          row.primary_source_id !== item.primarySourceId ||
          JSON.stringify(relationalItem) !== JSON.stringify(item)) {
        throw new Error(`歷史報告項目 ${item.id} 與關聯紀錄不一致。`);
      }
    }
    return report;
  }

  updateReportPresentation(report: ResearchReport): void {
    validateStoredReport(report, report.id);
    const existing = this.getReport(report.id);
    if (!existing) throw new Error('找不到要更新的歷史報告。');
    const existingSourceIds = existing.citedSources.map(({ id }) => id);
    const nextSourceIds = report.citedSources.map(({ id }) => id);
    if (JSON.stringify(existingSourceIds) !== JSON.stringify(nextSourceIds) ||
        JSON.stringify(existing.items) !== JSON.stringify(report.items)) {
      throw new Error('格式改寫不可更動報告項目或引用來源。');
    }
    this.database.prepare(
      'UPDATE reports SET report_json = ? WHERE id = ?',
    ).run(JSON.stringify(report), report.id);
  }

  saveCitationEvaluation(
    summary: CitationEvaluationSummary,
    importedAt = new Date().toISOString(),
  ): CitationEvaluationSummary {
    const reportId = requiredString(summary.reportId, '評估報告 ID');
    const report = this.getReport(reportId);
    if (!report) throw new Error('找不到 citation 評估對應的報告。');
    const expectedClaimIds = listEvaluationClaims(report).map(({ id }) => id);
    const validated = validateCitationEvaluation(summary, reportId, expectedClaimIds);
    const timestamp = validIsoTime(importedAt, '評估匯入時間');
    this.database.prepare(`
      INSERT INTO report_evaluations(report_id, imported_at, evaluation_json)
      VALUES (?, ?, ?)
      ON CONFLICT(report_id) DO UPDATE SET
        imported_at = excluded.imported_at,
        evaluation_json = excluded.evaluation_json
    `).run(reportId, timestamp, JSON.stringify(validated));
    return validated;
  }

  getCitationEvaluation(reportId: string): CitationEvaluationSummary | null {
    const id = requiredString(reportId, '評估報告 ID');
    const row = this.database.prepare(`
      SELECT evaluation_json FROM report_evaluations WHERE report_id = ?
    `).get(id) as { evaluation_json: string } | undefined;
    if (!row) return null;
    const report = this.getReport(id);
    if (!report) throw new Error('citation 評估對應的報告不存在。');
    try {
      return validateCitationEvaluation(
        JSON.parse(row.evaluation_json) as unknown,
        id,
        listEvaluationClaims(report).map(({ id: claimId }) => claimId),
      );
    } catch (error) {
      throw new Error(`無法讀取 citation 評估：${
        error instanceof Error ? error.message : '格式錯誤'
      }`);
    }
  }

  appendConversation(
    reportId: string,
    userContent: string,
    assistantContent: string,
    createdAt = new Date().toISOString(),
    targetItemId?: string,
  ): void {
    const id = requiredString(reportId, '報告 ID');
    const user = requiredString(userContent, '使用者訊息');
    const assistant = requiredString(assistantContent, '助理訊息');
    const timestamp = new Date(createdAt);
    if (Number.isNaN(timestamp.valueOf())) throw new Error('對話時間無效。');
    const report = this.getReport(id);
    if (!report) throw new Error('找不到對話對應的報告。');
    const target = targetItemId === undefined
      ? null
      : requiredString(targetItemId, '追問目標項目 ID');
    if (target && !report.items.some(({ id: itemId }) => itemId === target)) {
      throw new Error(`報告中找不到追問目標項目 ${target}。`);
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.database.prepare(`
        INSERT INTO messages(report_id, target_item_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      statement.run(id, target, 'user', user, timestamp.toISOString());
      statement.run(id, target, 'assistant', assistant, timestamp.toISOString());
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  appendFollowUp(
    reportId: string,
    userContent: string,
    answerInput: FollowUpAnswer,
  ): void {
    const id = requiredString(reportId, '報告 ID');
    const user = requiredString(userContent, '使用者訊息');
    const answer = validateStoredFollowUpAnswer(answerInput, id);
    const report = this.getReport(id);
    if (!report) throw new Error('找不到追問對應的報告。');
    if (!report.items.some(({ id: itemId }) => itemId === answer.targetItemId)) {
      throw new Error(`報告中找不到追問目標項目 ${answer.targetItemId}。`);
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.database.prepare(`
        INSERT INTO messages(report_id, target_item_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      statement.run(id, answer.targetItemId, 'user', user, answer.createdAt);
      const assistantResult = statement.run(
        id, answer.targetItemId, 'assistant', answer.markdown, answer.createdAt,
      );
      const assistantMessageId = Number(assistantResult.lastInsertRowid);
      this.database.prepare(`
        INSERT INTO follow_ups(
          id, report_id, target_item_id, assistant_message_id, created_at, answer_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        answer.id,
        id,
        answer.targetItemId,
        assistantMessageId,
        answer.createdAt,
        JSON.stringify(answer),
      );
      const sourceStatement = this.database.prepare(`
        INSERT INTO follow_up_sources(follow_up_id, source_id, source_order, source_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const [index, source] of answer.citedSources.entries()) {
        sourceStatement.run(answer.id, source.id, index, JSON.stringify(source));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getLatestFollowUp(reportId: string): FollowUpAnswer | null {
    const id = requiredString(reportId, '報告 ID');
    const row = this.database.prepare(`
      SELECT id, answer_json FROM follow_ups
      WHERE report_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(id) as { id: string; answer_json: string } | undefined;
    if (!row) return null;
    let answer: FollowUpAnswer;
    try {
      answer = validateStoredFollowUpAnswer(JSON.parse(row.answer_json) as unknown, id);
    } catch (error) {
      throw new Error(`無法讀取追問回答：${
        error instanceof Error ? error.message : '格式錯誤'
      }`);
    }
    const sourceRows = this.database.prepare(`
      SELECT source_id, source_order, source_json FROM follow_up_sources
      WHERE follow_up_id = ? ORDER BY source_order ASC
    `).all(row.id) as Array<{
      source_id: string;
      source_order: number;
      source_json: string;
    }>;
    if (sourceRows.length !== answer.citedSources.length) {
      throw new Error('追問回答的來源數量與關聯紀錄不一致。');
    }
    for (const [index, source] of answer.citedSources.entries()) {
      const stored = sourceRows[index];
      if (stored.source_order !== index || stored.source_id !== source.id ||
          stored.source_json !== JSON.stringify(source)) {
        throw new Error(`追問來源 ${source.id} 與關聯紀錄不一致。`);
      }
    }
    return answer;
  }

  listMessages(reportId: string): ConversationMessage[] {
    const id = requiredString(reportId, '報告 ID');
    return this.database.prepare(`
      SELECT id, report_id, target_item_id, role, content, created_at
      FROM messages WHERE report_id = ? ORDER BY id ASC
    `).all(id).map((row) => {
      const value = row as Record<string, unknown>;
      const role = value.role === 'user' ? 'user' : 'assistant';
      return {
        id: Number(value.id),
        reportId: value.report_id === null ? null : String(value.report_id),
        targetItemId: value.target_item_id === null ? null : String(value.target_item_id),
        role,
        content: String(value.content),
        createdAt: String(value.created_at),
      };
    });
  }

  getLastReferencedItemId(reportId: string): string | null {
    const id = requiredString(reportId, '報告 ID');
    const row = this.database.prepare(`
      SELECT target_item_id FROM messages
      WHERE report_id = ? AND target_item_id IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(id) as { target_item_id: string } | undefined;
    if (!row) return null;
    const target = requiredString(row.target_item_id, '追問目標項目 ID');
    const report = this.getReport(id);
    if (!report?.items.some(({ id: itemId }) => itemId === target)) {
      throw new Error(`歷史對話指向不存在的報告項目 ${target}。`);
    }
    return target;
  }

  upsertMonitoringRule(
    input: MonitoringRuleInput,
    updatedAt = new Date().toISOString(),
  ): MonitoringRule {
    const validated = validateMonitoringRuleInput(input);
    const timestamp = validMonitoringTime(updatedAt, '監測規則更新時間');
    const existing = this.getMonitoringRule(validated.id);
    const createdAt = existing?.createdAt ?? timestamp;
    const lastSucceededAt = existing?.lastSucceededAt ?? null;
    const lastDigestAt = existing?.lastDigestAt ?? null;
    const nextRunAt = validated.enabled
      ? (existing?.enabled && existing.nextRunAt ? existing.nextRunAt : timestamp)
      : null;
    this.database.prepare(`
      INSERT INTO monitoring_rules(
        id, name, query, enabled, interval_hours, lookback_days, max_items,
        auto_brief, digest_hour_local, created_at, updated_at, last_succeeded_at,
        next_run_at, last_digest_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, query = excluded.query, enabled = excluded.enabled,
        interval_hours = excluded.interval_hours, lookback_days = excluded.lookback_days,
        max_items = excluded.max_items, auto_brief = excluded.auto_brief,
        digest_hour_local = excluded.digest_hour_local,
        updated_at = excluded.updated_at, next_run_at = excluded.next_run_at
    `).run(
      validated.id, validated.name, validated.query, validated.enabled ? 1 : 0,
      validated.intervalHours, validated.lookbackDays, validated.maxItems,
      validated.autoBrief ? 1 : 0, validated.digestHourLocal ?? 9,
      createdAt, timestamp, lastSucceededAt, nextRunAt, lastDigestAt,
    );
    return this.getMonitoringRule(validated.id)!;
  }

  getMonitoringRule(id: string): MonitoringRule | null {
    const safeId = validateMonitoringRuleInput({
      id, name: 'placeholder', query: 'placeholder', enabled: false,
      intervalHours: 1, lookbackDays: 1, maxItems: 1, autoBrief: false,
    }).id;
    const row = this.database.prepare(`
      SELECT id, name, query, enabled, interval_hours, lookback_days, max_items,
        auto_brief, digest_hour_local, created_at, updated_at, last_succeeded_at,
        next_run_at, last_digest_at
      FROM monitoring_rules WHERE id = ?
    `).get(safeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const input = validateMonitoringRuleInput({
      id: String(row.id), name: String(row.name), query: String(row.query),
      enabled: row.enabled === 1, intervalHours: Number(row.interval_hours),
      lookbackDays: Number(row.lookback_days), maxItems: Number(row.max_items),
      autoBrief: row.auto_brief === 1,
      digestHourLocal: Number(row.digest_hour_local),
    });
    return {
      ...input,
      digestHourLocal: input.digestHourLocal ?? 9,
      createdAt: validMonitoringTime(String(row.created_at), '監測建立時間'),
      updatedAt: validMonitoringTime(String(row.updated_at), '監測更新時間'),
      lastSucceededAt: row.last_succeeded_at === null
        ? null : validMonitoringTime(String(row.last_succeeded_at), '監測成功時間'),
      nextRunAt: row.next_run_at === null
        ? null : validMonitoringTime(String(row.next_run_at), '下次監測時間'),
      lastDigestAt: row.last_digest_at === null
        ? null : validMonitoringTime(String(row.last_digest_at), '上次匯報時間'),
    };
  }

  listMonitoringRules(): MonitoringRule[] {
    const rows = this.database.prepare('SELECT id FROM monitoring_rules ORDER BY created_at, id')
      .all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.getMonitoringRule(id)!);
  }

  listDueMonitoringRules(now = new Date().toISOString()): MonitoringRule[] {
    const timestamp = validMonitoringTime(now, '排程檢查時間');
    const rows = this.database.prepare(`
      SELECT id FROM monitoring_rules
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at, id
    `).all(timestamp) as Array<{ id: string }>;
    return rows.map(({ id }) => this.getMonitoringRule(id)!);
  }

  completeMonitoringRule(ruleId: string, succeededAt = new Date().toISOString()): MonitoringRule {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const timestamp = validMonitoringTime(succeededAt, '監測成功時間');
    const nextRunAt = rule.enabled ? nextMonitoringRunAt(timestamp, rule.intervalHours) : null;
    this.database.prepare(`
      UPDATE monitoring_rules SET last_succeeded_at = ?, next_run_at = ? WHERE id = ?
    `).run(timestamp, nextRunAt, rule.id);
    return this.getMonitoringRule(rule.id)!;
  }

  deferMonitoringRule(
    ruleId: string,
    attemptedAt = new Date().toISOString(),
    retryHours = 1,
  ): MonitoringRule {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const timestamp = validMonitoringTime(attemptedAt, '監測嘗試時間');
    const nextRunAt = rule.enabled ? nextMonitoringRunAt(timestamp, retryHours) : null;
    this.database.prepare('UPDATE monitoring_rules SET next_run_at = ? WHERE id = ?')
      .run(nextRunAt, rule.id);
    return this.getMonitoringRule(rule.id)!;
  }

  scheduleMonitoringRuleNow(ruleId: string, now = new Date().toISOString()): MonitoringRule {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    if (!rule.enabled) throw new Error('監測規則目前已停用。');
    const timestamp = validMonitoringTime(now, '立即監測時間');
    this.database.prepare('UPDATE monitoring_rules SET next_run_at = ? WHERE id = ?')
      .run(timestamp, rule.id);
    return this.getMonitoringRule(rule.id)!;
  }

  recordMonitoringCandidates(
    ruleId: string,
    candidates: readonly SearchCandidate[],
    firstSeenAt = new Date().toISOString(),
  ): MonitoringInboxItem[] {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const timestamp = validMonitoringTime(firstSeenAt, '來源發現時間');
    const inserted: MonitoringInboxItem[] = [];
    const statement = this.database.prepare(`
      INSERT OR IGNORE INTO monitoring_items(
        rule_id, source_id, status, first_seen_at, candidate_json
      ) VALUES (?, ?, 'new', ?, ?)
    `);
    for (const candidate of candidates) {
      const normalized = normalizeSearchCandidate(candidate, candidate.providerId, candidate.discoveredAt);
      if (normalized.id !== candidate.id) throw new Error(`監測來源 ID 與 URL 不一致：${candidate.id}。`);
      const result = statement.run(rule.id, normalized.id, timestamp, JSON.stringify(normalized));
      if (Number(result.changes) === 1) {
        inserted.push({
          ruleId: rule.id, sourceId: normalized.id, status: 'new',
          firstSeenAt: timestamp, candidate: normalized,
          brief: null, briefedAt: null, briefModelSlug: null,
          feedback: null, feedbackAt: null, linkedReportId: null,
          notifiedAt: null,
        });
      }
    }
    return inserted;
  }

  listMonitoringInbox(ruleId: string, status: MonitoringInboxItem['status'] = 'new'):
    MonitoringInboxItem[] {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    if (!['new', 'read', 'dismissed'].includes(status)) throw new Error('監測收件匣狀態無效。');
    const rows = this.database.prepare(`
      SELECT source_id, status, first_seen_at, candidate_json,
        brief_json, briefed_at, brief_model_slug, feedback, feedback_at,
        linked_report_id, notified_at FROM monitoring_items
      WHERE rule_id = ? AND status = ? ORDER BY first_seen_at DESC, source_id
    `).all(rule.id, status) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const parsed = JSON.parse(String(row.candidate_json)) as SearchCandidate;
      const candidate = normalizeSearchCandidate(parsed, parsed.providerId, parsed.discoveredAt);
      if (candidate.id !== row.source_id) throw new Error('監測收件匣來源 ID 不一致。');
      let brief: MonitoringBrief | null = null;
      if (row.brief_json !== null) {
        brief = validateMonitoringBrief(JSON.parse(String(row.brief_json)), candidate.id);
      }
      return {
        ruleId: rule.id,
        sourceId: candidate.id,
        status,
        firstSeenAt: validMonitoringTime(String(row.first_seen_at), '來源發現時間'),
        candidate,
        brief,
        briefedAt: row.briefed_at === null
          ? null : validMonitoringTime(String(row.briefed_at), '主動摘要時間'),
        briefModelSlug: row.brief_model_slug === null
          ? null : requiredString(row.brief_model_slug, '主動摘要模型'),
        feedback: row.feedback === null
          ? null : validateMonitoringFeedback(row.feedback),
        feedbackAt: row.feedback_at === null
          ? null : validMonitoringTime(String(row.feedback_at), '監測回饋時間'),
        linkedReportId: row.linked_report_id === null
          ? null : requiredString(row.linked_report_id, '監測連結報告 ID'),
        notifiedAt: row.notified_at === null
          ? null : validMonitoringTime(String(row.notified_at), '監測通知時間'),
      };
    });
  }

  listAllMonitoringInbox(ruleId: string): MonitoringInboxItem[] {
    return (['new', 'read', 'dismissed'] as const)
      .flatMap((status) => this.listMonitoringInbox(ruleId, status))
      .sort((left, right) =>
        right.firstSeenAt.localeCompare(left.firstSeenAt) ||
        left.sourceId.localeCompare(right.sourceId));
  }

  getMonitoringInboxItem(ruleId: string, sourceId: string): MonitoringInboxItem | null {
    const source = requiredString(sourceId, '監測來源 ID');
    return this.listAllMonitoringInbox(ruleId)
      .find((item) => item.sourceId === source) ?? null;
  }

  listPendingMonitoringDigest(ruleId: string): MonitoringInboxItem[] {
    return this.listMonitoringInbox(ruleId)
      .filter(({ notifiedAt }) => notifiedAt === null);
  }

  markMonitoringDigestDelivered(
    ruleId: string,
    sourceIds: readonly string[],
    deliveredAt = new Date().toISOString(),
  ): void {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    if (sourceIds.length < 1 || sourceIds.length > 100) {
      throw new Error('每日匯報來源必須包含 1 到 100 項。');
    }
    const ids = [...new Set(sourceIds.map((id) => requiredString(id, '監測來源 ID')))];
    if (ids.length !== sourceIds.length) throw new Error('每日匯報來源 ID 不可重複。');
    const timestamp = validMonitoringTime(deliveredAt, '每日匯報時間');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.database.prepare(`
        UPDATE monitoring_items SET notified_at = ?
        WHERE rule_id = ? AND source_id = ? AND notified_at IS NULL
      `);
      for (const id of ids) {
        if (Number(update.run(timestamp, rule.id, id).changes) !== 1) {
          throw new Error(`監測來源無法標記為已匯報：${id}。`);
        }
      }
      this.database.prepare(
        'UPDATE monitoring_rules SET last_digest_at = ? WHERE id = ?',
      ).run(timestamp, rule.id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  startMonitoringRun(ruleId: string, startedAt = new Date().toISOString()): number {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const timestamp = validMonitoringTime(startedAt, '監測執行開始時間');
    const result = this.database.prepare(`
      INSERT INTO monitoring_runs(rule_id, status, started_at)
      VALUES (?, 'running', ?)
    `).run(rule.id, timestamp);
    return Number(result.lastInsertRowid);
  }

  finishMonitoringRun(
    runId: number,
    status: Exclude<MonitoringRunSummary['status'], never>,
    discoveredCount: number,
    briefedCount: number,
    error?: { code: string; message: string },
    finishedAt = new Date().toISOString(),
  ): void {
    if (!Number.isInteger(runId) || runId < 1) throw new Error('監測執行 ID 無效。');
    if (!['completed', 'failed', 'cancelled'].includes(status)) {
      throw new Error('監測執行狀態無效。');
    }
    const discovered = nonNegativeInteger(discoveredCount, '新來源數');
    const briefed = nonNegativeInteger(briefedCount, '摘要數');
    if (briefed > discovered) throw new Error('摘要數不可大於新來源數。');
    const timestamp = validMonitoringTime(finishedAt, '監測執行完成時間');
    const result = this.database.prepare(`
      UPDATE monitoring_runs SET status = ?, finished_at = ?,
        discovered_count = ?, briefed_count = ?, error_code = ?, error_message = ?
      WHERE id = ? AND status = 'running'
    `).run(
      status, timestamp, discovered, briefed,
      error ? requiredString(error.code, '監測錯誤代碼') : null,
      error ? requiredString(error.message, '監測錯誤訊息') : null,
      runId,
    );
    if (Number(result.changes) !== 1) throw new Error('找不到執行中的監測紀錄。');
  }

  listMonitoringRuns(limit = 20): MonitoringRunSummary[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('監測執行紀錄上限必須是 1 到 100。');
    }
    return this.database.prepare(`
      SELECT id, rule_id, status, started_at, finished_at, discovered_count,
        briefed_count, error_code, error_message
      FROM monitoring_runs WHERE status != 'running'
      ORDER BY started_at DESC, id DESC LIMIT ?
    `).all(limit).map((raw) => {
      const row = raw as Record<string, unknown>;
      const status = String(row.status);
      if (!['completed', 'failed', 'cancelled'].includes(status)) {
        throw new Error('保存的監測執行狀態無效。');
      }
      return {
        id: Number(row.id),
        ruleId: requiredString(row.rule_id, '監測規則 ID'),
        status: status as MonitoringRunSummary['status'],
        startedAt: validMonitoringTime(String(row.started_at), '監測執行開始時間'),
        finishedAt: row.finished_at === null
          ? null : validMonitoringTime(String(row.finished_at), '監測執行完成時間'),
        discoveredCount: nonNegativeInteger(row.discovered_count, '新來源數'),
        briefedCount: nonNegativeInteger(row.briefed_count, '摘要數'),
        errorCode: row.error_code === null ? null : requiredString(row.error_code, '監測錯誤代碼'),
        errorMessage: row.error_message === null
          ? null : requiredString(row.error_message, '監測錯誤訊息'),
      };
    });
  }

  tryClaimMonitoringModelBudget(now = new Date().toISOString()): boolean {
    const timestamp = validMonitoringTime(now, '背景模型用量時間');
    const day = timestamp.slice(0, 10);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO monitoring_model_usage(usage_date, request_count, updated_at)
        VALUES (?, 0, ?)
      `).run(day, timestamp);
      const result = this.database.prepare(`
        UPDATE monitoring_model_usage SET request_count = request_count + 1, updated_at = ?
        WHERE usage_date = ? AND request_count < 1
      `).run(timestamp, day);
      this.database.exec('COMMIT');
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  saveMonitoringBriefs(
    ruleId: string,
    briefs: readonly MonitoringBrief[],
    modelSlug: string,
    briefedAt = new Date().toISOString(),
  ): void {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const model = requiredString(modelSlug, '主動摘要模型');
    const timestamp = validMonitoringTime(briefedAt, '主動摘要時間');
    if (briefs.length < 1 || briefs.length > rule.maxItems) {
      throw new Error(`主動摘要必須包含 1 到 ${rule.maxItems} 項。`);
    }
    const ids = new Set<string>();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.database.prepare(`
        UPDATE monitoring_items SET brief_json = ?, briefed_at = ?, brief_model_slug = ?
        WHERE rule_id = ? AND source_id = ?
      `);
      for (const raw of briefs) {
        const brief = validateMonitoringBrief(raw, raw.sourceId);
        if (ids.has(brief.sourceId)) throw new Error('主動摘要來源 ID 不可重複。');
        ids.add(brief.sourceId);
        const result = statement.run(
          JSON.stringify(brief), timestamp, model, rule.id, brief.sourceId,
        );
        if (Number(result.changes) !== 1) {
          throw new Error(`主動摘要來源不在監測收件匣：${brief.sourceId}。`);
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  setMonitoringItemStatus(
    ruleId: string,
    sourceId: string,
    status: MonitoringInboxItem['status'],
  ): void {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const id = requiredString(sourceId, '監測來源 ID');
    if (!/^src_[a-f0-9]{20}$/.test(id)) throw new Error('監測來源 ID 格式無效。');
    if (!['new', 'read', 'dismissed'].includes(status)) throw new Error('監測收件匣狀態無效。');
    const result = this.database.prepare(`
      UPDATE monitoring_items SET status = ? WHERE rule_id = ? AND source_id = ?
    `).run(status, rule.id, id);
    if (Number(result.changes) !== 1) throw new Error('找不到指定的監測來源。');
  }

  setMonitoringItemFeedback(
    ruleId: string,
    sourceId: string,
    feedback: MonitoringFeedback | null,
    feedbackAt = new Date().toISOString(),
  ): void {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const id = requiredString(sourceId, '監測來源 ID');
    if (!/^src_[a-f0-9]{20}$/.test(id)) throw new Error('監測來源 ID 格式無效。');
    const value = feedback === null ? null : validateMonitoringFeedback(feedback);
    const timestamp = value === null ? null : validMonitoringTime(feedbackAt, '監測回饋時間');
    const result = this.database.prepare(`
      UPDATE monitoring_items SET feedback = ?, feedback_at = ?
      WHERE rule_id = ? AND source_id = ?
    `).run(value, timestamp, rule.id, id);
    if (Number(result.changes) !== 1) throw new Error('找不到指定的監測來源。');
  }

  linkMonitoringItemReport(ruleId: string, sourceId: string, reportId: string): void {
    const rule = this.getMonitoringRule(ruleId);
    if (!rule) throw new Error(`找不到監測規則 ${ruleId}。`);
    const id = requiredString(sourceId, '監測來源 ID');
    const report = requiredString(reportId, '報告 ID');
    if (!this.getReport(report)) throw new Error('找不到要連結的研究報告。');
    const result = this.database.prepare(`
      UPDATE monitoring_items SET linked_report_id = ?, status = 'read'
      WHERE rule_id = ? AND source_id = ?
    `).run(report, rule.id, id);
    if (Number(result.changes) !== 1) throw new Error('找不到指定的監測來源。');
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
