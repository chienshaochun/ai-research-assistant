import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ResearchStore } from '../electron/research/research-store.js';

const enabled = process.env.RUN_MONITORING_PRODUCTION_E2E === '1';
const suite = enabled ? describe : describe.skip;
const dedupEnabled = process.env.RUN_MONITORING_DEDUP_E2E === '1';
const dedupSuite = dedupEnabled ? describe : describe.skip;

function productionDatabasePath(): string {
  if (process.env.AI_RESEARCH_ASSISTANT_PRODUCTION_DB) {
    return process.env.AI_RESEARCH_ASSISTANT_PRODUCTION_DB;
  }
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('APPDATA is unavailable.');
  return join(appData, 'AI Research Assistant', 'research.sqlite');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

suite('production background monitoring acceptance', () => {
  it('lets the running app discover, deduplicate, and save a Luna brief', async () => {
    const path = productionDatabasePath();
    if (!existsSync(path)) throw new Error(`Production database does not exist: ${path}`);

    const setupStore = new ResearchStore(path);
    const previous = setupStore.getMonitoringRule('ai_updates');
    const previousSuccess = previous?.lastSucceededAt ?? null;
    const previousItems = previous
      ? (['new', 'read', 'dismissed'] as const).flatMap((status) =>
          setupStore.listMonitoringInbox(previous.id, status))
      : [];
    const previousIds = new Set(previousItems.map(({ sourceId }) => sourceId));
    const persistedBriefModels = [...new Set(previousItems.flatMap(({ briefModelSlug }) =>
      briefModelSlug ? [briefModelSlug] : []))];
    if (previousSuccess && previousItems.some(({ brief }) => brief !== null) &&
        persistedBriefModels.some((model) => /luna/i.test(model))) {
      console.info('[production monitoring persisted acceptance]', JSON.stringify({
        lastSucceededAt: previousSuccess,
        sourceCount: previousItems.length,
        briefedCount: previousItems.filter(({ brief }) => brief !== null).length,
        briefModels: persistedBriefModels,
      }));
      setupStore.close();
      expect(previousItems.length).toBeGreaterThan(0);
      return;
    }
    setupStore.upsertMonitoringRule({
      id: 'ai_updates',
      name: 'AI 新技術',
      query: 'AI Application AI Agent RAG LLM Evaluation',
      enabled: true,
      intervalHours: 24,
      lookbackDays: 7,
      maxItems: 3,
      autoBrief: true,
    });
    setupStore.scheduleMonitoringRuleNow('ai_updates');
    setupStore.close();

    const deadline = Date.now() + 180_000;
    let observation: {
      lastSucceededAt: string | null;
      newSourceIds: string[];
      briefedSourceIds: string[];
      briefModels: string[];
    } | null = null;

    while (Date.now() < deadline) {
      const store = new ResearchStore(path);
      const rule = store.getMonitoringRule('ai_updates');
      const inbox = ['new', 'read', 'dismissed'].flatMap((status) =>
        store.listMonitoringInbox(
          'ai_updates',
          status as 'new' | 'read' | 'dismissed',
        ));
      store.close();
      const newItems = inbox.filter(({ sourceId }) => !previousIds.has(sourceId));
      observation = {
        lastSucceededAt: rule?.lastSucceededAt ?? null,
        newSourceIds: newItems.map(({ sourceId }) => sourceId),
        briefedSourceIds: newItems.filter(({ brief }) => brief !== null)
          .map(({ sourceId }) => sourceId),
        briefModels: [...new Set(newItems.flatMap(({ briefModelSlug }) =>
          briefModelSlug ? [briefModelSlug] : []))],
      };
      if (observation.lastSucceededAt !== previousSuccess &&
          observation.newSourceIds.length > 0 &&
          observation.briefedSourceIds.length > 0) break;
      await delay(1_000);
    }

    console.info('[production monitoring]', JSON.stringify(observation));
    expect(observation?.lastSucceededAt).not.toBe(previousSuccess);
    expect(observation?.newSourceIds.length).toBeGreaterThan(0);
    expect(observation?.briefedSourceIds.length).toBeGreaterThan(0);
    expect(observation?.briefModels.some((model) => /luna/i.test(model))).toBe(true);
  }, 190_000);
});

dedupSuite('production background monitoring deduplication', () => {
  it('does not add or re-brief the same sources on an immediate repeat', async () => {
    const path = productionDatabasePath();
    const initialStore = new ResearchStore(path);
    const initialRule = initialStore.getMonitoringRule('ai_updates');
    if (!initialRule?.lastSucceededAt) {
      initialStore.close();
      throw new Error('Run the production monitoring acceptance test first.');
    }
    const statuses = ['new', 'read', 'dismissed'] as const;
    const initialInbox = statuses.flatMap((status) =>
      initialStore.listMonitoringInbox('ai_updates', status));
    const initialBriefedIds = initialInbox.filter(({ brief }) => brief !== null)
      .map(({ sourceId }) => sourceId).sort();
    initialStore.scheduleMonitoringRuleNow('ai_updates');
    initialStore.close();

    const deadline = Date.now() + 120_000;
    let finalSuccess = initialRule.lastSucceededAt;
    while (Date.now() < deadline) {
      const pollingStore = new ResearchStore(path);
      finalSuccess = pollingStore.getMonitoringRule('ai_updates')?.lastSucceededAt ?? finalSuccess;
      pollingStore.close();
      if (finalSuccess !== initialRule.lastSucceededAt) break;
      await delay(1_000);
    }

    const finalStore = new ResearchStore(path);
    const finalInbox = statuses.flatMap((status) =>
      finalStore.listMonitoringInbox('ai_updates', status));
    finalStore.close();
    const finalBriefedIds = finalInbox.filter(({ brief }) => brief !== null)
      .map(({ sourceId }) => sourceId).sort();
    const usageDatabase = new DatabaseSync(path, { readOnly: true });
    const usage = usageDatabase.prepare(
      'SELECT request_count FROM monitoring_model_usage WHERE usage_date = ?',
    ).get(new Date().toISOString().slice(0, 10)) as { request_count: number } | undefined;
    usageDatabase.close();
    console.info('[production monitoring dedup]', JSON.stringify({
      initialSuccess: initialRule.lastSucceededAt,
      finalSuccess,
      initialCount: initialInbox.length,
      finalCount: finalInbox.length,
      initialBriefedCount: initialBriefedIds.length,
      finalBriefedCount: finalBriefedIds.length,
      dailyModelRequestCount: usage?.request_count ?? 0,
    }));

    expect(finalSuccess).not.toBe(initialRule.lastSucceededAt);
    expect(finalInbox).toHaveLength(initialInbox.length);
    expect(finalBriefedIds).toEqual(initialBriefedIds);
    expect(usage?.request_count).toBe(1);
  }, 130_000);
});
