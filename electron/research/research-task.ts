export const REPORT_FORMATS = ['brief', 'detailed', 'comparison_table'] as const;
export type ReportFormat = typeof REPORT_FORMATS[number];
export const PUBLICATION_DATE_MODES = ['recent', 'any'] as const;
export type PublicationDateMode = typeof PUBLICATION_DATE_MODES[number];
export const SEARCH_MODES = ['arxiv', 'web'] as const;
export type SearchMode = typeof SEARCH_MODES[number];

export interface ResearchSettings {
  topic: string;
  lookbackDays: number;
  publicationDateMode: PublicationDateMode;
  searchMode: SearchMode;
  maxItems: number;
  summaryPoints: number;
  reportFormat: ReportFormat;
  paperFirst: boolean;
  preferOpenSource: boolean;
  requireOpenSource: boolean;
  language: 'zh-Hant';
}

export type LongTermPreferences = Partial<Omit<ResearchSettings, 'language'>>;
export type TaskOverrides = Partial<Omit<ResearchSettings, 'language'>>;

export interface ResolvedResearchTask extends ResearchSettings {
  publishedFrom: string | null;
  publishedTo: string | null;
}

export type FollowUpReference =
  | { kind: 'ordinal'; itemOrdinal: number; instruction: string; requiresNewSearch: boolean }
  | { kind: 'recent'; instruction: string; requiresNewSearch: boolean };

export interface CommandInterpretation {
  kind: 'research' | 'preference_update' | 'follow_up' | 'rewrite';
  taskOverrides: TaskOverrides;
  preferencePatch: LongTermPreferences;
  followUp?: FollowUpReference;
}

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  topic: 'AI Application、AI Agent、RAG 與 LLM Evaluation',
  lookbackDays: 7,
  publicationDateMode: 'recent',
  searchMode: 'arxiv',
  maxItems: 3,
  summaryPoints: 3,
  reportFormat: 'detailed',
  paperFirst: true,
  preferOpenSource: true,
  requireOpenSource: false,
  language: 'zh-Hant',
};

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseSmallNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (CHINESE_NUMBERS[value]) return CHINESE_NUMBERS[value];
  const match = value.match(/^十([一二三四五六七八九])$/);
  if (match) return 10 + CHINESE_NUMBERS[match[1]];
  const tens = value.match(/^([二三四五六七八九])十([一二三四五六七八九])?$/);
  if (tens) return CHINESE_NUMBERS[tens[1]] * 10 + (tens[2] ? CHINESE_NUMBERS[tens[2]] : 0);
  return undefined;
}

function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} 必須是 YYYY-MM-DD。`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} 不是有效日期。`);
  }
  return value;
}

function cleanTopic(value: string): string {
  return value.trim().replace(/[的，。；;]+$/g, '').trim();
}

function formatFromCommand(command: string): ReportFormat | undefined {
  if (/比較表/.test(command)) return 'comparison_table';
  if (/短摘要|簡短摘要|精簡版/.test(command)) return 'brief';
  if (/詳細報告|深入報告|完整版/.test(command)) return 'detailed';
  return undefined;
}

function hasExplicitResearchIntent(command: string): boolean {
  return /(?:幫我|請)?(?:找|搜尋|查找|研究)|(?:這次|本次)(?:(?:改)?看|只看)|新技術|(?:最近|近期)[^，。；;]*(?:論文|研究|進展|技術)|(?:有哪些|有什麼)[^，。；;]*(?:論文|研究|技術|進展)/
    .test(command);
}

