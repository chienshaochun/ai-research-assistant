import type { CitedStatement, ResearchReport } from './report.js';

export interface EvaluationClaim {
  id: string;
  section: string;
  text: string;
  sourceIds: string[];
}

export const CITATION_SUPPORT_LABELS = [
  'supported', 'partially_supported', 'unsupported', 'unclear',
] as const;
export type CitationSupportLabel = typeof CITATION_SUPPORT_LABELS[number];

export interface CitationEvaluationSummary {
  reportId: string;
  total: number;
  evaluated: number;
  unlabeled: number;
  counts: Record<CitationSupportLabel, number>;
  strictSupportedRate: number | null;
  supportedOrPartialRate: number | null;
  annotations: CitationEvaluationAnnotation[];
}

export interface CitationEvaluationAnnotation {
  claimId: string;
  label: CitationSupportLabel | null;
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]])/g, '\\$1');
}

function claim(
  id: string,
  section: string,
  statement: CitedStatement,
): EvaluationClaim {
  return { id, section, text: statement.text, sourceIds: [...statement.sourceIds] };
}

export function listEvaluationClaims(report: ResearchReport): EvaluationClaim[] {
  const claims = report.summary.map((statement, index) => claim(
    `summary_${String(index + 1).padStart(2, '0')}`,
    '重點摘要',
    statement,
  ));
  for (const item of report.items) {
    claims.push(claim(`${item.id}.problem`, `${item.id} 解決問題`, item.problem));
    claims.push(claim(`${item.id}.method`, `${item.id} 核心方法`, item.method));
    item.evidence.forEach((statement, index) => claims.push(claim(
      `${item.id}.evidence_${String(index + 1).padStart(2, '0')}`,
      `${item.id} 作者證據`,
      statement,
    )));
    item.limitations.forEach((statement, index) => claims.push(claim(
      `${item.id}.limitation_${String(index + 1).padStart(2, '0')}`,
      `${item.id} 來源限制`,
      statement,
    )));
  }
  return claims;
}

export function buildEvaluationWorksheet(report: ResearchReport): string {
  const sourceById = new Map(report.citedSources.map((source) => [source.id, source]));
  const claims = listEvaluationClaims(report);
  for (const item of claims) {
    for (const sourceId of item.sourceIds) {
      if (!sourceById.has(sourceId)) {
        throw new Error(`評估主張 ${item.id} 找不到來源 ${sourceId}。`);
      }
    }
  }
  const lines = [
    '# 研究報告 citation support 人工評估工作表',
    '',
    `- 報告 ID：\`${report.id}\``,
    `- 主題：${escapeMarkdown(report.topic)}`,
    `- 報告產出時間：${report.generatedAt}`,
    `- 待評估來源主張：${claims.length}`,
    '',
    '> 這份工作表尚未包含評估結果。請只根據下方「當次保存的證據」標註，不要根據記憶或目前外部頁面的新增內容。',
    '',
    '## 標註準則',
    '',
    '- **supported**：保存的來源文字直接支持完整主張。',
    '- **partially_supported**：只支持主張的一部分，或主張強度高於證據。',
    '- **unsupported**：保存的來源文字沒有支持，或與主張矛盾。',
    '- **unclear**：摘要級證據不足以判斷；不要自行補推論。',
    '',
    '## 主張',
    '',
  ];
  for (const item of claims) {
    lines.push(
      `### ${item.id} · ${escapeMarkdown(item.section)}`,
      '',
      `- 主張：${escapeMarkdown(item.text)}`,
      `- 來源 ID：${item.sourceIds.map((id) => `\`${id}\``).join('、')}`,
      '- 標註：[ ] supported　[ ] partially_supported　[ ] unsupported　[ ] unclear',
      '- 最小支持／反證片段：',
      '- 判斷備註：',
      '',
    );
  }
  lines.push('## 當次保存的證據', '');
  for (const source of report.citedSources) {
    lines.push(
      `### ${source.id} · ${escapeMarkdown(source.title)}`,
      '',
      `- 原始來源：[開啟](<${source.url}>)`,
      `- 證據層級：${source.evidenceLevel}`,
      `- 發布日期：${source.publishedDate ?? '未知'}`,
      `- 擷取時間：${source.retrievedAt}`,
      `- 內容 hash：\`${source.contentHash}\``,
      '',
      ...source.content.split(/\r?\n/).map((line) => `> ${escapeMarkdown(line)}`),
      '',
    );
  }
  return `${lines.join('\n').trim()}\n`;
}

