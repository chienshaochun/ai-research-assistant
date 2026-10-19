# AI Research Assistant 開發計畫

最後更新：2026-10-06（Asia/Taipei）

## 技術決策

- 採用 Electron + TypeScript + React。OpenAI 官方 Sign in with ChatGPT cookbook 的完整桌面範例 Paste Perfect 使用相同組合，可直接沿用主程序登入、preload bridge 與 renderer 不接觸 token 的安全邊界。
- ChatGPT 整合只使用 OpenAI 官方 `sign-in-with-chatgpt-devkit`。`@siwc/local` 與 `@siwc/react` 目前無法從公開 npm registry 取得，因此依官方文件改由官方 GitHub repository 提供的 workspace 套件整合；不自行仿造 OAuth SDK。
- 第一階段只完成登入、授權判斷、帳號可用模型列舉與一次真實 Responses API 串流回應。研究流程、SQLite 與完整 UI 在 A 驗證通過後才擴充。
- token 只存在 Electron 主程序並交由官方 devkit 的 protected storage 管理；renderer、SQLite、一般設定、log 與 Git 均不得接觸 token。

## 階段 A：整合驗證（已完成）

- [x] 核對指定的四份官方文件。
- [x] 確認身份登入與 `chatgpt.tokens.use.direct` 方案授權是兩件事。
- [x] 確認本機個人專案屬於文件所述的可用情境，實際資格仍須由登入後的 granted scopes 與模型請求判定。
- [x] 取得並固定官方 devkit 依賴。
- [x] 建立 Electron 主程序、preload 安全橋接與 React 驗證畫面。
- [x] 顯示 `connected`、`sharing`、可用模型與錯誤狀態。
- [x] 由使用者在系統瀏覽器完成 OAuth（不在聊天傳送密碼或 token）。
- [x] 收到 `response.completed` 且非空的真實模型文字；五小時用量恢復後，實測目前帳號 catalog 列出的所有模型皆通過。

驗收結果：僅「Connected」或列出模型不算通過；2026-10-01 已由目前帳號 catalog 列出的所有模型取得真實完成回應。先前各模型共同出現 sharing limit，五小時共享用量恢復後全部通過，因此先前失敗歸類為用量受限，而非模型不相容。

## 階段 B：研究流程（已完成）

- [x] 實作可替換的 `SearchProvider` 與安全的公開 HTTP(S) 內容讀取器。
- [x] 驗證帳號／模型是否允許官方 web search；`gpt-5.6-luna` 已於 2026-10-01 完成真實探測。不可用時仍保留有限 RSS、論文 API 與官方來源的替換介面。
- [x] 實作日期核對、來源去重、同來源欄位合併、讀取證據與引用 ID 驗證。
- [x] 真實產出一份最多三項、繁中且引用可追溯的研究報告；2026-10-04 正式 SQLite 已保存九份真實報告。
- [x] 加入搜尋、閱讀、重試與取消上限；流程為固定有界 stage，不使用無界 Agent loop。

### B1：官方 Web Search 能力探測

- [x] 依官方 Responses 工具格式送出 `tools: [{ type: "web_search" }]`，並要求 `web_search_call.action.sources`。
- [x] 不以完成文字當成工具成功；必須觀察到 `web_search_call`、至少一個安全公開來源及非空文字。
- [x] renderer 僅接收通過檢查的 HTTP(S) URL；token 與原始授權資料仍留在 main process。
- [x] 加入 fixture 測試：工具未使用、來源缺失、私有 URL、來源去重與事件擷取。
- [x] 使用目前帳號與 `gpt-5.6-luna` 完成一次真實 Web Search；收到完成文字、工具事件及 12 個公開來源。

### B2：SearchProvider 候選來源契約

- [x] 定義查詢、日期範圍、結果上限與可替換的 `SearchProvider` 介面。
- [x] 定義固定來源 ID、來源類型、發布／更新日期、內容層級及實際摘錄。
- [x] 將公開 HTTP(S) URL 邊界抽成共用安全模組。
- [x] 日期未知時不判定符合指定時間範圍。
- [x] 依 canonical URL 產生固定 ID；精確重複時保留原始順序並合併較完整欄位，衝突值另行稽核。
- [x] 實作官方 Web Search adapter，將 `action.sources` 轉為 bounded、metadata-only 候選來源。
- [x] 實作研究搜尋 orchestrator：候選逐筆驗證、去重、日期硬條件、結果上限、取消與排除原因。
- [x] 日期未知但相關的來源保留為補充候選，不計入「符合指定日期範圍」的正式數量。
- [x] 將 orchestrator 接入 IPC 與自然語言研究輸入。

