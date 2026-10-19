import { describe, expect, it, vi } from 'vitest';
import {
  MAX_MODEL_EVIDENCE_CHARACTERS,
  MAX_MODEL_SOURCE_CHARACTERS,
  OfficialReportDraftProvider,
  buildReportGenerationInput,
  generateResearchReport,
  prepareReportGeneration,
  reportDraftTextFormat,
  selectModelEvidenceContent,
} from '../electron/research/report-provider.js';
import type {
  EvidenceBundle,
  EvidenceSource,
  ResearchReportContext,
} from '../electron/research/report.js';
import { responseRequestBody } from
  '../vendor/sign-in-with-chatgpt-devkit/packages/local/src/responses.js';

const context: ResearchReportContext = {
  topic: 'AI Agent 評估',
  publishedFrom: '2026-09-25',
  publishedTo: '2026-10-01',
  searchScope: '成功讀取的論文。',
  generatedAt: '2026-10-01T12:05:00.000Z',
  maxItems: 3,
};

function source(id: string, content = 'Paper evidence.'): EvidenceSource {
  return {
    id,
    title: 'Trace Paper',
    url: 'https://papers.example.org/trace',
    authorOrOrganization: 'Example Lab',
    publishedDate: '2026-09-30',
    updatedDate: null,
    sourceType: 'paper',
    evidenceLevel: 'abstract',
    retrievedAt: '2026-10-01T12:01:00.000Z',
    contentHash: 'a'.repeat(64),
    content,
    contentTruncated: false,
  };
}

function draft(sourceId: string) {
  const cited = (text: string) => ({ text, sourceIds: [sourceId] });
  return {
    summary: [cited('這項方法以軌跡評估 Agent。')],
    items: [{
      name: 'TraceEval',
      primarySourceId: sourceId,
      relatedSourceIds: [],
      problem: cited('現有方法難以定位失敗步驟。'),
      method: cited('逐步保存並評分工具軌跡。'),
      evidence: [cited('作者在固定資料集報告診斷結果。')],
      limitations: [],
      analysis: {
        applicationValue: '可用於工具呼叫回歸測試。',
        smallExperiment: '以十題固定任務比較兩種評分法。',
        unverified: ['尚未在本專案重現。'],
      },
    }],
  };
}

