import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finalizeResearchReport,
  rewriteResearchReport,
  type EvidenceBundle,
  type EvidenceSource,
} from '../electron/research/report.js';
import {
  buildEvaluationWorksheet,
  summarizeEvaluationWorksheet,
} from '../electron/research/evaluation-worksheet.js';
import { ResearchStore } from '../electron/research/research-store.js';
import { resolveResearchTask } from '../electron/research/research-task.js';
import { generateFollowUpAnswer } from '../electron/research/report-follow-up.js';
import { normalizeSearchCandidate } from '../electron/research/search-provider.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'ai-ra-store-'))) {
      throw new Error(`Refusing to remove unexpected test directory: ${directory}`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ai-ra-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'research.sqlite');
}

function source(id: string, url: string, title: string): EvidenceSource {
  return {
    id,
    title,
    url,
    authorOrOrganization: 'Example Lab',
    publishedDate: '2026-09-30',
    updatedDate: '2026-10-01',
    sourceType: 'paper',
    evidenceLevel: 'abstract',
    retrievedAt: '2026-10-01T12:00:00.000Z',
    contentHash: 'a'.repeat(64),
    content: `${title} abstract evidence.`,
    contentTruncated: false,
  };
}

function completedResearch() {
  const first = source('src_first', 'https://arxiv.org/abs/2610.00001', 'First paper');
  const second = source('src_second', 'https://arxiv.org/abs/2610.00002', 'Second paper');
  const unused = source('src_unused', 'https://arxiv.org/abs/2610.00003', 'Unused paper');
  const cited = (text: string, sourceId: string) => ({ text, sourceIds: [sourceId] });
  const report = finalizeResearchReport({
    topic: 'AI Agent',
    publishedFrom: '2026-09-25',
    publishedTo: '2026-10-01',
    searchScope: 'arXiv abstract fixture',
    generatedAt: '2026-10-01T12:05:00.000Z',
    maxItems: 3,
  }, { sources: [first, second, unused], failures: [] }, {
    summary: [cited('Two relevant methods were found.', first.id)],
    items: [first, second].map((item) => ({
      name: item.title,
      primarySourceId: item.id,
      relatedSourceIds: [],
      problem: cited(`Problem in ${item.title}.`, item.id),
      method: cited(`Method in ${item.title}.`, item.id),
      evidence: [cited(`Evidence in ${item.title}.`, item.id)],
      limitations: [],
      analysis: {
        applicationValue: `Application value of ${item.title}.`,
        smallExperiment: `Experiment for ${item.title}.`,
        unverified: ['Not reproduced locally.'],
      },
    })),
  });
  const evidence: EvidenceBundle = {
    sources: [first, second, unused],
    failures: [{
      sourceId: 'src_failed',
      errorCode: 'timeout',
      errorMessage: 'Fixture timeout.',
    }],
  };
  return {
    command: '幫我找最近七天 AI Agent 新技術',
    modelSlug: 'gpt-5.6-luna',
    understanding: '主題：AI Agent；最多 3 項',
    report,
    evidence,
  };
}

