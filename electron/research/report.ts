import { createHash } from 'node:crypto';
import type { ContentReadFailure, ContentReadSuccess } from './content-reader.js';
import type { SourceReadRecord } from './run-reading.js';
import type { EvidenceLevel, SearchCandidate, SourceType } from './search-provider.js';

export interface EvidenceSource {
  id: string;
  title: string;
  url: string;
  authorOrOrganization: string | null;
  publishedDate: string | null;
  updatedDate: string | null;
  sourceType: SourceType;
  evidenceLevel: EvidenceLevel;
  retrievedAt: string;
  contentHash: string;
  content: string;
  contentTruncated: boolean;
}

export interface EvidenceFailure {
  sourceId: string;
  errorCode: ContentReadFailure['errorCode'];
  errorMessage: string;
}

export interface EvidenceBundle {
  sources: EvidenceSource[];
  failures: EvidenceFailure[];
}

export interface ResearchReportContext {
  topic: string;
  publishedFrom?: string;
  publishedTo?: string;
  searchScope: string;
  generatedAt: string;
  maxItems: number;
  summaryPoints?: number;
}

export interface CitedStatement {
  text: string;
  sourceIds: string[];
}

export interface ReportItemAnalysis {
  applicationValue: string;
  smallExperiment: string;
  unverified: string[];
}

export interface ReportItem {
  id: string;
  name: string;
  primarySourceId: string;
  relatedSourceIds: string[];
  problem: CitedStatement;
  method: CitedStatement;
  evidence: CitedStatement[];
  limitations: CitedStatement[];
  analysis: ReportItemAnalysis;
}

export interface ResearchReport {
  id: string;
  topic: string;
  publishedFrom: string | null;
  publishedTo: string | null;
  searchScope: string;
  generatedAt: string;
  summary: CitedStatement[];
  items: ReportItem[];
  citedSources: EvidenceSource[];
  markdown: string;
}

interface ReportDraftItem {
  name: string;
  primarySourceId: string;
  relatedSourceIds: string[];
  problem: CitedStatement;
  method: CitedStatement;
  evidence: CitedStatement[];
  limitations: CitedStatement[];
  analysis: ReportItemAnalysis;
}

interface ReportDraft {
  summary: CitedStatement[];
  items: ReportDraftItem[];
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} 必須是文字。`);
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f]/.test(text)) {
    throw new Error(`${label} 必須是 1 到 ${maxLength} 個可顯示字元。`);
  }
  return text;
}

function stringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  itemMaxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} 必須包含 ${minimum} 到 ${maximum} 項。`);
  }
  return value.map((item, index) => requiredText(item, `${label}[${index}]`, itemMaxLength));
}

function uniqueSourceIds(value: unknown, label: string, maximum: number): string[] {
  const ids = stringArray(value, label, 0, maximum, 64);
  return [...new Set(ids)];
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必須是物件。`);
  }
  return value as Record<string, unknown>;
}

function optionalIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = requiredText(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} 必須是 YYYY-MM-DD。`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} 不是有效日期。`);
  }
  return date;
}

function citedStatement(
  value: unknown,
  label: string,
  allowedSourceIds: ReadonlySet<string>,
): CitedStatement {
  const object = asObject(value, label);
  const sourceIds = uniqueSourceIds(object.sourceIds, `${label}.sourceIds`, 6);
  if (sourceIds.length === 0) throw new Error(`${label} 至少需要一個來源 ID。`);
  for (const sourceId of sourceIds) {
    if (!allowedSourceIds.has(sourceId)) {
      throw new Error(`${label} 引用了不屬於此報告項目的來源 ID：${sourceId}。`);
    }
  }
  return {
    text: requiredText(object.text, `${label}.text`, 2_000),
    sourceIds,
  };
}

function statementArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  allowedSourceIds: ReadonlySet<string>,
): CitedStatement[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} 必須包含 ${minimum} 到 ${maximum} 項。`);
  }
  return value.map((item, index) =>
    citedStatement(item, `${label}[${index}]`, allowedSourceIds)
  );
}

