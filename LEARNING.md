# 學習紀錄

## 單元 1：官方登入整合與最小模型呼叫

完成日期：2026-10-01

### 本次概念與程式位置

- 身份登入與方案使用授權是兩層狀態：`session.status === "connected"` 只表示身份成立，`session.sharing === true` 才表示取得 ChatGPT plan usage scope。主要流程在 `electron/main.ts` 的 `refreshAccount()`、`refreshModels()` 與 `accountAction()`。
- Electron 權限邊界：OAuth、token refresh、模型列舉與 Responses request 都在 main process；renderer 只能經由 `electron/preload.ts` 的窄 IPC bridge 取得不含憑證的 `AppState`。
- 真實完成條件：`electron/verification.ts` 選擇帳號實際列出的模型，再由官方 SDK 等到 `response.completed`；Connected、模型清單或部分 delta 都不能單獨算成功。
- 安全儲存：`electron/credential-encryption.ts` 將官方 SDK 接到 Electron `safeStorage`，沒有明文 fallback。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：OAuth 狀態、scope 檢查、模型白名單、參數驗證、取消、錯誤分類、IPC 與安全儲存。
- LLM：只有收到已驗證的 model slug 與固定文字輸入後產生回應。本單元尚未提供搜尋工具，也沒有讓模型決定或執行任意本機操作。

### 使用者親自完成

- 在系統瀏覽器完成 OAuth 與 ChatGPT plan usage 授權。
- 從 Usage 頁辨識 app limit、共享方案限制、點數與重置是不同狀態。
- 逐一執行帳號模型驗證：先確認 GPT-5.6 Terra 與 GPT-5.6 Luna 通過；發現其他模型共同受到 sharing limit 後等待五小時額度恢復，再確認目前 catalog 列出的所有模型皆通過。

### 問題與排查

- npm package 名稱存在於官方 repository workspace，但公開 registry 回傳 404：固定官方 devkit commit，由 workspace build。
- Electron binary 下載器在目前 Windows/proxy 環境建立 0-byte zip：用官方 GitHub release 的 byte range 下載，依 npm package 內附 SHA-256 驗證後安裝。
- 第一次模型請求回傳 `subscription_sharing_usage_limit_exceeded`：由 Usage 頁確認 app 已啟用且額度限制生效，沒有改用 API key 或付費 fallback。
- 模型 catalog 與實際推論能力不相等：以逐模型真實請求取得目前帳號的實測結果。

### 理解狀態

- 已介紹：SIWC 身份／方案 scope 分離、Electron main／renderer 邊界、完成事件驗收。
- 有提示完成：Usage limit 的證據判讀與恢復路徑。
- 獨立完成：使用者逐模型執行真實驗證並回報成功集合。
- 獨立完成：能根據錯誤證據判斷「部分模型失敗」不足以證明模型不支援 SIWC，並提出方案額度、workspace／rollout／serving policy 等替代假設；後續仍需用各模型的精確錯誤碼區分原因。
- 獨立完成：在五小時共享用量恢復後重跑全部模型，透過控制用量狀態證實先前共同失敗不是模型相容性問題。
- 待複習：取消訊號如何從 UI 經 IPC 傳到 SDK，以及如何用測試防止取消請求被誤報為一般錯誤。

### 下一個核心練習（15–30 分鐘）

在 `tests/verification.test.ts` 新增「取消中的真實驗證不會掛住」測試：

- 使用一個假的 `streamResponse`，它在收到 `AbortSignal` 的 abort 事件後，以 `AbortError` 拒絕。
- 呼叫 `verifyTokenSharing()` 後觸發 `AbortController.abort()`。
- 驗收：Promise 會拒絕且 error name 為 `AbortError`；測試不連網、不呼叫真實模型，整個 suite 維持快速完成。

先不要修改正式 OAuth 或憑證程式。卡住時先描述觀察到的 failure，再取得概念提示。

## 單元 2：官方 Web Search 能力探測

完成日期：2026-10-01

### 本次概念與程式位置

- 「模型能產生文字」和「模型實際使用工具」是兩個不同能力。`vendor/sign-in-with-chatgpt-devkit/packages/local/src/responses.ts` 保留原本的完成事件要求，並額外蒐集 `web_search_call` 與官方來源欄位。
- `electron/web-search-probe.ts` 是程式端驗收邊界：必須同時有工具事件、安全公開來源與非空文字；僅有搜尋風格的回答不能通過。
- `electron/main.ts` 負責執行、取消、錯誤分類及安全 IPC；`src/App.tsx` 只呈現結果，並透過 main process 開啟已重新驗證的來源 URL。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：宣告可用工具、驗證 model slug、解析串流事件、驗證／去重 URL、阻擋私有位址、限制來源數量、處理取消與顯示證據。
- LLM：判斷何時呼叫官方 Web Search、形成搜尋內容，並根據工具結果生成一句回答。LLM 不能自行宣告探測成功。

### 問題與排查

- 官方 devkit 的高階 `streamResponse()` 原先只回傳文字，無法證明工具執行；新增窄介面 `streamWebSearch()`，但仍沿用同一套官方登入、加密憑證與 Responses 串流實作。
- Electron bundler 在受限沙箱內無法讀取必要的相依目錄；在核准的建置權限下重跑後成功。這和應用執行時的網路／憑證權限無關。
- fixture 共 20 項通過；真實 `gpt-5.6-luna` 探測另行記錄於 `EXPERIMENTS.md`，沒有把 mock 當作帳號能力證據。
- 真實探測收到 12 個公開來源，但多個 API 頁面與最終一句回答沒有直接關係。這證明「工具可用」與「來源品質／引用對齊」必須分開評估。

### 理解狀態

- 已介紹：完成事件、工具呼叫事件、來源證據是三種不同驗收訊號。
- 已介紹：網路來源在進入 renderer 前仍需做程式端安全檢查。
- 有提示完成：使用者以 `gpt-5.6-luna` 執行一次真實 Web Search，並提供包含模型、回答、12 個來源與完成時間的畫面證據。
- 待實作：區分工具查閱的候選來源、回答實際引用的來源，以及內容讀取後可支持主張的證據。
- 待複習：DNS 解析及重新導向後仍要再次阻擋私有網段；這會在內容讀取器單元完成。

### 核心練習結果

- 使用者獨立完成 `tests/verification.test.ts` 的取消測試：假 provider 監聽 `AbortSignal`、以 `AbortError` 拒絕，並由 5 秒 timeout 修正為約 15 ms 內通過。
- 後續型別檢查發現只走 reject 的 Promise 被推論成 `Promise<unknown>`；補上成功型別 `{ text: string }` 後符合正式 provider 契約。

## 單元 3：SearchProvider 候選來源契約

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/search-provider.ts` 定義搜尋輸入與候選來源資料契約。SearchProvider 只能回傳候選資料，不能自行宣告來源已讀或主張已被證明。
- `electron/security/public-url.ts` 是搜尋與未來內容讀取器共用的第一層 URL 邊界；目前處理 URL 形式與明顯私有位址，DNS 與重新導向後檢查留待讀取器。
- 固定來源 ID 由 canonical URL 產生，因此 fragment 不會建立兩個來源；不同 URL 即使屬於同一研究，仍需後續 entity merge。
- 日期範圍由普通程式判定；發布日期未知時回傳 false，不能讓 LLM 猜測它符合「最近七天」。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：查詢參數驗證、URL 正規化、固定 ID、來源種類／內容層級驗證、日期判定與精確 URL 去重。
- LLM：本單元沒有參與。後續 LLM 可以規劃查詢與分析內容，但不能繞過這些資料邊界。

### 實作與驗證歸屬

- 使用者獨立完成：上一單元的取消測試與失敗排查。
- 助理實作：SearchProvider 契約、安全 URL 模組、固定 ID、日期規則、精確去重與 fixtures。
- 驗證結果：TypeScript 通過；4 個測試檔共 27 項通過。

### 理解狀態

- 已介紹：候選來源、回答引用與已讀證據是不同資料層級。
- 已介紹：穩定 ID 解決精確 URL 重複，但不解決跨 URL 的同研究合併。
- 待實作：官方 Web Search adapter 及無結果、取消與結果上限的 provider 整合測試。

### 下一個核心練習（設計審查，15–20 分鐘）

閱讀 `tests/search-provider.test.ts` 的三個 fixture：同 URL 不同 fragment、arXiv 論文、GitHub repository。把每一組分類為「精確重複」「同研究的不同來源」或「不同研究」，並說明應在 URL 去重層或研究項目合併層處理。這個練習不要求手動補樣板程式。

### 設計審查結果

- 使用者提出 paper-first 策略：先以論文理解問題、方法與證據；只有確認值得深入實作時才進一步呈現與分析 GitHub。
- 精確化後的資料策略：論文與 repository 保留為不同 `Source`，在研究項目合併層關聯；論文為主要證據，repository 僅先保存 metadata，延後內容讀取。

## 單元 4：官方 Web Search Provider Adapter

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/official-web-search-provider.ts` 將 SIWC `streamWebSearch()` 包裝成通用 `SearchProvider`，並強制查詢上限、公開 URL、安全提示及取消訊號。
- 官方 `action.sources` 是搜尋過程查閱的完整 URL 集合，通常多於真正 inline citations；adapter 因此只輸出 `evidenceLevel: "metadata"`，不宣告來源已讀或主張已被支持。
- arXiv、OpenReview 與 ACL Anthology 可由 URL 保守標為 paper；GitHub／GitLab 標為 repository；其餘來源先標為 other，避免未讀前錯誤提升權威性。
- 日期欄位保持 null。Prompt 要求日期不能取代程式證據；後續需由論文 API 或內容讀取器取得可驗證日期。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：請求驗證、候選數量硬上限、安全 URL 過濾、來源類型的保守規則、metadata 標記、取消傳遞與錯誤分類。
- LLM：執行 Web Search 並挑選候選 URL。它不能將搜尋結果自行升級為已讀證據，也不能替未知日期補值。