### B3：安全內容讀取器

- [x] 定義可替換的 `ContentReader`，以固定來源 ID 輸出 read／failed 狀態、最終 URL、擷取時間、內容 hash 與可追溯文字。
- [x] 每一個 URL 與重新導向都重新檢查公開 HTTP(S)、DNS 結果與私有／保留網段；實際連線固定使用已檢查的 IP。
- [x] 限制重新導向、讀取時間、回應 bytes、保存文字長度、MIME type 與 content encoding。
- [x] HTML 僅作為不可信資料轉成純文字；移除 script／style 等非內容區塊，不執行頁面程式或指令。
- [x] 驗證來源 ID 與 URL 一致；讀取失敗保存明確代碼，呼叫端取消仍維持 `AbortError`。
- [x] 使用 fixtures 覆蓋公開／私有 DNS、重新導向、循環、ID 錯置、類型、大小、空內容、timeout 與取消。
- [x] 將 reader 接入 paper-first 的有界閱讀流程；分開設定閱讀數量與每來源嘗試上限，只重試暫時性錯誤，repository 預設延後。
- [x] 將搜尋／閱讀流程接入 IPC 並保存結果；PDF 解析留待後續獨立設計。

### B4：證據與引用安全邊界

- [x] 只將成功讀取且來源 ID／URL 一致的內容建立為 `EvidenceSource`；失敗讀取另外保存錯誤。
- [x] 報告草稿只能引用程式提供的來源 ID，不能由模型提供 URL。
- [x] 摘要、問題、方法、作者證據與來源限制均驗證 citation；引用必須屬於該報告項目且來源確實支持至少一項主張。
- [x] 程式配置固定 `item_01` 等項目 ID，並從已驗證來源產生 Markdown 原始連結。
- [x] 清楚分隔「來源中的主張」與「助理分析／尚未驗證」，來源清單只列真正引用的已讀來源。
- [x] 實作可替換的報告模型 provider，將 EvidenceBundle 轉為結構化草稿後通過上述驗證。

### B5：arXiv 有日期論文基線

- [x] 使用 arXiv 公開 metadata API 取得首次提交日、更新日、作者與摘要。
- [x] 依官方條款維持單連線及三秒請求間隔，並完成一次不消耗 ChatGPT 額度的真實 E2E。
- [x] 把 API 摘要標示為 `abstract`，不誤宣稱已讀全文。
- [x] 優先安全讀取 arXiv 官方 HTML 全文並標示為 `full_text`；不可用時誠實退回已保存摘要。
- [x] 研究 UI 明確標示現行搜尋範圍只是 arXiv 論文 metadata／摘要。
- [x] 在 API 回傳的有界集合內，以主題概念涵蓋度、標題命中與摘要命中進行穩定排序；同分保留新到舊順序且不放寬日期條件。

### B6：完整固定研究管線

- [x] 串起任務解析 → 搜尋 → 日期篩選 → 證據閱讀 → 結構化報告 → citation validator。
- [x] 將發布日期建模為明確的 `recent`／`any` 狀態；預設維持近期硬條件，只有使用者明示「日期不限」才允許日期未知來源，矛盾指令在搜尋前拒絕。
- [x] 加入顯式 `arxiv`／`web` 搜尋模式；預設不變，官方 Web Search 只有搭配「日期不限」才會進入研究管線，日期不相容時在工具呼叫前拒絕。
- [x] 日期無結果與全部讀取失敗是明確狀態，不要求模型湊滿篇數。
- [x] UI 顯示進度、來源、Markdown、取消與匯出。
- [x] 由使用者從 UI 觸發 Luna 真實結構化報告，確認當前 SIWC 模型實際支援 `text.format` JSON schema；最新報告 `rpt_30ac3e9513e98235584e` 引用 3 份已讀 arXiv 摘要，另保存 3 份已讀但未引用的候選。

## 階段 C：助理互動與持久化

- [x] 使用 SQLite 保存長期偏好、對話、來源與報告；不保存 OAuth token。
- [x] 實作優先序：當次明確指令 > 長期偏好 > 系統預設。
- [x] 支援「這次」、「以後」、格式改寫、依固定項目 ID 的「第二篇」與可持久化的「剛才那個方法」追問。
- [x] 追問要求最新證據或 GitHub 時，使用固定項目 ID 執行有界補查、安全閱讀與新來源引用驗證；一般深入追問仍只重用舊證據。
- [x] 對 GitHub 補查建立論文直連、arXiv ID 與完整標題的保守關聯 gate；未通過時禁止宣稱官方實作。
- [x] 提供歷史報告、偏好檢視／修改／逐項刪除／全部清除與 Markdown 匯出。
- [x] 以 SQLite 關閉後重開的自動測試，驗證應保留的資料仍存在。
- [x] 加入 deterministic report audit、實際證據檢視與人工 citation support 評估工作表。