function validateContext(context: ResearchReportContext): ResearchReportContext {
  const generated = new Date(context.generatedAt);
  if (Number.isNaN(generated.valueOf())) throw new Error('報告產出時間必須是有效時間。');
  if (!Number.isInteger(context.maxItems) || context.maxItems < 1 || context.maxItems > 10) {
    throw new Error('報告項目上限必須是 1 到 10 的整數。');
  }
  const summaryPoints = context.summaryPoints ?? 3;
  if (!Number.isInteger(summaryPoints) || summaryPoints < 1 || summaryPoints > 3) {
    throw new Error('重點摘要數量必須是 1 到 3 的整數。');
  }
  const publishedFrom = optionalIsoDate(context.publishedFrom, '開始日期');
  const publishedTo = optionalIsoDate(context.publishedTo, '結束日期');
  if (publishedFrom && publishedTo && publishedFrom > publishedTo) {
    throw new Error('開始日期不能晚於結束日期。');
  }
  return {
    topic: requiredText(context.topic, '研究主題', 500),
    ...(publishedFrom ? { publishedFrom } : {}),
    ...(publishedTo ? { publishedTo } : {}),
    searchScope: requiredText(context.searchScope, '搜尋範圍', 1_000),
    generatedAt: generated.toISOString(),
    maxItems: context.maxItems,
    summaryPoints,
  };
}

function successfulEvidence(candidate: SearchCandidate, result: ContentReadSuccess): EvidenceSource {
  if (result.sourceId !== candidate.id || result.requestedUrl !== candidate.url) {
    throw new Error(`來源 ${candidate.id} 的讀取結果與候選來源不一致。`);
  }
  if (!result.text.trim()) throw new Error(`來源 ${candidate.id} 沒有可用的已讀內容。`);
  if (!/^[a-f0-9]{64}$/.test(result.contentHash)) {
    throw new Error(`來源 ${candidate.id} 的內容 hash 格式無效。`);
  }
  return {
    id: candidate.id,
    title: candidate.title,
    url: candidate.url,
    authorOrOrganization: candidate.authorOrOrganization,
    publishedDate: candidate.publishedDate,
    updatedDate: candidate.updatedDate,
    sourceType: candidate.sourceType,
    evidenceLevel: result.evidenceLevel ?? candidate.evidenceLevel,
    retrievedAt: result.retrievedAt,
    contentHash: result.contentHash,
    content: result.text,
    contentTruncated: result.textTruncated,
  };
}

export function buildEvidenceBundle(
  candidates: readonly SearchCandidate[],
  records: readonly SourceReadRecord[],
): EvidenceBundle {
  const candidateById = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    if (candidateById.has(candidate.id)) throw new Error(`候選來源 ID 重複：${candidate.id}。`);
    candidateById.set(candidate.id, candidate);
  }

  const seenRecordIds = new Set<string>();
  const sources: EvidenceSource[] = [];
  const failures: EvidenceFailure[] = [];
  for (const record of records) {
    if (seenRecordIds.has(record.sourceId)) throw new Error(`讀取結果來源 ID 重複：${record.sourceId}。`);
    seenRecordIds.add(record.sourceId);
    const candidate = candidateById.get(record.sourceId);
    if (!candidate) throw new Error(`讀取結果找不到候選來源：${record.sourceId}。`);
    if (record.sourceType !== candidate.sourceType) {
      throw new Error(`來源 ${record.sourceId} 的讀取類型與候選來源不一致。`);
    }
    if (record.result.status === 'read') {
      sources.push(successfulEvidence(candidate, record.result));
    } else {
      failures.push({
        sourceId: record.sourceId,
        errorCode: record.result.errorCode,
        errorMessage: record.result.errorMessage,
      });
    }
  }
  return { sources, failures };
}