### 實作與驗證歸屬

- 使用者完成：paper-first 呈現與延後 repository 分析的產品決策。
- 助理實作：官方 Web Search adapter 與 4 項 provider fixtures。
- 驗證結果：TypeScript 通過；5 個測試檔共 31 項通過；本單元沒有真實模型呼叫。

### 理解狀態與下一步

- 已介紹：完整 consulted sources 與真正 citations 不相等。
- 已介紹：搜尋 adapter 只能建立候選來源，內容證據需由下一層取得。
- 待實作：研究任務 orchestrator、候選正規化／日期篩選流程，以及安全內容讀取器。
- 下一個理解檢查：若使用者要求最近七天，而 adapter 回傳一篇標題很相關但 `publishedDate: null` 的論文，程式應如何處理，以及為何不能交給 LLM 猜測日期。

## 單元 5：研究搜尋流程控制

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/run-search.ts` 將 `SearchProvider` 的原始輸出轉成可稽核的搜尋結果：逐筆正規化、公開 URL 驗證、精確去重、日期資格判定、正式結果上限與排除原因。
- 日期範圍是硬性資格，不是相關性排序。`publishedDate: null` 的候選會進入 `supplementaryCandidates`，不會計入正式 `candidates`，因此兩篇日期合格加一篇日期未知，正式數量仍是兩篇。
- 單筆壞資料只排除該筆並記錄原因；搜尋無結果則回傳 completed 空結果。取消使用呼叫端同一個 `AbortSignal`，在 provider 前後及處理迴圈中檢查。
- `tests/run-search.test.ts` 以 fixtures 覆蓋日期未知、精確重複、日期超界、不安全 URL、正式結果上限、原始候選安全上限、無結果與預先取消。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：所有硬性規則、資料驗證、計數、分類、去重、上限與取消；這些結果必須可重現。
- LLM／搜尋工具：提出可能相關的候選來源。它不能覆寫日期規則，也不能把未知日期猜成符合範圍。

### 實作與驗證歸屬

- 使用者完成：在具體案例中正確判定正式報告只能顯示兩篇，第三篇只能作為日期待核對的補充候選。
- 助理實作：搜尋 orchestrator 與 5 項流程 fixtures。
- 驗證結果：單元測試與 TypeScript 通過；本單元沒有網路或真實模型呼叫。

### 理解狀態與下一步

- 已介紹並能套用到具體案例：硬性日期資格與相關性是兩個不同維度。
- 待複習：加入日期補查後，補充候選如何重新進入正式候選，以及如何保存這次狀態轉換的證據。
- 下一個核心練習：閱讀 `tests/run-search.test.ts` 的混合失敗 fixture，預測五筆輸入各自落入正式候選或哪一種排除原因，並說明處理順序為何會影響結果。這是設計／除錯練習，不需補樣板程式。

## 單元 6：相同來源的 metadata 合併

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/search-provider.ts` 的 `mergeSearchCandidates()` 不再直接丟棄相同 canonical URL 的後續資料，而是補上第一筆缺少的作者、發布日期、更新日期、來源類型與證據。
- 證據層級採 `metadata < snippet < abstract`；較高層級會連同實際摘錄一起更新。同層級則只在新摘錄較完整時更新。
- 兩個非空值互相矛盾時不自動決定真偽：保留第一筆並寫入 `conflictingFields`。每次合併也記錄原始輸入位置、目標位置及實際補強欄位。
- `electron/research/run-search.ts` 先合併再判斷日期，因此後續重複來源補到可靠日期後，可以正確參與最近七天的資格判定。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：canonical URL 比對、空值補齊、證據層級比較、衝突紀錄與日期資格重算。
- LLM：本單元沒有決策權；尤其不能在兩個衝突日期之間自行選一個。

### 實作與驗證歸屬

- 使用者完成：指出「第一筆勝出」會遺失同來源後續較完整資料，決定改採欄位合併策略。
- 助理實作：保守合併、merge audit、衝突處理，以及跨多組重複來源的原始索引修正。
- 驗證結果：TypeScript 通過；6 個測試檔共 39 項通過；沒有網路或真實模型呼叫。

### 理解狀態與下一步

- 已介紹：補齊缺失值與解決衝突是不同問題；前者可自動化，後者需要更可靠來源。
- 待驗證：實際搜尋來源的 metadata 衝突率，以及內容讀取後能否可靠解決日期衝突。
- 下一個核心練習：比較兩組相同 URL 資料——「第一筆日期空白、第二筆有日期」及「兩筆都有不同日期」——說明為何前者可以自動補值、後者只能記錄衝突。這個練習不需修改樣板程式。

## 單元 7：安全 HTTP(S) 內容讀取器

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/content-reader.ts` 定義 `ContentReader` 與 `SafeHttpContentReader`。成功結果保存來源 ID、最終 URL、redirect 軌跡、擷取時間、MIME type、內容 hash、純文字與截斷狀態；失敗結果保存可處理的錯誤代碼。
- `electron/security/public-url.ts` 負責 URL 形式與明顯私有／保留 IP；reader 再查 DNS，任何解析結果為私有位址就拒絕，並把通過檢查的 IP 固定交給 HTTP socket，縮小 DNS rebinding 的檢查與連線落差。
- 每次 redirect 都重新執行相同檢查，並限制 redirect 次數、循環、timeout、bytes、文字長度、MIME type 與 content encoding。
- HTML 只轉為純文字並移除 script／style 等區塊。像「ignore previous instructions」仍可能出現在正文中，但它只是待分析資料，不會在讀取階段變成程式指令。
- reader 會重新計算 URL 的固定來源 ID；不一致時在網路存取前回傳 `source_id_mismatch`，開始建立引用不錯置的邊界。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：所有網路安全檢查、重新導向、限制、HTML 轉文字、hash、讀取狀態與錯誤分類。
- LLM：本單元完全不使用 LLM。後續只能分析 reader 已取得的資料，不能要求 reader 執行網頁中的指令。

### 實作與驗證歸屬

- 助理實作：ContentReader 契約、固定 DNS 連線、安全限制、文字抽取與 fixtures。
- 驗證結果：TypeScript、renderer／Electron build 與 7 個測試檔共 51 項通過；不含公開網站真實讀取，也不宣稱 PDF 已支援。Electron bundle 首次受沙箱目錄權限阻擋，使用既有核准權限重跑後成功，與 reader 邏輯無關。

### 理解狀態與下一步

- 已介紹：URL 字串看似公開仍不足夠，DNS 結果與每次重新導向都必須再次檢查。
- 待驗證：真實網站的 MIME、charset、HTML 品質與阻擋率；這些需要獨立 E2E 與量測，不能由 fixtures 推論。
- 下一個核心練習：解釋為何 `https://public.example/redirect` 的第一個 URL 通過檢查後，仍不能直接跟隨它導向的 `http://127.0.0.1/private`；指出檢查應發生在 HTTP 請求之前還是之後。

