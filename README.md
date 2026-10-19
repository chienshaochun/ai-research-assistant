# AI Research Assistant

本機執行的 AI 技術研究助理。已完成 OpenAI 官方 Sign in with ChatGPT、有界研究管線、引用驗證、SQLite 歷史與長期偏好，以及可在系統匣執行的 arXiv／官方 feed 定時監測、每日彙報與主動技術摘要。

> 2026-10-01 實測目前帳號 catalog 列出的所有模型皆可完成真實文字回應；`gpt-5.6-luna` 另外通過 Web Search 探測。2026-10-04 正式 SQLite 已保存九份真實研究報告與一份追問；主動監測真實 E2E 另找到 12 個新來源並以 Luna 保存 3 份摘要。

## Windows 需求

- Windows 10/11
- Node.js 22.12 以上（已在 Node.js 24 測試）
- ChatGPT Plus 或 Pro；實際資格仍由登入時的帳號、workspace、政策與 granted scopes 決定
- 可使用系統預設瀏覽器完成 OpenAI 登入

## 安裝與啟動

PowerShell 的 execution policy 若阻擋 `npm.ps1`，請使用 `npm.cmd`，不必修改全域政策：

```powershell
cd path\to\ai-research-assistant
npm.cmd install
npm.cmd run install:electron
npm.cmd start
```

Electron 42 將官方 Windows binary 下載器提供為獨立的 `install-electron` 指令；此步會依 package 內附 checksums 驗證下載內容。若 binary 已存在，指令會直接完成。

第一次啟動：

1. 按 **Continue with ChatGPT**。
2. 在系統瀏覽器登入並選擇 workspace；不要把密碼或 token 貼到終端或聊天。
3. 在 OpenAI 授權畫面允許 ChatGPT plan usage。
4. 回到應用，確認不只是 Connected，還顯示 usage sharing 已啟用並列出模型。
5. 按「執行真實驗證」。只有收到完成文字且驗收四項全勾，階段 A 才通過。
6. 選擇模型並按「驗證官方 Web Search」。只有畫面同時顯示通過、完成文字及至少一個可點擊來源，才證明該次請求實際使用搜尋工具。
7. 在「有證據的論文研究」保留預設指令或輸入新主題，開發期間建議選 Luna 後按「執行研究」。
8. 報告完成後可輸入「改成比較表」（不搜尋、不用模型）或「第二篇深入一點」（沿用該項證據、使用一次模型）。
9. 「以後先給三個重點」會儲存長期偏好；「這次改看推論效率」不會覆蓋它。
10. 在「主動技術監測」設定主題與頻率；背景搜尋不使用模型，自動摘要需明確勾選且所有規則合計每天最多一次 Luna 請求。
11. 「可攜式資料備份」可搬移報告、來源、偏好與監控資料；ChatGPT 登入憑證不會被匯出，新電腦仍須自行登入。

## 主動技術監測

- scheduler 每分鐘檢查到期規則；每條規則實際搜尋間隔限制為 6 小時到 7 天。
- discovery 會合併有日期範圍的 arXiv 查詢，以及 OpenAI News、Hugging Face Blog、Google Blog 的公開 RSS／Atom；任一 provider 暫時失敗時仍保留其他成功結果。
- 新來源進入 SQLite 收件匣；可回饋「值得深入、稍後、不相關、已知、難實作」，之後的本機排序會使用這些明確標註。
- 回饋可再次點選取消；標為已讀或忽略的來源仍保存在 SQLite，並可從「已處理項目」還原至收件匣。
- 新技術收件匣與已處理項目皆以每頁十項呈現，避免長清單妨礙操作。
- 到使用者指定的本機整點後，每條規則每天最多送出一次彙整 Windows 通知；晚啟動會補送當天尚未通知的項目。
- 可從單一收件匣項目按「深入研究這項技術」，固定使用該來源進入既有全文／摘要、引用與報告管線，不會被其他搜尋結果替換。
- 選擇自動摘要時，一次最多三項，輸出「解決問題、核心方法、工作價值、未驗證事項」。所有背景規則合計每天最多一次模型請求，模型失敗也計入上限以阻止重試耗量。
- 啟用規則後關閉視窗會縮到系統匣；從系統匣選擇「結束」才會停止程序。可另行勾選 Windows 登入後背景啟動。
- 前景研究、模型驗證或另一輪監測執行中時，背景工作會讓路，不會並行搶用同一研究流程。