export function summarizeEvaluationWorksheet(
  report: ResearchReport,
  markdown: string,
): CitationEvaluationSummary {
  if (!markdown || markdown.length > 2_000_000 || /\u0000/.test(markdown)) {
    throw new Error('評估工作表必須是 1 到 2,000,000 個字元且不含 NUL。');
  }
  const reportIdMatch = markdown.match(/^- 報告 ID：`([^`]+)`\s*$/m);
  if (!reportIdMatch || reportIdMatch[1] !== report.id) {
    throw new Error('評估工作表的報告 ID 與目前報告不一致。');
  }
  const claimsStart = markdown.indexOf('## 主張');
  const evidenceStart = markdown.indexOf('## 當次保存的證據');
  if (claimsStart < 0 || evidenceStart <= claimsStart) {
    throw new Error('評估工作表缺少主張或證據區段。');
  }

  const sections = new Map<string, string[]>();
  let currentId: string | undefined;
  for (const line of markdown.slice(claimsStart, evidenceStart).split(/\r?\n/)) {
    const heading = line.match(/^### ([A-Za-z0-9_.-]+) ·/);
    if (heading) {
      currentId = heading[1];
      if (sections.has(currentId)) throw new Error(`評估主張 ${currentId} 重複。`);
      sections.set(currentId, []);
    } else if (currentId) {
      sections.get(currentId)!.push(line);
    }
  }

  const claims = listEvaluationClaims(report);
  const expectedIds = new Set(claims.map(({ id }) => id));
  for (const id of sections.keys()) {
    if (!expectedIds.has(id)) throw new Error(`評估工作表包含未知主張 ${id}。`);
  }
  const counts: Record<CitationSupportLabel, number> = {
    supported: 0,
    partially_supported: 0,
    unsupported: 0,
    unclear: 0,
  };
  let unlabeled = 0;
  const annotations: CitationEvaluationAnnotation[] = [];
  for (const claimItem of claims) {
    const lines = sections.get(claimItem.id);
    if (!lines) throw new Error(`評估工作表缺少主張 ${claimItem.id}。`);
    const labelLine = lines.find((line) => line.startsWith('- 標註：'));
    if (!labelLine) throw new Error(`評估主張 ${claimItem.id} 缺少標註欄。`);
    const checkboxes = [...labelLine.matchAll(
      /\[([ xX])\]\s*(supported|partially_supported|unsupported|unclear)/g,
    )];
    if (checkboxes.length !== CITATION_SUPPORT_LABELS.length ||
        new Set(checkboxes.map((match) => match[2])).size !== CITATION_SUPPORT_LABELS.length) {
      throw new Error(`評估主張 ${claimItem.id} 的標註選項格式無效。`);
    }
    const selected = checkboxes.filter((match) => match[1].toLowerCase() === 'x');
    if (selected.length > 1) throw new Error(`評估主張 ${claimItem.id} 只能勾選一個標籤。`);
    if (selected.length === 0) {
      unlabeled += 1;
      annotations.push({ claimId: claimItem.id, label: null });
    } else {
      const label = selected[0][2] as CitationSupportLabel;
      counts[label] += 1;
      annotations.push({ claimId: claimItem.id, label });
    }
  }
  const evaluated = claims.length - unlabeled;
  return {
    reportId: report.id,
    total: claims.length,
    evaluated,
    unlabeled,
    counts,
    strictSupportedRate: evaluated === 0 ? null : counts.supported / evaluated,
    supportedOrPartialRate: evaluated === 0
      ? null
      : (counts.supported + counts.partially_supported) / evaluated,
    annotations,
  };
}