## 單元 8：有界閱讀流程

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/run-reading.ts` 將候選來源排入有限的閱讀預算。論文、官方文件與官方部落格優先；repository 預設標記為 `repository_deferred`，符合 paper-first 決策。
- 搜尋候選數、實際閱讀數與最終報告項目數是三個不同上限。`maxSources` 只控制本輪網頁讀取，不應與使用者要求的報告篇數混為一談。
- 每個來源的嘗試次數限制為 1～3。只有 `network_error` 與 `timeout` 會使用指數退避重試；不支援的 MIME、錯誤來源 ID 等永久問題不重試。
- 單一來源讀取失敗會保存在 `SourceReadRecord`，流程繼續下一來源；呼叫端取消則直接傳播 `AbortError`，停止整個任務。
- 每次 reader 回傳後立即核對來源 ID，避免成功文字或錯誤狀態被掛到另一個來源。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：來源優先順序、去重、repository 延後、閱讀上限、重試分類、嘗試計數、取消與來源 ID 核對。
- LLM：本單元完全不使用 LLM。之後的摘要模型只能接收已成功讀取且仍保有正確來源 ID 的內容。

### 實作與驗證歸屬

- 助理實作：有界閱讀 orchestrator、有限重試與 7 項 fixtures。
- 驗證結果：TypeScript、renderer build 與 8 個測試檔共 58 項通過；沒有網路或真實模型呼叫。

### 理解狀態與下一步

- 已介紹：永久錯誤重試只會增加延遲與負載，暫時性錯誤才適合有限重試。
- 待驗證：paper-first 優先順序與預設閱讀數量，是否能在真實任務中兼顧來源品質與速度。
- 下一個核心練習：假設搜尋得到 5 篇論文、2 份官方文件與 1 個 repository，而 `maxSources = 3`、repository 維持預設延後，請預測哪些來源類型會被讀取，其他來源各自屬於 `read_limit` 或 `repository_deferred`。

## 單元 9：證據與引用驗證

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/report.ts` 的 `buildEvidenceBundle()` 只接受成功讀取、來源 ID／URL／類型一致且內容 hash 合法的資料；讀取失敗另存，不會變成可引用證據。
- 模型草稿只使用固定 `sourceId`，不提供 URL。`finalizeResearchReport()` 再將 ID 映射回程式已驗證的來源，因此不存在讓模型生成新連結的資料欄位。
- 摘要、問題、方法、作者證據與來源限制全部使用 `CitedStatement`。citation 必須是成功讀取來源、屬於該項目的主要或相關來源，而且列出的每個來源都必須實際支持至少一個主張。
- `item_01` 等固定項目 ID 由普通程式依報告順序配置；Markdown renderer 清楚區隔來源主張和助理分析，並只列真正引用的來源。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：證據資格、來源 ID 對應、citation 驗證、篇數上限、固定項目 ID、日期與 URL、Markdown 結構。
- LLM：未來只負責根據 EvidenceBundle 產生結構化文字草稿；它不能新增來源、URL 或繞過引用驗證。

### 實作與驗證歸屬

- 助理實作：EvidenceBundle、結構化報告契約、citation validator 與 Markdown renderer。
- 驗證結果：TypeScript 與 9 個測試檔共 65 項通過；沒有網路或真實模型呼叫。

### 理解狀態與下一步

- 已介紹：提示詞要求「不要捏造引用」不足以形成保證，必須讓程式控制可引用 ID 與 URL 映射。
- 待驗證：模型在真實 EvidenceBundle 上產生可通過 schema／citation validator 的比例與內容忠實度。
- 下一個核心練習：比較「讓模型直接輸出 URL」與「模型只輸出 sourceId、程式映射 URL」兩種設計，找出前者至少兩種可能造成引用錯置或虛構連結的失敗模式。

## 單元 10：結構化報告 provider 與固定研究管線

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/report-provider.ts` 使用 Responses `text.format` JSON schema，模型只能選擇本次實際提供的 source ID。證據總長度有上限，未進入模型 context 的來源也不會出現在 citation schema。
- `electron/research/research-pipeline.ts` 使用固定 stage：planning、searching、reading、generating 與終止狀態。沒有讓 LLM 自行無限迴圈。
- 日期合格數量為零、全部讀取失敗與用戶取消都有不同狀態。

### 哪些由普通程式執行，哪些交給 LLM

- 普通程式：任務合併、上限、stage、證據預算、schema、citation validator 與 Markdown URL。
- LLM：將已讀證據組織成繁中結構化草稿。真實 SIWC structured-output E2E 仍待 UI 驗證。

### 實作與理解狀態

- 助理實作：provider、schema、pipeline 與 fixtures。
- 已介紹：「模型輸出符合 JSON schema」不等於「引用必然正確」，所以還需 app-side validator。
- 下一個練習：從 `runResearchPipeline()` 追蹤一次無日期合格來源的請求，說明為何模型不會被呼叫。

## 單元 11：arXiv 公開論文基線

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/arxiv-search-provider.ts` 把常用中文 AI 主題映射為英文論文查詢，解析 Atom 的 title、author、published、updated 與 summary。
- `published` 是第一版提交日，`updated` 是取得版本的更新日；程式不混為一個「日期」。
- `EvidenceAwareContentReader` 可直接重用 API 已取得的摘要，但在證據與報告中保留 `abstract` 標記。
- 真實 arXiv E2E 通過，並記錄於 `EXPERIMENTS.md`。

### 實作與理解狀態

- 助理實作：provider、XML 解析、安全 reader 擴充與 E2E。
- 已介紹：來源範圍較窄是可觀察的產品限制，比把無日期網路結果假裝成「最近七天」可靠。
- 下一個練習：為新的中文主題新增一個英文查詢別名，並寫一個不呼叫網路的 fixture。

