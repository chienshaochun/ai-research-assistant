import { describe, expect, it, vi } from 'vitest';
import { runBackgroundDiscovery } from '../electron/research/background-discovery.js';
import { ResearchStore } from '../electron/research/research-store.js';
import type { SearchProvider } from '../electron/research/search-provider.js';

function configuredStore() {
  const store = new ResearchStore(':memory:');
  const rule = store.upsertMonitoringRule({
    id: 'ai_updates', name: 'AI 新技術', query: 'AI Agent RAG', enabled: true,
    intervalHours: 24, lookbackDays: 7, maxItems: 3, autoBrief: false,
  }, '2026-10-04T01:00:00.000Z');
  return { store, rule };
}

describe('background discovery', () => {
  it('records only newly seen candidates and advances the schedule without a model', async () => {
    const { store, rule } = configuredStore();
    const search = vi.fn<SearchProvider['search']>().mockResolvedValue([{
      title: 'New Agent Paper', url: 'https://arxiv.org/abs/2610.12345',
      authorOrOrganization: 'Example Lab', publishedDate: '2026-10-04',
      updatedDate: null, sourceType: 'paper', evidenceLevel: 'abstract',
      excerpt: 'A new agent method.',
    }]);
    const provider = {
      id: 'arxiv-fixture', scopeDescription: 'Fixture arXiv',
      publicationDateSupport: 'verified' as const, search,
    };
    const times = [
      new Date('2026-10-04T01:00:00.000Z'),
      new Date('2026-10-04T01:00:01.000Z'),
      new Date('2026-10-04T01:00:02.000Z'),
      new Date('2026-10-04T01:00:03.000Z'),
    ];
    const now = () => times.shift() ?? new Date('2026-10-04T01:00:03.000Z');

    const first = await runBackgroundDiscovery(
      provider, store, rule, new AbortController().signal, { now },
    );
    expect(search).toHaveBeenCalledTimes(1);
    expect(first.newItems).toHaveLength(1);
    expect(first.rule.nextRunAt).toBe('2026-10-05T01:00:03.000Z');

    const second = await runBackgroundDiscovery(
      provider, store, first.rule, new AbortController().signal,
      { now: () => new Date('2026-10-05T01:00:03.000Z') },
    );
    expect(second.newItems).toEqual([]);
    expect(store.listMonitoringInbox(rule.id)).toHaveLength(1);
    store.close();
  });

  it('defers a failed rule by one hour to prevent a tight retry loop', async () => {
    const { store, rule } = configuredStore();
    const provider = {
      id: 'failing-fixture', scopeDescription: 'Fixture',
      publicationDateSupport: 'verified' as const,
      async search() { throw new Error('Temporary failure'); },
    };
    await expect(runBackgroundDiscovery(
      provider, store, rule, new AbortController().signal,
      { now: () => new Date('2026-10-04T02:00:00.000Z') },
    )).rejects.toThrow('Temporary failure');
    expect(store.getMonitoringRule(rule.id)?.nextRunAt).toBe('2026-10-04T03:00:00.000Z');
    store.close();
  });
});