function validateDraft(
  value: unknown,
  availableSources: ReadonlyMap<string, EvidenceSource>,
  maxItems: number,
  maxSummaryPoints: number,
): ReportDraft {
  const object = asObject(value, '報告草稿');
  if (!Array.isArray(object.items) || object.items.length < 1 || object.items.length > maxItems) {
    throw new Error(`報告項目必須包含 1 到 ${maxItems} 項。`);
  }
  const seenPrimarySources = new Set<string>();
  const availableSourceIds = new Set(availableSources.keys());
  const items = object.items.map((rawItem, index): ReportDraftItem => {
    const item = asObject(rawItem, `報告項目[${index}]`);
    const primarySourceId = requiredText(
      item.primarySourceId, `報告項目[${index}].primarySourceId`, 64,
    );
    if (!availableSources.has(primarySourceId)) {
      throw new Error(`報告項目[${index}] 的主要來源未成功讀取：${primarySourceId}。`);
    }
    if (seenPrimarySources.has(primarySourceId)) {
      throw new Error(`主要來源不可建立多個報告項目：${primarySourceId}。`);
    }
    seenPrimarySources.add(primarySourceId);
    const relatedSourceIds = uniqueSourceIds(
      item.relatedSourceIds ?? [], `報告項目[${index}].relatedSourceIds`, 5,
    );
    for (const sourceId of relatedSourceIds) {
      if (!availableSources.has(sourceId)) {
        throw new Error(`報告項目[${index}] 的相關來源未成功讀取：${sourceId}。`);
      }
    }
    const problem = citedStatement(item.problem, `報告項目[${index}].problem`, availableSourceIds);
    const method = citedStatement(item.method, `報告項目[${index}].method`, availableSourceIds);
    const evidence = statementArray(
      item.evidence, `報告項目[${index}].evidence`, 1, 5, availableSourceIds,
    );
    const limitations = statementArray(
      item.limitations, `報告項目[${index}].limitations`, 0, 5, availableSourceIds,
    );
    const analysisObject = asObject(item.analysis, `報告項目[${index}].analysis`);
    const unverified = stringArray(
      analysisObject.unverified, `報告項目[${index}].analysis.unverified`, 0, 5, 1_000,
    );
    if (unverified.length === 0) {
      const claimedSourceIds = new Set([
        ...problem.sourceIds,
        ...method.sourceIds,
        ...evidence.flatMap((statement) => statement.sourceIds),
        ...limitations.flatMap((statement) => statement.sourceIds),
      ]);
      const hasAbstractOnlyEvidence = [...claimedSourceIds].some(
        (sourceId) => availableSources.get(sourceId)?.evidenceLevel === 'abstract',
      );
      unverified.push(hasAbstractOnlyEvidence
        ? '尚未由本專案重現作者結果；目前證據包含論文摘要，未讀取 PDF 全文。'
        : '尚未由本專案重現作者結果。');
    }
    const analysis: ReportItemAnalysis = {
      applicationValue: requiredText(
        analysisObject.applicationValue, `報告項目[${index}].analysis.applicationValue`, 2_000,
      ),
      smallExperiment: requiredText(
        analysisObject.smallExperiment, `報告項目[${index}].analysis.smallExperiment`, 2_000,
      ),
      unverified,
    };
    const citedIds = new Set([
      ...problem.sourceIds,
      ...method.sourceIds,
      ...evidence.flatMap((statement) => statement.sourceIds),
      ...limitations.flatMap((statement) => statement.sourceIds),
    ]);
    if (!citedIds.has(primarySourceId)) {
      throw new Error(`報告項目[${index}] 的主要來源沒有支持任何項目主張：${primarySourceId}。`);
    }
    const citedRelatedSourceIds = [...citedIds].filter((sourceId) => sourceId !== primarySourceId);
    if (citedRelatedSourceIds.length > 5) {
      throw new Error(`報告項目[${index}] 實際引用的相關來源不可超過 5 個。`);
    }
    return {
      name: requiredText(item.name, `報告項目[${index}].name`, 300),
      primarySourceId,
      relatedSourceIds: citedRelatedSourceIds,
      problem,
      method,
      evidence,
      limitations,
      analysis,
    };
  });
  const summary = statementArray(
    object.summary, '重點摘要', 1, maxSummaryPoints, availableSourceIds,
  );
  return { summary, items };
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function dateRangeLabel(report: Pick<ResearchReport, 'publishedFrom' | 'publishedTo'>): string {
  if (!report.publishedFrom && !report.publishedTo) return '未指定';
  return `${report.publishedFrom ?? '不限'} ～ ${report.publishedTo ?? '不限'}`;
}

function renderStatement(
  label: string,
  statement: CitedStatement,
  citationNumber: ReadonlyMap<string, number>,
  sourceById: ReadonlyMap<string, EvidenceSource>,
): string {
  const citations = statement.sourceIds
    .map((sourceId) =>
      `[來源 ${citationNumber.get(sourceId)}](<${sourceById.get(sourceId)!.url}>)`
    )
    .join('、');
  return `- ${label}：${escapeMarkdown(statement.text)}（${citations}）`;
}

function renderSummary(
  statement: CitedStatement,
  citationNumber: ReadonlyMap<string, number>,
  sourceById: ReadonlyMap<string, EvidenceSource>,
): string {
  const citations = statement.sourceIds
    .map((sourceId) =>
      `[來源 ${citationNumber.get(sourceId)}](<${sourceById.get(sourceId)!.url}>)`
    )
    .join('、');
  return `- ${escapeMarkdown(statement.text)}（${citations}）`;
}

export function renderResearchReportMarkdown(report: Omit<ResearchReport, 'markdown'>): string {
  const citationNumber = new Map(report.citedSources.map((source, index) => [source.id, index + 1]));
  const sourceById = new Map(report.citedSources.map((source) => [source.id, source]));
  const lines = [
    `# ${escapeMarkdown(report.topic)}`,
    '',
    `- 報告 ID：\`${report.id}\``,
    `- 時間範圍：${dateRangeLabel(report)}`,
    `- 產出時間：${report.generatedAt}`,
    `- 搜尋範圍：${escapeMarkdown(report.searchScope)}`,
    '',
    '## 重點摘要（助理整理）',
    '',
    ...report.summary.map((summary) =>
      renderSummary(summary, citationNumber, sourceById)
    ),
  ];

  for (const item of report.items) {
    const primary = sourceById.get(item.primarySourceId)!;
    lines.push(
      '',
      `## ${escapeMarkdown(item.name)}`,
      '',
      `- 項目 ID：\`${item.id}\``,
      `- 日期：${primary.publishedDate ?? '未知'}`,
      `- 主要來源：[${escapeMarkdown(primary.title)}](<${primary.url}>)`,
      '',
      '### 來源中的主張',
      '',
      renderStatement('解決的問題', item.problem, citationNumber, sourceById),
      renderStatement('核心方法與差異', item.method, citationNumber, sourceById),
      ...item.evidence.map((statement) =>
        renderStatement('作者提出的證據', statement, citationNumber, sourceById)
      ),
      ...(item.limitations.length > 0
        ? item.limitations.map((statement) =>
          renderStatement('來源陳述的限制', statement, citationNumber, sourceById)
        )
        : ['- 來源陳述的限制：未從已讀內容取得可引用限制（系統註記，不是來源主張）。']),
      '',
      '### 助理分析（不是來源原文主張）',
      '',
      `- 對 AI 應用／Agent 研究的價值：${escapeMarkdown(item.analysis.applicationValue)}`,
      `- 可進行的小型實驗：${escapeMarkdown(item.analysis.smallExperiment)}`,
      ...item.analysis.unverified.map((value) => `- 尚未驗證：${escapeMarkdown(value)}`),
    );
  }

  lines.push('', '## 原始來源', '');
  for (const [index, source] of report.citedSources.entries()) {
    lines.push(
      `### 來源 ${index + 1}`,
      '',
      `- 標題：[${escapeMarkdown(source.title)}](<${source.url}>)`,
      `- 來源 ID：\`${source.id}\``,
      `- 作者／組織：${escapeMarkdown(source.authorOrOrganization ?? '未知')}`,
      `- 發布日期：${source.publishedDate ?? '未知'}`,
      `- 更新日期：${source.updatedDate ?? '未知'}`,
      `- 來源種類：${source.sourceType}`,
      `- 讀取層級：${source.evidenceLevel === 'abstract'
        ? '僅論文摘要'
        : source.evidenceLevel === 'full_text' ? '論文 HTML 全文' : source.evidenceLevel}`,
      `- 讀取時間：${source.retrievedAt}`,
      `- 讀取狀態：成功${source.contentTruncated ? '（內容因長度限制截斷）' : ''}`,
      '',
    );
  }
  return `${lines.join('\n').trim()}\n`;
}

function markdownTableCell(value: string): string {
  return escapeMarkdown(value).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

export function renderBriefResearchReportMarkdown(
  report: Omit<ResearchReport, 'markdown'>,
): string {
  const citationNumber = new Map(report.citedSources.map((source, index) => [source.id, index + 1]));
  const sourceById = new Map(report.citedSources.map((source) => [source.id, source]));
  const lines = [
    `# ${escapeMarkdown(report.topic)}（短摘要）`,
    '',
    `- 時間範圍：${dateRangeLabel(report)}`,
    `- 產出時間：${report.generatedAt}`,
    `- 搜尋範圍：${escapeMarkdown(report.searchScope)}`,
    '',
    '## 重點',
    '',
    ...report.summary.map((summary) => renderSummary(summary, citationNumber, sourceById)),
    '',
    '## 技術項目',
    '',
    ...report.items.map((item) => {
      const source = sourceById.get(item.primarySourceId)!;
      return `- **${escapeMarkdown(item.name)}**：${escapeMarkdown(item.problem.text)} ` +
        `[原始來源](<${source.url}>)`;
    }),
    '',
    '> 這是已讀證據的精簡重排，沒有重新搜尋或產生新主張。',
  ];
  return `${lines.join('\n').trim()}\n`;
}

export function renderComparisonResearchReportMarkdown(
  report: Omit<ResearchReport, 'markdown'>,
): string {
  const sourceById = new Map(report.citedSources.map((source) => [source.id, source]));
  const lines = [
    `# ${escapeMarkdown(report.topic)}（比較表）`,
    '',
    `- 時間範圍：${dateRangeLabel(report)}`,
    `- 產出時間：${report.generatedAt}`,
    `- 搜尋範圍：${escapeMarkdown(report.searchScope)}`,
    '',
    '| 技術 | 解決問題（來源主張） | 核心方法（來源主張） | 助理分析：應用價值 | 小型實驗 | 來源 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.items.map((item) => {
      const source = sourceById.get(item.primarySourceId)!;
      return `| ${markdownTableCell(item.name)} | ${markdownTableCell(item.problem.text)} | ` +
        `${markdownTableCell(item.method.text)} | ${markdownTableCell(item.analysis.applicationValue)} | ` +
        `${markdownTableCell(item.analysis.smallExperiment)} | ` +
        `[${markdownTableCell(source.title)}](<${source.url}>) |`;
    }),
    '',
    '> 「來源主張」與「助理分析」保持分欄；本表只重排已讀證據。',
  ];
  return `${lines.join('\n').trim()}\n`;
}