## 單元 12：SQLite 狀態分層

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/research-store.ts` 使用 SQLite 分開保存長期偏好、報告、已讀來源、失敗來源、固定項目 ID 與對話。OAuth token 不進入此資料庫。
- 完整報告使用 transaction 寫入；中途失敗會 rollback。重啟載入時同時核對 JSON 內的引用順序與 relational rows。
- 當次 override 只在 `resolveResearchTask()` 合併，不會呼叫 preference write；「以後」才會更新 SQLite。

### 實作與理解狀態

- 助理實作：migration、store API、IPC／UI 與重啟測試。
- 測試覆蓋：這次不覆蓋偏好、以後可保存及清除、引用不錯置、rollback 與關閉後重開。
- 下一個練習：在 `tests/research-store.test.ts` 新增「損壞的 report JSON 在載入時被拒絕」測試，不修改 production validator。

## 單元 13：改寫與固定項目追問

完成日期：2026-10-01

### 本次概念與程式位置

- `rewriteResearchReport()` 將現有報告重排為短摘要或比較表，不重新搜尋或呼叫模型，且不允許更動項目與引用映射。
- `electron/research/report-follow-up.ts` 只取固定項目的 primary／related evidence；「第二篇」先解析為 `item_02`，才呼叫模型。
- 追問回答同樣區分來源主張與助理分析，citation schema 與 validator 會拒絕用第一篇來回答第二篇。

### 實作與理解狀態

- 助理實作：格式 renderer、follow-up provider、validator、SQLite 對話與 UI。
- 已介紹：格式改寫與新知識請求不同，前者可完全沿用既有證據。
- 下一個練習：預測「第三篇深入一點」在只有兩項的報告上會在哪一層失敗，以及為何模型不應先呼叫模型。

## 單元 14：Structured Outputs 相容性與雙層驗證

完成日期：2026-10-01

### 本次概念與程式位置

- `electron/research/report-provider.ts` 與 `report-follow-up.ts` 的模型端 schema 只保留資料形狀、必填欄位與可引用來源 ID；這降低不同帳號模型對 JSON Schema 關鍵字支援差異造成的請求失敗。
- `electron/research/report.ts` 與追問 validator 仍在信任邊界內檢查非空文字、陣列數量、引用白名單、去重與項目歸屬。模型輸出符合 schema 不代表內容已可信。
- `summaryPoints` 現在同時送入模型任務資料，並由本機 validator 依當次設定強制上限，修正「指令已解析但下游沒有真正執行」的狀態傳遞缺口。

### 實作與理解狀態

- 助理實作：可攜 schema、app-side bounds 回歸測試、摘要數量端到端資料流與交付稽核。
- 驗證結果：113 項 fixture／整合測試通過、1 項外部 arXiv E2E 預設跳過、TypeScript 與 production build 通過；Luna 真實結構化報告仍待 UI 觸發。
- 已介紹：API schema 是輸出形狀約束；業務規則與證據忠實度仍需應用程式驗證及後續評估集。
- 下一個核心練習：查看一份真實 Luna 報告的 `summary`，確認其數量符合任務設定，並任選一條主張沿 `sourceIds` 回查 SQLite 中的實際摘要。

## 單元 15：歷史資料的重新驗證

完成日期：2026-10-02

### 本次概念與程式位置

- `electron/research/research-store.ts` 不再把「先前成功寫入」當成永久可信；每次從 SQLite 載入時，都重新驗證 statement citation、項目來源集合與固定項目順序。
- JSON 報告會和 `report_sources`、`report_items` 關聯資料交叉核對。來源內容、hash、URL 或項目 primary source 任一邊不一致時會拒絕載入。
- `tests/research-store.test.ts` 直接修改測試 SQLite，驗證錯置 citation 與關聯列不一致都能被攔截。

### 實作與理解狀態

- 助理實作：歷史報告深層 validator、關聯資料交叉核對與損壞資料 fixtures。
- 已介紹：持久化資料也是輸入；即使資料庫只在本機，也不能假設它永遠維持最初寫入時的不變量。
- 下一個核心練習：說明為何只檢查 `primarySourceId` 存在，仍不足以阻止 `problem.sourceIds` 指向另一篇報告項目的來源。

## 單元 16：不誇大的評估 baseline

完成日期：2026-10-02

### 本次概念與程式位置

- `electron/research/report-audit.ts` 由普通程式統計來源主張、citation reference、日期覆蓋、摘要級證據與截斷來源。
- 稽核輸出把 `structuralCitationStatus: passed` 和 `semanticSupportStatus: not_evaluated` 分開；引用 ID 可解析不等於來源在語意上支持該句話。
- `src/App.tsx` 在真實或歷史報告上顯示同一組可比較指標，不額外呼叫模型。

### 實作與理解狀態

- 助理實作：deterministic audit、三個 fixtures 與 UI 指標。
- 已介紹：先建立可重複的結構 baseline，再新增需要人工標註或模型 judge 的語意品質評估，才能區分產品功能增加與效果改善。
- 下一個核心練習：挑一條報告主張，人工標記 supported／partially supported／unsupported，並寫下判斷所需的最小來源片段。

## 單元 17：桌面應用的執行期邊界

完成日期：2026-10-02

### 本次概念與程式位置

- `electron/ipc-input.ts` 在 main process 驗證 renderer 傳入的 command、model slug 與 report ID。TypeScript 只能在編譯期協助開發，不能驗證執行時 IPC payload。
- `electron/main.ts` 使用 Electron single-instance lock；第二次啟動只聚焦既有視窗，避免兩個 SQLite writer 競爭。
- `src/App.tsx` 可展開顯示實際保存的摘要、擷取時間與 hash。外部文字由 React escape 後呈現，不被當成 HTML 或指令執行。

### 實作與理解狀態

- 助理實作：IPC runtime validator、三個 fixtures、single-instance lifecycle 與證據檢視 UI。
- 已介紹：renderer 即使有 context isolation，也不是 main process 可以盲目信任的輸入來源；同理，LLM 產生的工具參數必須在執行工具前驗證。
- 下一個核心練習：預測 renderer 傳入 `{ command: '研究' }` 而非字串時，若只依賴 TypeScript 會在哪裡出錯，以及 runtime validator 如何提早拒絕。

## 單元 18：可持久化的對話指涉

完成日期：2026-10-02

### 本次概念與程式位置

- `research-task.ts` 將追問 reference 分成明確序號與 `recent`。`resolveFollowUpItemId()` 只接受已存在的最近 `item_XX`；多項報告缺少上下文時會拒絕歧義。
- `research-store.ts` schema v2 為 messages 加入 `target_item_id`，並包含 v1 → v2 migration。載入歷史報告時可恢復最近指向，不必從自然語言回答反向猜測。
- 更新長期偏好不再清掉畫面上的報告與 active item；單一偏好也可經 allowlisted IPC／store API 刪除。

### 實作與理解狀態

- 助理實作：recent reference、SQLite migration、上下文恢復、單一偏好刪除及回歸 fixtures。
- 已介紹：對話中的「那個」不是靠把所有歷史全文丟給模型解決；可識別的實體應先正規化成穩定 ID，再持久化。
- 下一個核心練習：比較「保存 target_item_id」與「重啟後讓模型從舊回答猜是哪一篇」兩種作法，指出後者至少兩個不可重現的失敗模式。

## 單元 19：人工 citation support 工作表

完成日期：2026-10-02

### 本次概念與程式位置

- `electron/research/evaluation-worksheet.ts` 將來源主張轉成 `summary_01`、`item_01.method` 等穩定 claim ID；助理分析不列入 citation support 評估。
- 工作表引用的是報告當次保存的證據與 hash，不依賴日後可能更新的網頁。所有外部文字先 escape，再寫入 Markdown。
- `electron/main.ts` 與 UI 提供獨立匯出按鈕；不呼叫模型，也不會自動勾選任何品質標籤。

### 實作與理解狀態

- 助理實作：工作表生成、三個 fixtures、IPC 匯出與 UI 操作。
- 已介紹：評估資料必須固定 claim、證據與標註準則；否則不同時間的評分不是可比較實驗。
- 下一個核心練習：真實報告完成後，任選三條 claim 各自標註，並記錄最小支持片段；先不要使用另一個 LLM 當 judge。

## 單元 20：跨模組回歸與 IPv6 SSRF 邊界

完成日期：2026-10-02

### 本次概念與程式位置

- `tests/research-flow.integration.test.ts` 用原始示例指令串過解析、搜尋、閱讀、報告、稽核、SQLite 重載與評估工作表；整條 fixture 不登入、不連網、不消耗方案額度。
- `electron/security/public-url.ts` 的 IPv6 規則改為只接受 global-unicast `2000::/3`，並排除文件、benchmark、Teredo／ORCHID 等特殊範圍。
- WHATWG URL 可能把 IPv4-mapped loopback 正規化為 `::ffff:7f00:1`；新測試確認它和 NAT64 特殊位址都不會繞過私有網段限制。

### 實作與理解狀態

- 助理實作：跨模組 fixture、IPv6 SSRF 修正及正常 global-unicast 回歸案例。
- 驗證結果：137 項 fixtures／整合測試通過，1 項外部 arXiv E2E 預設跳過；TypeScript 通過。
- 已介紹：安全檢查必須在 URL 正規化後判斷，而且同一條規則需重用於候選來源、讀取器與持久化資料重載。
- 下一個核心練習：解釋為何字面字串沒有 `127.0.0.1`，仍不能直接認定 `::ffff:7f00:1` 是公開位址。

## 單元 21：追問的證據邊界與執行前防護

完成日期：2026-10-03

### 本次概念與程式位置

- `electron/research/research-task.ts` 會把追問標記成「可沿用既有證據」或 `requiresNewSearch`。像「第二篇深入一點」可直接使用已儲存來源；「第二篇最新的 GitHub 實作」則需要取得新資料。
- `electron/main.ts` 在呼叫 LLM 前檢查這個標記。第一版尚未具備可靠的論文—repository 關聯查找時，會清楚拒絕需要新資料的追問，而不是讓模型靠記憶猜測。
- 這是 deterministic guard：分類與拒絕由一般程式負責；LLM 只負責在已核准且可引用的證據範圍內整理回答。

### 驗證與理解狀態

- 新增「最新 GitHub 實作」與純深入追問的對照測試；當時全套結果為 135 項通過、1 項需外部網路與真實服務的測試預設跳過。
- 已介紹：同一句追問可能改變資料需求，不能只靠固定項目 ID 判斷能否回答。
- 下一個練習：設計三句追問，分別屬於「只需舊證據」、「需要新搜尋」、「語意仍有歧義」，並說明你預期程式在呼叫模型前採取什麼動作。

## 單元 22：未完成研究的持久化與取消語意

完成日期：2026-10-03

### 本次概念與程式位置

- `electron/research/research-store.ts` 的 schema v3 新增 `research_attempts` 與 `research_attempt_failures`。成功報告仍走原本的報告表；無結果、無證據、失敗與取消則有獨立紀錄。
- `electron/main.ts` 在研究結束或捕捉錯誤時保存最後階段、來源數與公開錯誤資訊。`cancelled` 是獨立 outcome，不會混成 `failed`。
- `src/App.tsx` 在歷史報告下方顯示未完成執行紀錄；OAuth token、方案額度與模型原始憑證都不會寫入這些資料表。

### 驗證與理解狀態

- 助理實作：v1/v2 到 v3 migration、transaction 寫入、排序查詢、兩個 migration／狀態 fixtures 與 UI。
- 驗證結果：153 項通過、1 項外部 E2E 預設跳過；TypeScript 通過。
- 已介紹：使用者取消是預期控制流程，不是系統故障；兩者要分開才能正確評估可靠性。
- 下一個練習：比較 `no_results` 與 `no_evidence` 的資料流差異，指出哪一個已經取得候選 URL、哪一個已經嘗試讀取內容。

## 單元 23：固定任務路由 baseline

完成日期：2026-10-03

### 本次概念與程式位置

- `evaluation/task-routing-cases.ts` 保存 10 個固定輸入與預期路由；`tests/evaluation/task-routing.eval.test.ts` 執行同一批案例。
- `npm.cmd run eval:task-routing` 可以獨立重跑 baseline，不登入、不連網、不消耗方案額度。
- baseline 與一般 unit test 的差別在用途：unit test 保護函式契約；固定 evaluation set 用相同案例比較日後 parser 版本，既有預期不能只為了讓新版本通過而任意改寫。

### 實驗與理解狀態

- 實際結果記錄於 `EXPERIMENTS.md` 的 EXP-004：初始 baseline 為 10/10；加入長期主題案例後先得到 10/11，最小修正後為 11/11。
- 助理實作：固定案例、專用執行指令與第一版量測；這不是使用者獨立完成的成果。
- 已介紹：測試沒有真正收集到案例時，即使工具沒有顯示 assertion failure，也不能算有效實驗。
- 下一個練習：新增一句你平常真的會輸入、但現有 10 例沒有涵蓋的指令；先寫預期路由，再執行 baseline，避免看到結果後才改答案。

## 單元 24：人工 citation support 的匯入與量測

完成日期：2026-10-03

### 本次概念與程式位置

- `electron/research/evaluation-worksheet.ts` 的 `summarizeEvaluationWorksheet()` 解析人工勾選，核對 report ID、固定 claim ID、標籤 allowlist 與單選限制。
- `electron/main.ts` 只允許從系統檔案對話框讀取 2 MB 以下的 Markdown；`src/App.tsx` 顯示標註分布、嚴格支持率及完整或部分支持率。
- 模型不參與評分。未勾選 claim 保持 `unlabeled`，不會被默認成 supported 或 unsupported，也不進入比率分母。

### 實作與理解狀態

- 助理實作：工作表 parser、5 個 fixtures、IPC、檔案上限與 UI 統計。
- 驗證結果：150 項通過、1 項外部 E2E 預設跳過；TypeScript 通過。
- 待實機：取得第一份真實報告後，由使用者人工標註至少三條 claim 並匯入，才有真實 citation support baseline；目前不能填寫尚未執行的結果。
- 下一個練習：說明為何 `supportedOrPartialRate` 較高，不代表摘要一定忠實；特別考慮「主張強度高於證據」被標成 partially supported 的情況。

## 單元 25：跨階段進度資料不遺失

完成日期：2026-10-03

### 本次概念與程式位置

- `electron/research/research-pipeline.ts` 的 `ResearchProgress` 現在會在搜尋後持續帶著 `eligibleSourceCount` 與 `supplementarySourceCount`。
- `electron/main.ts` 將這兩個數字合併進目前狀態；若後續閱讀或報告生成失敗，SQLite 執行紀錄仍能保存搜尋階段已取得的統計。
- 這些數字描述流程觀察值，不代表來源一定被引用，也不代表模型輸出品質。

### 實作與理解狀態

- 助理實作：進度契約、main state 合併及「生成失敗仍保留 1 筆合格／1 筆待核對」fixture。
- 驗證結果：151 項通過、1 項外部 E2E 預設跳過；TypeScript 通過。
- 下一個練習：預測若搜尋找到 4 筆、閱讀上限為 3、其中 1 筆讀取失敗，畫面的「日期合格來源」與模型實際收到的 evidence 數各是多少，並說明兩者為何不應共用同一欄位。

## 單元 26：未完成來源的可追溯保存

完成日期：2026-10-03

### 本次概念與程式位置

- `electron/research/research-store.ts` 的 schema v4 新增 `research_attempt_sources`，保存未完成研究的候選 URL、標題、作者、日期、來源類型、摘錄層級、eligible／supplementary 分類及 read status。
- `electron/main.ts` 在 `no_results` 與 `no_evidence` 時把搜尋結果明細交給 store；`src/App.tsx` 讓使用者展開候選來源，開啟 URL 仍經既有公開 HTTP(S) allowlist。
- 來源錯誤 ID 必須對應同一次執行的候選來源，避免只留下無法追查的孤立錯誤。

### 實作與理解狀態

- 助理實作：v3→v4 migration、transaction 寫入、明細查詢、UI 與兩個 fixtures。
- 驗證結果：153 項通過、1 項外部 E2E 預設跳過；TypeScript 通過。
- 已介紹：summary count 適合快速觀察，但偵錯與研究稽核需要保留逐來源資料，兩者不能互相替代。
- 下一個練習：比較 `not_attempted` 與 `failed`；說明為何超過閱讀上限的第四筆來源不能標成讀取失敗。

## 單元 27：用真實失敗收緊報告邊界與評估持久化

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/report.ts` 現在允許模型在草稿中回傳空的 `analysis.unverified`，再由普通程式補上最小、保守且可重現的限制說明。若證據僅為摘要，會額外標明未讀取 PDF 全文。
- `electron/research/research-store.ts` 的 SQLite schema v5 新增 `report_evaluations`，讓人工 citation support 標註匯入後能跨重啟保留。
- 這個修正不會額外重試模型請求：當輸出已有可用主張與合法引用時，不應為了一個可由程式安全補上的欄位再消耗一次共享用量。

