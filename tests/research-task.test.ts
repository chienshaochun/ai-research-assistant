import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESEARCH_SETTINGS,
  applyPreferencePatch,
  describeResearchTask,
  interpretCommand,
  resolveFollowUpItemId,
  resolveResearchTask,
} from '../electron/research/research-task.js';

describe('research task state scopes', () => {
  it('parses the first-version research example into task-only overrides', () => {
    const interpreted = interpretCommand(
      '幫我找最近七天 AI Agent 與 RAG 的新技術，最多整理三項，優先有論文或開源程式碼的內容。',
    );
    expect(interpreted).toMatchObject({
      kind: 'research',
      preferencePatch: {},
      taskOverrides: {
        topic: 'AI Agent 與 RAG',
        lookbackDays: 7,
        maxItems: 3,
        paperFirst: true,
        preferOpenSource: true,
      },
    });
    const task = resolveResearchTask({}, interpreted.taskOverrides, '2026-10-01');
    expect(task).toMatchObject({ publishedFrom: '2026-09-25', publishedTo: '2026-10-01' });
  });

  it('does not let 這次 overwrite long-term preferences', () => {
    const preferences = { topic: 'AI Agent', requireOpenSource: false };
    const interpreted = interpretCommand('這次只看有開源程式碼的');
    const task = resolveResearchTask(preferences, interpreted.taskOverrides, '2026-10-01');

    expect(interpreted.preferencePatch).toEqual({});
    expect(preferences).toEqual({ topic: 'AI Agent', requireOpenSource: false });
    expect(task).toMatchObject({ topic: 'AI Agent', requireOpenSource: true });
  });

  it('turns 以後 into a persistent preference patch', () => {
    const interpreted = interpretCommand('以後先給三個重點');
    expect(interpreted).toEqual({
      kind: 'preference_update',
      taskOverrides: {},
      preferencePatch: { summaryPoints: 3 },
    });
    expect(applyPreferencePatch({ summaryPoints: 5 }, interpreted.preferencePatch))
      .toEqual({ summaryPoints: 3 });
  });

  it('applies explicit task overrides after preferences and defaults', () => {
    const task = resolveResearchTask(
      { maxItems: 5, reportFormat: 'brief', topic: 'RAG' },
      { maxItems: 2, topic: '推論效率' },
      '2026-10-01',
    );
    expect(task).toMatchObject({
      maxItems: 2,
      topic: '推論效率',
      reportFormat: 'brief',
      summaryPoints: DEFAULT_RESEARCH_SETTINGS.summaryPoints,
    });
  });

  it('changes this task topic without creating a preference patch', () => {
    const interpreted = interpretCommand('這次改看推論效率');
    expect(interpreted).toMatchObject({
      kind: 'research',
      taskOverrides: { topic: '推論效率' },
      preferencePatch: {},
    });
  });

  it('only removes the publication date boundary when explicitly requested', () => {
    const interpreted = interpretCommand('這次研究 AI Agent，日期不限');
    expect(interpreted).toMatchObject({
      kind: 'research',
      taskOverrides: { publicationDateMode: 'any' },
      preferencePatch: {},
    });
    const task = resolveResearchTask({}, interpreted.taskOverrides, '2026-10-04');
    expect(task).toMatchObject({
      publicationDateMode: 'any', publishedFrom: null, publishedTo: null,
    });
    expect(describeResearchTask(task)).toContain('日期：不限（日期未知來源可納入）');
  });

  it('rejects contradictory recent and unbounded publication date instructions', () => {
    expect(() => interpretCommand('找最近七天的 RAG，日期不限'))
      .toThrow('同時指定最近期間與日期不限');
  });

  it('selects official web search only from an explicit instruction', () => {
    const interpreted = interpretCommand('這次改看 AI Agent，使用官方 Web Search，日期不限');
    expect(interpreted).toMatchObject({
      kind: 'research',
      taskOverrides: { topic: 'AI Agent', searchMode: 'web', publicationDateMode: 'any' },
    });
    const task = resolveResearchTask({}, interpreted.taskOverrides, '2026-10-04');
    expect(describeResearchTask(task)).toContain('搜尋：官方 Web Search；日期：不限');
  });

  it('rejects contradictory search modes', () => {
    expect(() => interpretCommand('這次使用 arXiv，再改用官方 Web Search'))
      .toThrow('同時指定 arXiv 與官方 Web Search');
  });

  it('resolves 第二篇 through the previous report item order', () => {
    const interpreted = interpretCommand('第二篇深入一點');
    expect(interpreted.kind).toBe('follow_up');
    expect(resolveFollowUpItemId(
      [{ id: 'item_01' }, { id: 'item_02' }], interpreted.followUp!,
    )).toBe('item_02');
    expect(() => resolveFollowUpItemId([{ id: 'item_01' }], interpreted.followUp!))
      .toThrow('沒有第 2 項');
  });

  it('safely treats the common 二篇深入一點 shorthand as an ordinal follow-up', () => {
    const interpreted = interpretCommand('二篇深入一點');

    expect(interpreted).toMatchObject({
      kind: 'follow_up',
      followUp: {
        kind: 'ordinal', itemOrdinal: 2, instruction: '二篇深入一點', requiresNewSearch: false,
      },
    });
  });

  it('resolves 剛才那個方法 only from explicit conversation context', () => {
    const interpreted = interpretCommand('剛才那個方法再深入一點');

    expect(interpreted.followUp).toEqual({
      kind: 'recent', instruction: '剛才那個方法再深入一點', requiresNewSearch: false,
    });
    const items = [{ id: 'item_01' }, { id: 'item_02' }];
    expect(resolveFollowUpItemId(items, interpreted.followUp!, 'item_02')).toBe('item_02');
    expect(() => resolveFollowUpItemId(items, interpreted.followUp!))
      .toThrow('請改用「第幾篇」');
    expect(resolveFollowUpItemId([{ id: 'item_01' }], interpreted.followUp!))
      .toBe('item_01');
  });

  it('marks a follow-up that cannot be answered from existing evidence', () => {
    expect(interpretCommand('第二篇最新的 GitHub 實作是什麼').followUp)
      .toMatchObject({ kind: 'ordinal', itemOrdinal: 2, requiresNewSearch: true });
    expect(interpretCommand('第二篇深入一點').followUp)
      .toMatchObject({ requiresNewSearch: false });
  });

  it('recognizes format-only rewrites without implying a new search', () => {
    expect(interpretCommand('改成比較表')).toMatchObject({
      kind: 'rewrite',
      taskOverrides: { reportFormat: 'comparison_table' },
    });
  });

  it('fails closed for an unrecognized command instead of running the default research task', () => {
    expect(() => interpretCommand('幫我處理一下'))
      .toThrow('為避免誤用搜尋與模型額度');
    expect(() => interpretCommand('二篇說明一下'))
      .toThrow('為避免誤用搜尋與模型額度');
  });

  it('still accepts concise but explicit research intent', () => {
    expect(interpretCommand('近期有哪些 RAG 技術進展')).toMatchObject({ kind: 'research' });
    expect(interpretCommand('請搜尋 AI Agent 論文')).toMatchObject({ kind: 'research' });
  });

  it('produces a concise task understanding for display before execution', () => {
    const task = resolveResearchTask(
      {}, { topic: 'AI Agent', requireOpenSource: true }, '2026-10-01',
    );
    expect(describeResearchTask(task)).toContain(
      '主題：AI Agent；搜尋：arXiv；日期：2026-09-25～2026-10-01；最多 3 項',
    );
    expect(describeResearchTask(task)).toContain('只納入有開源程式碼的研究');
  });

  it('rejects corrupted persisted boolean preferences', () => {
    expect(() => resolveResearchTask(
      { paperFirst: 'yes' as unknown as boolean }, {}, '2026-10-01',
    )).toThrow('布林值');
  });

  it('rejects a corrupted persisted publication date mode', () => {
    expect(() => resolveResearchTask(
      { publicationDateMode: 'unknown' as 'recent' }, {}, '2026-10-01',
    )).toThrow('發布日期模式');
  });

  it('rejects a corrupted persisted search mode', () => {
    expect(() => resolveResearchTask(
      { searchMode: 'unknown' as 'arxiv' }, {}, '2026-10-01',
    )).toThrow('搜尋模式');
  });
});
