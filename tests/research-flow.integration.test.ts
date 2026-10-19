import { describe, expect, it } from 'vitest';
import type { ContentReader } from '../electron/research/content-reader.js';
import { buildEvaluationWorksheet } from '../electron/research/evaluation-worksheet.js';
import { auditResearchReport } from '../electron/research/report-audit.js';
import type { ReportDraftProvider } from '../electron/research/report-provider.js';
import { runResearchPipeline } from '../electron/research/research-pipeline.js';
import { ResearchStore } from '../electron/research/research-store.js';
import { interpretCommand, resolveResearchTask } from '../electron/research/research-task.js';
import type { SearchProvider } from '../electron/research/search-provider.js';

describe('fixture research flow integration', () => {
  it('runs the sample command through report, audit, SQLite reload, and worksheet', async () => {
    const command = '幫我找最近七天 AI Agent 與 RAG 的新技術，最多整理三項，優先有論文或開源程式碼的內容。';
    const interpreted = interpretCommand(command);
    expect(interpreted.kind).toBe('research');
    const task = resolveResearchTask({}, interpreted.taskOverrides, '2026-10-02');
    const searchProvider: SearchProvider = {
      id: 'fixture-search',
      scopeDescription: 'fixture paper abstract',
      async search() {
        return [{
          title: 'Traceable Agent Evaluation',
          url: 'https://arxiv.org/abs/2610.00001',
          authorOrOrganization: 'Example Lab',
          publishedDate: '2026-10-01',
          updatedDate: '2026-10-02',
          sourceType: 'paper',
          evidenceLevel: 'abstract',
          excerpt: 'The paper evaluates tool trajectories for retrieval-augmented agents.',
        }];
      },
    };
    const contentReader: ContentReader = {
      async read(candidate) {
        return {
          status: 'read', sourceId: candidate.id, requestedUrl: candidate.url,
          finalUrl: candidate.url, redirects: [], retrievedAt: '2026-10-02T01:00:00.000Z',
          contentType: 'text/plain', contentHash: 'a'.repeat(64),
          text: candidate.excerpt!, textTruncated: false,
        };
      },
    };
    const reportProvider: ReportDraftProvider = {
      id: 'fixture-report',
      async generateDraft(_context, evidence) {
        const sourceId = evidence.sources[0].id;
        const cited = (text: string) => ({ text, sourceIds: [sourceId] });
        return {
          summary: [cited('此方法以工具軌跡評估檢索增強 Agent。')],
          items: [{
            name: 'Traceable Agent Evaluation', primarySourceId: sourceId,
            relatedSourceIds: [], problem: cited('最終答案分數難以定位工具步驟錯誤。'),
            method: cited('方法評估 Agent 的工具使用軌跡。'),
            evidence: [cited('摘要指出評估對象包含 retrieval-augmented agents。')],
            limitations: [], analysis: {
              applicationValue: '可作為本專案軌跡評估設計參考。',
              smallExperiment: '建立十題工具任務並保存逐步軌跡。',
              unverified: ['尚未在本機重現論文實驗。'],
            },
          }],
        };
      },
    };

    const result = await runResearchPipeline(
      { searchProvider, contentReader, reportProvider },
      task,
      new AbortController().signal,
    );
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Fixture pipeline did not complete.');

    const store = new ResearchStore(':memory:');
    store.saveCompletedResearch({
      command, modelSlug: 'fixture-model', understanding: result.understanding,
      report: result.report, evidence: result.evidence,
    });
    const loaded = store.getReport(result.report.id)!;
    const audit = auditResearchReport(loaded);
    const worksheet = buildEvaluationWorksheet(loaded);

    expect(loaded.items[0]).toMatchObject({ id: 'item_01' });
    expect(loaded.markdown).toContain('https://arxiv.org/abs/2610.00001');
    expect(audit).toMatchObject({
      citedSourceCount: 1, structuralCitationStatus: 'passed',
      semanticSupportStatus: 'not_evaluated',
    });
    expect(worksheet).toContain('item_01.method');
    expect(store.listReports()).toHaveLength(1);
    store.close();
  });
});