### 實作與理解狀態

- 助理實作：空欄位 fallback、摘要層級限制說明、SQLite v4→v5 migration、評估結果讀寫與回歸 fixtures。
- 驗證結果：157 項通過、1 項外部 E2E 預設跳過；TypeScript 通過。
- 已介紹：Structured Output schema 只是模型輸出形狀的第一層約束，應用程式仍要對引用、上限與最終不變條件進行驗證。
- 下一個核心練習：真實報告成功後，選一條報告主張，從報告的 source ID 追到已讀摘要，判斷它是 supported、partially supported 或 unsupported，並寫下最小支持片段。

## 單元 28：外部搜尋的暫時失敗與有界重試

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/arxiv-search-provider.ts` 只針對 timeout、network error、DNS failure、429 與 5xx 最多再試一次；400 等永久性用戶端錯誤不重試。
- 每次實際請求仍遵守最小間隔，重試前額外等待 5 秒，整個等待與請求都共用同一個 `AbortSignal`。
- `src/App.tsx` 在研究結果卡片直接顯示 `state.research.error.message`，讓使用者能區分搜尋 timeout、額度限制與報告驗證錯誤。

### 除錯證據與理解狀態

- 觀察：App 第四次執行在 `searching` 階段 20 秒 timeout，沒有呼叫 Luna。
- 對照：系統 `curl` 直連 `export.arxiv.org` 曾在 45 秒內完全無回應；稍後由 `arxiv.org/api/query` 導向同一官方 API 時約 1.5 秒成功。
- 回歸：159 項本機測試通過、1 項外部 E2E 預設跳過；另行開啟的真實 arXiv E2E 1/1 通過，不消耗 ChatGPT 額度。
- 已介紹：重試是對特定暫時失敗的有界復原策略，不是對所有錯誤重複嘗試。
- 下一個核心練習仍是完成真實報告後的 citation support 人工標註；本次的重試邏輯由助理實作，不記為使用者獨立完成。

## 單元 29：冗餘來源與錯誤引用的不同處理

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/report.ts` 現在把「模型列入 `relatedSourceIds` 但沒有任何項目主張引用」視為可安全清理的冗餘 metadata，而不是要重試模型的致命錯誤。
- 主要來源是報告項目的身份基礎；若它沒有支持任何 problem、method、evidence 或 limitation，validator 仍會拒絕。
- 只被重點摘要引用的來源會保留在 `citedSources`，即使它從項目的 `relatedSourceIds` 被移除，可點擊連結仍能追溯。
- `electron/research/report-provider.ts` 也加強指令：只有同一項目內至少一條來源主張真正引用時，才應列入 related source。

### 驗證與理解狀態

- 實機證據：第五次執行搜尋成功，有 12 個日期合格來源，失敗階段為 `generating`；錯誤指向多餘的 `src_391c2df4237ce6453e15`。
- 助理實作：冗餘 related source 清理、primary source 強約束、summary-only citation 可追溯性與相關 fixtures。
- 回歸結果：161 項通過、1 項外部 E2E 預設跳過；TypeScript 通過。
- 已介紹：修復應區分「多列了沒用到的來源」與「用了不能支持主張的來源」；前者可刪除，後者不能用程式自動補成支持。