describe('official structured report provider', () => {
  const paper = source('src_paper');
  const evidence: EvidenceBundle = { sources: [paper], failures: [] };

  it('uses the official Responses text.format wire shape with required SIWC flags', () => {
    const textFormat = reportDraftTextFormat([paper.id], context.maxItems);
    const body = responseRequestBody({
      model: 'gpt-5.6-luna',
      input: [{ role: 'user', content: '{}' }],
      instructions: 'Return a report.',
      textFormat,
    });

    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      stream: true,
      text: { format: { type: 'json_schema', name: 'research_report_draft', strict: true } },
    });
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('previous_response_id');
  });

  it('puts officially supported array bounds in the model schema and keeps unique checks local', () => {
    const format = reportDraftTextFormat([paper.id], context.maxItems, 2);
    const schema = format.schema as {
      properties: {
        summary: { minItems: number; maxItems: number };
        items: { minItems: number; maxItems: number; items: {
          properties: {
            relatedSourceIds: { maxItems: number };
            evidence: { minItems: number; maxItems: number };
            limitations: { maxItems: number };
            analysis: { properties: { unverified: { maxItems: number } } };
          };
        } };
      };
    };

    expect(schema.properties.summary).toMatchObject({ minItems: 1, maxItems: 2 });
    expect(schema.properties.items).toMatchObject({ minItems: 1, maxItems: context.maxItems });
    expect(schema.properties.items.items.properties.relatedSourceIds.maxItems).toBe(5);
    expect(schema.properties.items.items.properties.evidence).toMatchObject({ minItems: 1, maxItems: 5 });
    expect(schema.properties.items.items.properties.limitations.maxItems).toBe(5);
    expect(schema.properties.items.items.properties.analysis.properties.unverified.maxItems).toBe(5);
    expect(JSON.stringify(format)).not.toContain('"uniqueItems"');
  });

  it('bounds evidence supplied to the model and excludes source URLs', () => {
    const longEvidence: EvidenceBundle = {
      sources: [
        source('src_first', 'a'.repeat(MAX_MODEL_SOURCE_CHARACTERS + 10)),
        source('src_second', 'b'.repeat(MAX_MODEL_EVIDENCE_CHARACTERS)),
      ],
      failures: [],
    };
    const parsed = JSON.parse(buildReportGenerationInput(context, longEvidence)) as {
      sources: Array<{ content: string; contentTruncatedForModel: boolean }>;
    };

    expect(parsed.sources[0].content).toHaveLength(MAX_MODEL_SOURCE_CHARACTERS);
    expect(parsed.sources[0].contentTruncatedForModel).toBe(true);
    expect(parsed.sources.reduce((total, item) => total + item.content.length, 0))
      .toBeLessThanOrEqual(MAX_MODEL_EVIDENCE_CHARACTERS);
    expect(buildReportGenerationInput(context, evidence)).not.toContain(paper.url);
  });

  it('selects bounded section windows across long full-text evidence', () => {
    const fullText = [
      'Abstract and introduction. ', 'a'.repeat(11_000),
      ' Results ', 'r'.repeat(18_000),
      ' Limitations ', 'l'.repeat(18_000),
      ' Conclusion ', 'c'.repeat(18_000),
      ' End matter ', 'z'.repeat(5_000),
    ].join('');
    const selected = selectModelEvidenceContent({
      ...source('src_full_text', fullText),
      evidenceLevel: 'full_text',
    });

    expect(selected).toMatchObject({ truncated: true, strategy: 'section_windows' });
    expect(selected.content.length).toBeLessThanOrEqual(MAX_MODEL_SOURCE_CHARACTERS);
    expect(selected.content).toContain('Abstract and introduction');
    expect(selected.content).toContain('Results');
    expect(selected.content).toContain('Limitations');
    expect(selected.content).toContain('Conclusion');
    expect(selected.content).toContain('[證據片段');
  });

  it('keeps short full text contiguous and marks its selection as complete', () => {
    expect(selectModelEvidenceContent({
      ...source('src_short_full_text', 'Complete short paper.'),
      evidenceLevel: 'full_text',
    })).toEqual({
      content: 'Complete short paper.', truncated: false, strategy: 'complete',
    });
  });

  it('passes the requested summary count to the model input', () => {
    const parsed = JSON.parse(buildReportGenerationInput(
      { ...context, summaryPoints: 1 }, evidence,
    )) as { task: { summaryPoints: number } };

    expect(parsed.task.summaryPoints).toBe(1);
  });

  it('only permits citations to sources that fit inside the model evidence budget', () => {
    const budgetedEvidence: EvidenceBundle = {
      sources: [
        source('src_1', 'a'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_2', 'b'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_3', 'c'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_4', 'd'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_omitted', 'evidence outside the total budget'),
      ],
      failures: [],
    };

    const prepared = prepareReportGeneration(context, budgetedEvidence);

    expect(prepared.includedSourceIds).toEqual(['src_1', 'src_2', 'src_3', 'src_4']);
    expect(prepared.input).not.toContain('src_omitted');
  });

  it('forwards the caller signal, requests strict JSON schema, and parses the draft', async () => {
    const controller = new AbortController();
    const streamResponse = vi.fn().mockResolvedValue({ text: JSON.stringify(draft(paper.id)) });
    const provider = new OfficialReportDraftProvider({ streamResponse }, 'gpt-5.6-luna');

    await expect(provider.generateDraft(context, evidence, controller.signal))
      .resolves.toEqual(draft(paper.id));
    expect(streamResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-luna',
      signal: controller.signal,
      textFormat: expect.objectContaining({ type: 'json_schema', strict: true }),
    }));
  });

  it('does not put evidence omitted by the character budget into the citation schema', async () => {
    const streamResponse = vi.fn().mockResolvedValue({ text: JSON.stringify(draft('src_1')) });
    const provider = new OfficialReportDraftProvider({ streamResponse }, 'gpt-5.6-luna');
    const budgetedEvidence: EvidenceBundle = {
      sources: [
        source('src_1', 'a'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_2', 'b'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_3', 'c'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_4', 'd'.repeat(MAX_MODEL_SOURCE_CHARACTERS)),
        source('src_omitted', 'not sent'),
      ],
      failures: [],
    };

    await provider.generateDraft(context, budgetedEvidence, new AbortController().signal);

    const request = streamResponse.mock.calls[0][0];
    expect(JSON.stringify(request.textFormat)).not.toContain('src_omitted');
  });

  it('rejects invalid JSON instead of trying to repair model output', async () => {
    const provider = new OfficialReportDraftProvider({
      streamResponse: vi.fn().mockResolvedValue({ text: '```json\n{}\n```' }),
    }, 'gpt-5.6-luna');

    await expect(provider.generateDraft(context, evidence, new AbortController().signal))
      .rejects.toThrow('有效 JSON');
  });

  it('runs model output through citation validation before returning a report', async () => {
    const provider = {
      id: 'fixture-report',
      async generateDraft() {
        return draft(paper.id);
      },
    };
    const report = await generateResearchReport(
      provider, context, evidence, new AbortController().signal,
    );

    expect(report.items[0]).toMatchObject({ id: 'item_01', primarySourceId: paper.id });
    expect(report.markdown).toContain(paper.url);
  });

  it('rejects fabricated citations returned by a provider', async () => {
    const invalidDraft = draft(paper.id);
    invalidDraft.items[0].problem.sourceIds = ['src_fabricated'];
    await expect(generateResearchReport({
      id: 'fixture-report',
      async generateDraft() { return invalidDraft; },
    }, context, evidence, new AbortController().signal))
      .rejects.toThrow('不屬於此報告項目的來源 ID');
  });
});
