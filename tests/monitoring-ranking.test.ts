import { describe, expect, it } from 'vitest';
import type { MonitoringRule } from '../electron/research/background-monitor.js';
import { monitoringTokens, rankMonitoringItems } from '../electron/research/monitoring-ranking.js';
import type { MonitoringInboxItem } from '../electron/research/research-store.js';
import { normalizeSearchCandidate } from '../electron/research/search-provider.js';

const rule: MonitoringRule = {
  id: 'ai_updates',
  name: 'AI 新技術',
  query: 'AI Agent RAG LLM Evaluation',
  enabled: true,
  intervalHours: 24,
  lookbackDays: 7,
  maxItems: 3,
  autoBrief: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastSucceededAt: null,
  nextRunAt: '2026-10-06T00:00:00.000Z',
  digestHourLocal: 9,
  lastDigestAt: null,
};

function item(
  suffix: string,
  title: string,
  excerpt: string,
  feedback: MonitoringInboxItem['feedback'] = null,
): MonitoringInboxItem {
  const candidate = normalizeSearchCandidate({
    title,
    url: `https://arxiv.org/abs/2610.0000${suffix}`,
    authorOrOrganization: 'Researcher',
    publishedDate: '2026-10-05',
    sourceType: 'paper',
    evidenceLevel: 'abstract',
    excerpt,
  }, 'arxiv', '2026-10-06T00:00:00.000Z');
  return {
    ruleId: rule.id,
    sourceId: candidate.id,
    status: 'new',
    firstSeenAt: '2026-10-06T00:00:00.000Z',
    candidate,
    brief: null,
    briefedAt: null,
    briefModelSlug: null,
    feedback,
    feedbackAt: feedback ? '2026-10-06T00:00:00.000Z' : null,
    linkedReportId: null,
    notifiedAt: null,
  };
}

describe('monitoring feedback ranking', () => {
  it('tokenizes English terms and Chinese bigrams deterministically', () => {
    expect(monitoringTokens('Agent 評估方法 Agent')).toEqual(['評估', '估方', '方法']);
  });

  it('raises a new candidate similar to explicitly useful history', () => {
    const useful = item('1', 'Graph memory for tool agents', 'persistent graph planning',
      'worth_investigating');
    const related = item('2', 'Graph planning for RAG agents', 'persistent graph retrieval');
    const generic = item('3', 'RAG benchmark', 'evaluation dataset');
    const ranked = rankMonitoringItems(rule, [generic, related], [useful],
      new Date('2026-10-06T12:00:00.000Z'));
    expect(ranked.map(({ item: entry }) => entry.sourceId)).toEqual([
      related.sourceId, generic.sourceId,
    ]);
    expect(ranked[0].reasons).toContain('接近過去標為值得深入的內容');
  });

  it('lowers a candidate similar to explicit negative feedback', () => {
    const rejected = item('4', 'Legal agent benchmark', 'legal question answering',
      'not_relevant');
    const similar = item('5', 'Legal RAG agent', 'legal question answering benchmark');
    const preferred = item('6', 'Production RAG evaluation', 'retrieval metrics');
    const ranked = rankMonitoringItems(rule, [similar, preferred], [rejected],
      new Date('2026-10-06T12:00:00.000Z'));
    expect(ranked.at(-1)?.item.sourceId).toBe(similar.sourceId);
  });

  it('keeps stable source-id order when all signals tie', () => {
    const left = item('7', 'Unrelated alpha', 'nothing');
    const right = item('8', 'Unrelated beta', 'nothing');
    const ranked = rankMonitoringItems(
      { ...rule, query: 'unmatched' },
      [right, left],
      [],
      new Date('2027-01-01T00:00:00.000Z'),
    );
    expect(ranked.map(({ item: entry }) => entry.sourceId)).toEqual(
      [left.sourceId, right.sourceId].sort(),
    );
  });
});
