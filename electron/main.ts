import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol,
  safeStorage, shell, Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CHATGPT_USAGE_URL, ChatGPTError, createChatGPT, type SessionState,
} from '@siwc/local';
import {
  preferredDevelopmentModel,
  type AppState, type PublicError, type PublicMonitoringInboxItem,
  type PublicMonitoringRuleInput,
} from '../shared.js';
import { createElectronCredentialEncryption } from './credential-encryption.js';
import { optionalIpcText, requiredIpcText } from './ipc-input.js';
import { selectVerificationModel, verifyTokenSharing } from './verification.js';
import { normalizePublicHttpUrl, probeWebSearchCapability } from './web-search-probe.js';
import { ArxivSearchProvider } from './research/arxiv-search-provider.js';
import { OfficialWebSearchProvider } from './research/official-web-search-provider.js';
import { OfficialFeedSearchProvider } from './research/official-feed-search-provider.js';
import { CompositeSearchProvider } from './research/composite-search-provider.js';
import { EvidenceAwareContentReader, SafeHttpContentReader } from './research/content-reader.js';
import { OfficialReportDraftProvider } from './research/report-provider.js';
import { rewriteResearchReport, type EvidenceBundle } from './research/report.js';
import { auditResearchReport } from './research/report-audit.js';
import {
  buildEvaluationWorksheet,
  summarizeEvaluationWorksheet,
} from './research/evaluation-worksheet.js';
import { runResearchPipeline, type ResearchProgress } from './research/research-pipeline.js';
import type { SearchRunResult } from './research/run-search.js';
import {
  describeResearchTask,
  interpretCommand,
  resolveFollowUpItemId,
  resolveResearchTask,
  type FollowUpReference,
} from './research/research-task.js';
import {
  ResearchStore,
  type ResearchAttemptStage,
} from './research/research-store.js';
import {
  generateFollowUpAnswer,
  OfficialFollowUpDraftProvider,
} from './research/report-follow-up.js';
import {
  isImplementationFollowUp,
  runFollowUpSearch,
} from './research/follow-up-search.js';
import {
  runBackgroundDiscovery,
  type BackgroundDiscoveryResult,
} from './research/background-discovery.js';
import { BackgroundMonitorScheduler } from './research/background-scheduler.js';
import { generateBackgroundBriefs } from './research/background-brief.js';
import {
  shouldDeliverMonitoringDigest,
  validateMonitoringFeedback,
  type MonitoringRule,
} from './research/background-monitor.js';
import { rankMonitoringItems } from './research/monitoring-ranking.js';
import {
  MonitoringItemSearchProvider,
  monitoringResearchTask,
} from './research/monitoring-research.js';
import {
  createPortableBackup,
  readPortableBackup,
} from './research/portable-backup.js';

const packageSmokeTest = process.argv.includes('--smoke-test');
const directory = dirname(fileURLToPath(import.meta.url));
const rendererDirectory = resolve(directory, '../dist');
const appUrl = 'ai-research://app/';
const backgroundLaunch = process.argv.includes('--background-monitor');

app.setName('AI Research Assistant');
app.setPath(
  'userData',
  process.env.AI_RESEARCH_ASSISTANT_DATA_DIR
    ? resolve(process.env.AI_RESEARCH_ASSISTANT_DATA_DIR)
    : join(app.getPath('appData'), 'AI Research Assistant'),
);
const hasSingleInstanceLock = packageSmokeTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
protocol.registerSchemesAsPrivileged([
  { scheme: 'ai-research', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const chatgpt = createChatGPT({
  appName: 'AI Research Assistant',
  appId: 'ai-research-assistant',
  redirectPort: 0,
  sendHostId: true,
  storageDir: join(app.getPath('userData'), 'chatgpt'),
  credentialEncryption: createElectronCredentialEncryption(safeStorage, () => app.isReady()),
  openBrowser: async (url) => {
    const target = new URL(url);
    if (target.origin !== 'https://auth.openai.com') throw new Error('拒絕開啟非預期的登入網址。');
    await shell.openExternal(target.href);
  },
});
const arxivSearchProvider = new ArxivSearchProvider();
const monitoringSearchProvider = new CompositeSearchProvider([
  arxivSearchProvider,
  new OfficialFeedSearchProvider(),
], 'monitoring-public-sources');

let window: BrowserWindow | undefined;
let verificationController: AbortController | undefined;
let webSearchProbeController: AbortController | undefined;
let researchController: AbortController | undefined;
let catalogController: AbortController | undefined;
let researchStore: ResearchStore | undefined;
let backgroundScheduler: BackgroundMonitorScheduler | undefined;
let tray: Tray | undefined;
let quitting = false;
let backgroundNoticeShown = false;
let dataTransferBusy = false;
const disconnected: SessionState = { status: 'disconnected', sharing: false };
let state: AppState = {
  session: disconnected,
  profiles: [],
  accountBusy: false,
  models: [],
  modelsStatus: 'idle',
  verification: { status: 'idle', text: '' },
  webSearchProbe: { status: 'idle', text: '', sources: [] },
  research: { status: 'idle', command: '', message: '' },
  preferences: {},
  reportHistory: [],
  attemptHistory: [],
  monitoring: {
    status: 'idle', message: '背景監測尚未設定。', rules: [], inbox: [], runs: [],
  },
  launchAtLogin: false,
  dataDirectory: app.getPath('userData'),
};

function publish(): void {
  if (window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame()) {
    window.webContents.send('research-assistant:state', state);
  }
}

function publicError(error: unknown): PublicError {
  if (error instanceof ChatGPTError) {
    const value = error.toJSON();
    return {
      code: value.code,
      message: value.message,
      retryable: value.retryable,
      ...(value.status === undefined ? {} : { status: value.status }),
      ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      ...(value.param === undefined ? {} : { param: value.param }),
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'cancelled', message: '操作已取消。', retryable: true };
  }
  return {
    code: 'unexpected_error',
    message: error instanceof Error ? error.message : '發生未預期錯誤。',
    retryable: true,
  };
}

function refreshMonitoringState(
  status: AppState['monitoring']['status'] = 'idle',
  message?: string,
  error?: PublicError,
): void {
  if (!researchStore) return;
  const rules = researchStore.listMonitoringRules();
  const inbox = rules.flatMap((rule) => {
    const history = researchStore!.listAllMonitoringInbox(rule.id);
    return rankMonitoringItems(
      rule,
      history.filter(({ status: itemStatus }) => itemStatus === 'new'),
      history,
    ).map(({ item, score, reasons }) => ({
      ...item,
      rankingScore: score,
      rankingReasons: reasons,
    }));
  });
  state = {
    ...state,
    monitoring: {
      status,
      message: message ?? (rules.length === 0
        ? '背景監測尚未設定。'
        : `已設定 ${rules.length} 個監測規則；目前有 ${inbox.length} 項未讀新技術。`),
      rules,
      inbox,
      runs: researchStore.listMonitoringRuns(),
      ...(error ? { error } : {}),
    },
  };
}

function focusMainWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function monitoringEnabled(): boolean {
  return state.monitoring.rules.some(({ enabled }) => enabled);
}

function createTray(): void {
  if (tray) return;
  try {
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels[offset] = 45; pixels[offset + 1] = 74;
      pixels[offset + 2] = 35; pixels[offset + 3] = 255;
    }
    const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16, scaleFactor: 1 });
    if (icon.isEmpty()) return;
    tray = new Tray(icon);
    tray.setToolTip('AI Research Assistant');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '開啟 AI Research Assistant', click: focusMainWindow },
      { type: 'separator' },
      { label: '結束', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', focusMainWindow);
  } catch {
    tray = undefined;
  }
}

