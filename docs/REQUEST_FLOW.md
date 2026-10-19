# 真實研究請求追蹤

這份文件以 UI 預設指令為例：

> 幫我找最近七天 AI Agent 與 RAG 的新技術，最多整理三項，優先有論文或開源程式碼的內容。

## 呼叫關係

```text
src/App.tsx
  └─ preload.ts: runResearch(command, modelSlug)
      └─ electron/main.ts: runResearch()
          ├─ research-task.ts: interpretCommand() / resolveResearchTask()
          ├─ research-pipeline.ts: runResearchPipeline()
          │   ├─ search-orchestrator.ts: runOrchestratedSearch()
          │   │   ├─ arxiv-search-provider.ts 或 official-web-search-provider.ts
          │   │   └─ 主查詢後最多一次缺口補查
          │   ├─ run-reading.ts: runReading()
          │   ├─ report.ts: buildEvidenceBundle()
          │   ├─ report-provider.ts: OfficialReportDraftProvider.generateDraft()
          │   │   └─ @siwc/local: ChatGPTClient.streamResponse()
          │   └─ report.ts: finalizeResearchReport()
          ├─ report-audit.ts: auditResearchReport()
          └─ research-store.ts: saveCompletedResearch()
```

## 一次請求的資料流

1. `App.tsx` 只把使用者文字與模型 slug 經 preload bridge 送到 Electron main process；renderer 不持有 OAuth token。`ipc-input.ts` 在執行時重新檢查型別、長度與控制字元，不把 TypeScript 型別當成安全邊界。
2. `interpretCommand()` 判斷這是新研究、長期偏好、格式改寫或固定項目追問。`resolveResearchTask()` 依「當次指令 > 長期偏好 > 系統預設」產生完整設定與日期範圍。
3. `runOrchestratedSearch()` 執行主查詢、驗證候選、合併同 URL 欄位、核對首次發布日並檢查顯式子題涵蓋；不足時只允許一次針對缺口的補查。預設 provider 是 arXiv；只有使用者明確要求官方 Web Search 且日期不限時才切換。
4. `runReading()` 依 paper-first 順序讀取。arXiv API 摘要可成為 abstract-level 證據，並優先嘗試同站官方 HTML 全文；一般 URL 則逐次檢查公開 HTTP(S)、DNS、redirect、MIME、bytes 與 timeout。
5. `buildEvidenceBundle()` 只接受成功讀取且 ID／URL 一致的來源。失敗來源留下錯誤碼，但不會進入可引用集合。
6. `OfficialReportDraftProvider` 把任務與有上限的證據文字送給 Luna。長全文會在相同字數額度內選取開頭、結果、限制、結論與分散片段；模型只輸出固定 JSON 欄位與既有 `sourceId`，不輸出 URL，也不能新增來源。
7. `finalizeResearchReport()` 是主要信任邊界：它再次檢查篇數、摘要數量、非空文字、citation 白名單、每項來源歸屬、重複 ID，最後才由普通程式映射 URL、配置 `item_01` 並產生 Markdown。
8. `auditResearchReport()` 計算結構指標，明確把 semantic support 留為 `not_evaluated`。
9. `ResearchStore.saveCompletedResearch()` 以 SQLite transaction 同時保存報告、所有已讀來源、讀取失敗、固定項目與對話。任何一步失敗會 rollback。
10. main process 發布新的 `AppState`；React 顯示報告、引用、稽核摘要與實際保存的來源內容。

需要建立內容品質 baseline 時，`evaluation-worksheet.ts` 會將 summary、problem、method、evidence 與來源限制轉成穩定 claim ID，並附上同一份 SQLite 報告保存的證據。助理分析不會混入 citation support 標註集合。
人工填寫後，`summarizeEvaluationWorksheet()` 只接受同一報告的完整 claim 集合與 allowlist 標籤；空白標註保持未評估，多選、未知或遺失的 claim 會拒絕。比率由普通程式計算，不讓報告生成模型替自己的答案打分。

## 普通程式與 LLM 的分工

