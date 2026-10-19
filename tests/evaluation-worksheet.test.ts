import { describe, expect, it } from 'vitest';
import {
  buildEvaluationWorksheet,
  listEvaluationClaims,
  summarizeEvaluationWorksheet,
} from '../electron/research/evaluation-worksheet.js';
import type { EvidenceSource, ResearchReport } from '../electron/research/report.js';

const source: EvidenceSource = {
  id: 'src_paper', title: 'Paper <script>', url: 'https://arxiv.org/abs/2610.00001',
  authorOrOrganization: 'Lab', publishedDate: '2026-10-01', updatedDate: null,
  sourceType: 'paper', evidenceLevel: 'abstract',
  retrievedAt: '2026-10-02T00:00:00.000Z', contentHash: 'a'.repeat(64),
  content: 'Evidence <b>must remain data</b>.', contentTruncated: false,
};
const cited = (text: string) => ({ text, sourceIds: [source.id] });
const report: ResearchReport = {
  id: 'rpt_fixture', topic: 'AI Agent', publishedFrom: '2026-09-25',
  publishedTo: '2026-10-01', searchScope: 'fixture',
  generatedAt: '2026-10-02T00:00:00.000Z', summary: [cited('Summary')],
  items: [{
    id: 'item_01', name: 'Method', primarySourceId: source.id, relatedSourceIds: [],
    problem: cited('Problem'), method: cited('Method'), evidence: [cited('Evidence')],
    limitations: [], analysis: {
      applicationValue: 'Value', smallExperiment: 'Experiment', unverified: ['Unknown'],
    },
  }],
  citedSources: [source], markdown: '# Report',
};

describe('manual citation support worksheet', () => {
  it('assigns stable claim IDs only to source-grounded statements', () => {
    expect(listEvaluationClaims(report).map(({ id }) => id)).toEqual([
      'summary_01', 'item_01.problem', 'item_01.method', 'item_01.evidence_01',
    ]);
  });

  it('exports blank labels and the exact saved evidence without claiming a result', () => {
    const markdown = buildEvaluationWorksheet(report);

    expect(markdown).toContain('[ ] supported');
    expect(markdown).toContain('這份工作表尚未包含評估結果');
    expect(markdown).toContain('Evidence &lt;b&gt;must remain data&lt;/b&gt;.');
    expect(markdown).not.toContain('<script>');
  });

  it('rejects a worksheet claim whose source is missing', () => {
    const invalid = structuredClone(report);
    invalid.summary[0].sourceIds = ['src_missing'];

    expect(() => buildEvaluationWorksheet(invalid)).toThrow('找不到來源');
  });

  it('summarizes only explicit human labels and leaves blank claims unevaluated', () => {
    let markdown = buildEvaluationWorksheet(report);
    const select = (claimId: string, label: string) => {
      const start = markdown.indexOf(`### ${claimId} ·`);
      const end = markdown.indexOf('\n### ', start + 1);
      const boundary = end < 0 ? markdown.indexOf('\n## 當次保存的證據', start) : end;
      const section = markdown.slice(start, boundary);
      const labeled = section.replace(`[ ] ${label}`, `[x] ${label}`);
      markdown = `${markdown.slice(0, start)}${labeled}${markdown.slice(boundary)}`;
    };
    select('summary_01', 'supported');
    select('item_01.problem', 'partially_supported');
    select('item_01.method', 'unsupported');

    expect(summarizeEvaluationWorksheet(report, markdown)).toEqual({
      reportId: report.id,
      total: 4,
      evaluated: 3,
      unlabeled: 1,
      counts: {
        supported: 1, partially_supported: 1, unsupported: 1, unclear: 0,
      },
      strictSupportedRate: 1 / 3,
      supportedOrPartialRate: 2 / 3,
      annotations: [
        { claimId: 'summary_01', label: 'supported' },
        { claimId: 'item_01.problem', label: 'partially_supported' },
        { claimId: 'item_01.method', label: 'unsupported' },
        { claimId: 'item_01.evidence_01', label: null },
      ],
    });
  });

  it('rejects mismatched reports, missing claims, and multiple labels', () => {
    const worksheet = buildEvaluationWorksheet(report);
    expect(() => summarizeEvaluationWorksheet(
      { ...report, id: 'rpt_other' }, worksheet,
    )).toThrow('報告 ID');
    expect(() => summarizeEvaluationWorksheet(
      report, worksheet.replace('### item_01.method ·', '### removed.method ·'),
    )).toThrow('未知主張');
    expect(() => summarizeEvaluationWorksheet(
      report,
      worksheet.replace(
        '[ ] supported　[ ] partially_supported',
        '[x] supported　[x] partially_supported',
      ),
    )).toThrow('只能勾選一個');
  });
});
