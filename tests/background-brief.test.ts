import { describe, expect, it, vi } from 'vitest';
import { generateBackgroundBriefs } from '../electron/research/background-brief.js';
import type { MonitoringRule } from '../electron/research/background-monitor.js';
import type { MonitoringInboxItem } from '../electron/research/research-store.js';
import { normalizeSearchCandidate } from '../electron/research/search-provider.js';

const rule: MonitoringRule = {
  id: 'ai_updates', name: 'AI updates', query: 'AI Agent', enabled: true,
  intervalHours: 24, lookbackDays: 7, maxItems: 2, autoBrief: true,
  createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
  lastSucceededAt: null, nextRunAt: '2026-10-04T00:00:00.000Z',
  digestHourLocal: 9, lastDigestAt: null,
};
const item = (number: number): MonitoringInboxItem => {
  const candidate = normalizeSearchCandidate({
    title: `Paper ${number}`, url: `https://arxiv.org/abs/2610.0000${number}`,
    publishedDate: '2026-10-04', sourceType: 'paper', evidenceLevel: 'abstract',
    excerpt: `Abstract ${number}.`,
  }, 'arxiv', '2026-10-04T00:00:00.000Z');
  return {
    ruleId: rule.id, sourceId: candidate.id, status: 'new',
    firstSeenAt: '2026-10-04T00:00:00.000Z', candidate,
    brief: null, briefedAt: null, briefModelSlug: null,
    feedback: null, feedbackAt: null, linkedReportId: null,
    notifiedAt: null,
  };
};

describe('background technology briefs', () => {
  it('generates one concise structured brief per allowed source', async () => {
    const items = [item(1), item(2)];
    const streamResponse = vi.fn().mockResolvedValue({ text: JSON.stringify({
      briefs: items.map(({ sourceId }, index) => ({
        sourceId, problem: `Problem ${index}`, coreMethod: `Method ${index}`,
        workValue: `Value ${index}`, unverified: ['Abstract-only evidence.'],
      })),
    }) });
    const result = await generateBackgroundBriefs(
      { streamResponse }, 'gpt-5.6-luna', rule, items, new AbortController().signal,
    );
    expect(result).toHaveLength(2);
    expect(streamResponse).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-luna', textFormat: expect.objectContaining({ strict: true }),
    }));
  });

  it('rejects missing or unallowlisted source IDs', async () => {
    const items = [item(1), item(2)];
    await expect(generateBackgroundBriefs({
      streamResponse: vi.fn().mockResolvedValue({ text: JSON.stringify({ briefs: [{
        sourceId: 'src_00000000000000000000', problem: 'p', coreMethod: 'm',
        workValue: 'v', unverified: ['u'],
      }] }) }),
    }, 'gpt-5.6-luna', rule, items, new AbortController().signal))
      .rejects.toThrow('數量與輸入來源不一致');
  });
});
