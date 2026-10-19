import { describe, expect, it } from 'vitest';
import {
  MonitoringItemSearchProvider,
  monitoringResearchTask,
} from '../electron/research/monitoring-research.js';
import type { MonitoringInboxItem } from '../electron/research/research-store.js';
import { normalizeSearchCandidate } from '../electron/research/search-provider.js';

function inboxItem(): MonitoringInboxItem {
  const candidate = normalizeSearchCandidate({
    title: 'Exact monitored paper',
    url: 'https://arxiv.org/abs/2610.99999',
    authorOrOrganization: 'Example Lab',
    publishedDate: '2026-10-05',
    sourceType: 'paper',
    evidenceLevel: 'abstract',
    excerpt: 'The exact abstract that was saved by monitoring.',
  }, 'arxiv', '2026-10-06T00:00:00.000Z');
  return {
    ruleId: 'ai_updates',
    sourceId: candidate.id,
    status: 'new',
    firstSeenAt: '2026-10-06T00:00:00.000Z',
    candidate,
    brief: null,
    briefedAt: null,
    briefModelSlug: null,
    feedback: 'worth_investigating',
    feedbackAt: '2026-10-06T00:01:00.000Z',
    linkedReportId: null,
    notifiedAt: null,
  };
}

describe('monitoring item deep research', () => {
  it('locks the search provider to the selected saved source', async () => {
    const item = inboxItem();
    const provider = new MonitoringItemSearchProvider(item);
    const results = await provider.search({
      query: 'a different query cannot replace the source',
      maxResults: 1,
    }, new AbortController().signal);
    expect(results).toEqual([expect.objectContaining({
      title: item.candidate.title,
      url: item.candidate.url,
      excerpt: item.candidate.excerpt,
    })]);
  });

  it('creates a single-item detailed task without a date guess', () => {
    const task = monitoringResearchTask(inboxItem());
    expect(task).toMatchObject({
      topic: 'Exact monitored paper',
      publicationDateMode: 'any',
      maxItems: 1,
      reportFormat: 'detailed',
      publishedFrom: null,
      publishedTo: null,
    });
  });
});