function loginLaunchArguments(): string[] {
  return app.isPackaged
    ? ['--background-monitor']
    : [app.getAppPath(), '--background-monitor'];
}

function launchAtLoginEnabled(): boolean {
  return app.getLoginItemSettings({
    path: process.execPath,
    args: loginLaunchArguments(),
  }).openAtLogin;
}

function setLaunchAtLogin(value: unknown): void {
  if (typeof value !== 'boolean') throw new Error('登入時啟動設定必須是布林值。');
  app.setLoginItemSettings({
    openAtLogin: value,
    path: process.execPath,
    args: loginLaunchArguments(),
  });
  state = { ...state, launchAtLogin: launchAtLoginEnabled() };
  publish();
}

function notifyMonitoringDigest(
  rule: MonitoringRule,
  items: PublicMonitoringInboxItem[],
): void {
  if (items.length === 0 || !Notification.isSupported()) return;
  const first = items[0];
  const summary = first.brief
    ? `${first.candidate.title}：${first.brief.problem}；核心：${first.brief.coreMethod}`
    : items.slice(0, 2).map(({ candidate }) => candidate.title).join('；');
  const notification = new Notification({
    title: `${rule.name}每日匯報：${items.length} 項新技術`,
    body: `${summary}${items.length > 1 ? `；另有 ${items.length - 1} 項` : ''}`.slice(0, 240),
  });
  notification.on('click', focusMainWindow);
  notification.show();
}

function deliverPendingMonitoringDigests(now: string): void {
  if (!researchStore || !Notification.isSupported()) return;
  let delivered = false;
  for (const rule of researchStore.listMonitoringRules()) {
    const current = new Date(now);
    if (!shouldDeliverMonitoringDigest(rule, current)) continue;
    const pending = researchStore.listPendingMonitoringDigest(rule.id);
    if (pending.length === 0) continue;
    const ranked = rankMonitoringItems(
      rule,
      pending,
      researchStore.listAllMonitoringInbox(rule.id),
      current,
    );
    const publicItems = ranked.map(({ item, score, reasons }) => ({
      ...item,
      rankingScore: score,
      rankingReasons: reasons,
    }));
    notifyMonitoringDigest(rule, publicItems);
    researchStore.markMonitoringDigestDelivered(
      rule.id,
      pending.map(({ sourceId }) => sourceId),
      now,
    );
    delivered = true;
  }
  if (delivered) {
    refreshMonitoringState('idle', '已送出排程中的每日技術匯報。');
    publish();
  }
}

async function executeBackgroundRule(
  rule: MonitoringRule,
  signal: AbortSignal,
): Promise<BackgroundDiscoveryResult> {
  if (!researchStore) throw new Error('本機研究資料庫尚未就緒。');
  const runId = researchStore.startMonitoringRun(rule.id);
  try {
    refreshMonitoringState('checking', `正在背景檢查「${rule.name}」…`);
    publish();
    let result = await runBackgroundDiscovery(monitoringSearchProvider, researchStore, rule, signal);
    if (rule.autoBrief && result.newItems.length > 0) {
      if (state.session.status !== 'connected' || !state.session.sharing) {
        result = { ...result, briefing: {
          status: 'skipped', message: '未登入或未授權方案用量，因此只完成背景搜尋。',
        } };
      } else {
        const model = preferredDevelopmentModel(state.models);
        if (!model) {
          result = { ...result, briefing: {
            status: 'skipped', message: '目前沒有可用模型，因此只完成背景搜尋。',
          } };
        } else if (!researchStore.tryClaimMonitoringModelBudget()) {
          result = { ...result, briefing: {
            status: 'skipped', message: '今日背景模型請求已達 1 次硬上限。',
          } };
        } else {
          try {
            const rankedItems = rankMonitoringItems(
              rule,
              result.newItems,
              researchStore.listAllMonitoringInbox(rule.id),
            ).map(({ item }) => item);
            const briefs = await generateBackgroundBriefs(
              chatgpt, model.slug, rule, rankedItems, signal,
            );
            researchStore.saveMonitoringBriefs(rule.id, briefs, model.slug);
            result = { ...result, briefing: {
              status: 'completed',
              message: `已使用 ${model.slug} 產生 ${briefs.length} 項主動摘要。`,
            } };
          } catch (error) {
            result = { ...result, briefing: {
              status: 'failed', message: `背景摘要失敗：${publicError(error).message}`,
            } };
          }
        }
      }
    }
    const briefedCount = result.newItems.filter(({ sourceId }) =>
      Boolean(researchStore!.getMonitoringInboxItem(rule.id, sourceId)?.brief)).length;
    researchStore.finishMonitoringRun(
      runId,
      'completed',
      result.newItems.length,
      briefedCount,
      result.briefing?.status === 'failed'
        ? { code: 'brief_failed', message: result.briefing.message } : undefined,
    );
    return result;
  } catch (error) {
    const problem = publicError(error);
    researchStore.finishMonitoringRun(
      runId,
      problem.code === 'cancelled' ? 'cancelled' : 'failed',
      0,
      0,
      { code: problem.code, message: problem.message },
    );
    throw error;
  }
}

