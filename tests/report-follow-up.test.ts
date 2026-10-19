import { describe, expect, it, vi } from 'vitest';
import {
  OfficialFollowUpDraftProvider,
  buildFollowUpInput,
  followUpTextFormat,
  generateFollowUpAnswer,
} from '../electron/research/report-follow-up.js';
import type { EvidenceSource, ResearchReport } from '../electron/research/report.js';

function source(id: string, url: string): EvidenceSource {
  return {
    id,
    title: `Paper ${id}`,
    url,
    authorOrOrganization: 'Example Lab',
    publishedDate: '2026-09-30',
    updatedDate: null,
    sourceType: 'paper',
    evidenceLevel: 'abstract',
    retrievedAt: '2026-10-01T12:00:00.000Z',
    contentHash: 'a'.repeat(64),
    content: `Abstract evidence for ${id}.`,
    contentTruncated: false,
  };
}

const first = source('src_first', 'https://arxiv.org/abs/2610.00001');
const second = source('src_second', 'https://arxiv.org/abs/2610.00002');
const cited = (text: string, sourceId: string) => ({ text, sourceIds: [sourceId] });
const report: ResearchReport = {
  id: 'rpt_fixture',
  topic: 'AI Agent',
  publishedFrom: '2026-09-25',
  publishedTo: '2026-10-01',
  searchScope: 'arXiv abstracts',
  generatedAt: '2026-10-01T12:05:00.000Z',
  summary: [cited('Summary', first.id)],
  items: [first, second].map((item, index) => ({
    id: `item_0${index + 1}`,
    name: item.title,
    primarySourceId: item.id,
    relatedSourceIds: [],
    problem: cited('Problem', item.id),
    method: cited('Method', item.id),
    evidence: [cited('Evidence', item.id)],
    limitations: [],
    analysis: {
      applicationValue: 'Value',
      smallExperiment: 'Experiment',
      unverified: ['Not reproduced'],
    },
  })),
  citedSources: [first, second],
  markdown: '# Existing report',
};

function draft(sourceId = second.id) {
  return {
    sourceGroundedDetails: [{
      text: 'The method evaluates intermediate tool trajectories.',
      sourceIds: [sourceId],
    }],
    analysis: {
      interpretation: 'This may improve failure diagnosis.',
      suggestedExperiment: 'Compare trajectory and final-answer scoring on ten tasks.',
      unverified: ['The result has not been reproduced locally.'],
    },
  };
}