## 階段 D：交付

- [x] 補齊 fixtures、單元／整合測試與另行標記的真實 E2E 測試。
- [x] 覆蓋偏好作用域、引用不錯置、日期不明、去重、讀取失敗、無結果、引用 ID、上限、取消與授權失敗。
- [x] 建立第一版固定任務路由 evaluation set，與一般功能測試共用但可獨立執行並記錄 baseline。
- [x] 完成繁中 README：Windows 安裝／啟動、登入、資料位置、測試、限制與故障排除。
- [x] 在 `docs/DELIVERY_STATUS.md` 列出完成、未完成與尚未實機驗證項目。

## 階段 E：主動監測 Agent

- [x] SQLite schema v10 保存監測規則、新來源 inbox、摘要、明確回饋、報告連結、通知時間、執行紀錄與每日背景模型用量。
- [x] 有界 arXiv 與官方 feed discovery 依上次成功時間搜尋並以固定來源 ID 去重；單一 provider 失敗可降級，整體失敗延後一小時。
- [x] 不可重入 scheduler 在前景工作時讓路，App 結束時可取消。
- [x] 每日指定本機時段彙整通知、晚啟動補送、system tray、關閉視窗後背景執行及明確的登入後自動啟動選項。
- [x] Opt-in Luna 摘要輸出問題、核心方法、工作價值與證據缺口；所有背景規則合計每天最多一次模型請求。
- [x] 以明確回饋與主題相似度進行 deterministic 排序；支援從單一 inbox 來源一鍵進入完整研究流程。
- [x] 以正在執行的正式 App 完成 discovery、Luna 主動摘要與立即重跑去重 E2E；production inbox 12 筆、摘要 3 筆、當日背景模型計數 1。Windows toast 的實際視覺呈現留給 demo 確認。

## 階段 F：可攜資料與 Windows 發佈

- [x] 單檔可攜備份包含 SQLite 快照、版本、時間與 SHA-256；明確排除 ChatGPT 憑證。
- [x] 匯入前驗證 gzip／JSON 格式、雜湊、SQLite header、migration 與 quick_check；取代前建立回復副本。
- [x] 建立 electron-builder Windows x64 設定與 package:win 品質門檻。
- [x] app.asar 以實際 Electron runtime 完成無視窗啟動及 SQLite 初始化 smoke test。
- [x] NSIS x64 安裝器與 ZIP 便攜版已產生並記錄 SHA-256。
- [ ] 安裝／解除安裝 E2E 與可信程式碼簽章尚未完成；未簽章檔可能觸發 SmartScreen 或組織政策。
- [x] 建立功能盤點與 UI 精簡候選；任何刪除留待使用者確認。

## 後續實機驗收

- [x] 從最新版 UI 以 Luna 完成一次「第二篇深入一點」，production 對話已保存 `target_item_id = item_02`，並以摘要級警語誠實降級。
- [ ] 從最新版 UI 明確執行一次「使用官方 Web Search，日期不限」研究，確認工具事件、實際頁面閱讀、可點擊引用與報告生成的整合路徑。
- [ ] 由使用者對至少三條真實 claim 完成人工 citation support 標註並匯入。
- [x] 加入有界多查詢、缺口判斷與最多一次補查的 orchestrator，並驗證取消與總搜尋上限。

## 階段 A 官方依據摘要

- Sign in with ChatGPT 可提供身份；ChatGPT plan usage 是另行授權的選用權限，不會讀取既有 ChatGPT 對話或記憶。
- 方案使用必須實際取得 `chatgpt.tokens.use.direct` granted scope；有效 ID token 本身不足以代表可推論。
- 初次登入以動態註冊、穩定的 host ID、loopback `127.0.0.1` callback、PKCE、state 與 nonce 完成；不需要 API key 或 client secret。
- 模型必須用登入帳號的 access token 動態列舉，不硬編不存在或未授權的 model slug。
- Responses HTTP 請求必須 `store: false`、`stream: true`，並讀到 `response.completed` 才成功。
- preview 不支援 `previous_response_id` 持久狀態與多項一般 API 欄位；每次 HTTP 請求需在 `input` 帶齊必要歷史。web search 仍受模型及帳號／workspace policy 約束。
- 使用量只能導向 ChatGPT Settings → Usage；本機應用不能捏造剩餘額度或重設時間。

官方來源：

- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://developers.openai.com/siwc/quickstart
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