function createBackgroundScheduler(): BackgroundMonitorScheduler {
  return new BackgroundMonitorScheduler({
    listDueRules: (now) => researchStore?.listDueMonitoringRules(now) ?? [],
    canRun: () => !researchController && !verificationController &&
      !webSearchProbeController && !state.accountBusy,
    runRule: executeBackgroundRule,
    onResult: (result) => {
      refreshMonitoringState(
        'idle',
        (result.newItems.length > 0
          ? `「${result.rule.name}」找到 ${result.newItems.length} 項新技術。`
          : `「${result.rule.name}」檢查完成，沒有未看過的新來源。`) +
          (result.briefing ? ` ${result.briefing.message}` : ''),
      );
      publish();
    },
    onError: (rule, error) => {
      const problem = publicError(error);
      refreshMonitoringState(
        'failed', `「${rule.name}」背景檢查失敗；一小時後有限次重試。`, problem,
      );
      publish();
    },
    onTick: deliverPendingMonitoringDigests,
  });
}

async function refreshProfiles(): Promise<void> {
  try { state = { ...state, profiles: await chatgpt.listProfiles() }; }
  catch { state = { ...state, profiles: [] }; }
}

async function refreshModels(): Promise<void> {
  catalogController?.abort();
  catalogController = undefined;
  delete state.modelsError;
  if (state.session.status !== 'connected' || !state.session.sharing) {
    state = { ...state, models: [], modelsStatus: 'idle' };
    publish();
    return;
  }
  const controller = new AbortController();
  catalogController = controller;
  const profileId = state.session.profileId;
  state = { ...state, models: [], modelsStatus: 'loading' };
  publish();
  try {
    const models = await chatgpt.listModels({ signal: controller.signal });
    if (controller.signal.aborted || state.session.profileId !== profileId) return;
    state = { ...state, models, modelsStatus: 'ready' };
  } catch (error) {
    if (!controller.signal.aborted && state.session.profileId === profileId) {
      state = { ...state, models: [], modelsStatus: 'error', modelsError: publicError(error) };
    }
  } finally {
    if (catalogController === controller) catalogController = undefined;
    publish();
  }
}

async function refreshAccount(): Promise<void> {
  state = { ...state, session: await chatgpt.getSession() };
  await refreshProfiles();
  await refreshModels();
  publish();
}

async function accountAction(
  action: () => Promise<unknown>,
  allowActiveRequest = false,
): Promise<void> {
  if (state.accountBusy) throw new Error('目前已有登入操作進行中。');
  if (!allowActiveRequest &&
      (verificationController || webSearchProbeController || researchController)) {
    throw new Error('請先完成或取消目前的模型、搜尋或研究任務。');
  }
  state = { ...state, accountBusy: true };
  publish();
  try {
    await action();
  } catch (error) {
    state = { ...state, session: { ...state.session, error: publicError(error) } };
  } finally {
    try { await refreshAccount(); }
    catch (error) {
      state = { ...state, session: { ...state.session, error: publicError(error) } };
    }
    state = { ...state, accountBusy: false };
    publish();
  }
}