describe('ResearchStore', () => {
  it('keeps one-time overrides out of persisted long-term preferences', () => {
    const store = new ResearchStore(':memory:');
    store.replacePreferences({ topic: 'RAG', maxItems: 3 });

    const oneTimeTask = resolveResearchTask(
      store.getPreferences(), { topic: '推論效率', maxItems: 1 }, '2026-10-01',
    );

    expect(oneTimeTask).toMatchObject({ topic: '推論效率', maxItems: 1 });
    expect(store.getPreferences()).toEqual({ topic: 'RAG', maxItems: 3 });
    store.close();
  });

  it('persists explicit future preferences and can clear them', () => {
    const store = new ResearchStore(':memory:');

    expect(store.patchPreferences({ summaryPoints: 3 })).toEqual({ summaryPoints: 3 });
    expect(store.getPreferences()).toEqual({ summaryPoints: 3 });
    store.clearPreferences();
    expect(store.getPreferences()).toEqual({});
    expect(() => store.patchPreferences({ maxItems: 99 })).toThrow('項目上限');
    store.close();
  });

  it('persists an explicit unbounded publication date preference', () => {
    const store = new ResearchStore(':memory:');

    expect(store.patchPreferences({ publicationDateMode: 'any' }))
      .toEqual({ publicationDateMode: 'any' });
    expect(resolveResearchTask(store.getPreferences(), {}, '2026-10-04'))
      .toMatchObject({ publicationDateMode: 'any', publishedFrom: null, publishedTo: null });
    expect(() => store.patchPreferences({
      publicationDateMode: 'invalid' as 'recent',
    })).toThrow('發布日期模式');
    store.close();
  });

  it('persists and validates an explicit search mode preference', () => {
    const store = new ResearchStore(':memory:');

    expect(store.patchPreferences({ searchMode: 'web' })).toEqual({ searchMode: 'web' });
    expect(resolveResearchTask(store.getPreferences(), {}, '2026-10-04'))
      .toMatchObject({ searchMode: 'web' });
    expect(() => store.patchPreferences({ searchMode: 'invalid' as 'arxiv' }))
      .toThrow('搜尋模式');
    store.close();
  });

  it('deletes one allowlisted preference without clearing the others', () => {
    const store = new ResearchStore(':memory:');
    store.replacePreferences({ topic: 'RAG', maxItems: 2 });

    expect(store.deletePreference('topic')).toEqual({ maxItems: 2 });
    expect(store.getPreferences()).toEqual({ maxItems: 2 });
    expect(() => store.deletePreference('oauthToken')).toThrow('不支援');
    store.close();
  });

  it('keeps report item citations attached to the same sources after reload', () => {
    const store = new ResearchStore(':memory:');
    const input = completedResearch();
    store.saveCompletedResearch(input);

    const loaded = store.getReport(input.report.id);

    expect(loaded?.items.map(({ id, primarySourceId }) => ({ id, primarySourceId }))).toEqual([
      { id: 'item_01', primarySourceId: 'src_first' },
      { id: 'item_02', primarySourceId: 'src_second' },
    ]);
    expect(loaded?.citedSources.map(({ id }) => id)).toEqual(['src_first', 'src_second']);
    expect(store.listReports()).toEqual([expect.objectContaining({
      id: input.report.id,
      itemCount: 2,
      citedSourceCount: 2,
    })]);
    store.close();
  });

  it('survives closing and reopening the SQLite file', () => {
    const path = temporaryDatabasePath();
    const input = completedResearch();
    const firstProcess = new ResearchStore(path);
    firstProcess.replacePreferences({ topic: 'LLM Evaluation', paperFirst: true });
    firstProcess.saveCompletedResearch(input);
    firstProcess.close();

    const restartedProcess = new ResearchStore(path);

    expect(restartedProcess.getPreferences()).toEqual({
      topic: 'LLM Evaluation', paperFirst: true,
    });
    expect(restartedProcess.getReport(input.report.id)?.markdown).toBe(input.report.markdown);
    restartedProcess.close();
  });

  it('persists monitoring rules, due times, and source deduplication across restart', () => {
    const path = temporaryDatabasePath();
    const firstProcess = new ResearchStore(path);
    const rule = firstProcess.upsertMonitoringRule({
      id: 'ai_updates', name: 'AI 新技術', query: 'AI Agent RAG', enabled: true,
      intervalHours: 24, lookbackDays: 7, maxItems: 3, autoBrief: false,
    }, '2026-10-04T01:00:00.000Z');
    expect(rule.nextRunAt).toBe('2026-10-04T01:00:00.000Z');
    expect(firstProcess.listDueMonitoringRules('2026-10-04T01:00:00.000Z'))
      .toHaveLength(1);

    const candidate = normalizeSearchCandidate({
      title: 'New Agent Paper', url: 'https://arxiv.org/abs/2610.12345',
      authorOrOrganization: 'Example Lab', publishedDate: '2026-10-04',
      updatedDate: null, sourceType: 'paper', evidenceLevel: 'abstract',
      excerpt: 'A new agent method.',
    }, 'arxiv', '2026-10-04T01:02:00.000Z');
    expect(firstProcess.recordMonitoringCandidates(
      rule.id, [candidate], '2026-10-04T01:03:00.000Z',
    )).toHaveLength(1);
    expect(firstProcess.recordMonitoringCandidates(
      rule.id, [candidate], '2026-10-04T01:04:00.000Z',
    )).toEqual([]);
    expect(firstProcess.tryClaimMonitoringModelBudget('2026-10-04T01:04:00.000Z')).toBe(true);
    expect(firstProcess.tryClaimMonitoringModelBudget('2026-10-04T23:59:00.000Z')).toBe(false);
    expect(firstProcess.tryClaimMonitoringModelBudget('2026-10-05T00:00:00.000Z')).toBe(true);
    firstProcess.saveMonitoringBriefs(rule.id, [{
      sourceId: candidate.id,
      problem: '解決 agent 狀態漂移。',
      coreMethod: '以可檢查狀態圖約束工具使用。',
      workValue: '可用於改善 agent 除錯。',
      unverified: ['只有摘要證據。'],
    }], 'gpt-5.6-luna', '2026-10-04T01:04:30.000Z');
    firstProcess.setMonitoringItemFeedback(
      rule.id, candidate.id, 'worth_investigating', '2026-10-04T01:04:45.000Z',
    );
    expect(firstProcess.completeMonitoringRule(rule.id, '2026-10-04T01:05:00.000Z'))
      .toMatchObject({
        lastSucceededAt: '2026-10-04T01:05:00.000Z',
        nextRunAt: '2026-10-05T01:05:00.000Z',
      });
    firstProcess.close();

    const restarted = new ResearchStore(path);
    expect(restarted.listMonitoringRules()).toHaveLength(1);
    expect(restarted.listMonitoringInbox(rule.id)).toEqual([
      expect.objectContaining({
        sourceId: candidate.id, status: 'new',
        brief: expect.objectContaining({ problem: '解決 agent 狀態漂移。' }),
        briefModelSlug: 'gpt-5.6-luna',
        feedback: 'worth_investigating',
        feedbackAt: '2026-10-04T01:04:45.000Z',
      }),
    ]);
    restarted.setMonitoringItemFeedback(rule.id, candidate.id, null);
    expect(restarted.getMonitoringInboxItem(rule.id, candidate.id)).toMatchObject({
      feedback: null,
      feedbackAt: null,
    });
    expect(restarted.listPendingMonitoringDigest(rule.id)).toHaveLength(1);
    restarted.markMonitoringDigestDelivered(
      rule.id, [candidate.id], '2026-10-04T09:00:00.000Z',
    );
    expect(restarted.listPendingMonitoringDigest(rule.id)).toEqual([]);
    expect(restarted.getMonitoringRule(rule.id)?.lastDigestAt)
      .toBe('2026-10-04T09:00:00.000Z');
    const runId = restarted.startMonitoringRun(rule.id, '2026-10-04T08:59:00.000Z');
    restarted.finishMonitoringRun(
      runId, 'completed', 1, 1, undefined, '2026-10-04T09:00:00.000Z',
    );
    expect(restarted.listMonitoringRuns()).toEqual([
      expect.objectContaining({
        id: runId, ruleId: rule.id, status: 'completed',
        discoveredCount: 1, briefedCount: 1,
      }),
    ]);
    restarted.setMonitoringItemStatus(rule.id, candidate.id, 'read');
    expect(restarted.listMonitoringInbox(rule.id)).toEqual([]);
    expect(restarted.listMonitoringInbox(rule.id, 'read')).toHaveLength(1);
    restarted.setMonitoringItemStatus(rule.id, candidate.id, 'new');
    expect(restarted.listMonitoringInbox(rule.id)).toHaveLength(1);
    expect(restarted.listDueMonitoringRules('2026-10-05T01:04:59.999Z')).toEqual([]);
    expect(restarted.listDueMonitoringRules('2026-10-05T01:05:00.000Z')).toHaveLength(1);
    restarted.close();
  });

  it('links a monitoring item to a saved report and restores it after restart', () => {
    const path = temporaryDatabasePath();
    const store = new ResearchStore(path);
    const rule = store.upsertMonitoringRule({
      id: 'ai_updates', name: 'AI 新技術', query: 'RAG', enabled: true,
      intervalHours: 24, lookbackDays: 7, maxItems: 1, autoBrief: false,
    });
    const candidate = normalizeSearchCandidate({
      title: 'Linked paper', url: 'https://arxiv.org/abs/2610.54321',
      publishedDate: '2026-10-04', sourceType: 'paper', evidenceLevel: 'abstract',
      excerpt: 'Linked abstract.',
    }, 'arxiv', '2026-10-04T01:00:00.000Z');
    store.recordMonitoringCandidates(rule.id, [candidate]);
    const saved = completedResearch();
    store.saveCompletedResearch(saved);
    store.linkMonitoringItemReport(rule.id, candidate.id, saved.report.id);
    store.close();

    const restarted = new ResearchStore(path);
    expect(restarted.getMonitoringInboxItem(rule.id, candidate.id)).toMatchObject({
      status: 'read',
      linkedReportId: saved.report.id,
    });
    restarted.close();
  });

  it('migrates schema v8 monitoring data to feedback and report linkage columns', () => {
    const path = temporaryDatabasePath();
    const current = new ResearchStore(path);
    current.close();
    const downgraded = new DatabaseSync(path);
    downgraded.exec(`
      DROP INDEX monitoring_runs_rule_started_idx;
      DROP TABLE monitoring_runs;
      ALTER TABLE monitoring_items DROP COLUMN notified_at;
      DROP INDEX monitoring_items_feedback_idx;
      ALTER TABLE monitoring_items DROP COLUMN linked_report_id;
      ALTER TABLE monitoring_items DROP COLUMN feedback_at;
      ALTER TABLE monitoring_items DROP COLUMN feedback;
      ALTER TABLE monitoring_rules DROP COLUMN last_digest_at;
      ALTER TABLE monitoring_rules DROP COLUMN digest_hour_local;
      PRAGMA user_version = 8;
    `);
    downgraded.close();

    const migrated = new ResearchStore(path);
    migrated.close();
    const inspected = new DatabaseSync(path, { readOnly: true });
    const columns = inspected.prepare('PRAGMA table_info(monitoring_items)').all() as
      Array<{ name: string }>;
    const version = inspected.prepare('PRAGMA user_version').get() as
      { user_version: number };
    inspected.close();
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'feedback', 'feedback_at', 'linked_report_id', 'notified_at',
    ]));
    expect(version.user_version).toBe(10);
  });

  it('does not schedule a disabled monitoring rule', () => {
    const store = new ResearchStore(':memory:');
    const rule = store.upsertMonitoringRule({
      id: 'paused', name: 'Paused', query: 'RAG', enabled: false,
      intervalHours: 12, lookbackDays: 3, maxItems: 1, autoBrief: false,
    }, '2026-10-04T01:00:00.000Z');
    expect(rule.nextRunAt).toBeNull();
    expect(store.listDueMonitoringRules('2026-10-10T01:00:00.000Z')).toEqual([]);
    expect(() => store.scheduleMonitoringRuleNow(rule.id)).toThrow('已停用');
    store.close();
  });

  it('migrates a version 1 message table through follow-up context and attempt history', () => {
    const path = temporaryDatabasePath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    old.close();

    const migrated = new ResearchStore(path);
    migrated.close();
    const inspected = new DatabaseSync(path, { readOnly: true });
    const columns = inspected.prepare('PRAGMA table_info(messages)').all() as
      Array<{ name: string }>;
    const version = inspected.prepare('PRAGMA user_version').get() as
      { user_version: number };
    const attemptTable = inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_attempts'
    `).get();
    inspected.close();

    expect(columns.map(({ name }) => name)).toContain('target_item_id');
    expect(attemptTable).toBeTruthy();
    expect(version.user_version).toBe(10);
  });

  it('migrates the production version 2 schema to attempt history', () => {
    const path = temporaryDatabasePath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT,
        target_item_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    old.close();

    const migrated = new ResearchStore(path);
    expect(migrated.listResearchAttempts()).toEqual([]);
    migrated.close();
    const inspected = new DatabaseSync(path, { readOnly: true });
    const version = inspected.prepare('PRAGMA user_version').get() as
      { user_version: number };
    inspected.close();

    expect(version.user_version).toBe(10);
  });

  it('migrates version 3 attempts to source traceability without losing attempts', () => {
    const path = temporaryDatabasePath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE research_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        command TEXT NOT NULL,
        model_slug TEXT NOT NULL,
        understanding TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        eligible_source_count INTEGER NOT NULL,
        supplementary_source_count INTEGER NOT NULL
      );
      CREATE TABLE research_attempt_failures (
        attempt_id INTEGER NOT NULL REFERENCES research_attempts(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        error_code TEXT NOT NULL,
        error_message TEXT NOT NULL,
        PRIMARY KEY (attempt_id, source_id)
      );
      INSERT INTO research_attempts(
        status, stage, command, model_slug, understanding, started_at, finished_at,
        eligible_source_count, supplementary_source_count
      ) VALUES (
        'no_results', 'searching', 'fixture', 'luna', 'fixture task',
        '2026-10-03T01:00:00.000Z', '2026-10-03T01:01:00.000Z', 0, 0
      );
      PRAGMA user_version = 3;
    `);
    old.close();

    const migrated = new ResearchStore(path);
    expect(migrated.listResearchAttempts()).toHaveLength(1);
    expect(migrated.listResearchAttemptSources(1)).toEqual([]);
    migrated.close();
    const inspected = new DatabaseSync(path, { readOnly: true });
    const version = inspected.prepare('PRAGMA user_version').get() as
      { user_version: number };
    inspected.close();
    expect(version.user_version).toBe(10);
  });

  it('migrates the production version 4 database to persisted report evaluations', () => {
    const path = temporaryDatabasePath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE reports (id TEXT PRIMARY KEY);
      CREATE TABLE research_attempt_sources (
        source_id TEXT PRIMARY KEY,
        read_status TEXT NOT NULL
      );
      PRAGMA user_version = 4;
    `);
    old.close();

    const migrated = new ResearchStore(path);
    migrated.close();
    const inspected = new DatabaseSync(path, { readOnly: true });
    const table = inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_evaluations'
    `).get();
    const version = inspected.prepare('PRAGMA user_version').get() as
      { user_version: number };
    inspected.close();

    expect(table).toBeTruthy();
    expect(version.user_version).toBe(10);
  });

  it('migrates version 5 attempt sources with a default unread checkpoint', () => {
    const path = temporaryDatabasePath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE research_attempt_sources (
        source_id TEXT PRIMARY KEY,
        read_status TEXT NOT NULL
      );
      INSERT INTO research_attempt_sources(source_id, read_status)
      VALUES ('src_existing', 'not_attempted');
      PRAGMA user_version = 5;
    `);
    old.close();

    const migrated = new ResearchStore(path);
    migrated.close();
    const inspected = new DatabaseSync(path, { readOnly: true });
    const version = inspected.prepare('PRAGMA user_version').get() as
      { user_version: number };
    const row = inspected.prepare(`
      SELECT read_status, read_succeeded FROM research_attempt_sources
      WHERE source_id = 'src_existing'
    `).get();
    inspected.close();

    expect(version.user_version).toBe(10);
    expect(row).toEqual({ read_status: 'not_attempted', read_succeeded: 0 });
  });

  it('persists failed and cancelled attempts without treating cancellation as failure', () => {
    const store = new ResearchStore(':memory:');
    const base = {
      command: '找最近七天 RAG 論文',
      modelSlug: 'gpt-5.6-luna',
      understanding: '主題：RAG；最近七天',
      startedAt: '2026-10-03T01:00:00.000Z',
      eligibleSourceCount: 2,
      supplementarySourceCount: 1,
    };
    store.saveResearchAttempt({
      ...base,
      status: 'failed',
      stage: 'generating',
      finishedAt: '2026-10-03T01:01:00.000Z',
      errorCode: 'model_error',
      errorMessage: 'Fixture model error.',
      failures: [{
        sourceId: 'src_timeout', errorCode: 'timeout', errorMessage: 'Fixture timeout.',
      }],
    });
    store.saveResearchAttempt({
      ...base,
      status: 'cancelled',
      stage: 'reading',
      finishedAt: '2026-10-03T01:02:00.000Z',
      errorCode: 'cancelled',
      errorMessage: '操作已取消。',
    });

    expect(store.listResearchAttempts()).toEqual([
      expect.objectContaining({ status: 'cancelled', stage: 'reading', failureCount: 0 }),
      expect.objectContaining({
        status: 'failed', stage: 'generating', failureCount: 1,
        eligibleSourceCount: 2, supplementarySourceCount: 1,
      }),
    ]);
    store.close();
  });

  it('persists traceable metadata and read failures for an incomplete attempt', () => {
    const store = new ResearchStore(':memory:');
    const eligible = {
      id: 'src_eligible', providerId: 'fixture', title: 'Eligible paper',
      url: 'https://arxiv.org/abs/2610.00001', authorOrOrganization: 'Example Lab',
      publishedDate: '2026-10-02', updatedDate: null, sourceType: 'paper' as const,
      evidenceLevel: 'abstract' as const, excerpt: 'Saved abstract.',
      discoveredAt: '2026-10-03T01:00:00.000Z',
    };
    const supplementary = {
      ...eligible,
      id: 'src_supplementary', title: 'Unknown date page',
      url: 'https://example.org/unknown', publishedDate: null,
      evidenceLevel: 'metadata' as const, excerpt: null,
    };
    const attemptId = store.saveResearchAttempt({
      status: 'no_evidence', stage: 'reading', command: 'fixture research',
      modelSlug: 'gpt-5.6-luna', understanding: 'fixture task',
      startedAt: '2026-10-03T01:00:00.000Z', finishedAt: '2026-10-03T01:01:00.000Z',
      eligibleSourceCount: 1, supplementarySourceCount: 1,
      eligibleSources: [eligible], supplementarySources: [supplementary],
      failures: [{
        sourceId: eligible.id, errorCode: 'timeout', errorMessage: 'Fixture timeout.',
      }],
    });

    expect(store.listResearchAttemptSources(attemptId)).toEqual([
      expect.objectContaining({
        sourceId: eligible.id, bucket: 'eligible', readStatus: 'failed',
        errorCode: 'timeout', excerpt: 'Saved abstract.',
      }),
      expect.objectContaining({
        sourceId: supplementary.id, bucket: 'supplementary',
        readStatus: 'not_attempted', errorCode: null,
      }),
    ]);
    store.close();
  });

  it('persists successful reads when report generation fails', () => {
    const store = new ResearchStore(':memory:');
    const eligible = {
      id: 'src_read', providerId: 'fixture', title: 'Read paper',
      url: 'https://arxiv.org/abs/2610.00004', authorOrOrganization: 'Example Lab',
      publishedDate: '2026-10-02', updatedDate: null, sourceType: 'paper' as const,
      evidenceLevel: 'abstract' as const, excerpt: 'Successfully read abstract.',
      discoveredAt: '2026-10-03T01:00:00.000Z',
    };
    const attemptId = store.saveResearchAttempt({
      status: 'failed', stage: 'generating', command: 'fixture research',
      modelSlug: 'gpt-5.6-luna', understanding: 'fixture task',
      startedAt: '2026-10-03T01:00:00.000Z', finishedAt: '2026-10-03T01:01:00.000Z',
      eligibleSourceCount: 1, supplementarySourceCount: 0,
      eligibleSources: [eligible], supplementarySources: [], readSourceIds: [eligible.id],
      errorCode: 'model_error', errorMessage: 'Fixture validation error.',
    });

    expect(store.listResearchAttemptSources(attemptId)).toEqual([
      expect.objectContaining({
        sourceId: eligible.id, bucket: 'eligible', readStatus: 'read',
        errorCode: null, excerpt: 'Successfully read abstract.',
      }),
    ]);
    store.close();
  });

  it('rejects a corrupted citation when loading report JSON', () => {
    const path = temporaryDatabasePath();
    const input = completedResearch();
    const store = new ResearchStore(path);
    store.saveCompletedResearch(input);
    store.close();
    const raw = new DatabaseSync(path);
    const row = raw.prepare('SELECT report_json FROM reports WHERE id = ?')
      .get(input.report.id) as { report_json: string };
    const report = JSON.parse(row.report_json) as typeof input.report;
    report.items[0].problem.sourceIds = ['src_second'];
    raw.prepare('UPDATE reports SET report_json = ? WHERE id = ?')
      .run(JSON.stringify(report), input.report.id);
    raw.close();

    const restarted = new ResearchStore(path);
    expect(() => restarted.getReport(input.report.id))
      .toThrow('不屬於該項目的來源');
    restarted.close();
  });

  it('rejects a report item that disagrees with its relational record', () => {
    const path = temporaryDatabasePath();
    const input = completedResearch();
    const store = new ResearchStore(path);
    store.saveCompletedResearch(input);
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare(`
      UPDATE report_items SET primary_source_id = 'src_second'
      WHERE report_id = ? AND item_id = 'item_01'
    `).run(input.report.id);
    raw.close();

    const restarted = new ResearchStore(path);
    expect(() => restarted.getReport(input.report.id))
      .toThrow('與關聯紀錄不一致');
    restarted.close();
  });

  it('rolls back a duplicate report insertion without damaging history', () => {
    const store = new ResearchStore(':memory:');
    const input = completedResearch();
    store.saveCompletedResearch(input);

    expect(() => store.saveCompletedResearch(input)).toThrow();
    expect(store.listReports()).toHaveLength(1);
    expect(store.getReport(input.report.id)?.id).toBe(input.report.id);
    store.close();
  });

  it('persists a format-only rewrite without changing item citation mapping', () => {
    const store = new ResearchStore(':memory:');
    const input = completedResearch();
    store.saveCompletedResearch(input);
    const comparison = rewriteResearchReport(input.report, 'comparison_table');

    store.updateReportPresentation(comparison);

    const loaded = store.getReport(input.report.id)!;
    expect(loaded.markdown).toContain('（比較表）');
    expect(loaded.items.map(({ primarySourceId }) => primarySourceId))
      .toEqual(['src_first', 'src_second']);
    expect(loaded.citedSources.map(({ id }) => id)).toEqual(['src_first', 'src_second']);
    store.close();
  });

  it('persists human citation labels across a database restart', () => {
    const path = temporaryDatabasePath();
    const input = completedResearch();
    const firstProcess = new ResearchStore(path);
    firstProcess.saveCompletedResearch(input);
    const worksheet = buildEvaluationWorksheet(input.report).replace(
      '[ ] supported　[ ] partially_supported',
      '[x] supported　[ ] partially_supported',
    );
    const summary = summarizeEvaluationWorksheet(input.report, worksheet);
    firstProcess.saveCitationEvaluation(summary, '2026-10-03T02:00:00.000Z');
    firstProcess.close();

    const restarted = new ResearchStore(path);
    expect(restarted.getCitationEvaluation(input.report.id)).toEqual(summary);
    restarted.close();
  });

  it('appends follow-up conversation to the report history', () => {
    const store = new ResearchStore(':memory:');
    const input = completedResearch();
    store.saveCompletedResearch(input);

    store.appendConversation(
      input.report.id,
      '第二篇深入一點',
      '# 追問回答',
      '2026-10-01T13:00:00.000Z',
      'item_02',
    );

    const messages = store.listMessages(input.report.id);
    expect(messages.map(({ role }) => role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
    expect(messages.at(-1)?.content).toBe('# 追問回答');
    expect(messages.slice(-2).map(({ targetItemId }) => targetItemId))
      .toEqual(['item_02', 'item_02']);
    expect(store.getLastReferencedItemId(input.report.id)).toBe('item_02');
    store.close();
  });

  it('persists a structured follow-up and its cited evidence across restart', async () => {
    const path = temporaryDatabasePath();
    const input = completedResearch();
    const firstProcess = new ResearchStore(path);
    firstProcess.saveCompletedResearch(input);
    const second = input.report.citedSources[1];
    const answer = await generateFollowUpAnswer({
      id: 'fixture-follow-up',
      async generateDraft() {
        return {
          sourceGroundedDetails: [{
            text: 'The second method preserves an inspectable evidence trail.',
            sourceIds: [second.id],
          }],
          analysis: {
            interpretation: 'This can help diagnose failures.',
            suggestedExperiment: 'Compare two fixed tasks.',
            unverified: ['Not reproduced locally.'],
          },
        };
      },
    }, input.report, 'item_02', '第二篇補查證據',
    '2026-10-01T13:00:00.000Z', new AbortController().signal, {
      performed: true,
      scope: 'Fixture bounded search.',
      queries: ['Second paper evidence'],
    });

    firstProcess.appendFollowUp(input.report.id, answer.command, answer);
    firstProcess.close();

    const restarted = new ResearchStore(path);
    expect(restarted.getLatestFollowUp(input.report.id)).toEqual(answer);
    expect(restarted.listMessages(input.report.id).slice(-2).map(({ targetItemId }) =>
      targetItemId)).toEqual(['item_02', 'item_02']);
    restarted.close();
  });
});