## 單元 30：Structured Output 契約對齊與階段 B 真實驗收

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/report-provider.ts` 只使用官方 Structured Outputs 支援的 `pattern`、`minItems`、`maxItems`、必填欄位與 `additionalProperties: false`，讓模型端先拒絕明顯不合格的形狀；引用歸屬與證據規則仍由本機 validator 負責。
- `electron/research/report.ts` 將重複來源 ID 正規化，並依 claim 的實際引用推導 `relatedSourceIds`；primary source 未支持該項任何主張時仍會拒絕。
- `electron/research/research-pipeline.ts`、`main.ts` 與 `research-store.ts` schema v6 在生成失敗時保存搜尋候選、成功讀取來源與失敗原因，讓外部搜尋、閱讀與模型生成三種問題可分辨。

### 驗證與理解狀態

- 助理實作：schema 約束、本機正規化、失敗 checkpoint、SQLite v6 migration、UI 讀取狀態與 fixtures。
- 自動驗證：164 項通過、1 項外部 E2E 預設跳過；TypeScript、production build 與 11/11 任務路由 baseline 通過。另行執行 arXiv 真實 E2E 1/1 通過。
- 真實驗證：使用者從 UI 以 Luna 完成兩份報告；最新一份有 3 個固定項目、5 個被引用摘要，引用／日期／持久化結構檢查通過，助理抽查語意支持未發現錯置。
- 理解狀態：Structured Output 與 citation validator 已介紹；本次程式修改與語意抽查由助理完成，不記為使用者獨立完成。
- 下一個核心練習：從最新報告選三條 claim，沿 `sourceIds` 比對已儲存摘要，標註 supported／partially_supported／unsupported／unclear，記錄最小支持片段後匯入工作表。

## 單元 31：真實資料快照驗收與 deterministic relevance ranking

完成日期：2026-10-04

### 本次概念與程式位置

- `tests/production-snapshot.e2e.test.ts` 不直接修改正式 SQLite，而是複製到受控暫存目錄，再使用 `ResearchStore` 的正式載入／驗證路徑。它補上 fixture 與真正 production 資料形狀之間的驗收層。
- `electron/research/arxiv-search-provider.ts` 的 `rankArxivCandidates()` 只重排 API 已回傳的有界集合：先比較命中的主題概念數，再比較標題與摘要命中；同分維持原始時間順序。
- 日期是否符合仍由 `runSearch()` 的普通程式硬性判定。相關性高不能把日期未知來源自動變成「最近七天」。

### 驗證與理解狀態

- 助理實作：production snapshot opt-in E2E、相關性排序、透明搜尋範圍說明與 fixtures。
- 驗證結果：完整 suite 166 項通過、2 項 opt-in E2E 預設跳過；production snapshot 1/1、真實 arXiv 1/1、TypeScript 與 production build 通過。
- 除錯流程：sandbox 內真實 arXiv 測試得到 `network_error`；以相同測試在允許網路的環境重跑成功，證明失敗發生在 feed 取得前，不是排序邏輯。
- 理解狀態：production snapshot 與 ranking tradeoff 已介紹；本次程式與測試由助理完成，不記為使用者獨立完成。
- 下一個核心練習：為「AI Agent 與 RAG」各寫一篇只命中單一概念、以及一篇同時命中兩個概念的 fixture，先預測排序，再說明為何日期篩選不能併入 relevance score。

## 單元 32：明確的發布日期模式

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/research-task.ts` 將日期意圖保存為 `publicationDateMode: 'recent' | 'any'`。預設與「最近七天」都解析為 `recent`；只有明確「日期不限」才是 `any`，矛盾指令會在搜尋前拒絕。
- `electron/research/research-pipeline.ts` 只在 `recent` 模式把 `publishedFrom`／`publishedTo` 傳給搜尋器與報告 context。這讓日期未知來源是否合格成為可測試的普通程式規則，而非交給 LLM 自行放寬。
- `electron/research/research-store.ts` 與 `shared.ts` 允許此狀態成為長期偏好；合併順序仍是當次明確指令 > 長期偏好 > 系統預設。

### 驗證與理解狀態

- 助理實作：日期模式 parser、矛盾檢查、nullable 日期邊界、偏好持久化與 fixtures。
- 驗證結果：完整 suite 178 項通過、2 項 opt-in E2E 預設跳過；12/12 任務路由 baseline、production snapshot 1/1、真實 arXiv 1/1、TypeScript 與 production build 通過。正式 SQLite 現有三份成功報告，重啟後完整性仍為 `ok` 且外鍵違規為 0。
- 理解狀態：顯式狀態與「不得偷偷放寬篩選」已介紹；本次程式與測試由助理完成，不記為使用者獨立完成。
- 下一個核心練習：在任務路由 fixtures 各新增一句「以後日期不限」與「這次只看最近 30 天」，預測兩次設定合併後的 `publicationDateMode` 與日期邊界，再執行 baseline 驗證。

## 單元 33：顯式官方 Web Search 研究模式

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/research-task.ts` 新增 `searchMode: 'arxiv' | 'web'`。沒有明確指令時維持 arXiv；矛盾 provider 指令會拒絕，任務理解會在執行前顯示實際搜尋模式。
- `electron/main.ts` 依已解析任務選擇 `ArxivSearchProvider` 或 `OfficialWebSearchProvider`。搜尋模式選擇由普通程式決定，不由 LLM 自行決定是否使用工具。
- `electron/research/research-pipeline.ts` 讀取 provider 的日期能力；官方 Web Search 缺少已驗證日期時，近期任務會在 `search()` 前拒絕。明確日期不限後，候選仍須經 `SafeHttpContentReader` 真正讀取，再交給既有 citation validator。

### 驗證與理解狀態

- 助理實作：搜尋模式 parser／偏好、provider routing、日期能力 guard、UI 用量說明與 fixtures。
- 驗證結果：核心 targeted 64/64，另補一項不限日期零結果呈現測試；完整 suite 186 項通過、2 項 opt-in E2E 預設跳過；13/13 任務路由 baseline、production snapshot 1/1、真實 arXiv 1/1、TypeScript 與 production build 通過。
- 尚未實機驗證：整合後的官方 Web Search 研究路徑尚未真的消耗方案額度執行；不能把 adapter 探測與 fixture 成功寫成完整研究 E2E 已通過。
- 理解狀態：provider routing、能力 guard 與工具結果／已讀證據的差異已介紹；本次程式由助理完成，不記為使用者獨立完成。
- 下一個核心練習：為 `tests/research-pipeline.test.ts` 加入一個日期未知的 Web 候選，先預測 `recent` 與 `any` 兩種 task 各會在哪個函式停止，並用 mock call count 證明近期模式沒有呼叫搜尋工具。

## 單元 34：追問 Structured Output 契約對齊

完成日期：2026-10-04

### 本次概念與程式位置

- 真實「第二篇深入一點」已正確解析到 `item_02`，但 Luna 回傳超過 6 條 `sourceGroundedDetails`，因此 `electron/research/report-follow-up.ts` 的本機 validator 拒絕保存。
- 根因不是來源 ID 或項目定位，而是 `followUpTextFormat()` 未把本機的 1～6 項限制寫進模型端 JSON Schema；模型端契約與本機契約不一致。
- 修正後 `sourceGroundedDetails`、每條 `sourceIds` 與 `analysis.unverified` 都有明確 `minItems`／`maxItems`，文字另有非空白 pattern；本機 validator 保留為第二道邊界，不以截斷掩蓋 provider 違約。

### 驗證與理解狀態

- 助理實作：追問 schema 邊界與 7 項違約 fixture。
- 驗證結果：targeted 29/29；完整 suite 187 項通過、2 項 opt-in E2E 預設跳過；TypeScript 與 production build 通過。
- 真實結果：修正前請求安全失敗且未寫入追問訊息；修正後真實 Luna 重試待使用者從最新版 UI 觸發。
- 理解狀態：觀察現象 → 區分定位／引用／數量錯誤 → 對照 schema 與 validator → 最小修正 → 回歸驗證已示範；程式修正由助理完成。
- 下一個核心練習：比較「schema 先限制」與「收到 7 項後自動截斷」兩種策略，說明哪一種較能保留可重現的輸出契約，以及截斷可能隱藏什麼品質問題。

## 單元 35：自然語言近似輸入的安全路由與結果可見性

完成日期：2026-10-04

### 本次概念與程式位置

- production 訊息證明 UI 實際收到 `二篇深入一點`，少了「第」；舊 parser 因未命中 ordinal 規則，將它當成使用預設設定的新研究，造成額外 arXiv 與模型請求。
- `electron/research/research-task.ts` 現在只對具明確追問語氣、且完整匹配的數字開頭簡寫提供容錯，例如 `二篇深入一點`；它會解析成 ordinal 2，而不是廣泛把所有「兩篇…」視為第二篇。
- `src/App.tsx` 將追問回答移到舊報告內容上方，成功後無需捲過整份長報告才看見結果。

### 驗證與理解狀態

- 助理實作：簡寫 routing、固定 evaluation 案例與 UI 結果位置調整。
- 驗證結果：targeted 32/32；完整 suite 189 項通過、2 項 opt-in E2E 預設跳過；14/14 任務路由 baseline、TypeScript 與 production build 通過。
- 真實資料：誤路由已產生三份額外但有效的研究報告；正式 SQLite 目前共七份報告、14 則一般研究訊息，仍無成功 target item 追問。
- 理解狀態：先查實際輸入而非只看畫面推測、再縮小 parser 規則與改善可見性已示範；程式修正由助理完成。
- 下一個核心練習：列出 `二篇深入一點`、`兩篇深入報告`、`第二篇有哪些限制` 三句各自應走 follow-up、rewrite 或需要澄清的原因，並為其中一個邊界補 fixture。

## 單元 36：未知意圖 fail-closed

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/research-task.ts` 只有在句子包含明確研究意圖時才建立新研究；無法辨識為研究、追問、改寫或偏好更新的文字會先拒絕。
- 這個 guard 防止像「幫我處理一下」或不完整的 ordinal 句子意外啟動搜尋與模型請求；簡短但明確的「近期有哪些 RAG 技術進展」仍可執行。