async function runVerification(requestedSlug?: string): Promise<void> {
  if (verificationController) throw new Error('驗證請求已在執行中。');
  if (webSearchProbeController) throw new Error('Web search 探測正在執行中。');
  if (researchController) throw new Error('研究或追問任務正在執行中。');
  const model = selectVerificationModel(state.session, state.models, requestedSlug);
  const controller = new AbortController();
  verificationController = controller;
  state = { ...state, verification: { status: 'running', modelSlug: model.slug, text: '' } };
  publish();
  try {
    let streamedText = '';
    const text = await verifyTokenSharing(chatgpt, model, controller.signal, (delta) => {
      streamedText += delta;
      state = {
        ...state,
        verification: { status: 'running', modelSlug: model.slug, text: streamedText },
      };
      publish();
    });
    state = {
      ...state,
      verification: {
        status: 'passed', modelSlug: model.slug, text, completedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const problem = publicError(error);
    state = {
      ...state,
      verification: {
        status: problem.code === 'cancelled' ? 'cancelled' : 'failed',
        modelSlug: model.slug,
        text: state.verification.text,
        error: problem,
      },
    };
  } finally {
    if (verificationController === controller) verificationController = undefined;
    publish();
  }
}

async function runWebSearchProbe(requestedSlug?: string): Promise<void> {
  if (webSearchProbeController) throw new Error('Web search 探測已在執行中。');
  if (verificationController) throw new Error('模型驗證正在執行中。');
  if (researchController) throw new Error('研究或追問任務正在執行中。');
  const model = selectVerificationModel(state.session, state.models, requestedSlug);
  const controller = new AbortController();
  webSearchProbeController = controller;
  state = {
    ...state,
    webSearchProbe: { status: 'running', modelSlug: model.slug, text: '', sources: [] },
  };
  publish();
  try {
    let streamedText = '';
    const result = await probeWebSearchCapability(chatgpt, model, controller.signal, (delta) => {
      streamedText += delta;
      state = {
        ...state,
        webSearchProbe: {
          status: 'running', modelSlug: model.slug, text: streamedText, sources: [],
        },
      };
      publish();
    });
    state = {
      ...state,
      webSearchProbe: {
        status: 'passed', modelSlug: model.slug, text: result.text,
        sources: result.sources, completedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const problem = publicError(error);
    state = {
      ...state,
      webSearchProbe: {
        status: problem.code === 'cancelled' ? 'cancelled' : 'failed',
        modelSlug: model.slug,
        text: state.webSearchProbe.text,
        sources: state.webSearchProbe.sources,
        error: problem,
      },
    };
  } finally {
    if (webSearchProbeController === controller) webSearchProbeController = undefined;
    publish();
  }
}

function localIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function updateResearchProgress(progress: ResearchProgress): void {
  state = {
    ...state,
    research: {
      ...state.research,
      status: progress.stage,
      message: progress.message,
      ...(progress.eligibleSourceCount === undefined
        ? {} : { eligibleSourceCount: progress.eligibleSourceCount }),
      ...(progress.supplementarySourceCount === undefined
        ? {} : { supplementarySourceCount: progress.supplementarySourceCount }),
    },
  };
  publish();
}

async function runReportFollowUp(
  command: string,
  reference: FollowUpReference,
  requestedSlug?: string,
): Promise<void> {
  const report = state.research.report;
  if (!report) throw new Error('目前沒有可追問的報告。');
  if (!researchStore) throw new Error('本機研究資料庫未就緒；不會啟動追問模型。');
  const targetItemId = resolveFollowUpItemId(
    report.items, reference, state.research.activeItemId,
  );
  const model = selectVerificationModel(state.session, state.models, requestedSlug);
  const controller = new AbortController();
  researchController = controller;
  state = {
    ...state,
    research: {
      ...state.research,
      status: 'generating',
      command: command.trim(),
      modelSlug: model.slug,
      message: `正在沿用已讀證據回答 ${targetItemId}；不重新搜尋。`,
      error: undefined,
    },
  };
  publish();
  try {
    let reportForAnswer = report;
    let searchContext;
    if (reference.requiresNewSearch) {
      state = {
        ...state,
        research: {
          ...state.research,
          status: 'searching',
          message: `正在為 ${targetItemId} 執行有界補查；最多搜尋兩次。`,
        },
      };
      publish();
      const implementation = isImplementationFollowUp(command);
      const supplement = await runFollowUpSearch({
        searchProvider: implementation
          ? new OfficialWebSearchProvider(chatgpt, model.slug)
          : arxivSearchProvider,
        contentReader: new EvidenceAwareContentReader(new SafeHttpContentReader(), {
          preferArxivHtmlFullText: true,
        }),
      }, report, targetItemId, command, controller.signal);
      reportForAnswer = supplement.reportWithEvidence;
      searchContext = supplement.searchContext;
      state = {
        ...state,
        research: {
          ...state.research,
          status: 'generating',
          message: `已讀取 ${supplement.addedSources.length} 筆補查證據，正在回答 ${targetItemId}。`,
          eligibleSourceCount: supplement.search.candidates.length,
          supplementarySourceCount: supplement.search.supplementaryCandidates.length,
          searchQueries: supplement.search.queryExecutions ?? [],
          uncoveredConcepts: supplement.search.uncoveredConcepts ?? [],
          candidateShortfall: supplement.search.candidateShortfall ?? 0,
          searchCallLimitReached: supplement.search.searchCallLimitReached ?? false,
        },
      };
      publish();
    }
    const answer = await generateFollowUpAnswer(
      new OfficialFollowUpDraftProvider(chatgpt, model.slug),
      reportForAnswer,
      targetItemId,
      command,
      new Date().toISOString(),
      controller.signal,
      searchContext,
    );
    researchStore.appendFollowUp(report.id, command.trim(), answer);
    state = {
      ...state,
      research: {
        ...state.research,
        status: 'completed',
        message: reference.requiresNewSearch
          ? `已完成 ${targetItemId} 的補查追問，並保存實際引用對應。`
          : `已完成 ${targetItemId} 的追問，並保留原始引用對應。`,
        activeItemId: targetItemId,
        followUp: answer,
        error: undefined,
      },
    };
  } catch (error) {
    const problem = publicError(error);
    state = {
      ...state,
      research: {
        ...state.research,
        status: problem.code === 'cancelled' ? 'cancelled' : 'failed',
        message: problem.code === 'cancelled' ? '追問已取消。' : '追問失敗。',
        error: problem,
      },
    };
  } finally {
    if (researchController === controller) researchController = undefined;
    publish();
  }
}

async function runResearch(command: string, requestedSlug?: string): Promise<void> {
  if (researchController) throw new Error('研究任務已在執行中。');
  if (verificationController || webSearchProbeController) {
    throw new Error('請先等待目前的模型驗證或 Web Search 探測完成。');
  }
  if (!researchStore) throw new Error('本機研究資料庫未就緒；不會啟動搜尋或模型呼叫。');
  const interpreted = interpretCommand(command);
  if (interpreted.kind === 'preference_update') {
    const preferences = researchStore.patchPreferences(interpreted.preferencePatch);
    state = {
      ...state,
      preferences,
      research: {
        ...state.research,
        status: state.research.report ? 'completed' : 'idle',
        command: command.trim(),
        message: '長期偏好已更新；這次沒有啟動搜尋或模型呼叫。',
        error: undefined,
      },
    };
    publish();
    return;
  }
  if (interpreted.kind === 'rewrite') {
    const report = state.research.report;
    const format = interpreted.taskOverrides.reportFormat;
    if (!report || !format) throw new Error('目前沒有可改寫的報告。');
    const rewritten = rewriteResearchReport(report, format);
    researchStore?.updateReportPresentation(rewritten);
    state = {
      ...state,
      research: {
        ...state.research,
        status: 'completed',
        command: command.trim(),
        message: '已沿用原報告證據完成格式改寫；沒有重新搜尋或呼叫模型。',
        report: rewritten,
        audit: auditResearchReport(rewritten),
      },
    };
    publish();
    return;
  }
  if (interpreted.kind === 'follow_up' && interpreted.followUp) {
    await runReportFollowUp(command, interpreted.followUp, requestedSlug);
    return;
  }
  if (interpreted.kind !== 'research') {
    throw new Error('指令缺少可執行的研究、改寫或追問設定。');
  }
  const model = selectVerificationModel(state.session, state.models, requestedSlug);
  const task = resolveResearchTask(state.preferences, interpreted.taskOverrides, localIsoDate());
  const understanding = describeResearchTask(task);
  const controller = new AbortController();
  const startedAt = new Date().toISOString();
  let attemptFinalizationStarted = false;
  let checkpointSearch: SearchRunResult | undefined;
  let checkpointEvidence: EvidenceBundle | undefined;
  researchController = controller;
  state = {
    ...state,
    research: {
      status: 'planning', command: command.trim(), modelSlug: model.slug,
      understanding,
      message: '已解析研究任務，準備搜尋。',
    },
  };
  publish();

  try {
    const fallbackReader = new SafeHttpContentReader();
    const searchProvider = task.searchMode === 'web'
      ? new OfficialWebSearchProvider(chatgpt, model.slug)
      : arxivSearchProvider;
    const result = await runResearchPipeline({
      searchProvider,
      contentReader: new EvidenceAwareContentReader(fallbackReader, {
        preferArxivHtmlFullText: true,
      }),
      reportProvider: new OfficialReportDraftProvider(chatgpt, model.slug),
    }, task, controller.signal, {
      onProgress: updateResearchProgress,
      onSearchCompleted: (search) => { checkpointSearch = search; },
      onEvidenceBuilt: ({ search, evidence }) => {
        checkpointSearch = search;
        checkpointEvidence = evidence;
      },
    });
    if (controller.signal.aborted) return;
    const counts = {
      eligibleSourceCount: result.search.candidates.length,
      supplementarySourceCount: result.search.supplementaryCandidates.length,
      searchQueries: result.search.queryExecutions ?? [],
      uncoveredConcepts: result.search.uncoveredConcepts ?? [],
      candidateShortfall: result.search.candidateShortfall ?? 0,
      searchCallLimitReached: result.search.searchCallLimitReached ?? false,
    };
    if (result.status === 'completed') {
      researchStore.saveCompletedResearch({
        command: command.trim(),
        modelSlug: model.slug,
        understanding: result.understanding,
        report: result.report,
        evidence: result.evidence,
      });
      state = {
        ...state,
        reportHistory: researchStore.listReports(),
        research: {
          status: 'completed', command: command.trim(), modelSlug: model.slug,
          understanding: result.understanding,
          message: `完成 ${result.report.items.length} 項研究整理。`,
          report: result.report,
          audit: auditResearchReport(result.report),
          ...counts,
        },
      };
    } else {
      attemptFinalizationStarted = true;
      researchStore.saveResearchAttempt({
        status: result.status,
        stage: result.status === 'no_results' ? 'searching' : 'reading',
        command: command.trim(),
        modelSlug: model.slug,
        understanding: result.understanding,
        startedAt,
        finishedAt: new Date().toISOString(),
        eligibleSourceCount: counts.eligibleSourceCount,
        supplementarySourceCount: counts.supplementarySourceCount,
        failures: result.status === 'no_evidence' ? result.evidence.failures : [],
        eligibleSources: result.search.candidates,
        supplementarySources: result.search.supplementaryCandidates,
      });
      state = {
        ...state,
        attemptHistory: researchStore.listResearchAttempts(),
        research: {
          status: result.status, command: command.trim(), modelSlug: model.slug,
          understanding: result.understanding,
          message: result.status === 'no_results'
            ? result.reason === 'no_date_eligible_sources'
              ? '沒有日期已確認且符合範圍的來源。'
              : '沒有符合搜尋條件的來源。'
            : '找到候選論文，但沒有可用的已讀證據。',
          ...counts,
        },
      };
    }
  } catch (error) {
    const problem = publicError(error);
    let historyWarning = '';
    if (!attemptFinalizationStarted) {
      const currentStage = state.research.status;
      const stage: ResearchAttemptStage = [
        'planning', 'searching', 'reading', 'generating',
      ].includes(currentStage)
        ? currentStage as ResearchAttemptStage
        : 'planning';
      try {
        researchStore.saveResearchAttempt({
          status: problem.code === 'cancelled' ? 'cancelled' : 'failed',
          stage,
          command: command.trim(),
          modelSlug: model.slug,
          understanding,
          startedAt,
          finishedAt: new Date().toISOString(),
          errorCode: problem.code,
          errorMessage: problem.message,
          eligibleSourceCount: checkpointSearch?.candidates.length ??
            state.research.eligibleSourceCount ?? 0,
          supplementarySourceCount: checkpointSearch?.supplementaryCandidates.length ??
            state.research.supplementarySourceCount ?? 0,
          failures: checkpointEvidence?.failures ?? [],
          readSourceIds: checkpointEvidence?.sources.map(({ id }) => id) ?? [],
          eligibleSources: checkpointSearch?.candidates,
          supplementarySources: checkpointSearch?.supplementaryCandidates,
        });
        state = { ...state, attemptHistory: researchStore.listResearchAttempts() };
      } catch {
        historyWarning = '（執行紀錄未能寫入 SQLite。）';
      }
    }
    state = {
      ...state,
      research: {
        ...state.research,
        status: problem.code === 'cancelled' ? 'cancelled' : 'failed',
        message: `${problem.code === 'cancelled' ? '研究任務已取消。' : '研究任務失敗。'}${historyWarning}`,
        ...(checkpointSearch ? {
          searchQueries: checkpointSearch.queryExecutions ?? [],
          uncoveredConcepts: checkpointSearch.uncoveredConcepts ?? [],
          candidateShortfall: checkpointSearch.candidateShortfall ?? 0,
          searchCallLimitReached: checkpointSearch.searchCallLimitReached ?? false,
        } : {}),
        error: problem,
      },
    };
  } finally {
    if (researchController === controller) researchController = undefined;
    publish();
  }
}

function clearPreferences(): void {
  if (!researchStore) throw new Error('本機資料庫尚未就緒。');
  researchStore.clearPreferences();
  state = { ...state, preferences: {} };
  publish();
}

async function disconnectAccount(): Promise<void> {
  verificationController?.abort();
  webSearchProbeController?.abort();
  researchController?.abort();
  catalogController?.abort();
  await accountAction(() => chatgpt.disconnect(), true);
}

function deletePreference(key: string): void {
  if (!researchStore) throw new Error('本機資料庫尚未就緒。');
  state = { ...state, preferences: researchStore.deletePreference(key) };
  publish();
}

function loadReport(reportId: string): void {
  if (!researchStore) throw new Error('本機資料庫尚未就緒。');
  if (researchController) throw new Error('研究任務執行中，無法切換歷史報告。');
  const report = researchStore.getReport(reportId);
  if (!report) throw new Error('找不到指定的歷史報告。');
  const activeItemId = researchStore.getLastReferencedItemId(report.id);
  const latestFollowUp = researchStore.getLatestFollowUp(report.id);
  const evaluationSummary = researchStore.getCitationEvaluation(report.id);
  state = {
    ...state,
    research: {
      status: 'completed',
      command: '',
      understanding: `從 SQLite 載入歷史報告 ${report.id}`,
      message: `已載入 ${report.items.length} 項歷史研究整理。`,
      report,
      audit: auditResearchReport(report),
      ...(evaluationSummary ? { evaluationSummary } : {}),
      ...(activeItemId ? { activeItemId } : {}),
      ...(latestFollowUp ? { followUp: latestFollowUp } : {}),
    },
  };
  publish();
}

function saveMonitoringRule(value: unknown): void {
  if (!researchStore) throw new Error('本機研究資料庫尚未就緒。');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('監測規則格式無效。');
  }
  const input = value as PublicMonitoringRuleInput;
  researchStore.upsertMonitoringRule(input);
  if (input.enabled) createTray();
  refreshMonitoringState('idle', input.enabled
    ? `已保存「${input.name}」；可立即檢查，之後會依排程執行。`
    : `已保存「${input.name}」並暫停背景檢查。`);
  publish();
}

async function runMonitoringNow(ruleId: string): Promise<void> {
  if (!researchStore || !backgroundScheduler) throw new Error('背景監測尚未就緒。');
  researchStore.scheduleMonitoringRuleNow(ruleId);
  refreshMonitoringState('idle', '已將監測排到現在。');
  publish();
  const ran = await backgroundScheduler.tick();
  if (!ran) {
    refreshMonitoringState('idle', '前景任務或另一輪監測正在執行；本次檢查已排隊。');
    publish();
  }
}

function setMonitoringItemStatus(
  ruleId: string,
  sourceId: string,
  status: PublicMonitoringInboxItem['status'],
): void {
  if (!researchStore) throw new Error('本機研究資料庫尚未就緒。');
  researchStore.setMonitoringItemStatus(ruleId, sourceId, status);
  refreshMonitoringState();
  publish();
}

function setMonitoringItemFeedback(
  ruleId: string,
  sourceId: string,
  feedback: unknown,
): void {
  if (!researchStore) throw new Error('本機研究資料庫尚未就緒。');
  researchStore.setMonitoringItemFeedback(
    ruleId,
    sourceId,
    validateMonitoringFeedback(feedback),
  );
  refreshMonitoringState('idle', '已保存你的明確回饋；後續候選會使用可解釋規則重新排序。');
  publish();
}

async function researchMonitoringItem(
  ruleId: string,
  sourceId: string,
  requestedSlug?: string,
): Promise<void> {
  if (researchController) throw new Error('研究任務已在執行中。');
  if (verificationController || webSearchProbeController) {
    throw new Error('請先等待目前的模型驗證或 Web Search 探測完成。');
  }
  if (!researchStore) throw new Error('本機研究資料庫尚未就緒。');
  const item = researchStore.getMonitoringInboxItem(ruleId, sourceId);
  if (!item) throw new Error('找不到指定的監測來源。');
  if (item.linkedReportId) {
    loadReport(item.linkedReportId);
    state = {
      ...state,
      research: {
        ...state.research,
        message: '這個監測來源已有深入報告；已直接載入，沒有重新搜尋或呼叫模型。',
      },
    };
    publish();
    return;
  }
  const model = selectVerificationModel(state.session, state.models, requestedSlug);
  const task = monitoringResearchTask(item);
  const understanding = `從監測來源深入研究：${item.candidate.title}；固定來源 ID：${item.sourceId}`;
  const command = `深入研究監測來源：${item.candidate.title}`;
  const controller = new AbortController();
  researchController = controller;
  state = {
    ...state,
    research: {
      status: 'planning',
      command,
      modelSlug: model.slug,
      understanding,
      message: '已鎖定監測來源，準備讀取原始內容。',
    },
  };
  publish();

  try {
    const result = await runResearchPipeline({
      searchProvider: new MonitoringItemSearchProvider(item),
      contentReader: new EvidenceAwareContentReader(new SafeHttpContentReader(), {
        preferArxivHtmlFullText: true,
      }),
      reportProvider: new OfficialReportDraftProvider(chatgpt, model.slug),
    }, task, controller.signal, {
      maxSearchCandidates: 1,
      maxReadSources: 1,
      onProgress: updateResearchProgress,
    });
    if (controller.signal.aborted) return;
    if (result.status !== 'completed') {
      throw new Error(result.status === 'no_evidence'
        ? '固定來源無法取得可引用內容，未建立深入報告。'
        : '固定來源未通過研究條件，未建立深入報告。');
    }
    researchStore.saveCompletedResearch({
      command,
      modelSlug: model.slug,
      understanding,
      report: result.report,
      evidence: result.evidence,
    });
    researchStore.linkMonitoringItemReport(ruleId, sourceId, result.report.id);
    refreshMonitoringState('idle', '已完成監測來源的深入研究並建立可追溯報告。');
    state = {
      ...state,
      reportHistory: researchStore.listReports(),
      research: {
        status: 'completed',
        command,
        modelSlug: model.slug,
        understanding,
        message: '已沿固定監測來源完成深入研究；來源與報告連結已保存。',
        report: result.report,
        audit: auditResearchReport(result.report),
        eligibleSourceCount: 1,
        supplementarySourceCount: 0,
        searchQueries: result.search.queryExecutions ?? [],
        uncoveredConcepts: [],
        candidateShortfall: 0,
        searchCallLimitReached: false,
      },
    };
  } catch (error) {
    const problem = publicError(error);
    state = {
      ...state,
      research: {
        ...state.research,
        status: problem.code === 'cancelled' ? 'cancelled' : 'failed',
        message: problem.code === 'cancelled'
          ? '監測來源深入研究已取消。'
          : '監測來源深入研究失敗。',
        error: problem,
      },
    };
  } finally {
    if (researchController === controller) researchController = undefined;
    publish();
  }
}

async function saveMarkdownDocument(
  title: string,
  defaultPath: string,
  content: string,
): Promise<{ saved: boolean; path?: string }> {
  const saveOptions: Electron.SaveDialogOptions = {
    title,
    defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const selection = window
    ? await dialog.showSaveDialog(window, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (selection.canceled || !selection.filePath) return { saved: false };
  await writeFile(selection.filePath, content, { encoding: 'utf8', flag: 'wx' }).catch(
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      await writeFile(selection.filePath!, content, 'utf8');
    },
  );
  return { saved: true, path: selection.filePath };
}

async function exportResearchReport(): Promise<{ saved: boolean; path?: string }> {
  const report = state.research.report;
  if (!report) throw new Error('目前沒有可匯出的研究報告。');
  const safeTopic = report.topic.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 60);
  return saveMarkdownDocument(
    '匯出 Markdown 報告', `${safeTopic || report.id}.md`, report.markdown,
  );
}

async function exportEvaluationWorksheet(): Promise<{ saved: boolean; path?: string }> {
  const report = state.research.report;
  if (!report) throw new Error('目前沒有可建立評估工作表的研究報告。');
  const safeTopic = report.topic.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 52);
  return saveMarkdownDocument(
    '匯出 citation support 評估工作表',
    `${safeTopic || report.id}-evaluation.md`,
    buildEvaluationWorksheet(report),
  );
}

async function importEvaluationWorksheet(): Promise<{ imported: boolean; path?: string }> {
  const report = state.research.report;
  if (!report) throw new Error('目前沒有可評估的研究報告。');
  const openOptions: Electron.OpenDialogOptions = {
    title: '匯入已標註的 citation support 工作表',
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const selection = window
    ? await dialog.showOpenDialog(window, openOptions)
    : await dialog.showOpenDialog(openOptions);
  if (selection.canceled || selection.filePaths.length !== 1) return { imported: false };
  const path = selection.filePaths[0];
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 2_000_000) {
    throw new Error('評估工作表必須是 1 byte 到 2 MB 的一般檔案。');
  }
  const summary = summarizeEvaluationWorksheet(report, await readFile(path, 'utf8'));
  if (!researchStore) throw new Error('本機研究資料庫未就緒。');
  const persistedSummary = researchStore.saveCitationEvaluation(summary);
  state = {
    ...state,
    research: { ...state.research, evaluationSummary: persistedSummary },
  };
  publish();
  return { imported: true, path };
}

function databasePath(): string {
  return join(app.getPath('userData'), 'research.sqlite');
}

function ensureDataTransferReady(): ResearchStore {
  if (dataTransferBusy) throw new Error('另一個資料匯入或匯出仍在進行中。');
  if (researchController) throw new Error('請先等研究任務完成或取消，再匯入／匯出資料。');
  if (!researchStore) throw new Error('研究資料庫尚未就緒。');
  return researchStore;
}

async function exportPortableData(): Promise<{ saved: boolean; path?: string }> {
  const store = ensureDataTransferReady();
  const date = new Date().toISOString().slice(0, 10);
  const options: Electron.SaveDialogOptions = {
    title: '匯出可攜式研究資料',
    defaultPath: `AI-Research-Assistant-${date}.ara-backup`,
    filters: [{ name: 'AI Research Assistant Backup', extensions: ['ara-backup'] }],
  };
  const selection = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (selection.canceled || !selection.filePath) return { saved: false };

  const temporaryDirectory = await mkdtemp(join(app.getPath('userData'), 'export-'));
  dataTransferBusy = true;
  backgroundScheduler?.stop();
  try {
    const snapshotPath = join(temporaryDirectory, 'research.sqlite');
    store.createSnapshot(snapshotPath);
    const archive = createPortableBackup(await readFile(snapshotPath), {
      createdAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      schemaVersion: store.schemaVersion(),
    });
    await writeFile(selection.filePath, archive);
    return { saved: true, path: selection.filePath };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    dataTransferBusy = false;
    backgroundScheduler?.start();
  }
}

async function importPortableData(): Promise<{
  imported: boolean;
  path?: string;
  recoveryPath?: string;
}> {
  ensureDataTransferReady();
  const options: Electron.OpenDialogOptions = {
    title: '匯入可攜式研究資料',
    properties: ['openFile'],
    filters: [{ name: 'AI Research Assistant Backup', extensions: ['ara-backup'] }],
  };
  const selection = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || selection.filePaths.length !== 1) return { imported: false };
  const sourcePath = selection.filePaths[0];
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.size < 1 || sourceInfo.size > 150_000_000) {
    throw new Error('備份檔必須是小於 150 MB 的一般檔案。');
  }
  const confirmation = window ? await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['取消', '匯入並取代'],
    defaultId: 0,
    cancelId: 0,
    title: '取代目前研究資料？',
    message: '匯入會取代目前的報告、偏好與監控資料。',
    detail: 'ChatGPT 登入不受影響；程式會先保留一份可回復的 SQLite 副本。',
  }) : { response: 0 };
  if (confirmation.response !== 1) return { imported: false };

  const transferDirectory = await mkdtemp(join(app.getPath('userData'), 'import-'));
  dataTransferBusy = true;
  backgroundScheduler?.stop();
  const candidatePath = join(transferDirectory, 'research.sqlite');
  const recoveryPath = join(app.getPath('userData'), 'research.before-import.sqlite');
  let storeClosed = false;
  let recoveryCreated = false;
  try {
    const { database } = readPortableBackup(await readFile(sourcePath));
    await writeFile(candidatePath, database, { flag: 'wx' });
    const candidateStore = new ResearchStore(candidatePath);
    try {
      candidateStore.checkIntegrity();
    } finally {
      candidateStore.close();
    }

    researchStore!.close();
    researchStore = undefined;
    storeClosed = true;
    await copyFile(databasePath(), recoveryPath);
    recoveryCreated = true;
    try {
      await copyFile(candidatePath, databasePath());
      researchStore = new ResearchStore(databasePath());
      researchStore.checkIntegrity();
    } catch (error) {
      if (recoveryCreated) await copyFile(recoveryPath, databasePath());
      researchStore = new ResearchStore(databasePath());
      throw error;
    }
    state = {
      ...state,
      preferences: researchStore.getPreferences(),
      reportHistory: researchStore.listReports(),
      attemptHistory: researchStore.listResearchAttempts(),
      research: {
        status: 'idle',
        command: '',
        message: '已匯入研究資料；ChatGPT 登入憑證仍沿用本機設定。',
      },
    };
    refreshMonitoringState('idle', '已從備份重新載入監控資料。');
    publish();
    return { imported: true, path: sourcePath, recoveryPath };
  } catch (error) {
    if (storeClosed && !researchStore) {
      if (recoveryCreated) await copyFile(recoveryPath, databasePath());
      researchStore = new ResearchStore(databasePath());
    }
    throw error;
  } finally {
    await rm(transferDirectory, { recursive: true, force: true });
    dataTransferBusy = false;
    backgroundScheduler?.start();
  }
}

