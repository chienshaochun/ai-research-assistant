import { useEffect, useState } from 'react';
import type { PublicMonitoringState } from '../shared';

const shownTime = (value: string | null) => value
  ? new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(value))
  : '';

export function MonitoringPanel({ monitoring, launchAtLogin, call }: {
  monitoring: PublicMonitoringState;
  launchAtLogin: boolean;
  call: (action: () => Promise<void>) => Promise<void>;
}) {
  const [name, setName] = useState('AI 新技術');
  const [query, setQuery] = useState('AI Application AI Agent RAG LLM Evaluation');
  const [intervalHours, setIntervalHours] = useState(24);
  const [lookbackDays, setLookbackDays] = useState(7);
  const [maxItems, setMaxItems] = useState(3);
  const [digestHourLocal, setDigestHourLocal] = useState(9);
  const [enabled, setEnabled] = useState(true);
  const [autoBrief, setAutoBrief] = useState(false);
  const rule = monitoring.rules.find(({ id }) => id === 'ai_updates');
  useEffect(() => {
    if (!rule) return;
    setName(rule.name); setQuery(rule.query); setIntervalHours(rule.intervalHours);
    setLookbackDays(rule.lookbackDays); setMaxItems(rule.maxItems); setEnabled(rule.enabled);
    setAutoBrief(rule.autoBrief); setDigestHourLocal(rule.digestHourLocal);
  }, [rule?.updatedAt]);
  const selectNumber = (value: number, set: (next: number) => void, values: number[]) =>
    <select value={value} onChange={(event) => set(Number(event.target.value))}>
      {values.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select>;
  return <section className="panel evidence-panel">
    <div className="section-heading"><div><span className="step">05</span><h2>主動技術監測</h2></div></div>
    <p className="unit-copy">背景搜尋會掃描 arXiv 與少量官方公開 RSS／Atom，不使用模型；
      可選擇每天最多一次 Luna 摘要，整理新技術解決的問題、核心方法與工作價值。</p>
    <div className="monitor-grid">
      <label className="field"><span>監測名稱</span><input value={name} maxLength={100}
        onChange={(event) => setName(event.target.value)} /></label>
      <label className="field monitor-query"><span>搜尋主題</span><input value={query} maxLength={500}
        onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="field"><span>間隔（小時）</span>
        {selectNumber(intervalHours, setIntervalHours, [6, 12, 24, 72, 168])}</label>
      <label className="field"><span>回溯（天）</span>
        {selectNumber(lookbackDays, setLookbackDays, [1, 3, 7, 14, 30])}</label>
      <label className="field"><span>最多提示</span>
        {selectNumber(maxItems, setMaxItems, [1, 2, 3])}</label>
      <label className="field"><span>每日匯報時間</span>
        {selectNumber(digestHourLocal, setDigestHourLocal,
          Array.from({ length: 24 }, (_, hour) => hour))}</label>
    </div>
    <div className="monitor-options"><label><input type="checkbox" checked={enabled}
      onChange={(event) => setEnabled(event.target.checked)} />啟用背景搜尋</label>
      <label><input type="checkbox" checked={autoBrief}
        onChange={(event) => setAutoBrief(event.target.checked)} />自動 Luna 摘要（每天最多 1 次）</label>
      <label><input type="checkbox" checked={launchAtLogin}
        onChange={(event) => call(() => window.researchAssistant.setLaunchAtLogin(
          event.target.checked,
        ))} />Windows 登入後背景啟動</label></div>
    <div className="button-row"><button className="primary-button" type="button"
      disabled={monitoring.status === 'checking' || !name.trim() || !query.trim()}
      onClick={() => call(() => window.researchAssistant.saveMonitoringRule({
        id: 'ai_updates', name, query, enabled, intervalHours, lookbackDays, maxItems,
        autoBrief, digestHourLocal,
      }))}>儲存監測規則</button>
      {rule?.enabled && <button className="secondary-button" type="button"
        disabled={monitoring.status === 'checking'}
        onClick={() => call(() => window.researchAssistant.runMonitoringNow(rule.id))}>
        立即檢查</button>}</div>
    <div className={`result result--${monitoring.status === 'failed' ? 'failed' :
      monitoring.status === 'checking' ? 'running' : 'passed'}`}>
      <strong>{monitoring.message}</strong>
      {rule && <span>{rule.enabled ? `下次：${shownTime(rule.nextRunAt)}` : '已停用'}
        {rule.lastSucceededAt ? ` · 上次成功：${shownTime(rule.lastSucceededAt)}` : ''}</span>}
      {monitoring.error && <span>失敗原因：{monitoring.error.message}</span>}
    </div>
    <MonitoringInbox monitoring={monitoring} call={call} />
    <details className="monitor-run-history">
      <summary>最近背景執行（{monitoring.runs.length}）</summary>
      <div className="history-list">
        {monitoring.runs.slice(0, 10).map((run) => <div
          className="history-button history-button--static" key={run.id}>
          <strong>{run.status === 'completed' ? '完成' :
            run.status === 'cancelled' ? '已取消' : '失敗'}</strong>
          <small>{shownTime(run.startedAt)} · 新來源 {run.discoveredCount} · 摘要 {
            run.briefedCount}</small>
          {run.errorMessage && <small>{run.errorCode}：{run.errorMessage}</small>}
        </div>)}
      </div>
    </details>
  </section>;
}

function MonitoringInbox({ monitoring, call }: {
  monitoring: PublicMonitoringState;
  call: (action: () => Promise<void>) => Promise<void>;
}) {
  return <div className="source-list monitoring-inbox">
    <span>新技術收件匣（{monitoring.inbox.length}）</span>
    {monitoring.inbox.length === 0 ? <p className="muted">尚未發現未讀的新來源。</p>
      : monitoring.inbox.map((item) => <div className="evidence-source-card"
        key={`${item.ruleId}:${item.sourceId}`}>
        <button className="source-button" type="button"
          onClick={() => call(() => window.researchAssistant.openSource(item.candidate.url))}>
          <strong>{item.candidate.title}</strong>
          <small>{item.candidate.publishedDate ?? '日期未知'} · {
            item.candidate.authorOrOrganization ?? '作者未知'}</small>
          {item.candidate.excerpt && <small>{item.candidate.excerpt.slice(0, 260)}</small>}
        </button>
        <div className="ranking-explanation">
          <small>優先分數：{item.rankingScore}</small>
          {item.rankingReasons.map((reason) => <span key={reason}>{reason}</span>)}
        </div>
        {item.brief && <div className="technology-brief">
          <strong>解決問題</strong><p>{item.brief.problem}</p>
          <strong>核心方法</strong><p>{item.brief.coreMethod}</p>
          <strong>對工作的價值</strong><p>{item.brief.workValue}</p>
          <small>尚未驗證：{item.brief.unverified.join('；')}</small>
          <small>模型：{item.briefModelSlug} · {shownTime(item.briefedAt)}</small>
        </div>}
        <div className="feedback-actions" aria-label="這項技術對你的價值">
          {([
            ['worth_investigating', '值得深入'],
            ['later', '稍後閱讀'],
            ['not_relevant', '不相關'],
            ['already_known', '已經知道'],
            ['not_actionable', '目前難實作'],
          ] as const).map(([value, label]) => <button
            className={item.feedback === value ? 'feedback-button is-selected' : 'feedback-button'}
            type="button"
            aria-pressed={item.feedback === value}
            key={value}
            onClick={() => call(() => window.researchAssistant.setMonitoringItemFeedback(
              item.ruleId, item.sourceId, value,
            ))}>{label}</button>)}
        </div>
        <div className="inbox-actions">
          <button className="secondary-button" type="button" onClick={() => call(() =>
            item.linkedReportId
              ? window.researchAssistant.loadReport(item.linkedReportId)
              : window.researchAssistant.researchMonitoringItem(item.ruleId, item.sourceId))}>
            {item.linkedReportId ? '開啟深入報告' : '深入研究這項技術'}</button>
          <button className="text-button" type="button" onClick={() => call(() =>
            window.researchAssistant.setMonitoringItemStatus(item.ruleId, item.sourceId, 'read'))}>
            標為已讀</button>
          <button className="text-button" type="button" onClick={() => call(() =>
            window.researchAssistant.setMonitoringItemStatus(item.ruleId, item.sourceId, 'dismissed'))}>
            忽略</button>
        </div>
      </div>)}
  </div>;
}