export function rewriteResearchReport(
  report: ResearchReport,
  format: 'brief' | 'detailed' | 'comparison_table',
): ResearchReport {
  const withoutMarkdown: Omit<ResearchReport, 'markdown'> = {
    id: report.id,
    topic: report.topic,
    publishedFrom: report.publishedFrom,
    publishedTo: report.publishedTo,
    searchScope: report.searchScope,
    generatedAt: report.generatedAt,
    summary: report.summary,
    items: report.items,
    citedSources: report.citedSources,
  };
  const markdown = format === 'brief'
    ? renderBriefResearchReportMarkdown(withoutMarkdown)
    : format === 'comparison_table'
      ? renderComparisonResearchReportMarkdown(withoutMarkdown)
      : renderResearchReportMarkdown(withoutMarkdown);
  return { ...report, markdown };
}

export function finalizeResearchReport(
  contextInput: ResearchReportContext,
  evidence: EvidenceBundle,
  draftInput: unknown,
): ResearchReport {
  const context = validateContext(contextInput);
  const sourceById = new Map(evidence.sources.map((source) => [source.id, source]));
  if (sourceById.size !== evidence.sources.length) throw new Error('證據來源 ID 不可重複。');
  const draft = validateDraft(
    draftInput, sourceById, context.maxItems, context.summaryPoints ?? 3,
  );
  const items: ReportItem[] = draft.items.map((item, index) => ({
    id: `item_${String(index + 1).padStart(2, '0')}`,
    ...item,
  }));
  const citedSourceIds: string[] = [];
  const seenCitedSourceIds = new Set<string>();
  for (const item of items) {
    for (const sourceId of [item.primarySourceId, ...item.relatedSourceIds]) {
      if (!seenCitedSourceIds.has(sourceId)) {
        seenCitedSourceIds.add(sourceId);
        citedSourceIds.push(sourceId);
      }
    }
  }
  for (const statement of draft.summary) {
    for (const sourceId of statement.sourceIds) {
      if (!seenCitedSourceIds.has(sourceId)) {
        seenCitedSourceIds.add(sourceId);
        citedSourceIds.push(sourceId);
      }
    }
  }
  const id = `rpt_${createHash('sha256')
    .update(`${context.generatedAt}\n${context.topic}\n${citedSourceIds.join('\n')}`)
    .digest('hex').slice(0, 20)}`;
  const withoutMarkdown: Omit<ResearchReport, 'markdown'> = {
    id,
    topic: context.topic,
    publishedFrom: context.publishedFrom ?? null,
    publishedTo: context.publishedTo ?? null,
    searchScope: context.searchScope,
    generatedAt: context.generatedAt,
    summary: draft.summary,
    items,
    citedSources: citedSourceIds.map((sourceId) => sourceById.get(sourceId)!),
  };
  return {
    ...withoutMarkdown,
    markdown: renderResearchReportMarkdown(withoutMarkdown),
  };
}