function validateSender(event: IpcMainInvokeEvent): void {
  if (
    !window || event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !event.senderFrame.url.startsWith(appUrl)
  ) throw new Error('此操作只能由 AI Research Assistant 主視窗呼叫。');
}

function handle<Args extends unknown[]>(channel: string, action: (...args: Args) => unknown): void {
  ipcMain.handle(`research-assistant:${channel}`, (event, ...args: unknown[]) => {
    validateSender(event);
    return action(...(args as Args));
  });
}

function installIpc(): void {
  handle('get-state', () => state);
  handle('sign-in', () => accountAction(() => chatgpt.signIn()));
  handle('reconnect-sharing', () => accountAction(() => chatgpt.signIn({ reconsent: true })));
  handle('cancel-sign-in', () => chatgpt.cancelSignIn());
  handle('refresh-models', refreshModels);
  handle('verify', (modelSlug: unknown) =>
    runVerification(optionalIpcText(modelSlug, '模型名稱', 200))
  );
  handle('cancel-verification', () => verificationController?.abort());
  handle('probe-web-search', (modelSlug: unknown) =>
    runWebSearchProbe(optionalIpcText(modelSlug, '模型名稱', 200))
  );
  handle('cancel-web-search-probe', () => webSearchProbeController?.abort());
  handle('run-research', (command: unknown, modelSlug: unknown) => runResearch(
    requiredIpcText(command, '研究指令', 2_000),
    optionalIpcText(modelSlug, '模型名稱', 200),
  ));
  handle('cancel-research', () => researchController?.abort());
  handle('export-research-report', exportResearchReport);
  handle('export-evaluation-worksheet', exportEvaluationWorksheet);
  handle('import-evaluation-worksheet', importEvaluationWorksheet);
  handle('export-portable-data', exportPortableData);
  handle('import-portable-data', importPortableData);
  handle('clear-preferences', clearPreferences);
  handle('delete-preference', (key: unknown) =>
    deletePreference(requiredIpcText(key, '偏好欄位', 50))
  );
  handle('load-report', (reportId: unknown) =>
    loadReport(requiredIpcText(reportId, '報告 ID', 100))
  );
  handle('save-monitoring-rule', saveMonitoringRule);
  handle('run-monitoring-now', (ruleId: unknown) =>
    runMonitoringNow(requiredIpcText(ruleId, '監測規則 ID', 64))
  );
  handle('set-monitoring-item-status', (
    ruleId: unknown, sourceId: unknown, status: unknown,
  ) => {
    const safeStatus = requiredIpcText(status, '監測項目狀態', 20);
    if (!['new', 'read', 'dismissed'].includes(safeStatus)) {
      throw new Error('監測項目狀態無效。');
    }
    setMonitoringItemStatus(
      requiredIpcText(ruleId, '監測規則 ID', 64),
      requiredIpcText(sourceId, '監測來源 ID', 100),
      safeStatus as PublicMonitoringInboxItem['status'],
    );
  });
  handle('set-monitoring-item-feedback', (
    ruleId: unknown, sourceId: unknown, feedback: unknown,
  ) => setMonitoringItemFeedback(
    requiredIpcText(ruleId, '監測規則 ID', 64),
    requiredIpcText(sourceId, '監測來源 ID', 100),
    feedback,
  ));
  handle('research-monitoring-item', (
    ruleId: unknown, sourceId: unknown, modelSlug: unknown,
  ) => researchMonitoringItem(
    requiredIpcText(ruleId, '監測規則 ID', 64),
    requiredIpcText(sourceId, '監測來源 ID', 100),
    optionalIpcText(modelSlug, '模型名稱', 200),
  ));
  handle('set-launch-at-login', setLaunchAtLogin);
  handle('open-source', async (value: string) => {
    const url = typeof value === 'string' ? normalizePublicHttpUrl(value) : undefined;
    if (!url) throw new Error('只允許開啟公開 HTTP(S) 來源。');
    await shell.openExternal(url);
  });
  handle('disconnect', disconnectAccount);
  handle('open-usage', () => shell.openExternal(CHATGPT_USAGE_URL));
}

