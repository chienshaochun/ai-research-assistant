import { describe, expect, it } from 'vitest';
import type { ContentReadFailure, ContentReadSuccess } from '../electron/research/content-reader.js';
import {
  buildEvidenceBundle,
  finalizeResearchReport,
  rewriteResearchReport,
  type ResearchReportContext,
} from '../electron/research/report.js';
import type { SourceReadRecord } from '../electron/research/run-reading.js';
import {
  normalizeSearchCandidate,
  type SearchCandidate,
  type SourceType,
} from '../electron/research/search-provider.js';

const discoveredAt = '2026-10-01T12:00:00.000Z';
const retrievedAt = '2026-10-01T12:01:00.000Z';

function candidate(name: string, type: SourceType, publishedDate: string | null): SearchCandidate {
  return normalizeSearchCandidate({
    title: name,
    url: `https://${name.toLowerCase().replaceAll(' ', '-')}.example.org/source`,
    authorOrOrganization: 'Example Lab',
    publishedDate,
    sourceType: type,
    evidenceLevel: 'metadata',
  }, 'fixture-search', discoveredAt);
}

function success(source: SearchCandidate, text = `Read content for ${source.title}`): ContentReadSuccess {
  return {
    status: 'read',
    sourceId: source.id,
    requestedUrl: source.url,
    finalUrl: source.url,
    redirects: [],
    retrievedAt,
    contentType: 'text/plain',
    contentHash: 'a'.repeat(64),
    text,
    textTruncated: false,
  };
}

function failure(source: SearchCandidate): ContentReadFailure {
  return {
    status: 'failed',
    sourceId: source.id,
    requestedUrl: source.url,
    finalUrl: source.url,
    redirects: [],
    retrievedAt,
    errorCode: 'unsupported_content_type',
    errorMessage: 'PDF is not supported.',
  };
}

function record(
  source: SearchCandidate,
  result: ContentReadSuccess | ContentReadFailure,
  inputIndex: number,
): SourceReadRecord {
  return { sourceId: source.id, sourceType: source.sourceType, inputIndex, attempts: 1, result };
}

const context: ResearchReportContext = {
  topic: 'AI Agent 評估新技術',
  publishedFrom: '2026-09-25',
  publishedTo: '2026-10-01',
  searchScope: '官方 Web Search；只使用成功讀取的論文與官方文件。',
  generatedAt: '2026-10-01T12:05:00.000Z',
  maxItems: 3,
};

function validDraft(paperId: string, documentationId: string) {
  return {
    summary: [{ text: '新方法以可重現軌跡評估 Agent。', sourceIds: [paperId] }],
    items: [{
      name: 'TraceEval',
      primarySourceId: paperId,
      relatedSourceIds: [documentationId],
      problem: { text: '現有評估難以定位 Agent 失敗步驟。', sourceIds: [paperId] },
      method: { text: '方法保存工具軌跡並逐步評分。', sourceIds: [paperId, documentationId] },
      evidence: [{ text: '作者在固定資料集報告較高診斷率。', sourceIds: [paperId] }],
      limitations: [],
      analysis: {
        applicationValue: '可用於本專案的工具呼叫回歸測試。',
        smallExperiment: '建立十題固定任務，比較只有最終答案與加入軌跡評分。',
        unverified: ['尚未在本專案資料上重現作者結果。'],
      },
    }],
  };
}