預設研究使用明確的近期日期範圍。只有指令明確包含「日期不限」時，系統才會採用不限發布日模式，並允許發布日未知的來源進入正式候選；「最近七天」與「日期不限」同時出現會在搜尋前拒絕，避免系統自行猜測。此設定也可作為長期偏好保存，但當次明確日期要求仍有最高優先序。

預設 provider 仍是 arXiv。若要改用已通過能力探測的官方工具，可輸入「這次改看 AI Agent，使用官方 Web Search，日期不限」。這條路徑通常使用一次 Web Search 工具請求，再於成功讀取來源後使用一次報告生成請求；搜尋來源仍須經公開 URL、防 SSRF 與內容讀取限制，不能直接當成已讀證據。因目前來源清單沒有可驗證發布日，省略「日期不限」會在工具呼叫前拒絕。

長期偏好可逐項刪除或全部清除。完成一次「第二篇深入一點」後，「剛才那個方法」會沿用已保存的固定項目 ID；如果報告有多項但沒有可辨識的最近目標，應用會要求改用「第幾篇」，不交給模型猜測。

報告上方的稽核摘要由普通程式計算，顯示來源主張、引用連結、日期覆蓋、全文來源與摘要級來源數。它只代表結構檢查；畫面會明確標示 citation 的語意支持程度尚未自動評分。
每個「報告實際引用來源」都可展開查看當次保存的證據、擷取時間與內容 hash；這比只打開目前的外部頁面更適合追查模型當時實際收到的內容。
「匯出評估工作表」會為每條來源主張建立穩定 claim ID，附上引用 ID 與當次保存的證據，並留下 supported／partially_supported／unsupported／unclear 空白欄位供人工標註；匯出本身不代表評估已執行。
完成標註後可按「匯入已標註工作表」。程式會核對報告 ID、所有 claim ID、四個 allowlist 標籤與每題最多一個勾選，再顯示人工標註分布及支持率；未勾選項目不進入比率分母。匯入只讀取使用者選取、最大 2 MB 的 Markdown，不呼叫模型。

## 驗證指令

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run eval:task-routing
npm.cmd run eval:source-ranking
npm.cmd run eval:numeric-grounding
npm.cmd run build
npm.cmd run package:win
```

測試使用 mock／fixtures，不會登入或消耗真實方案額度。模型文字、官方 Web Search 與結構化研究報告的真實 E2E 都由 UI 明確觸發；研究搜尋先做主查詢，涵蓋或候選不足時最多補查一次。arXiv 搜尋不耗 ChatGPT 額度，報告生成消耗一次；官方 Web 模式每次搜尋會使用方案額度，因此一次研究可能包含一至兩次工具請求，再加一次報告生成請求。
`eval:task-routing` 會重跑固定的自然語言任務路由 baseline；案例定義在 `evaluation/task-routing-cases.ts`，既有預期不應為了配合新版 parser 任意改寫。目前包含 15 個案例。

arXiv 外部 E2E 預設跳過，需明確開啟；它不使用 ChatGPT 額度：

```powershell
$env:RUN_ARXIV_E2E = '1'
npm.cmd test -- tests/arxiv-live.e2e.test.ts
```

也可針對 production SQLite 建立暫存副本，使用真實報告驗證改寫、追問目標、偏好與重啟持久化；正式資料庫不會被修改：

```powershell
$env:RUN_PRODUCTION_SNAPSHOT_E2E = '1'
npm.cmd test -- tests/production-snapshot.e2e.test.ts
```

主動監測 production E2E 會操作正式監測規則；首次缺少已驗收資料時，可能真正搜尋並使用一次 Luna。去重 E2E 只應在第一項成功後執行：

```powershell
$env:RUN_MONITORING_PRODUCTION_E2E = '1'
npm.cmd test -- tests/monitoring-production.e2e.test.ts