| 工作 | 執行者 | 原因 |
| --- | --- | --- |
| 指令分類、偏好合併、日期與上限 | 普通程式 | 規則可重現且需精確 |
| 搜尋 arXiv、HTTP 安全、取消與重試 | 普通程式 | 涉及外部操作與安全邊界 |
| 從已讀證據組織繁中草稿 | LLM | 需要語言理解與摘要 |
| URL、citation、固定 ID、數量與持久化 | 普通程式 | 不可依賴模型自我約束 |
| 主張是否真的被來源語意支持 | 尚未自動判定 | 需要固定標註集與評估方法 |

## 模型工具呼叫的現況

- 一般研究流程目前不讓 LLM 選擇或執行本機工具；搜尋與閱讀順序由 `runResearchPipeline()` 固定控制，所以沒有未驗證參數可直接觸發本機操作。
- 「官方 Web Search 能力探測」是另一條流程。模型使用 OpenAI hosted `web_search` 工具，本機要求收到 `web_search_call` 事件、非空完成文字與至少一個通過公開 URL 驗證的來源才算成功。
- Web Search 的 `action.sources` 只是候選清單，不會直接變成研究證據；明確切換的研究或 GitHub 補查仍要通過安全 reader 才能引用。一般研究預設維持 arXiv paper-first 基線。

## 追問與補查資料流

```text
自然語言追問
  └─ research-task.ts：固定到 item_01／item_02
      ├─ 不需新資料：只重用該項目已保存證據
      └─ 最新／GitHub：follow-up-search.ts
          ├─ 最多兩次搜尋 + 最多四個讀取來源
          ├─ repository-linkage.ts：核對論文直連／arXiv ID／完整標題
          └─ report-follow-up.ts：引用白名單 + 深入追問新穎度 gate
```

「深入」回答在保存前會檢查是否只重述原報告；摘要證據固定揭露深度限制，全文證據要求至少兩項不同的新細節。這是 ordinary-code contract，不由模型自行宣告通過。

## 三種狀態放在哪裡

- 長期偏好：SQLite `preferences`，只有「以後／之後都／未來都」更新。
- 單次任務設定：`ResolvedResearchTask`，只存在該次 pipeline；不寫回偏好。
- 對話上下文：SQLite `messages` 與當前 `ResearchRunState`。追問先把「第二篇」解析成固定 `item_02`，再只提供該項已讀證據。
- OAuth token：官方 devkit 的 protected storage；不在以上三種狀態、SQLite、renderer 或 log。

## 除錯觀察點

遇到問題時依序確認：

1. UI 的 `research.status` 停在哪個 stage。
2. `understanding` 是否正確反映主題、日期與上限。
3. `eligibleSourceCount` 是否為 0；日期未知不算最近七天。
4. `EvidenceBundle.sources` 是否有成功讀取內容，`failures` 的錯誤碼為何。
5. 模型錯誤發生在 Responses request，還是草稿被 app-side validator 拒絕。
6. 報告是否成功 transaction 寫入；重啟後 `getReport()` 會再核對 JSON 與 relational rows。

這個順序對應「觀察現象 → 提出假設 → 取得證據 → 定位層級 → 最小修正 → 回歸驗證」，可避免把搜尋、模型與資料庫錯誤混在一起。

## 主動監測資料流

```text
background-scheduler.ts（每分鐘檢查是否到期）
  └─ background-discovery.ts
      ├─ arxiv-search-provider.ts：一次有日期範圍的搜尋
      ├─ research-store.ts：固定來源 ID 去重並寫入 inbox
      └─ 選用 background-brief.ts：每天最多一次 Luna 摘要
          └─ research-store.ts：保存問題、核心方法、工作價值與未驗證事項
```

- discovery 是普通程式控制的固定流程，不需要模型，也不讓網頁內容決定下一個工具。
- 新候選先以 SQLite unique key 去重；只有本次新插入的來源才通知，因此重啟或重試不會重複提醒同一規則下的同一來源。
- 自動摘要必須由使用者勾選。程式先以 transaction 取得當日唯一背景模型額度，再把最多三份已保存摘要交給 Luna；輸出只能使用提供的來源 ID，回來後再由本機 validator 核對數量、ID 與必填欄位。
- 排程器不可重入，前景研究、模型驗證或 Web Search 探測執行時會讓路；失敗規則延後一小時，取消會中止目前請求。
- 規則、inbox、摘要與每日模型用量位於 SQLite；Windows 登入啟動是 Electron OS 設定；OAuth token 仍只在官方安全儲存。
