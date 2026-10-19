import { useEffect, useState } from 'react';
import { ChatGPTConnectionCard, ChatGPTUsageIndicator } from '@siwc/react';
import { preferredDevelopmentModel, type AppState, type PublicError } from '../shared';
import { MonitoringPanel } from './MonitoringPanel';

const initialState: AppState = {
  session: { status: 'disconnected', sharing: false },
  profiles: [], accountBusy: false, models: [], modelsStatus: 'idle',
  verification: { status: 'idle', text: '' },
  webSearchProbe: { status: 'idle', text: '', sources: [] },
  research: { status: 'idle', command: '', message: '' },
  preferences: {}, reportHistory: [], attemptHistory: [],
  monitoring: {
    status: 'idle', message: '背景監測尚未設定。', rules: [], inbox: [],
    processedInbox: [], runs: [],
  },
  launchAtLogin: false,
  dataDirectory: '',
};

const statusText: Record<AppState['verification']['status'], string> = {
  idle: '尚未執行', running: '執行中…', passed: '驗證通過',
  failed: '驗證失敗', cancelled: '已取消',
};

const attemptStatusText: Record<AppState['attemptHistory'][number]['status'], string> = {
  no_results: '沒有符合搜尋條件的來源',
  no_evidence: '來源皆未成功讀取',
  failed: '執行失敗',
  cancelled: '使用者取消',
};

function formatTime(value?: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'medium' })
    .format(new Date(value));
}

function ErrorDetails({ error }: { error?: PublicError }) {
  if (!error) return null;
  return <><small>錯誤代碼：{error.code}</small>
    {error.requestId && <small>Request ID：{error.requestId}</small>}</>;
}