function installProtocol(): void {
  protocol.handle('ai-research', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return new Response('Bad request', { status: 400 }); }
    const path = resolve(rendererDirectory, `.${pathname === '/' ? '/index.html' : pathname}`);
    const within = relative(rendererDirectory, path);
    if (within.startsWith('..') || isAbsolute(within)) return new Response('Not found', { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(path).href);
      const headers = new Headers(response.headers);
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
      );
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers,
      });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

async function createWindow(show = true): Promise<void> {
  window = new BrowserWindow({
    width: 1080, height: 820, minWidth: 820, minHeight: 650,
    title: 'AI Research Assistant — Active Monitoring', backgroundColor: '#f4f4ef', show,
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  createTray();
  window.on('close', (event) => {
    if (quitting || !monitoringEnabled() || !tray) return;
    event.preventDefault();
    window?.hide();
    if (!backgroundNoticeShown && Notification.isSupported()) {
      backgroundNoticeShown = true;
      new Notification({
        title: 'AI Research Assistant 仍在背景監測',
        body: '可從系統匣重新開啟；若要完全停止，請在系統匣選擇「結束」。',
      }).show();
    }
  });
  await window.webContents.session.clearCache();
  await window.loadURL(appUrl);
  window.setTitle('AI Research Assistant — Active Monitoring');
  if (show) { window.show(); window.focus(); }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    focusMainWindow();
  });
  app.whenReady().then(async () => {
    installProtocol();
    installIpc();
    await mkdir(app.getPath('userData'), { recursive: true });
    try {
      researchStore = new ResearchStore(join(app.getPath('userData'), 'research.sqlite'));
      state = {
        ...state,
        preferences: researchStore.getPreferences(),
        reportHistory: researchStore.listReports(),
        attemptHistory: researchStore.listResearchAttempts(),
      };
      refreshMonitoringState();
      state = { ...state, launchAtLogin: launchAtLoginEnabled() };
      backgroundScheduler = createBackgroundScheduler();
    } catch (error) {
      researchStore?.close();
      researchStore = undefined;
      state = {
        ...state,
        research: {
          status: 'failed',
          command: '',
          message: '本機研究資料庫初始化失敗；研究功能不會發出模型請求。',
          error: publicError(error),
        },
      };
    }
    if (packageSmokeTest) {
      if (!researchStore) process.exitCode = 1;
      else researchStore.checkIntegrity();
      app.quit();
      return;
    }
    await createWindow(!(backgroundLaunch && monitoringEnabled()));
    try { await refreshAccount(); }
    catch (error) {
      state = { ...state, session: { ...disconnected, error: publicError(error) } };
      publish();
    }
    // Restore the account and model catalog before the first scheduled tick so
    // an opted-in auto brief is not skipped simply because startup is racing.
    backgroundScheduler?.start();
  });
}

app.on('window-all-closed', () => {
  if (!monitoringEnabled() || !tray) app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  backgroundScheduler?.stop();
  catalogController?.abort();
  verificationController?.abort();
  webSearchProbeController?.abort();
  researchController?.abort();
  chatgpt.cancelSignIn();
  researchStore?.close();
  tray?.destroy();
  tray = undefined;
});
