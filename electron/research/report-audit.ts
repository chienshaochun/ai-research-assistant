import type { PublicReportAudit } from '../../shared.js';
import type { CitedStatement, ResearchReport } from './report.js';

export interface NumericGroundingIssue {
  label: string;
  unsupportedTokens: string[];
}

function asciiDigits(value: string): string {
  return value
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/\\times|×|倍|\b(?:times?|fold)\b/giu, 'x')
    .replace(/％|\bpercent(?:age)?\b/giu, '%');
}

function canonicalNumericToken(token: string): string {
  const compact = token.toLocaleLowerCase('en-US').replace(/[\s,]/g, '');
  const match = compact.match(/^(\d+(?:\.\d+)?)([%xkmb])?$/i);
  if (!match) return compact;
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? '';
  const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 :
    unit === 'b' ? 1_000_000_000 : 1;
  const normalizedValue = Number.isFinite(value) ? String(value * multiplier) : match[1];
  return `${normalizedValue}${unit === '%' || unit === 'x' ? unit : ''}`;
}

export function numericClaimTokens(value: string): string[] {
  const matches = asciiDigits(value).match(
    /\d[\d,]*(?:\.\d+)?(?:\s*(?:%|x)|[kmb])?/giu,
  ) ?? [];
  return [...new Set(matches.map(canonicalNumericToken))].filter(Boolean);
}

export function unsupportedNumericTokens(
  statement: CitedStatement,
  sourceContentById: ReadonlyMap<string, string>,
): string[] {
  const claimTokens = numericClaimTokens(statement.text);
  if (claimTokens.length === 0) return [];
  const sourceTokens = new Set(statement.sourceIds.flatMap((sourceId) =>
    numericClaimTokens(sourceContentById.get(sourceId) ?? '')));
  return claimTokens.filter((token) => !sourceTokens.has(token));
}

function collectStatement(
  statement: CitedStatement,
  allowedSourceIds: ReadonlySet<string>,
  label: string,
): number {
  if (!statement.text.trim()) throw new Error(`${label} 沒有可稽核的文字。`);
  if (statement.sourceIds.length < 1 ||
      new Set(statement.sourceIds).size !== statement.sourceIds.length) {
    throw new Error(`${label} 的引用為空或重複。`);
  }
  for (const sourceId of statement.sourceIds) {
    if (!allowedSourceIds.has(sourceId)) {
      throw new Error(`${label} 引用了超出範圍的來源：${sourceId}。`);
    }
  }
  return statement.sourceIds.length;
}

function insideRange(
  publishedDate: string,
  from: string | null,
  to: string | null,
): boolean {
  return (!from || publishedDate >= from) && (!to || publishedDate <= to);
}

export function auditResearchReport(report: ResearchReport): PublicReportAudit {
  const sourceIds = new Set(report.citedSources.map(({ id }) => id));
  if (sourceIds.size !== report.citedSources.length) {
    throw new Error('無法稽核來源 ID 重複的報告。');
  }
  let sourceClaimCount = 0;
  let citationReferenceCount = 0;
  let numericClaimCount = 0;
  const numericGroundingIssues: NumericGroundingIssue[] = [];
  const sourceContentById = new Map(report.citedSources.map((source) => [
    source.id, `${source.title}\n${source.content}`,
  ]));
  const add = (
    statement: CitedStatement,
    allowed: ReadonlySet<string>,
    label: string,
  ) => {
    citationReferenceCount += collectStatement(statement, allowed, label);
    sourceClaimCount += 1;
    if (numericClaimTokens(statement.text).length > 0) {
      numericClaimCount += 1;
      const unsupportedTokens = unsupportedNumericTokens(statement, sourceContentById);
      if (unsupportedTokens.length > 0) {
        numericGroundingIssues.push({ label, unsupportedTokens });
      }
    }
  };
  report.summary.forEach((statement, index) => add(statement, sourceIds, `摘要[${index}]`));
  for (const item of report.items) {
    const allowed = new Set([item.primarySourceId, ...item.relatedSourceIds]);
    add(item.problem, allowed, `${item.id} 問題`);
    add(item.method, allowed, `${item.id} 方法`);
    item.evidence.forEach((statement, index) =>
      add(statement, allowed, `${item.id} 證據[${index}]`)
    );
    item.limitations.forEach((statement, index) =>
      add(statement, allowed, `${item.id} 限制[${index}]`)
    );
  }

  const knownPublicationDateCount = report.citedSources.filter(
    ({ publishedDate }) => publishedDate !== null,
  ).length;
  const unknownPublicationDateCount = report.citedSources.length - knownPublicationDateCount;
  const outsideDateRangeSourceCount = report.citedSources.filter(({ publishedDate }) =>
    publishedDate !== null && !insideRange(
      publishedDate, report.publishedFrom, report.publishedTo,
    )
  ).length;
  const abstractOnlySourceCount = report.citedSources.filter(
    ({ evidenceLevel }) => evidenceLevel === 'abstract',
  ).length;
  const fullTextSourceCount = report.citedSources.filter(
    ({ evidenceLevel }) => evidenceLevel === 'full_text',
  ).length;
  const truncatedSourceCount = report.citedSources.filter(
    ({ contentTruncated }) => contentTruncated,
  ).length;
  const warnings: string[] = [];
  if (abstractOnlySourceCount > 0) {
    warnings.push(`${abstractOnlySourceCount} 個來源只有摘要級證據。`);
  }
  if (unknownPublicationDateCount > 0) {
    warnings.push(`${unknownPublicationDateCount} 個引用來源缺少發布日期。`);
  }
  if (outsideDateRangeSourceCount > 0) {
    warnings.push(`${outsideDateRangeSourceCount} 個引用來源超出指定發布日期範圍。`);
  }
  if (truncatedSourceCount > 0) {
    warnings.push(`${truncatedSourceCount} 個來源內容在讀取階段被截斷。`);
  }
  if (numericGroundingIssues.length > 0) {
    const examples = numericGroundingIssues.slice(0, 3)
      .map(({ label, unsupportedTokens }) => `${label}：${unsupportedTokens.join('、')}`)
      .join('；');
    warnings.push(
      `${numericGroundingIssues.length} 條來源主張含引用內容未出現的精確數值，需人工核對（${examples}）。`,
    );
  }
  warnings.push('引用結構已驗證；主張是否在語意上獲來源支持仍需評估。');

  return {
    sourceClaimCount,
    citationReferenceCount,
    citedSourceCount: report.citedSources.length,
    knownPublicationDateCount,
    unknownPublicationDateCount,
    outsideDateRangeSourceCount,
    abstractOnlySourceCount,
    fullTextSourceCount,
    truncatedSourceCount,
    numericClaimCount,
    numericGroundingWarningCount: numericGroundingIssues.length,
    numericGroundingIssues,
    structuralCitationStatus: 'passed',
    semanticSupportStatus: 'not_evaluated',
    warnings,
  };
}