### 驗證與理解狀態

- 助理實作：研究意圖 guard、邊界 fixtures 與固定路由案例。
- 驗證結果：相關 task／routing 測試 35/35 通過。
- 理解狀態：高成本動作的 fail-closed routing 已介紹；本次程式由助理完成，不記為使用者獨立完成。
- 下一個核心練習：各寫一句「明確研究」與「仍需澄清」的短指令，預測 parser 是否允許啟動研究，再用 fixture 驗證。

## 單元 37：arXiv 官方 HTML 全文證據

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/content-reader.ts` 從正式 arXiv `/abs/` URL 推導同站 `/html/` URL，仍通過既有公開 HTTP(S)、DNS、redirect、MIME、大小與逾時邊界。
- `EvidenceAwareContentReader` 優先讀取足量 HTML 全文；不可用或內容過短時回到已保存摘要。結果以 `full_text` 或 `abstract` 明確標示，不把 fallback 誤稱為全文。
- `electron/research/report.ts`、`report-audit.ts`、`shared.ts` 與 `src/App.tsx` 把實際 reader 證據層級傳入報告、SQLite payload 與 UI 稽核。

### 驗證與理解狀態

- 助理實作：HTML 全文升級、摘要降級、報告傳遞、全文來源計數與 fixtures。
- 驗證結果：型別檢查通過；相關 fixtures 35/35 通過；允許公開網路後，真實 arXiv 摘要與 HTML 全文 E2E 2/2 通過。第一次在 sandbox 內得到 `network_error`，同一測試在允許網路後通過，定位為環境網路限制。
- 理解狀態：搜尋結果／摘要／全文的證據層級差異已介紹；本次程式與真實驗證由助理完成。
- 下一個核心練習：挑一個 `full_text` 與一個 `abstract` 報告來源，說明兩者可安全支持的主張範圍為何不同，並預測 UI 的全文與摘要計數。

## 單元 38：有硬上限的搜尋 orchestrator

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/search-orchestrator.ts` 先執行主查詢，再以普通程式檢查主題概念涵蓋與候選數量；不足時最多執行一次針對缺口的補查，總搜尋呼叫硬上限為 2。
- 多次搜尋結果沿既有 URL 正規化與合併規則去重；日期硬條件、未知日期 supplementary、閱讀上限與 citation validator 均未放寬。
- `electron/research/research-pipeline.ts` 把實際查詢、未涵蓋概念與候選短缺寫入報告搜尋範圍；`shared.ts`、`main.ts` 與 `src/App.tsx` 顯示同一份 trace，達到上限後明確說明不湊數。

### 驗證與理解狀態

- 助理實作：deterministic query planning、coverage gap、最多一次補查、跨查詢去重、取消、短缺狀態與 UI trace。
- 驗證結果：完整 suite 203 項通過、4 項 opt-in 跳過；任務路由 15/15、來源排序 5/5、真實 arXiv 3/3、production SQLite snapshot 1/1，TypeScript、renderer 與 Electron production build 通過。
- 取捨：規劃先由可測試的普通程式負責，沒有新增一次 LLM planning 用量；它能處理顯式「A 與 B」缺口，但不等於語意完整的研究規劃器。
- 理解狀態：bounded agent loop、停止條件與可觀測 trace 已介紹；本次程式與驗證由助理完成。
- 下一個核心練習：給定主查詢只找到 AI Agent、補查找到 RAG、仍找不到 LLM Evaluation 的 fixture，說明停止後 UI 應顯示哪些 trace，以及為何不能進行第三次搜尋。

## 單元 39：追問的受控新證據補查

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/follow-up-search.ts` 先用固定 `item_01`／`item_02` 找到既有項目，再依追問意圖選 provider：最新論文證據走 arXiv；明確 GitHub／程式碼要求走官方 Web Search。
- 新來源仍經同一套最多兩次搜尋、安全公開 URL 閱讀、來源上限與 evidence bundle；repository 只有在明確實作追問時才解除一般 paper-first defer。
- `electron/research/report-follow-up.ts` 將補查來源加入該項目的引用白名單，模型只能引用實際讀到的來源；Markdown 明確區分「沿用舊證據」與「已執行受控補查」。
- `electron/research/research-store.ts` schema v7 保存結構化追問、搜尋 trace 與實際引用內容，歷史報告重載時可恢復最近追問。

### 驗證與理解狀態

- 助理實作：follow-up provider routing、30 天最新證據範圍、repository opt-in、安全閱讀、證據合併、引用驗證、SQLite v7 migration／重啟恢復與 UI 狀態。
- 驗證結果：完整 suite 210 項通過、4 項 opt-in 跳過；任務路由 15/15、來源排序 5/5、production SQLite v6→v7 暫存副本 1/1、完整 production build 通過。
- 尚未實機驗證：補查後的真實 Luna 結構化回答與官方 Web Search repository 結果尚未觸發，因此不能宣稱這條付額度路徑 E2E 已通過。
- 理解狀態：舊證據重用與新證據補查的狀態差異已介紹；本次程式由助理完成。
- 下一個核心練習：比較「第二篇深入一點」與「第二篇找 GitHub 實作」各會呼叫哪些 provider、最多消耗幾次模型請求，以及為何後者不能直接信任搜尋摘要。

## 單元 40：精確數值 citation grounding baseline

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/report-audit.ts` 從每條來源主張抽取數字、百分比、倍數與 k／m／b 數量級，只在該 claim 實際引用的保存內容中核對。
- canonicalization 將 `92.6 percent`／`92.6%`、`100k`／`100000`、LaTeX `5.6\\times`／`5.6倍` 視為等價；不會把空白後單字的 `b` 誤當 billion。
- `evaluation/numeric-grounding-cases.ts` 與 `npm run eval:numeric-grounding` 建立 6 案例固定 baseline；UI 顯示含數字 claim 中需要核對的數量，但仍把完整語意支持標為尚未評估。

### 實際量測與理解狀態

- 初版在 8 份 production 報告的 33 條數值 claim 中警告 18 條；短片段排查證明多數是格式 false positive。
- 修正 canonicalization 後只剩 2/33，皆為報告寫 `95%`、但當時保存的摘要只提供區間端點而未明寫 95% 信賴水準。這兩條保持 warning，不宣稱已證明錯誤。
- 完整 suite 218 項通過、5 項 opt-in 跳過；路由 15/15、排序 5/5、數值 grounding 6/6、production snapshot 2/2、完整 build 通過。
- 理解狀態：precision／false positive、證據層級與「警告不等於判錯」已介紹；規則與量測由助理完成。
- 下一個核心練習：針對剩餘 `95%` claim，選擇「刪除 95%」、「取得全文後保留」或「改列尚未驗證」，並說明各方案的證據要求。