describe('report follow-up', () => {
  it('keeps 第二篇 bound to item_02 and its source', async () => {
    const provider = { id: 'fixture', async generateDraft() { return draft(); } };
    const answer = await generateFollowUpAnswer(
      provider, report, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    );

    expect(answer.targetItemId).toBe('item_02');
    expect(answer.citedSources.map(({ id }) => id)).toEqual([second.id]);
    expect(answer.markdown).toContain(second.url);
    expect(answer.markdown).toContain('沒有執行新搜尋');
    expect(answer.analysis.unverified[0]).toContain('只有摘要級證據');
    expect(answer.searchContext).toBeNull();
  });

  it('rejects a deep follow-up that only repeats the existing report', async () => {
    const repeated = draft();
    repeated.sourceGroundedDetails[0].text = report.items[1].method.text;
    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return repeated; } },
      report, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).rejects.toThrow('只重複了原報告');
  });

  it('requires two distinct new details when full-text evidence is available', async () => {
    const fullTextReport: ResearchReport = {
      ...report,
      citedSources: report.citedSources.map((entry) => entry.id === second.id
        ? { ...entry, evidenceLevel: 'full_text' as const, content: 'Full paper body.' }
        : entry),
    };
    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return draft(); } },
      fullTextReport, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).rejects.toThrow('至少需要兩項');

    const duplicated = draft();
    duplicated.sourceGroundedDetails.push({ ...duplicated.sourceGroundedDetails[0] });
    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return duplicated; } },
      fullTextReport, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).rejects.toThrow('至少需要兩項');

    const deeper = draft();
    deeper.sourceGroundedDetails.push({
      text: 'The evaluation separates planning errors from tool-execution errors.',
      sourceIds: [second.id],
    });
    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return deeper; } },
      fullTextReport, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).resolves.toMatchObject({ sourceGroundedDetails: { length: 2 } });
  });

  it('records a bounded supplemental search without changing citation validation', async () => {
    const provider = { id: 'fixture', async generateDraft() { return draft(); } };
    const searchContext = {
      performed: true as const,
      scope: 'Fixture web. 實際查詢：缺口補查「Paper 2 GitHub」。',
      queries: ['Paper 2 GitHub'],
    };
    const answer = await generateFollowUpAnswer(
      provider, report, 'item_02', '第二篇找 GitHub',
      '2026-10-01T13:00:00.000Z', new AbortController().signal, searchContext,
    );

    expect(answer.searchContext).toEqual(searchContext);
    expect(answer.markdown).toContain('已執行受控補查');
    expect(answer.markdown).not.toContain('沒有執行新搜尋');
  });

  it('rejects a citation from another report item', async () => {
    const provider = { id: 'fixture', async generateDraft() { return draft(first.id); } };
    await expect(generateFollowUpAnswer(
      provider, report, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).rejects.toThrow('未允許的來源 ID');
  });

  it('rejects an official-implementation claim for an unverified repository link', async () => {
    const repository: EvidenceSource = {
      ...second,
      id: 'src_repo',
      title: 'Candidate repository',
      url: 'https://github.com/example/candidate',
      sourceType: 'repository',
      content: 'A candidate implementation.',
    };
    const reportWithRepository: ResearchReport = {
      ...report,
      items: report.items.map((item) => item.id === 'item_02'
        ? { ...item, relatedSourceIds: [repository.id] }
        : item),
      citedSources: [...report.citedSources, repository],
    };
    const searchContext = {
      performed: true as const,
      scope: 'Fixture web.',
      queries: ['Paper 2 GitHub'],
      repositoryLinkage: [{
        sourceId: repository.id,
        status: 'unverified' as const,
        reason: 'insufficient_evidence' as const,
      }],
    };
    const unsafeDraft = draft(repository.id);
    unsafeDraft.sourceGroundedDetails[0].text = '這是該論文的官方實作。';

    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return unsafeDraft; } },
      reportWithRepository, 'item_02', '第二篇找 GitHub',
      '2026-10-01T13:00:00.000Z', new AbortController().signal, searchContext,
    )).rejects.toThrow('尚未驗證關聯');
  });

  it('adds a deterministic caveat for a safely described unverified repository', async () => {
    const repository: EvidenceSource = {
      ...second,
      id: 'src_repo', title: 'Candidate repository',
      url: 'https://github.com/example/candidate', sourceType: 'repository',
    };
    const reportWithRepository: ResearchReport = {
      ...report,
      items: report.items.map((item) => item.id === 'item_02'
        ? { ...item, relatedSourceIds: [repository.id] }
        : item),
      citedSources: [...report.citedSources, repository],
    };
    const answer = await generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return draft(repository.id); } },
      reportWithRepository, 'item_02', '第二篇找 GitHub',
      '2026-10-01T13:00:00.000Z', new AbortController().signal, {
        performed: true, scope: 'Fixture web.', queries: ['Paper 2 GitHub'],
        repositoryLinkage: [{
          sourceId: repository.id, status: 'unverified', reason: 'insufficient_evidence',
        }],
      },
    );

    expect(answer.analysis.unverified[0]).toContain('不能視為官方實作');
    expect(answer.markdown).toContain('不能視為官方實作');
  });

  it('rejects a missing fixed item ID', async () => {
    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return draft(); } },
      report, 'item_03', '第三篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).rejects.toThrow('找不到項目 item_03');
  });

  it('sends only the target item evidence and a strict citation schema', async () => {
    const streamResponse = vi.fn().mockResolvedValue({ text: JSON.stringify(draft()) });
    const provider = new OfficialFollowUpDraftProvider({ streamResponse }, 'gpt-5.6-luna');

    await provider.generateDraft(
      report, report.items[1], '第二篇深入一點', new AbortController().signal,
    );

    const request = streamResponse.mock.calls[0][0];
    expect(request.textFormat).toMatchObject({ type: 'json_schema', strict: true });
    expect(JSON.stringify(request.textFormat)).toContain(second.id);
    expect(JSON.stringify(request.textFormat)).not.toContain(first.id);
    expect(request.input[0].content).not.toContain(first.url);
    expect(buildFollowUpInput(report, report.items[1], '深入')).not.toContain(second.url);
  });

  it('aligns model-side array bounds with local follow-up validation', () => {
    const format = followUpTextFormat([second.id]);
    const schema = format.schema as {
      properties: {
        sourceGroundedDetails: { minItems: number; maxItems: number; items: {
          properties: { sourceIds: { minItems: number; maxItems: number } };
        } };
        analysis: { properties: { unverified: { minItems: number; maxItems: number } } };
      };
    };

    expect(schema.properties.sourceGroundedDetails).toMatchObject({ minItems: 1, maxItems: 6 });
    expect(schema.properties.sourceGroundedDetails.items.properties.sourceIds)
      .toMatchObject({ minItems: 1, maxItems: 6 });
    expect(schema.properties.analysis.properties.unverified)
      .toMatchObject({ minItems: 1, maxItems: 6 });
    expect(JSON.stringify(format)).not.toContain('uniqueItems');
  });

  it('keeps the local validator as a second boundary for excessive claims', async () => {
    const excessive = draft();
    excessive.sourceGroundedDetails = Array.from({ length: 7 }, (_, index) => ({
      text: `Supported detail ${index + 1}.`,
      sourceIds: [second.id],
    }));

    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return excessive; } },
      report, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).rejects.toThrow('1 到 6 項');
  });

  it('rejects non-JSON model output without repair', async () => {
    const provider = new OfficialFollowUpDraftProvider({
      streamResponse: vi.fn().mockResolvedValue({ text: '```json\n{}\n```' }),
    }, 'gpt-5.6-luna');

    await expect(provider.generateDraft(
      report, report.items[1], '深入', new AbortController().signal,
    )).rejects.toThrow('有效 JSON');
  });

  it('rejects control characters in a structured follow-up draft', async () => {
    const invalid = draft();
    invalid.analysis.interpretation = 'Unsafe\u0000text';

    await expect(generateFollowUpAnswer(
      { id: 'fixture', async generateDraft() { return invalid; } },
      report, 'item_02', '第二篇深入一點',
      '2026-10-01T13:00:00.000Z', new AbortController().signal,
    )).rejects.toThrow('助理理解');
  });
});
