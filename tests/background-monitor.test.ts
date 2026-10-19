import { describe, expect, it } from 'vitest';
import {
  isMonitoringRuleDue,
  buildMonitoringSearchRequest,
  nextMonitoringRunAt,
  shouldDeliverMonitoringDigest,
  validateMonitoringRuleInput,
} from '../electron/research/background-monitor.js';

describe('background monitoring rules', () => {
  const input = {
    id: 'ai_updates', name: 'AI 新技術', query: 'AI Agent RAG LLM Evaluation',
    enabled: true, intervalHours: 24, lookbackDays: 7, maxItems: 3, autoBrief: false,
    digestHourLocal: 9,
  };

  it('validates bounded settings and computes the next UTC run', () => {
    expect(validateMonitoringRuleInput(input)).toEqual(input);
    expect(nextMonitoringRunAt('2026-10-04T01:30:00.000Z', 24))
      .toBe('2026-10-05T01:30:00.000Z');
  });

  it('detects due rules without treating disabled rules as due', () => {
    const rule = {
      ...input, createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z', lastSucceededAt: null,
      nextRunAt: '2026-10-04T01:00:00.000Z', lastDigestAt: null,
    };
    expect(isMonitoringRuleDue(rule, '2026-10-04T01:00:00.000Z')).toBe(true);
    expect(isMonitoringRuleDue({ ...rule, enabled: false }, '2026-10-05T00:00:00.000Z'))
      .toBe(false);
  });

  it('rejects schedules that could create uncontrolled background work', () => {
    expect(() => validateMonitoringRuleInput({ ...input, intervalHours: 0 }))
      .toThrow('1 到 168');
    expect(() => validateMonitoringRuleInput({ ...input, maxItems: 4 }))
      .toThrow('1 到 3');
    expect(() => validateMonitoringRuleInput({ ...input, digestHourLocal: 24 }))
      .toThrow('0 到 23');
  });

  it('uses the later of the lookback boundary and last successful date', () => {
    const rule = {
      ...input, createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastSucceededAt: '2026-10-03T22:00:00.000Z',
      nextRunAt: '2026-10-04T22:00:00.000Z',
      lastDigestAt: null,
    };
    expect(buildMonitoringSearchRequest(rule, '2026-10-04T23:00:00.000Z')).toMatchObject({
      query: input.query,
      maxResults: 12,
      publishedFrom: '2026-10-03',
      publishedTo: '2026-10-04',
    });
  });

  it('delivers once after the local digest hour and catches up after a late start', () => {
    const rule = {
      ...input, createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z', lastSucceededAt: null,
      nextRunAt: '2026-10-06T00:00:00.000Z', lastDigestAt: null,
    };
    const before = new Date(2026, 9, 6, 8, 59);
    const lateStart = new Date(2026, 9, 6, 14, 30);
    expect(shouldDeliverMonitoringDigest(rule, before)).toBe(false);
    expect(shouldDeliverMonitoringDigest(rule, lateStart)).toBe(true);
    expect(shouldDeliverMonitoringDigest({
      ...rule, lastDigestAt: lateStart.toISOString(),
    }, new Date(2026, 9, 6, 18, 0))).toBe(false);
    expect(shouldDeliverMonitoringDigest({
      ...rule, lastDigestAt: lateStart.toISOString(),
    }, new Date(2026, 9, 7, 9, 0))).toBe(true);
  });
});