function extractSettings(command: string): TaskOverrides {
  const settings: TaskOverrides = {};
  const lookback = command.match(/最近([\d一二兩三四五六七八九十]+)(天|週|周)/);
  const dateUnbounded = /日期不限|不限日期|不(?:用|必)管(?:發布|發表)?日期|不在意[^，。；;]*(?:發布|發表)?日期/.test(command);
  if (lookback && dateUnbounded) {
    throw new Error('指令同時指定最近期間與日期不限，請保留其中一種。');
  }
  if (lookback) {
    const count = parseSmallNumber(lookback[1]);
    if (count) {
      settings.lookbackDays = count * (lookback[2] === '天' ? 1 : 7);
      settings.publicationDateMode = 'recent';
    }
  }
  if (dateUnbounded) settings.publicationDateMode = 'any';
  const webSearch = /(?:使用|用|透過|改用)\s*(?:官方)?\s*(?:Web\s*Search|網路搜尋|網頁搜尋)|完整網路搜尋/i.test(command);
  const arxivSearch = /(?:使用|用|透過|改用)\s*arXiv/i.test(command);
  if (webSearch && arxivSearch) {
    throw new Error('指令同時指定 arXiv 與官方 Web Search，請保留其中一種。');
  }
  if (webSearch) settings.searchMode = 'web';
  if (arxivSearch) settings.searchMode = 'arxiv';
  const maxItems = command.match(/最多(?:整理|列出|提供)?([\d一二兩三四五六七八九十]+)(?:項|篇)/);
  if (maxItems) {
    const count = parseSmallNumber(maxItems[1]);
    if (count) settings.maxItems = count;
  }
  const summaryPoints = command.match(/(?:先給|給我|提供)([\d一二兩三四五六七八九十]+)個重點/);
  if (summaryPoints) {
    const count = parseSmallNumber(summaryPoints[1]);
    if (count) settings.summaryPoints = count;
  }
  const recentTopic = command.match(
    /最近[\d一二兩三四五六七八九十]+(?:天|週|周)\s*(.+?)(?:的)?新技術/,
  );
  const thisTopic = command.match(/(?:這次|本次)(?:改)?看\s*([^，。；;]+)/);
  const persistentTopic = command.match(
    /(?:以後|之後|未來)(?:都)?(?:改)?(?:研究|看)\s*([^，。；;]+)/,
  );
  const topic = cleanTopic(thisTopic?.[1] ?? recentTopic?.[1] ?? persistentTopic?.[1] ?? '');
  if (topic) settings.topic = topic;
  if (/(?:這次|本次)?只看[^，。]*(?:有)?開源程式碼/.test(command)) {
    settings.requireOpenSource = true;
    settings.preferOpenSource = true;
  } else if (/優先[^，。]*(?:開源|原始碼|程式碼)/.test(command)) {
    settings.preferOpenSource = true;
  }
  if (/優先[^，。]*論文|論文優先/.test(command)) settings.paperFirst = true;
  const reportFormat = formatFromCommand(command);
  if (reportFormat) settings.reportFormat = reportFormat;
  return settings;
}

export function interpretCommand(input: string): CommandInterpretation {
  const command = input.trim();
  if (!command || command.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(command)) {
    throw new Error('指令必須是 1 到 2,000 個可顯示字元。');
  }
  const explicitOrdinal = command.match(/第([\d一二兩三四五六七八九十]+)(?:篇|項)/);
  const shorthandOrdinal = command.match(
    /^([\d一二三四五六七八九十]+)(?:篇|項)(?:再|更)?(?:深入(?:一點)?|詳細說明|展開說明|有哪些(?:限制|方法|證據)|的(?:限制|方法|證據))[。！!?]?$/,
  );
  const ordinalMatch = explicitOrdinal ?? shorthandOrdinal;
  if (ordinalMatch) {
    const itemOrdinal = parseSmallNumber(ordinalMatch[1]);
    if (!itemOrdinal || itemOrdinal < 1) throw new Error('追問的報告項目編號無效。');
    return {
      kind: 'follow_up',
      taskOverrides: {},
      preferencePatch: {},
      followUp: {
        kind: 'ordinal', itemOrdinal, instruction: command,
        requiresNewSearch: /最新|目前|再搜尋|重新搜尋|補查|GitHub|repo|repository|程式碼|原始碼|實作/i
          .test(command),
      },
    };
  }
  if (/(?:剛才|方才|上一個|那個)(?:的)?(?:方法|技術|研究|項目)/.test(command)) {
    return {
      kind: 'follow_up',
      taskOverrides: {},
      preferencePatch: {},
      followUp: {
        kind: 'recent', instruction: command,
        requiresNewSearch: /最新|目前|再搜尋|重新搜尋|補查|GitHub|repo|repository|程式碼|原始碼|實作/i
          .test(command),
      },
    };
  }

  const settings = extractSettings(command);
  if (/(?:以後|之後|未來)(?:都)?/.test(command)) {
    return {
      kind: 'preference_update',
      taskOverrides: {},
      preferencePatch: settings,
    };
  }
  const onlyFormatChange = Boolean(formatFromCommand(command)) &&
    !/(幫我找|搜尋|研究|新技術|這次改看|本次改看)/.test(command);
  if (!onlyFormatChange && !hasExplicitResearchIntent(command)) {
    throw new Error(
      '無法判斷這是研究、追問、格式改寫或偏好更新；為避免誤用搜尋與模型額度，請明確寫「幫我找…」或「第二篇…」。',
    );
  }
  return {
    kind: onlyFormatChange ? 'rewrite' : 'research',
    taskOverrides: settings,
    preferencePatch: {},
  };
}