$env:RUN_MONITORING_DEDUP_E2E = '1'
npm.cmd test -- tests/monitoring-production.e2e.test.ts
```

開發期間預設選擇帳號目錄中的 Luna 模型；每個單元最多執行一次必要的真實 E2E，其餘驗證使用 fixtures。模型選單仍可手動改選，但共享用量百分比不保證每個高階模型在該時刻都能接受新請求。

目前研究呈現採 paper-first：論文用於說明問題、方法與證據；repository 預設延後。長期偏好、報告、來源、未完成執行及其候選來源／讀取狀態、固定項目 ID 與對話已保存在 SQLite。

## 資料與憑證

預設資料目錄：

```text
%APPDATA%\AI Research Assistant
```

OAuth 憑證由官方 `@siwc/local` 管理，並透過 Electron `safeStorage` 在 OS 層加密。renderer、SQLite、一般設定與 log 不會收到 token。按 Disconnect 會停止使用並由 SDK 清除所選連線的 token；registration label 可能保留，以便之後重新授權。

研究資料庫位於 `%APPDATA%\AI Research Assistant\research.sqlite`。它包含使用者研究內容，應視為私密資料；不包含 OAuth token。
介面可匯出單一 .ara-backup：檔案包含 SQLite 快照、版本 metadata 與 SHA-256，匯入前會驗證格式、雜湊與 SQLite 完整性，並在資料目錄保留 research.before-import.sqlite。它不包含 chatgpt 憑證目錄。
應用使用 single-instance lock；重複啟動會聚焦既有視窗，避免兩個主程序同時操作同一份 SQLite。
若已啟用監測，關閉主視窗只會隱藏到系統匣；必須使用系統匣的「結束」才會完全關閉。

如要隔離測試資料，可在啟動前指定：

```powershell
$env:AI_RESEARCH_ASSISTANT_DATA_DIR = 'C:\some\private\test-directory'
npm.cmd start
```

該位置會含加密憑證狀態，仍應視為私密資料，不可加入 Git 或分享。

## 目前限制

- 一般研究預設使用 arXiv 公開 metadata API；有界候選會依「涵蓋主題概念數 → 標題命中 → 摘要命中」在本機穩定排序。主查詢後會檢查顯式子題涵蓋與最低候選數，不足時最多補查一次，並顯示實際查詢、剩餘缺口與短缺。官方 Web Search 是明確切換的替代 provider，不會與 arXiv 自動混合；它已完成 adapter 能力探測與 fixture pipeline 驗證，但整合後的真實研究 E2E 仍待使用者明確觸發。Web Search metadata 缺少可驗證發布日，因此只允許「日期不限」，不會硬塞進最近七天報告。
- arXiv 證據會先嘗試官方 HTML 全文，成功時標為 `full_text`；未提供、讀取失敗或內容不足時退回 API 摘要並標為 `abstract`。長全文送入模型時會在固定字數額度內選取開頭、結果、限制、結論與分散區段，並標記原始字元範圍；這不代表模型看過被省略的全文。內容讀取器仍不解析 PDF。
- 主動監測搜尋 arXiv 與有限的官方公開 feeds；feed 只提供 snippet 時不能宣稱讀過全文，自動摘要必須把實驗細節與可重現性列為未驗證。scheduler、production inbox、去重與真實 Luna 自動摘要已通過 production E2E；新增 feeds 與每日彙整通知已由 fixtures 驗證，Windows toast 的實際視覺呈現仍由桌面 demo 確認。
- Windows 發佈已產生 NSIS x64 Setup EXE 與 ZIP 便攜版；app.asar 已完成無視窗啟動／SQLite smoke test。產物尚未做可信程式碼簽章，也尚未執行安裝／解除安裝 E2E，因此其他電腦可能顯示 SmartScreen 或組織政策警告。
- SIWC／Luna 的 `text.format` 已完成真實報告 E2E；這只證明目前帳號、workspace 與模型在該次請求可用，不保證其他模型或未來用量狀態。若模型不支援，應用會明確失敗，不會悄悄改用未驗證的文字解析。
- 一般「第二篇深入一點」只沿用已儲存證據，不重新搜尋；摘要級來源至少需新增一項非原報告重述的細節並固定揭露限制，有全文時至少需新增兩項不同細節，否則回答會在保存前被拒絕。若明確要求「最新／補查」，系統會對固定項目執行有界 arXiv 補查；要求 GitHub／原始碼時改走官方 Web Search，真正讀取公開頁面後才允許引用。補查與回答會使用額度，最多兩次搜尋加一次回答。repository 只有在論文直連、相同 arXiv ID 或完整論文標題可核對時才標為已驗證關聯；否則強制列為候選且不能稱為官方實作。
- 模型端 JSON Schema 刻意只使用較可攜的物件、陣列、必填欄位與來源 ID enum；摘要數量、文字長度、項目上限、引用白名單與去重由本機 validator 再強制檢查。
- deterministic audit 會警告 claim 中未出現在其引用證據的精確數字，並處理百分比、k 數量級與常見倍數格式；這不是完整語意支持判定，警告仍需人工核對。
- `gpt-5.6-luna` 已在目前帳號／workspace 真實通過 web search，但這不保證其他模型、帳號或未來時間點；工具來源清單也尚不等於經內容閱讀與引用對齊後的研究證據。
- Sign in with ChatGPT 是 preview，Responses 欄位與工具能力有限制。
- 官方 devkit 採 Noncommercial License v1.0，本專案目前僅供個人、非商業使用。
- 應用不會取得你既有的 ChatGPT 對話或記憶。
- 應用不顯示自行推算的剩餘額度或成本；請使用 **Manage usage** 前往 ChatGPT Settings → Usage。

## 故障排除

- **Connected 但不能驗證**：身份登入不等於方案授權。按「Enable usage sharing」重新授權，並確認 `chatgpt.tokens.use.direct` 已授予。
- **沒有模型**：重新整理模型；仍無結果時，所選帳號或 workspace 可能不符合資格。
- **401／403**：重新檢查所選帳號與授權。若是 `subscription_sharing_user_not_eligible`，不要反覆重試 OAuth。
- **429 usage limit**：按 Manage usage 查看 ChatGPT 設定；應用不猜測重設時間。
- **有回答但 Web Search 探測失敗**：查看錯誤代碼。`web_search_not_used` 表示完成文字中沒有工具事件；`web_search_sources_missing` 表示沒有取得可追溯的公開來源。兩者都不能當成搜尋成功。
- **503**：保留憑證，稍後有限次重試，不要自動切換成付費 API key。
- **secure storage unavailable**：確認 Windows 使用者工作階段與 OS credential storage 可用，再重啟應用；SDK 不會降級成明文保存。
- **npm.ps1 被封鎖**：使用 `npm.cmd`。

詳細官方依據與尚待本人登入的驗證項目見 [docs/PHASE_A_VALIDATION.md](docs/PHASE_A_VALIDATION.md)。完整開發順序見 [PLAN.md](PLAN.md)。
目前交付邊界與實機驗證狀態見 [docs/DELIVERY_STATUS.md](docs/DELIVERY_STATUS.md)。
完整的程式呼叫關係與普通程式／LLM 分工見 [docs/REQUEST_FLOW.md](docs/REQUEST_FLOW.md)。
安全邊界、威脅模型與尚存風險見 [docs/SECURITY.md](docs/SECURITY.md)。
完整能力盤點與精簡候選見 [docs/CAPABILITIES.md](docs/CAPABILITIES.md)。
