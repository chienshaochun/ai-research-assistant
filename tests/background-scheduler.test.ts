import { describe, expect, it, vi } from 'vitest';
import { BackgroundMonitorScheduler } from '../electron/research/background-scheduler.js';
import type { BackgroundDiscoveryResult } from '../electron/research/background-discovery.js';
import type { MonitoringRule } from '../electron/research/background-monitor.js';

const rule = (id: string): MonitoringRule => ({
  id, name: id, query: 'AI Agent', enabled: true, intervalHours: 24,
  lookbackDays: 7, maxItems: 3, autoBrief: false,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  lastSucceededAt: null, nextRunAt: '2026-10-04T00:00:00.000Z',
  digestHourLocal: 9, lastDigestAt: null,
});

function result(value: MonitoringRule): BackgroundDiscoveryResult {
  return {
    rule: value, newItems: [], search: {
      status: 'completed', providerId: 'fixture', scopeDescription: 'Fixture',
      request: { query: value.query, maxResults: 12 },
      startedAt: '2026-10-04T00:00:00.000Z',
      completedAt: '2026-10-04T00:00:01.000Z', rawCandidateCount: 0,
      processedCandidateCount: 0, rawLimitReached: false, candidates: [],
      supplementaryCandidates: [], merges: [], exclusions: [],
    },
  };
}

describe('background monitor scheduler', () => {
  it('runs due rules sequentially and reports per-rule failures without stopping the batch', async () => {
    const first = rule('first');
    const second = rule('second');
    const events: string[] = [];
    const onError = vi.fn();
    const scheduler = new BackgroundMonitorScheduler({
      listDueRules: () => [first, second],
      async runRule(current) {
        events.push(`start:${current.id}`);
        if (current.id === 'first') throw new Error('temporary');
        events.push(`finish:${current.id}`);
        return result(current);
      },
      onError,
    });

    await expect(scheduler.tick()).resolves.toBe(true);
    expect(events).toEqual(['start:first', 'start:second', 'finish:second']);
    expect(onError).toHaveBeenCalledWith(first, expect.any(Error));
  });

  it('skips overlapping ticks and yields to foreground work', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const current = rule('one');
    const runRule = vi.fn(async () => {
      await blocked;
      return result(current);
    });
    let foregroundBusy = false;
    const scheduler = new BackgroundMonitorScheduler({
      listDueRules: () => [current], runRule, canRun: () => !foregroundBusy,
    });

    const firstTick = scheduler.tick();
    expect(scheduler.active).toBe(true);
    await expect(scheduler.tick()).resolves.toBe(false);
    release();
    await expect(firstTick).resolves.toBe(true);
    foregroundBusy = true;
    await expect(scheduler.tick()).resolves.toBe(false);
    expect(runRule).toHaveBeenCalledTimes(1);
  });

  it('aborts an active rule when stopped', async () => {
    const current = rule('one');
    const scheduler = new BackgroundMonitorScheduler({
      listDueRules: () => [current],
      runRule: (_rule, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const running = scheduler.tick();
    scheduler.stop();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.active).toBe(false);
  });

  it('runs the digest tick even when no search rule is due', async () => {
    const onTick = vi.fn();
    const scheduler = new BackgroundMonitorScheduler({
      listDueRules: () => [],
      runRule: vi.fn(),
      onTick,
      now: () => new Date('2026-10-06T01:00:00.000Z'),
    });
    await expect(scheduler.tick()).resolves.toBe(true);
    expect(onTick).toHaveBeenCalledWith('2026-10-06T01:00:00.000Z');
  });
});