function validateSettings(settings: ResearchSettings): ResearchSettings {
  const topic = settings.topic.trim();
  if (!topic || topic.length > 500) throw new Error('研究主題必須是 1 到 500 個字元。');
  if (!Number.isInteger(settings.lookbackDays) || settings.lookbackDays < 1 || settings.lookbackDays > 365) {
    throw new Error('回溯天數必須是 1 到 365 的整數。');
  }
  if (!PUBLICATION_DATE_MODES.includes(settings.publicationDateMode)) {
    throw new Error('不支援的發布日期模式。');
  }
  if (!SEARCH_MODES.includes(settings.searchMode)) {
    throw new Error('不支援的搜尋模式。');
  }
  if (!Number.isInteger(settings.maxItems) || settings.maxItems < 1 || settings.maxItems > 10) {
    throw new Error('報告項目上限必須是 1 到 10 的整數。');
  }
  if (!Number.isInteger(settings.summaryPoints) || settings.summaryPoints < 1 || settings.summaryPoints > 3) {
    throw new Error('重點摘要數量必須是 1 到 3 的整數。');
  }
  if (!REPORT_FORMATS.includes(settings.reportFormat)) throw new Error('不支援的報告格式。');
  if (typeof settings.paperFirst !== 'boolean' ||
      typeof settings.preferOpenSource !== 'boolean' ||
      typeof settings.requireOpenSource !== 'boolean') {
    throw new Error('來源篩選設定必須是布林值。');
  }
  return { ...settings, topic };
}

function subtractDays(date: string, count: number): string {
  const parsed = new Date(`${assertIsoDate(date, '任務日期')}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() - count);
  return parsed.toISOString().slice(0, 10);
}

export function resolveResearchTask(
  preferences: LongTermPreferences,
  overrides: TaskOverrides,
  today: string,
): ResolvedResearchTask {
  const settings = validateSettings({
    ...DEFAULT_RESEARCH_SETTINGS,
    ...preferences,
    ...overrides,
    language: 'zh-Hant',
  });
  const publishedTo = assertIsoDate(today, '任務日期');
  return {
    ...settings,
    publishedFrom: settings.publicationDateMode === 'recent'
      ? subtractDays(publishedTo, settings.lookbackDays - 1)
      : null,
    publishedTo: settings.publicationDateMode === 'recent' ? publishedTo : null,
  };
}

export function applyPreferencePatch(
  current: LongTermPreferences,
  patch: LongTermPreferences,
): LongTermPreferences {
  validateSettings({ ...DEFAULT_RESEARCH_SETTINGS, ...current, ...patch, language: 'zh-Hant' });
  return { ...current, ...patch };
}

export function resolveFollowUpItemId(
  items: readonly { id: string }[],
  reference: FollowUpReference,
  recentItemId?: string,
): string {
  if (reference.kind === 'recent') {
    if (recentItemId && items.some(({ id }) => id === recentItemId)) return recentItemId;
    if (items.length === 1) return items[0].id;
    throw new Error('無法判斷「剛才那個方法」是報告中的哪一項，請改用「第幾篇」。');
  }
  const item = items[reference.itemOrdinal - 1];
  if (!item) throw new Error(`上一份報告沒有第 ${reference.itemOrdinal} 項。`);
  return item.id;
}

export function describeResearchTask(task: ResolvedResearchTask): string {
  const sourcePolicy = task.requireOpenSource
    ? '只納入有開源程式碼的研究'
    : task.preferOpenSource ? '開源實作優先但非必要' : '不以開源實作篩選';
  return [
    `主題：${task.topic}`,
    `搜尋：${task.searchMode === 'web' ? '官方 Web Search' : 'arXiv'}`,
    task.publicationDateMode === 'recent'
      ? `日期：${task.publishedFrom}～${task.publishedTo}`
      : '日期：不限（日期未知來源可納入）',
    `最多 ${task.maxItems} 項`,
    `格式：${task.reportFormat}`,
    sourcePolicy,
  ].join('；');
}