describe('research evidence and report', () => {
  const paper = candidate('Trace Paper', 'paper', '2026-09-30');
  const documentation = candidate('Official Docs', 'official_documentation', '2026-09-29');
  const unreadRepository = candidate('Code Repository', 'repository', '2026-09-30');
  const evidence = buildEvidenceBundle(
    [paper, documentation, unreadRepository],
    [
      record(paper, success(paper), 0),
      record(documentation, success(documentation), 1),
      record(unreadRepository, failure(unreadRepository), 2),
    ],
  );

  it('builds evidence only from successful reads and records failures separately', () => {
    expect(evidence.sources.map(({ id }) => id)).toEqual([paper.id, documentation.id]);
    expect(evidence.failures).toEqual([expect.objectContaining({
      sourceId: unreadRepository.id,
      errorCode: 'unsupported_content_type',
    })]);
  });

  it('preserves a reader upgrade from abstract metadata to full-text evidence', () => {
    const abstractPaper = { ...paper, evidenceLevel: 'abstract' as const };
    const fullTextRead = {
      ...success(abstractPaper, 'Full paper body.'),
      evidenceLevel: 'full_text' as const,
    };

    const upgradedEvidence = buildEvidenceBundle(
      [abstractPaper],
      [record(abstractPaper, fullTextRead, 0)],
    );

    expect(upgradedEvidence.sources[0]).toMatchObject({
      id: abstractPaper.id,
      evidenceLevel: 'full_text',
      content: 'Full paper body.',
    });
  });

  it('assigns fixed item IDs and renders links only from validated cited sources', () => {
    const report = finalizeResearchReport(context, evidence, validDraft(paper.id, documentation.id));

    expect(report.items[0].id).toBe('item_01');
    expect(report.citedSources.map(({ id }) => id)).toEqual([paper.id, documentation.id]);
    expect(report.markdown).toContain('### 來源中的主張');
    expect(report.markdown).toContain('### 助理分析（不是來源原文主張）');
    expect(report.markdown).toContain(`來源 ID：\`${paper.id}\``);
    expect(report.markdown).toContain(`(<${paper.url}>)`);
    expect(report.markdown).toContain(`新方法以可重現軌跡評估 Agent。（[來源 1](<${paper.url}>)）`);
    expect(report.markdown).not.toContain(unreadRepository.url);
  });

  it('rejects a fabricated citation ID', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].problem.sourceIds = ['src_fabricated'];
    expect(() => finalizeResearchReport(context, evidence, draft))
      .toThrow('不屬於此報告項目的來源 ID');
  });

  it('rejects an unread source as a primary source', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].primarySourceId = unreadRepository.id;
    expect(() => finalizeResearchReport(context, evidence, draft))
      .toThrow('主要來源未成功讀取');
  });

  it('derives related sources from the claim citations instead of a separate model list', () => {
    const extraPaper = candidate('Other Paper', 'paper', '2026-09-30');
    const expandedEvidence = buildEvidenceBundle(
      [paper, documentation, extraPaper],
      [record(paper, success(paper), 0), record(documentation, success(documentation), 1),
        record(extraPaper, success(extraPaper), 2)],
    );
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].evidence[0].sourceIds = [extraPaper.id];

    const report = finalizeResearchReport(context, expandedEvidence, draft);

    expect(report.items[0].relatedSourceIds).toEqual([documentation.id, extraPaper.id]);
  });

  it('removes a related source that does not support any item claim', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].method.sourceIds = [paper.id];

    const report = finalizeResearchReport(context, evidence, draft);

    expect(report.items[0].relatedSourceIds).toEqual([]);
    expect(report.citedSources.map(({ id }) => id)).toEqual([paper.id]);
  });

  it('still rejects a primary source that does not support any item claim', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].problem.sourceIds = [documentation.id];
    draft.items[0].method.sourceIds = [documentation.id];
    draft.items[0].evidence[0].sourceIds = [documentation.id];

    expect(() => finalizeResearchReport(context, evidence, draft))
      .toThrow('主要來源沒有支持任何項目主張');
  });

  it('keeps a summary-only citation traceable without listing it as an item relation', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].method.sourceIds = [paper.id];
    draft.summary[0].sourceIds = [documentation.id];

    const report = finalizeResearchReport(context, evidence, draft);

    expect(report.items[0].relatedSourceIds).toEqual([]);
    expect(report.citedSources.map(({ id }) => id)).toEqual([paper.id, documentation.id]);
    expect(report.markdown).toContain(documentation.url);
  });

  it('normalizes duplicate source IDs and a primary repeated in related sources', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].relatedSourceIds = [paper.id, documentation.id, documentation.id];
    draft.items[0].method.sourceIds = [paper.id, documentation.id, documentation.id];

    const report = finalizeResearchReport(context, evidence, draft);

    expect(report.items[0].method.sourceIds).toEqual([paper.id, documentation.id]);
    expect(report.items[0].relatedSourceIds).toEqual([documentation.id]);
  });

  it('enforces the requested report item limit', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items = [draft.items[0], { ...draft.items[0] }];
    expect(() => finalizeResearchReport({ ...context, maxItems: 1 }, evidence, draft))
      .toThrow('報告項目必須包含 1 到 1 項');
  });

  it('enforces the requested summary point limit locally', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.summary.push({ text: '第二個重點。', sourceIds: [paper.id] });

    expect(() => finalizeResearchReport(
      { ...context, summaryPoints: 1 }, evidence, draft,
    )).toThrow('重點摘要 必須包含 1 到 1 項');
  });

  it('adds a deterministic evidence caveat when the model returns no unverified items', () => {
    const draft = validDraft(paper.id, documentation.id);
    draft.items[0].analysis.unverified = [];

    const report = finalizeResearchReport(context, evidence, draft);

    expect(report.items[0].analysis.unverified).toEqual([
      '尚未由本專案重現作者結果。',
    ]);
  });

  it('states when the fallback caveat is based on an abstract rather than full text', () => {
    const abstractPaper = { ...paper, evidenceLevel: 'abstract' as const };
    const abstractEvidence = buildEvidenceBundle(
      [abstractPaper, documentation],
      [record(abstractPaper, success(abstractPaper), 0), record(documentation, success(documentation), 1)],
    );
    const draft = validDraft(abstractPaper.id, documentation.id);
    draft.items[0].analysis.unverified = [];

    const report = finalizeResearchReport(context, abstractEvidence, draft);

    expect(report.items[0].analysis.unverified).toEqual([
      '尚未由本專案重現作者結果；目前證據包含論文摘要，未讀取 PDF 全文。',
    ]);
  });

  it('rewrites an existing report as a brief without adding sources or claims', () => {
    const report = finalizeResearchReport(context, evidence, validDraft(paper.id, documentation.id));
    const brief = rewriteResearchReport(report, 'brief');

    expect(brief.id).toBe(report.id);
    expect(brief.items).toEqual(report.items);
    expect(brief.citedSources).toEqual(report.citedSources);
    expect(brief.markdown).toContain('（短摘要）');
    expect(brief.markdown).toContain('沒有重新搜尋或產生新主張');
  });

  it('rewrites an existing report as a comparison table with claim boundaries', () => {
    const report = finalizeResearchReport(context, evidence, validDraft(paper.id, documentation.id));
    const comparison = rewriteResearchReport(report, 'comparison_table');

    expect(comparison.markdown).toContain('| 技術 | 解決問題（來源主張） |');
    expect(comparison.markdown).toContain('「來源主張」與「助理分析」保持分欄');
    expect(comparison.markdown).toContain(`(<${paper.url}>)`);
  });
});