## 單元 41：長全文的有界證據選段

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/report-provider.ts` 在每來源 30,000 字、整份輸入 120,000 字的既有上限內，選取開頭、Results／Evaluation／Ablation、Limitations／Discussion／Conclusion、結尾與分散中段；每段保留原始字元範圍標記。
- `electron/research/report-follow-up.ts` 共用同一 selector，避免報告與追問對「已讀全文」採取不一致截斷策略。
- 非全文來源仍使用前綴；短全文完整傳入。`section_windows` 明確表示不連續片段，prompt 禁止推論被省略內容。

### 驗證與理解狀態

- 助理實作：證據範圍選取、硬字數上限、報告與追問整合及 fixtures。
- 驗證結果：相關流程 37/37 通過；完整 suite 也納入回歸。
- 取捨：沒有增加模型請求或字數額度，能降低只看 Introduction 的偏差；關鍵字選段仍是 heuristic，不保證抓到每篇論文語意最重要的段落。
- 理解狀態：context budgeting 與「已取得全文不等於全文都送進模型」已介紹；本次程式由助理完成。
- 下一個核心練習：在 `tests/report-provider.test.ts` 加入使用 `Findings` 而非 `Results` 的長論文 fixture，先預測目前 selector 是否會選到，再決定是否擴充 heading 規則。

## 單元 42：論文與 repository 關聯證據

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/repository-linkage.ts` 不把搜尋排名或相似名稱當成關聯證明；只有論文正文連到確切 repository、README 含相同 arXiv ID、或含完整正規化論文標題時才標為 `verified`。
- `electron/research/follow-up-search.ts` 將判定與補查 trace 一起傳給回答；`report-follow-up.ts` 會固定補上未驗證警語，且拒絕把未驗證候選說成「官方／作者／該論文實作」。
- 這是來源之間的 evidence linkage，不是 GitHub 組織擁有權或作者身分認證。

### 驗證與理解狀態

- 助理實作：三種可核對關聯、保守 fallback、prompt／本機 validator 雙重保護、持久化驗證與 fixtures。
- 驗證結果：完整 suite 226 項通過、5 項 opt-in 跳過；任務路由 15/15、來源排序 5/5、數值 grounding 6/6。
- 理解狀態：retrieval relevance 與 entity/link verification 的差異已介紹；本次程式由助理完成。
- 下一個核心練習：各找一個「README 有 arXiv ID」與「只有名稱相似」的 fixture，說明為何前者能通過而後者只能列為候選。

## 單元 43：深入追問的可驗收契約

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/report-follow-up.ts` 將「深入／詳細／方法／機制／實驗／證據／限制」視為 depth request，不再只依賴 prompt 希望模型寫得更長。
- 本機 validator 以正規化文字檢查明顯重述：摘要級證據至少要新增一項細節並固定揭露深度限制；有全文時至少要新增兩項彼此不同的來源細節。
- 這個 gate 在模型回應後、寫入 SQLite 前執行，因此不合格回答不會被保存成成功追問。

### 驗證與理解狀態

- 助理實作：depth intent、字面新穎度檢查、全文／摘要差異化契約、固定警語與 fixtures。
- 驗證結果：完整 suite 228 項通過、5 項 opt-in 跳過；三組固定 evaluation 無退步。
- 取捨：字面 gate 能抓完全重複與近似包含，不能可靠辨認所有語意改寫；真正的「有用深度」仍需使用者標註的品質集評估。
- 理解狀態：prompt constraint 與 code-enforced invariant 的差別已介紹；本次程式由助理完成。
- 下一個核心練習：為同一段方法寫一個純改寫版本與一個真正增加實驗設定的版本，預測目前 validator 的判定，並說明可能的 false positive／negative。

## 單元 44：有界背景監測與主動技術摘要

完成日期：2026-10-04

### 本次概念與程式位置

- `electron/research/background-scheduler.ts` 只負責到期檢查、不可重入、前景讓路與取消；`background-discovery.ts` 執行單次有界 arXiv 搜尋。排程與工作內容分離後，可用虛擬 clock 測試，不必真的等待一天。
- `electron/research/research-store.ts` schema v8 保存規則、來源 inbox、摘要與每日模型用量。固定來源 ID 加上資料庫 unique key 是通知去重邊界，不依賴記憶體狀態。
- `electron/research/background-brief.ts` 只接收最多三份新來源摘要，要求 Luna 回傳問題、核心方法、工作價值與未驗證事項；來源 ID 白名單與欄位完整性由普通程式驗證。
- `electron/main.ts` 將 Windows 通知、system tray、登入後啟動與 SIWC 模型狀態接在安全邊界外層。啟動時先恢復帳號／模型，再啟動 scheduler，避免第一次自動摘要的競態。

### 普通程式與 LLM 分工

- 普通程式：頻率、日期範圍、查詢上限、來源去重、每日一次 quota、通知、取消、錯誤延後、狀態保存與來源 ID 驗證。
- LLM：只對已找到的新論文摘要做繁中濃縮與工作價值分析；不能決定是否再搜尋、修改排程或觸發任意外部操作。

### 驗證與理解狀態

- 助理實作：背景監測資料模型、schema v8 migration、scheduler、inbox、Windows 通知、system tray、開機啟動及 opt-in Luna brief。
- 驗證結果：監測相關 35/35、完整 suite 241 項通過、7 項 opt-in 跳過；路由 15/15、來源排序 5/5、數值 grounding 6/6、production build 通過。正式資料庫 migration integrity 為 ok、外鍵違規 0。
- production E2E：正式 App 首次找到 12 個來源並以 `gpt-5.6-luna` 保存 3 份摘要；立即重跑後仍為 12／3，當日背景模型請求計數保持 1。Windows toast 視覺呈現留待使用者 demo。
- 理解狀態：durable scheduling、at-most-once 模型預算與 polling／work separation 已介紹；本次程式由助理完成。
- 下一個核心練習：觸發同一規則兩次，記錄第一次與第二次新增筆數及是否再呼叫 Luna，解釋 SQLite 去重與每日模型上限分別阻止了什麼。

## 單元 45：回饋驅動排序與固定來源深入研究

完成日期：2026-10-06

- monitoring-ranking.ts 以查詢命中、明確回饋、歷史相似度、日期與證據層級做 deterministic 排序；不是讓 LLM 自行改寫偏好。
- monitoring-research.ts 建立只回傳所選來源的 provider，讓「深入研究這項技術」能重用完整研究與引用管線，又不被另一篇搜尋結果替換。
- SQLite schema v9 保存回饋、時間與 linked report；已存在深入報告時直接載入，不重複消耗模型。
- 理解狀態：已介紹；本次程式由助理完成。
- 下一個核心練習：在 monitoring-ranking.test.ts 新增兩個主題相近但回饋相反的項目，先預測排序，再說明明確負回饋為何應高於關鍵字命中。

## 單元 46：每日彙報與可觀測的背景執行

完成日期：2026-10-06

- scheduler 的 polling 與 discovery 分離；即使沒有到期搜尋，onTick 仍可在指定本機整點檢查尚未通知項目。
- SQLite schema v10 保存 lastDigestAt、每項 notifiedAt 與 monitoring_runs；晚啟動會補送同一天尚未發出的摘要，但不重複送。
- 背景 run history 分開記錄搜尋成功、摘要失敗、取消與新來源數，讓 Agent 行為可以被追查而不是只看最後畫面。
- 理解狀態：已介紹；本次程式由助理完成。
- 下一個核心練習：用虛擬時間列出「08:50 啟動、09:00 通知、12:00 重啟」三個時點 shouldDeliverMonitoringDigest 的預期結果。

## 單元 47：官方 feeds、可攜資料與 Windows 發佈除錯

完成日期：2026-10-06

- official-feed-search-provider.ts 解析有界 RSS／Atom，限制每個 feed 的允許 host、保留未知日期，並由 CompositeSearchProvider 容忍單一 provider 故障。
- portable-backup.ts 將 SQLite 快照包成 gzip JSON envelope，附版本與 SHA-256；匯入仍要通過 SQLite migration 與 quick_check。OAuth 憑證不進入備份。
- 封裝除錯依序觀察：功能 tests → Electron bundle → app.asar 內容 → 真實 runtime smoke。smoke 首次抓到 production default reader 使用 750,000 字元、超出 500,000 安全硬上限的啟動 bug。
- 初次 NSIS 失敗與新版 builder 卡住並非 App 邏輯問題；明確指定已由 install-electron 驗證的本機 electronDist 後，electron-builder 26.15.3 成功產生 Setup EXE。產物仍未做可信程式碼簽章。
- 驗證結果：官方 feed／備份 targeted tests、260 項完整 suite、型別檢查、production build 與 app.asar runtime SQLite smoke test 通過；production dependencies audit 為 0 vulnerabilities。
- 理解狀態：已介紹；本次程式由助理完成。
- 下一個核心練習：在 official feed fixture 加入一個 http URL 與一個跨網域 https URL，預測兩者為何都不能進入候選。
