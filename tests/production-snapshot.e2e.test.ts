import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildEvaluationWorksheet } from '../electron/research/evaluation-worksheet.js';
import { auditResearchReport } from '../electron/research/report-audit.js';
import { rewriteResearchReport } from '../electron/research/report.js';
import { ResearchStore } from '../electron/research/research-store.js';
import { resolveFollowUpItemId, resolveResearchTask } from '../electron/research/research-task.js';

const enabled = process.env.RUN_PRODUCTION_SNAPSHOT_E2E === '1';
const suite = enabled ? describe : describe.skip;
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'ai-ra-production-snapshot-'))) {
      throw new Error(`Refusing to remove unexpected test directory: ${directory}`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function productionDatabasePath(): string {
  if (process.env.AI_RESEARCH_ASSISTANT_PRODUCTION_DB) {
    return process.env.AI_RESEARCH_ASSISTANT_PRODUCTION_DB;
  }
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is unavailable; set AI_RESEARCH_ASSISTANT_PRODUCTION_DB.');
  return join(appData, 'AI Research Assistant', 'research.sqlite');
}

function snapshotProductionDatabase(): string {
  const source = productionDatabasePath();
  if (!existsSync(source)) throw new Error(`Production database does not exist: ${source}`);
  const directory = mkdtempSync(join(tmpdir(), 'ai-ra-production-snapshot-'));
  temporaryDirectories.push(directory);
  const snapshot = join(directory, 'research.sqlite');
  copyFileSync(source, snapshot);
  return snapshot;
}

suite('production SQLite snapshot acceptance', () => {
  it('measures numeric grounding warnings across all saved reports without mutating them', () => {
    const path = snapshotProductionDatabase();
    const store = new ResearchStore(path);
    const summaries = store.listReports(100);
    const measurements = summaries.map(({ id }) => {
      const report = store.getReport(id);
      if (!report) throw new Error(`Production report ${id} could not be loaded.`);
      const audit = auditResearchReport(report);
      return {
        reportId: id,
        numericClaims: audit.numericClaimCount,
        warnings: audit.numericGroundingWarningCount,
        issues: audit.numericGroundingIssues,
      };
    });
    store.close();

    const totals = measurements.reduce((sum, measurement) => ({
      numericClaims: sum.numericClaims + measurement.numericClaims,
      warnings: sum.warnings + measurement.warnings,
    }), { numericClaims: 0, warnings: 0 });
    console.info('[production numeric grounding]', JSON.stringify({
      reportCount: measurements.length,
      ...totals,
      reportsWithWarnings: measurements.filter(({ warnings }) => warnings > 0).length,
      issues: measurements.filter(({ warnings }) => warnings > 0).map(({ reportId, issues }) => ({
        reportId,
        issues,
      })),
    }));
    expect(measurements.length).toBeGreaterThan(0);
    expect(totals.warnings).toBeLessThanOrEqual(totals.numericClaims);
  });

  it('handles a real report through rewrite, follow-up targeting, preferences, and restart', () => {
    const path = snapshotProductionDatabase();
    const firstProcess = new ResearchStore(path);
    const latestSummary = firstProcess.listReports(1)[0];
    expect(latestSummary, 'Production history must contain at least one report.').toBeDefined();
    const report = firstProcess.getReport(latestSummary.id);
    expect(report).not.toBeNull();
    if (!report) throw new Error('Latest production report could not be loaded.');

    const audit = auditResearchReport(report);
    expect(audit.structuralCitationStatus).toBe('passed');
    expect(audit.unknownPublicationDateCount).toBe(0);
    expect(audit.outsideDateRangeSourceCount).toBe(0);
    expect(report.items.length).toBeGreaterThanOrEqual(2);

    const comparison = rewriteResearchReport(report, 'comparison_table');
    expect(comparison.markdown).toContain('| 技術 | 解決問題（來源主張） |');
    expect(comparison.items).toEqual(report.items);
    expect(comparison.citedSources).toEqual(report.citedSources);
    firstProcess.updateReportPresentation(comparison);

    const targetItemId = resolveFollowUpItemId(report.items, {
      kind: 'ordinal', itemOrdinal: 2, instruction: '第二篇深入一點', requiresNewSearch: false,
    });
    expect(targetItemId).toBe('item_02');
    firstProcess.appendConversation(
      report.id,
      '第二篇深入一點',
      'production snapshot acceptance response',
      '2026-10-04T02:00:00.000Z',
      targetItemId,
    );

    firstProcess.replacePreferences({ topic: 'RAG', summaryPoints: 3 });
    const oneTimeTask = resolveResearchTask(
      firstProcess.getPreferences(), { topic: '推論效率' }, '2026-10-04',
    );
    expect(oneTimeTask.topic).toBe('推論效率');
    expect(firstProcess.getPreferences()).toEqual({ topic: 'RAG', summaryPoints: 3 });
    expect(buildEvaluationWorksheet(report)).toContain('item_02.method');
    firstProcess.close();

    const restartedProcess = new ResearchStore(path);
    expect(restartedProcess.getReport(report.id)?.markdown).toBe(comparison.markdown);
    expect(restartedProcess.getLastReferencedItemId(report.id)).toBe('item_02');
    expect(restartedProcess.getPreferences()).toEqual({ topic: 'RAG', summaryPoints: 3 });
    expect(restartedProcess.listMessages(report.id).slice(-2)).toEqual([
      expect.objectContaining({ role: 'user', targetItemId: 'item_02' }),
      expect.objectContaining({ role: 'assistant', targetItemId: 'item_02' }),
    ]);
    restartedProcess.close();
  });
});
