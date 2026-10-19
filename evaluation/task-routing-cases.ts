import type { CommandInterpretation } from '../electron/research/research-task.js';

export interface TaskRoutingCase {
  id: string;
  input: string;
  expected: Partial<CommandInterpretation>;
}

/**
 * 固定 baseline；新增案例可以擴充覆蓋面，但不可為了讓新版 parser 過關而改寫既有預期。
 */
export const TASK_ROUTING_CASES: readonly TaskRoutingCase[] = [
  {
    id: 'research_original_request',
    input: '幫我找最近七天 AI Agent 與 RAG 的新技術，最多整理三項，優先有論文或開源程式碼的內容。',
    expected: {
      kind: 'research',
      taskOverrides: {
        topic: 'AI Agent 與 RAG', lookbackDays: 7, maxItems: 3,
        paperFirst: true, preferOpenSource: true,
      },
      preferencePatch: {},
    },
  },
  {
    id: 'one_time_topic',
    input: '這次改看推論效率',
    expected: { kind: 'research', taskOverrides: { topic: '推論效率' }, preferencePatch: {} },
  },
  {
    id: 'one_time_requires_code',
    input: '這次只看有開源程式碼的',
    expected: {
      kind: 'research',
      taskOverrides: { requireOpenSource: true, preferOpenSource: true },
      preferencePatch: {},
    },
  },
  {
    id: 'persistent_summary_points',
    input: '以後先給三個重點',
    expected: {
      kind: 'preference_update', taskOverrides: {}, preferencePatch: { summaryPoints: 3 },
    },
  },
  {
    id: 'persistent_brief_format',
    input: '以後都用短摘要',
    expected: {
      kind: 'preference_update', taskOverrides: {}, preferencePatch: { reportFormat: 'brief' },
    },
  },
  {
    id: 'persistent_research_topic',
    input: '以後都研究 LLM Evaluation',
    expected: {
      kind: 'preference_update',
      taskOverrides: {},
      preferencePatch: { topic: 'LLM Evaluation' },
    },
  },
  {
    id: 'format_only_rewrite',
    input: '改成比較表',
    expected: {
      kind: 'rewrite', taskOverrides: { reportFormat: 'comparison_table' }, preferencePatch: {},
    },
  },
  {
    id: 'ordinal_follow_up',
    input: '第二篇深入一點',
    expected: {
      kind: 'follow_up',
      followUp: {
        kind: 'ordinal', itemOrdinal: 2, instruction: '第二篇深入一點', requiresNewSearch: false,
      },
    },
  },
  {
    id: 'ordinal_follow_up_shorthand',
    input: '二篇深入一點',
    expected: {
      kind: 'follow_up',
      followUp: {
        kind: 'ordinal', itemOrdinal: 2,
        instruction: '二篇深入一點', requiresNewSearch: false,
      },
    },
  },
  {
    id: 'recent_follow_up',
    input: '剛才那個方法有哪些限制',
    expected: {
      kind: 'follow_up',
      followUp: {
        kind: 'recent', instruction: '剛才那個方法有哪些限制', requiresNewSearch: false,
      },
    },
  },
  {
    id: 'follow_up_requires_search',
    input: '第二篇最新的 GitHub 實作是什麼',
    expected: {
      kind: 'follow_up',
      followUp: {
        kind: 'ordinal', itemOrdinal: 2,
        instruction: '第二篇最新的 GitHub 實作是什麼', requiresNewSearch: true,
      },
    },
  },
  {
    id: 'two_week_five_item_research',
    input: '幫我找最近兩週 RAG 的新技術，最多整理五篇',
    expected: {
      kind: 'research',
      taskOverrides: { topic: 'RAG', lookbackDays: 14, maxItems: 5 },
      preferencePatch: {},
    },
  },
  {
    id: 'one_time_unbounded_publication_date',
    input: '這次研究 AI Agent，日期不限',
    expected: {
      kind: 'research',
      taskOverrides: { publicationDateMode: 'any' },
      preferencePatch: {},
    },
  },
  {
    id: 'one_time_official_web_search',
    input: '這次改看 AI Agent，使用官方 Web Search，日期不限',
    expected: {
      kind: 'research',
      taskOverrides: { topic: 'AI Agent', searchMode: 'web', publicationDateMode: 'any' },
      preferencePatch: {},
    },
  },
  {
    id: 'concise_explicit_research',
    input: '近期有哪些 RAG 技術進展',
    expected: {
      kind: 'research',
      taskOverrides: {},
      preferencePatch: {},
    },
  },
] as const;