export function App() {
  const [state, setState] = useState(initialState);
  const [selectedModel, setSelectedModel] = useState('');
  const [researchCommand, setResearchCommand] = useState(
    '幫我找最近七天 AI Agent 與 RAG 的新技術，最多整理三項，優先有論文或開源程式碼的內容。',
  );
  const [preferenceCommand, setPreferenceCommand] = useState('以後先給三個重點');
  const [uiError, setUiError] = useState('');
  const [dataTransferMessage, setDataTransferMessage] = useState('');

  useEffect(() => {
    let mounted = true;
    window.researchAssistant.getState().then((value) => mounted && setState(value));
    const unsubscribe = window.researchAssistant.onState((value) => {
      setState(value); setUiError('');
    });
    return () => { mounted = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!state.models.some((model) => model.slug === selectedModel)) {
      setSelectedModel(preferredDevelopmentModel(state.models)?.slug ?? '');
    }
  }, [state.models, selectedModel]);


  const call = async (action: () => Promise<void>) => {
    setUiError('');
    try { await action(); }
    catch (error) { setUiError(error instanceof Error ? error.message : '操作失敗。'); }
  };
  const connectionAction = () => state.session.status === 'connected'
    ? call(() => window.researchAssistant.reconnectSharing())
    : call(() => window.researchAssistant.signIn());
  const activeError = state.research.error ?? state.webSearchProbe.error ?? state.verification.error ??
    state.modelsError ?? state.session.error;
  const visibleError = uiError || activeError?.message;
  const usageLimitReached = activeError?.code === 'subscription_sharing_usage_limit_exceeded';
  const researchRunning = ['planning', 'searching', 'reading', 'generating']
    .includes(state.research.status);
  const localOnlyCommand = /(?:以後|之後都|未來都|改成比較表|短摘要|簡短摘要|精簡版|詳細報告|完整版)/
    .test(researchCommand);
  const requestRunning = state.verification.status === 'running' ||
    state.webSearchProbe.status === 'running' || researchRunning;
  const phaseBPassed = state.research.status === 'completed';

  return <main className="shell">
    <header className="hero">
      <div><span className="eyebrow">LOCAL-FIRST · PHASE B</span>
        <h1>AI Research Assistant</h1>
        <p>以公開論文來源建立可追溯的研究證據鏈，再交由 ChatGPT 模型整理為繁體中文報告。</p>
      </div>
      <div className={`phase-badge phase-badge--${phaseBPassed ? 'passed' : 'idle'}`}>
        {phaseBPassed ? 'B 研究管線通過' : 'B 研究開發中'}
      </div>
    </header>

    <section className="grid">
      <div className="panel connection-panel">
        <div className="section-heading"><div><span className="step">01</span><h2>連線與方案授權</h2></div>
          {state.session.status === 'connected' && state.session.sharing &&
            <ChatGPTUsageIndicator source="plan"
              onManageUsage={() => call(() => window.researchAssistant.openUsage())} />}
        </div>
        <ChatGPTConnectionCard
          status={state.accountBusy ? 'connecting' : state.session.status}
          sharing={state.session.sharing} identity={state.session.identity}
          appName="AI Research Assistant" context="setup"
          onConnect={connectionAction}
          onDisconnect={() => call(() => window.researchAssistant.disconnect())}
          onManageUsage={() => call(() => window.researchAssistant.openUsage())} />
        {state.accountBusy && <button className="text-button" type="button"
          onClick={() => call(() => window.researchAssistant.cancelSignIn())}>取消登入</button>}
        {state.session.status === 'connected' && !state.session.sharing &&
          <div className="notice notice--warning">已登入，但尚未授予
            <code> chatgpt.tokens.use.direct</code>。請重新連線並允許方案用量分享。</div>}
      </div>

      <div className="panel verify-panel">
        <div className="section-heading"><div><span className="step">02</span><h2>最小真實模型呼叫</h2></div></div>
        <label className="field"><span>帳號可用模型</span>
          <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}
            disabled={state.modelsStatus !== 'ready' || requestRunning}>
            {state.models.length === 0 && <option value="">目前沒有可用模型</option>}
            {state.models.map((model) => <option key={model.slug} value={model.slug}>
              {model.displayName} ({model.slug})</option>)}
          </select>
        </label>
        <p className="muted model-note">開發預設使用 Luna；下方兩個驗證按鈕都會消耗五小時共享額度。</p>
        <div className="button-row">
          <button className="primary-button" type="button"
            disabled={!state.session.sharing || !selectedModel || requestRunning}
            onClick={() => call(() => window.researchAssistant.verify(selectedModel))}>執行真實驗證</button>
          {state.verification.status === 'running' && <button className="secondary-button" type="button"
            onClick={() => call(() => window.researchAssistant.cancelVerification())}>取消驗證</button>}
          {state.session.sharing && <button className="text-button" type="button" disabled={requestRunning}
            onClick={() => call(() => window.researchAssistant.refreshModels())}>重新整理模型</button>}
        </div>
        <div className={`result result--${state.verification.status}`} aria-live="polite">
          <strong>{statusText[state.verification.status]}</strong>
          {state.verification.modelSlug && <span>模型：{state.verification.modelSlug}</span>}
          {state.verification.text && <pre>{state.verification.text}</pre>}
          {state.verification.completedAt && <span>完成時間：{formatTime(state.verification.completedAt)}</span>}
        </div>
      </div>
    </section>

    {visibleError && <section className="notice notice--error" role="alert">
      <strong>{usageLimitReached ? 'ChatGPT 方案用量已達上限：' : '目前無法完成：'}</strong>{' '}
      {visibleError}<ErrorDetails error={activeError} />
      {usageLimitReached && <button className="primary-button error-action" type="button"
        onClick={() => call(() => window.researchAssistant.openUsage())}>Manage usage</button>}
    </section>}

    <section className="panel search-panel">
      <div className="section-heading"><div><span className="step">03</span><h2>官方 Web Search 能力探測</h2></div></div>
      <p className="unit-copy">這個探測會要求目前選取的模型搜尋一頁官方 OpenAI 文件。只有同時收到
        <code> web_search_call</code> 證據、公開 HTTP(S) 來源與完成文字才算通過。</p>
      <div className="button-row">
        <button className="primary-button" type="button"
          disabled={!state.session.sharing || !selectedModel || requestRunning}
          onClick={() => call(() => window.researchAssistant.probeWebSearch(selectedModel))}>驗證官方 Web Search</button>
        {state.webSearchProbe.status === 'running' && <button className="secondary-button" type="button"
          onClick={() => call(() => window.researchAssistant.cancelWebSearchProbe())}>取消搜尋</button>}
      </div>
      <div className={`result result--${state.webSearchProbe.status}`} aria-live="polite">
        <strong>{statusText[state.webSearchProbe.status]}</strong>
        {state.webSearchProbe.modelSlug && <span>模型：{state.webSearchProbe.modelSlug}</span>}
        {state.webSearchProbe.text && <pre>{state.webSearchProbe.text}</pre>}
        {state.webSearchProbe.sources.length > 0 && <div className="source-list">
          <span>已驗證來源（{state.webSearchProbe.sources.length}）</span>
          {state.webSearchProbe.sources.map((source) => <button key={source.url}
            className="source-button" type="button"
            onClick={() => call(() => window.researchAssistant.openSource(source.url))}>
            <strong>{source.title || new URL(source.url).hostname}</strong><small>{source.url}</small>
          </button>)}
        </div>}
        {state.webSearchProbe.completedAt && <span>完成時間：{formatTime(state.webSearchProbe.completedAt)}</span>}
      </div>
    </section>

    <section className="panel research-panel">
      <div className="section-heading"><div><span className="step">04</span><h2>有證據的論文研究</h2></div></div>
      <p className="unit-copy">預設搜尋範圍是 arXiv 公開 metadata API，會取得標題、作者、首次提交日、更新日與摘要。
        這是「摘要級」證據，不會假裝已讀完 PDF 全文；最後的報告生成會消耗一次 ChatGPT 方案用量。
        明確輸入「使用官方 Web Search，日期不限」才會改用網路來源，通常另消耗一次搜尋工具請求；目前無法核對
        Web Search 候選的發布日，因此不能與「最近七天」同時使用。</p>
      <label className="field research-input"><span>研究指令</span>
        <textarea value={researchCommand} maxLength={2000} rows={4}
          disabled={researchRunning}
          onChange={(event) => setResearchCommand(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="primary-button" type="button"
          disabled={requestRunning || !researchCommand.trim() ||
            (!localOnlyCommand && (!state.session.sharing || !selectedModel))}
          onClick={() => call(() => window.researchAssistant.runResearch(
            researchCommand, selectedModel || undefined,
          ))}>送出指令</button>
        {researchRunning && <button className="secondary-button" type="button"
          onClick={() => call(() => window.researchAssistant.cancelResearch())}>取消任務</button>}
        {state.research.report && <button className="secondary-button" type="button"
          disabled={researchRunning}
          onClick={() => call(async () => { await window.researchAssistant.exportResearchReport(); })}>
          匯出 Markdown</button>}
        {state.research.report && <button className="secondary-button" type="button"
          disabled={researchRunning}
          onClick={() => call(async () => {
            await window.researchAssistant.exportEvaluationWorksheet();
          })}>匯出評估工作表</button>}
        {state.research.report && <button className="secondary-button" type="button"
          disabled={researchRunning}
          onClick={() => call(async () => {
            await window.researchAssistant.importEvaluationWorksheet();
          })}>匯入已標註工作表</button>}
      </div>
      <div className={`result research-result result--${
        state.research.status === 'completed' ? 'passed' :
        state.research.status === 'failed' ? 'failed' :
        researchRunning ? 'running' : state.research.status
      }`} aria-live="polite">
        <strong>{state.research.status === 'idle' ? '尚未執行' : state.research.message}</strong>
        {state.research.modelSlug && <span>報告模型：{state.research.modelSlug}</span>}
        {state.research.understanding && <span>任務理解：{state.research.understanding}</span>}
        {state.research.error && <span>失敗原因：{state.research.error.message}</span>}
        {state.research.activeItemId && <span>目前對話指向：{state.research.activeItemId}</span>}
        {state.research.eligibleSourceCount !== undefined && <span>
          正式候選：{state.research.eligibleSourceCount}；
          日期待核對：{state.research.supplementarySourceCount ?? 0}</span>}
        {state.research.searchQueries && state.research.searchQueries.length > 0 && <span>
          搜尋步驟：{state.research.searchQueries.map((query, index) =>
            `${index + 1}.${query.kind === 'primary' ? '主查詢' : '缺口補查'}「${query.query}」`)
            .join('；')}
        </span>}
        {state.research.uncoveredConcepts && state.research.uncoveredConcepts.length > 0 && <span>
          尚未涵蓋：{state.research.uncoveredConcepts.join('、')}
          {state.research.searchCallLimitReached ? '（已達搜尋呼叫上限）' : ''}
        </span>}
        {Boolean(state.research.candidateShortfall) && <span>
          符合條件的候選仍少 {state.research.candidateShortfall} 筆
          {state.research.searchCallLimitReached ? '（已達搜尋呼叫上限，不會湊數）' : ''}
        </span>}
        {state.research.followUp && <div className="follow-up-result">
          <strong>追問回答 · {state.research.followUp.targetItemId}</strong>
          <pre className="report-markdown">{state.research.followUp.markdown}</pre>
        </div>}
        {state.research.report && <>
          {state.research.audit && <div className="preference-grid report-audit">
            <span><strong>來源主張</strong><code>{state.research.audit.sourceClaimCount}</code></span>
            <span><strong>引用連結</strong><code>{state.research.audit.citationReferenceCount}</code></span>
            <span><strong>日期已知</strong><code>{state.research.audit.knownPublicationDateCount}/
              {state.research.audit.citedSourceCount}</code></span>
            <span><strong>摘要級來源</strong><code>{state.research.audit.abstractOnlySourceCount}</code></span>
            <span><strong>全文來源</strong><code>{state.research.audit.fullTextSourceCount}</code></span>
            <span><strong>數值待核對</strong><code>{state.research.audit.numericGroundingWarningCount}/
              {state.research.audit.numericClaimCount}</code></span>
            <small>{state.research.audit.warnings.join(' ')}</small>
          </div>}
          {state.research.evaluationSummary && <div className="preference-grid report-audit">
            <span><strong>人工已評估</strong><code>{state.research.evaluationSummary.evaluated}/
              {state.research.evaluationSummary.total}</code></span>
            <span><strong>完整支持</strong><code>{state.research.evaluationSummary.counts.supported}</code></span>
            <span><strong>部分支持</strong><code>{state.research.evaluationSummary.counts.partially_supported}</code></span>
            <span><strong>不支持／不明</strong><code>{state.research.evaluationSummary.counts.unsupported}/
              {state.research.evaluationSummary.counts.unclear}</code></span>
            <small>嚴格支持率：{state.research.evaluationSummary.strictSupportedRate === null
              ? '尚無標註'
              : `${(state.research.evaluationSummary.strictSupportedRate * 100).toFixed(1)}%`}；
              完整或部分支持率：{state.research.evaluationSummary.supportedOrPartialRate === null
                ? '尚無標註'
                : `${(state.research.evaluationSummary.supportedOrPartialRate * 100).toFixed(1)}%`}。
              分母只包含已勾選的人工標註。</small>
          </div>}
          <div className="source-list">
            <span>報告實際引用來源（{state.research.report.citedSources.length}）</span>
            {state.research.report.citedSources.map((source) => <div key={source.id}
              className="evidence-source-card">
              <button className="source-button" type="button"
                onClick={() => call(() => window.researchAssistant.openSource(source.url))}>
                <strong>{source.title}</strong>
                <small>{source.publishedDate ?? '日期未知'} · {
                  source.evidenceLevel === 'abstract' ? '僅論文摘要' :
                    source.evidenceLevel === 'full_text' ? '論文 HTML 全文' : source.evidenceLevel
                }</small>
              </button>
              <details className="evidence-details">
                <summary>查看實際讀取證據</summary>
                <small>來源 ID：{source.id} · 擷取：{formatTime(source.retrievedAt)} ·
                  hash：{source.contentHash.slice(0, 12)}…</small>
                <pre>{source.content}</pre>
              </details>
            </div>)}
          </div>
          <pre className="report-markdown">{state.research.report.markdown}</pre>
        </>}
      </div>
    </section>

    <MonitoringPanel monitoring={state.monitoring} launchAtLogin={state.launchAtLogin} call={call} />

    <section className="panel evidence-panel">
      <div className="section-heading"><div><span className="step">06</span><h2>長期偏好</h2></div></div>
      <p className="unit-copy">只有「以後…」會寫入 SQLite；「這次…」只會合併到當次任務。更新偏好不會呼叫模型。</p>
      <div className="preference-grid">
        {Object.keys(state.preferences).length === 0
          ? <span className="muted">目前沒有自訂長期偏好，使用系統預設。</span>
          : Object.entries(state.preferences).map(([key, value]) => <span key={key}>
            <strong>{key}</strong><code>{String(value)}</code>
            <button className="preference-delete" type="button" disabled={requestRunning}
              aria-label={`刪除偏好 ${key}`}
              onClick={() => call(() => window.researchAssistant.deletePreference(key))}>×</button>
          </span>)}
      </div>
      <label className="field preference-input"><span>偏好指令</span>
        <input value={preferenceCommand} maxLength={2000}
          onChange={(event) => setPreferenceCommand(event.target.value)} />
      </label>
      <div className="button-row">
        <button className="primary-button" type="button"
          disabled={requestRunning || !preferenceCommand.trim()}
          onClick={() => call(() => window.researchAssistant.runResearch(preferenceCommand))}>
          儲存長期偏好</button>
        <button className="secondary-button" type="button"
          disabled={requestRunning || Object.keys(state.preferences).length === 0}
          onClick={() => call(() => window.researchAssistant.clearPreferences())}>
          清除所有自訂偏好</button>
      </div>
      {state.research.command === preferenceCommand && state.research.message &&
        <p className="notice notice--success">{state.research.message}</p>}
    </section>

    <section className="panel evidence-panel">
      <div className="section-heading"><div><span className="step">07</span><h2>歷史報告</h2></div></div>
      {state.reportHistory.length === 0
        ? <p className="muted">尚未儲存真實研究報告。</p>
        : <div className="history-list">{state.reportHistory.map((report) =>
          <button key={report.id} className="history-button" type="button"
            disabled={researchRunning}
            onClick={() => call(() => window.researchAssistant.loadReport(report.id))}>
            <strong>{report.topic}</strong>
            <small>{formatTime(report.generatedAt)} · {report.itemCount} 項 · {report.citedSourceCount} 來源</small>
          </button>)}</div>}
      <details className="attempt-history">
        <summary>查看未完成執行紀錄（{state.attemptHistory.length}）</summary>
        {state.attemptHistory.length === 0
          ? <p className="muted">目前沒有未完成的研究紀錄。</p>
          : <div className="history-list">{state.attemptHistory.map((attempt) =>
            <div key={attempt.id} className="history-button history-button--static">
              <strong>{attemptStatusText[attempt.status]} · {attempt.stage}</strong>
              <small>{formatTime(attempt.finishedAt)} · {attempt.modelSlug}</small>
              <span>{attempt.command}</span>
              <small>正式候選 {attempt.eligibleSourceCount} 筆 · 日期待核對 {attempt.supplementarySourceCount} 筆 · 讀取失敗 {attempt.failureCount} 筆</small>
              {attempt.errorMessage && <small>原因：{attempt.errorMessage}</small>}
              {attempt.sources.length > 0 && <details className="attempt-sources">
                <summary>查看候選來源（{attempt.sources.length}）</summary>
                {attempt.sources.map((source) => <button key={source.sourceId}
                  className="source-button" type="button"
                  onClick={() => call(() => window.researchAssistant.openSource(source.url))}>
                  <strong>{source.title}</strong>
                  <small>{source.bucket === 'eligible' ? '正式候選' : '日期待核對'} · {
                    source.readStatus === 'failed'
                      ? `讀取失敗：${source.errorCode ?? 'unknown'}`
                      : source.readStatus === 'read' ? '讀取成功' : '未讀取'
                  }</small>
                </button>)}
              </details>}
            </div>)}</div>}
      </details>
    </section>

    <section className="panel evidence-panel">
      <div className="section-heading"><div><span className="step">08</span><h2>目前證據鏈</h2></div></div>
      <ol className="checklist checklist--five">
        <li className={state.session.status === 'connected' ? 'done' : ''}>ChatGPT 登入成功</li>
        <li className={state.session.sharing ? 'done' : ''}>方案用量分享已授權</li>
        <li className={state.models.length > 0 ? 'done' : ''}>取得帳號模型目錄</li>
        <li className={state.verification.status === 'passed' ? 'done' : ''}>收到真實模型完成事件</li>
        <li className={phaseBPassed ? 'done' : ''}>真實研究報告已產生並保存</li>
      </ol>
      <p className="muted">一般程式負責權限、參數、搜尋與閱讀上限、URL／重新導向／私有網段、引用和輸出驗證；
        模型只根據已讀證據產生結構化草稿。外部內容一律視為不可信資料。</p>
      <details><summary>本機資料儲存位置</summary>
        <code className="path">{state.dataDirectory || '載入中…'}</code></details>
      <div className="data-transfer">
        <h3>可攜式資料備份</h3>
        <p className="muted">
          匯出報告、來源、偏好與監控資料；不會匯出 ChatGPT 登入憑證。
        </p>
        <div className="button-row">
          <button className="secondary-button" type="button" disabled={requestRunning}
            onClick={() => call(async () => {
              const result = await window.researchAssistant.exportPortableData();
              if (result.saved) setDataTransferMessage(`備份已儲存：${result.path}`);
            })}>匯出可攜備份</button>
          <button className="secondary-button" type="button" disabled={requestRunning}
            onClick={() => call(async () => {
              const result = await window.researchAssistant.importPortableData();
              if (result.imported) {
                setDataTransferMessage(
                  `資料已匯入；匯入前副本：${result.recoveryPath ?? '已建立'}`,
                );
              }
            })}>匯入可攜備份</button>
        </div>
        {dataTransferMessage && <small className="path">{dataTransferMessage}</small>}
      </div>
    </section>
  </main>;
}
