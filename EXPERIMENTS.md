# 實驗紀錄

## EXP-001：SIWC 帳號模型的最小推論可用性

日期：2026-10-01

### 問題

由登入帳號動態列出的模型，是否都能透過 ChatGPT plan usage 的 preview Responses route 完成最小文字回應？

### 假設

模型出現在 catalog 是必要條件，但不是充分條件；實際結果仍可能受帳號、workspace policy、模型 route 與當下用量限制影響。

### 設定

- 本機 Electron 應用與官方 `@siwc/local` devkit。
- 同一個 ChatGPT 帳號、workspace 與 app registration。
- 固定提示：`Reply with exactly: Token sharing works.`
- Request 由 SDK 設定 `store: false`、`stream: true`，以收到 `response.completed` 且文字非空為通過。
- 初次請求遇到方案用量限制；使用者在 Usage 頁使用既有方案重置後進行逐模型測試。

### 實際結果

| 模型顯示名稱 | 結果 | 證據 |
| --- | --- | --- |
| GPT-5.6 Terra | 通過 | 應用顯示 A 已驗證，真實串流完成且文字非空 |
| GPT-5.6 Luna | 通過 | 應用顯示 A 已驗證，真實串流完成且文字非空 |
| 其他 catalog 模型（第一次測試） | 因用量受限未完成 | 各模型顯示相同的 ChatGPT sharing limit 訊息 |
| 目前 catalog 的所有模型（五小時用量恢復後） | 全部通過 | 使用者逐一重測，每個模型皆完成真實驗證 |

後續觀察：GPT-5.6 Terra 在先前成功後，稍後的相同驗證也受到方案使用量限制。這證明「當下失敗」可能由會隨時間改變的用量狀態造成，不能覆蓋 Terra 已完成真實推論的相容性證據。

Usage 頁的同時觀察：五小時用量僅剩 6%，頁面顯示約 3 小時 13 分鐘後重設；每週用量仍剩 59%；購買點數餘額為 0；AI Research Assistant 的應用程式使用量上限設為 100%。這使五小時共享上限成為目前失敗的最強假設，但單靠 `subscription_sharing_usage_limit_exceeded` 仍無法排除 app-specific limit。

五小時用量恢復後，使用者以同一 App 再次測試所有 catalog 模型，全部通過。這個控制變因結果支持先前共同失敗源自當時的共享用量狀態，而不是各模型的 SIWC 相容性。

### 限制

- 沒有在文件中逐項記錄所有模型名稱、測試順序、延遲或每次測試時的剩餘用量，因此不能比較各模型的成本或可靠度。
- 測試順序可能與共享用量狀態互相干擾，不能把失敗直接歸因於模型不支援。
- Terra 的先成功後受限、再於額度恢復後成功，顯示單次失敗不能脫離 Usage 狀態解讀。
- 固定提示只驗證最小文字推論，不代表 web search、工具呼叫、長上下文或研究品質可用。
- 結果只適用於測試當下的帳號、workspace、官方 preview route 與政策。

### 下一步

階段 B 在加入 web search 前，應對候選模型逐一保存 model slug、時間、功能、error code、request ID（若有）與結果，形成可重跑的 capability probe；不重複消耗額度做無目的測試。

## EXP-002：SIWC 官方 Web Search 能力探測

日期：2026-10-01

### 問題與假設

問題：最小文字回應成功後，`gpt-5.6-luna` 是否也能透過目前帳號與 SIWC 授權執行官方 Web Search？

假設：只有同時觀察到 `web_search_call`、至少一個安全公開 HTTP(S) 來源及非空完成文字，才能判定工具能力通過。

### 設定

- 模型：`gpt-5.6-luna`
- 固定任務：搜尋官方 OpenAI developer documentation 中關於 web search 的頁面，產生一句簡短說明並引用來源。
- Responses 設定：`store: false`、`stream: true`、`tools: [{ type: "web_search" }]`、`include: ["web_search_call.action.sources"]`。
- 驗收由普通程式執行；頁面截圖由使用者提供。

### 實際結果

- 狀態：通過。
- 完成時間：2026-10-01 19:19:57（Asia/Taipei）。
- 收到非空完成文字及 `web_search_call` 證據。
- 取得並通過 URL 安全檢查的來源：12 個。
- fixture／型別檢查與真實探測分開執行；真實探測僅執行一次。

### 限制與觀察

- 來源集合包含多個與最終回答不直接相關的 API reference 頁面，表示 `action.sources` 不能直接當作高品質引用清單。
- 本實驗只證明目前帳號、workspace、時間點與 `gpt-5.6-luna` 的工具能力，不推廣到所有模型或帳號。
- 尚未驗證來源內容是否完整讀取、回答主張是否由特定來源支持、重新導向後位址安全，以及日期品質。

### 結論

階段 B1 能力探測通過。下一個單元需建立 SearchProvider 的候選結果結構，並把「搜尋候選來源」「回答引用」「實際讀取證據」分層保存與驗證。

## EXP-003：arXiv 公開 metadata 管線的真實 E2E

日期：2026-10-01

### 問題與假設

問題：不使用 ChatGPT 額度時，Windows 本機應用是否能透過安全 reader 存取 arXiv 官方公開 API，並得到可核對日期的論文摘要？

假設：arXiv Atom feed 的 `published` 與 `updated` 可分別作為首次提交日與版本更新日；只有實際解析到 `published` 的項目才能參與「最近七天」篩選。

### 設定

- 來源：`https://export.arxiv.org/api/query`。
- 查詢：AI Agent，`max_results=2`，依 `submittedDate` 降冪。
- 網路邊界：公開 HTTP(S)、DNS 公開 IP、固定已檢查 IP、timeout 與 bytes 上限。
- 遵循 arXiv 舊式 API 條款：單連線，請求間隔至少三秒。
- 測試只有設定 `RUN_ARXIV_E2E=1` 才執行，一般 suite 預設跳過。

### 實際結果

- 直接連線探測回傳 HTTP 200 與 `application/atom+xml; charset=utf-8`。
- `tests/arxiv-live.e2e.test.ts` 真實執行 1 項、1 項通過。
- 取得 1～2 筆真實候選，每筆均具 `paper`、`abstract`、`YYYY-MM-DD` 首次提交日、arXiv canonical URL 與非空摘要。
- 本實驗沒有發送 OpenAI 模型請求，因此不消耗 ChatGPT 共享額度。

### 限制

- 只驗證 metadata／摘要，沒有讀取 PDF 全文。
- 查詢相關性與主題別名尚未以固定資料集量測。
- 沒有驗證當前 Luna 對結構化報告 `text.format` 的真實支援；該項要由 UI 另行觸發。

## EXP-004：自然語言任務路由固定 baseline

日期：2026-10-03

### 問題與假設

問題：目前 deterministic parser 能否穩定區分研究、單次設定、長期偏好、格式改寫、固定項目追問，以及需要新搜尋的追問？

假設：把原始需求中的代表性語句固定成不可隨意改寫的資料集後，日後修改 parser 可以用相同案例比較，避免只修好新句型卻破壞舊語意。

### 設定

- 固定資料集：`evaluation/task-routing-cases.ts`。
- 初始 10 個案例涵蓋原始研究指令、「這次」、「以後」、短摘要、比較表、第二篇、剛才那個方法、最新 GitHub 與兩週／五篇數值解析；其後新增「以後都研究 LLM Evaluation」作為第 11 例。
- 執行指令：`npm.cmd run eval:task-routing`。
- 只執行本機 deterministic parser，不登入、不連網、不呼叫 LLM。

### 實際結果

- 2026-10-03 首次有效執行：10/10 通過。
- 新增第 11 個「長期研究主題」案例後：10/11，失敗輸出顯示路由已是 `preference_update`，但 `preferencePatch` 缺少 `topic`。
- 在 `extractSettings()` 增加長期主題抽取並放寬「之後／未來」語氣後：11/11；全套回歸 148 項通過、1 項外部 E2E 預設跳過。
- 首次嘗試因 Vitest 只收集 `tests/**/*.test.ts` 而未執行任何案例；將執行入口移至 `tests/evaluation/` 後重跑，才取得上述有效結果。

### 限制

- 目前資料集規模小，且案例來自已知需求，不能代表任意繁體中文表達。
- 這只量測路由與參數解析，不量測搜尋相關性、摘要忠實度或 citation semantic support。
- 全部通過是第一版 baseline，不代表 parser 已充分泛化；新增句型應新增案例，而不是改掉既有案例的預期。

## EXP-005：Luna 結構化研究報告實機除錯與成功驗收

日期：2026-10-04

### 問題與假設

問題：已通過最小文字推論與 Web Search 探測的 `gpt-5.6-luna`，能否完整跑過 arXiv 搜尋、閱讀、Structured Output、引用驗證與 SQLite 儲存？

假設：若搜尋與閱讀成功，失敗發生在報告生成階段，應能從已保存的 attempt stage、候選來源與精確 validator 錯誤區分是外部搜尋問題、模型無輸出，還是應用契約過度嚴格。

### 設定

- 從桌面 UI 使用預設研究指令與 `gpt-5.6-luna`。
- 一次真實 SIWC 模型請求；不在失敗後自動重試。
- 查詢 production SQLite 的 `research_attempts` 與候選來源紀錄作為除錯證據。

### 實際結果

- 未完成報告；失敗階段為 `generating`。
- 搜尋階段已取得 12 個日期合格候選來源，因此不是「搜尋無結果」。
- 應用收到可解析的結構化草稿，但第一個報告項目的 `analysis.unverified` 為空陣列；當時本機 validator 要求 1～5 項，因而拒絕。
- 錯誤為：`報告項目[0].analysis.unverified 必須包含 1 到 5 項。`
- 本次沒有產生或儲存報告，不能稱為階段 B 驗收通過。
- 後續兩次執行在 `searching` 階段分別收到 arXiv HTTP 429 與 20 秒 timeout，均為取得候選來源前的外部搜尋失敗，沒有發送報告生成請求，不能用來判斷 Luna 的 Structured Output 能力。
- 第四次執行仍在 `searching` 階段遇到 20 秒 timeout，候選來源為 0，也沒有發送 Luna 請求。
- 第五次執行取得 12 個日期合格來源並到達 `generating`，但草稿在第一個項目列出未支持任何主張的 `src_391c2df4237ce6453e15`，被當時的 validator 拒絕。

### 最小修正與限制

- 草稿允許 0～5 項 `unverified`；當為空時，程式依已讀證據層級補上保守說明，最終儲存格式仍要求至少一項。
- 回歸測試覆蓋一般 metadata 及僅摘要證據兩個分支；全套為 157 項通過、1 項外部 E2E 預設跳過。
- 修正後由 UI 真實重跑成功，production SQLite 保存兩份報告：`rpt_5d0beef3d0bd52975d64`（3 項、3 個引用來源）與 `rpt_ca0573d639185476a1b0`（3 項、5 個引用來源）。這證明目前帳號／workspace 的 Luna 可完成該版 strict Structured Output 路徑。
- 若再遇 arXiv 429 或 timeout，應保留單次失敗並稍後重試，不應立即連續點擊，以免放大外部限流。
- 直接連線對照中，`export.arxiv.org` 曾 45 秒無任何 bytes；稍後官方 API 回應恢復，而專案自身的安全 reader E2E 也在約 2 秒內 1/1 通過。這支持「間歇性外部失敗」而非 Luna 或本機 JSON validator 造成本次失敗。
- 第五次錯誤促成的最小修正是：移除未被項目主張引用的多餘 related source，但繼續拒絕未支持主張的 primary source。成功報告保留真正被 claim 引用的跨來源關係。
- 最新報告的引用 ID、primary source、日期範圍、內容非空與 Markdown URL 檢查全部通過；SQLite schema 為 v6，完整性檢查為 `ok` 且無外鍵違規。
- 助理逐項比對最新報告的 5 份已儲存摘要，未發現數值或方法跨來源錯置；這是一次抽查，不取代使用者標註的固定 citation support 評估集。
- 證據仍全是 arXiv 摘要，不能把成功驗收解讀為 PDF 全文研究品質已通過。

## EXP-006：真實資料快照與 arXiv 相關性排序

日期：2026-10-04

### 問題與假設

問題一：fixture 通過後，格式改寫、固定項目追問與偏好作用域能否處理 production 報告的實際資料形狀？

問題二：arXiv 的 OR 查詢依提交日排序時，閱讀上限是否可能先選到只涵蓋單一主題的候選，而漏掉同時涵蓋多個要求概念的論文？

假設：測試應在 production SQLite 的暫存副本執行；候選排序只在 API 已回傳的有界集合內進行，依「概念涵蓋數、標題命中、摘要命中」排序，同分保留原始新到舊順序，且不改變日期硬篩選。

### 設定

- `tests/production-snapshot.e2e.test.ts` 複製 `%APPDATA%\AI Research Assistant\research.sqlite` 到受控暫存目錄，再測比較表、`item_02`、單次 override、長期偏好及重啟恢復。
- `rankArxivCandidates()` 使用 deterministic regex 計分，不呼叫模型；未知主題不改變 provider 原始順序。
- 真實 arXiv E2E 仍走安全 reader；production snapshot 與 arXiv live 測試平時均 opt-in。

### 實際結果

- production snapshot：1/1 通過，正式資料庫未被修改。
- 相關性排序 targeted suite：23/23 通過；TypeScript 通過。
- 完整 suite：166 項通過、2 項 opt-in E2E 預設跳過。
- 真實 arXiv E2E 在 sandbox 內因網路限制失敗；相同測試在非 sandbox 網路環境 1/1 通過，因此不歸因為排序回歸。
- renderer build 通過；Electron build 在 sandbox 外通過。新版 App 重啟後 production SQLite 完整性仍為 `ok`，外鍵違規為 0。

### 限制

- regex 排序不是語意相關性模型，對未知別名、跨語言同義詞與隱含主題可能沒有分數；這時保留 arXiv 原始順序。
- 排序只能重排 API 已回傳的候選，不能找回因 `max_results` 未進入集合的論文。
- 官方 Web Search 候選通常缺少已核對發布日；在建立日期 metadata 驗證前，不應為了擴大來源而放寬「最近七天」規則。

## EXP-007：明確日期模式與未知日期來源

日期：2026-10-04

### 問題與假設

問題：高度相關但發布日未知的來源，如何在不破壞「最近七天」語意的前提下被使用者明確納入？

假設：應新增可持久化的 `recent`／`any` 狀態。預設保持 `recent`；只有明確的「日期不限」採用 `any`，並在同時出現相反要求時於搜尋前拒絕，而不是讓模型或無結果 fallback 猜測。

### 設定

- parser、設定合併、搜尋 request 與報告 context 使用同一個 `publicationDateMode`。
- `recent` 產生確切起訖日；`any` 不傳日期邊界，允許日期未知來源成為正式候選。
- 固定任務路由集加入一次性的「日期不限」案例；另以單元／整合測試覆蓋矛盾指令、損壞偏好、未知日期來源與重啟持久化。

### 實際結果

- targeted task／search／pipeline／store：48/48 通過。
- 固定任務路由 baseline：12/12 通過。
- 完整 suite：178 項通過、2 項 opt-in E2E 預設跳過。
- production snapshot：1/1 通過；真實 arXiv E2E：1/1 通過；TypeScript 與 production build 通過。

### 限制

- `any` 代表使用者接受「不能用發布日證明近期」，不代表來源內容或品質已驗證。
- 此實驗完成時 UI 研究流程仍只使用 arXiv；該狀態是後續接入日期常缺失的官方 Web Search 候選所需的安全前置條件。

## EXP-008：顯式 Web Search provider routing

日期：2026-10-04

### 問題與假設

問題：如何把已通過能力探測的官方 Web Search 接入研究管線，同時避免日期未知來源被誤判成「最近七天」？

假設：provider 必須由明確任務狀態選擇，預設仍是 arXiv。Web provider 宣告日期能力為 `unknown`，pipeline 在任何工具呼叫前拒絕近期模式；只有使用者明確接受「日期不限」才搜尋、讀取並生成報告。

### 設定

- parser 加入 `arxiv`／`web` 模式與矛盾檢查，固定路由集增加官方 Web Search 案例。
- `OfficialWebSearchProvider` 仍要求真實 `web_search_call` 與安全公開來源；來源清單只是 metadata，後續必須通過安全 reader。
- UI 明確說明官方 Web 路徑通常包含一次工具請求與一次報告生成請求。

### 實際結果

- targeted task／pipeline／store／provider／routing：64/64 通過。
- 完整 suite：186 項通過、2 項 opt-in E2E 預設跳過；固定任務路由：13/13。
- production snapshot 1/1、真實 arXiv E2E 1/1、TypeScript 與 production build 通過。
- 整合後的 Web 研究尚未執行真實 E2E，因此目前結果只證明 routing、guard 與既有 adapter 契約，不能證明真實網頁都能成功讀取或報告模型能完成該次資料形狀。

### 限制

- 第一版是替代 provider，不是 arXiv 與 Web 自動融合或去重。
- Web Search 的工具來源沒有可信發布日；`日期不限` 只是允許納入，並不提升來源品質或證據層級。

## EXP-009：追問 schema 與本機 validator 一致性

日期：2026-10-04

### 問題與假設

問題：為何 `item_02` 已正確定位且模型完成回應，追問仍因「來源主張必須包含 1 到 6 項」失敗？

假設：本機 validator 有陣列上限，但模型端 strict schema 沒有同一上限，因此真實模型可以合法產生超過 6 項，回來後才被拒絕。

### 設定與實際結果

- 對照 `followUpTextFormat()` 與 `validateStatements()`，確認前者原本沒有 `minItems`／`maxItems`，後者要求 1～6 項。
- 將已在真實報告流程通過的陣列 bounds 寫入追問 schema，並保留本機驗證。
- 新增 7 項 provider 違約 fixture，確認第二道邊界仍拒絕；targeted 29/29、完整 suite 187 項、TypeScript 與 production build 通過。
- 修正後真實 Luna 重試尚未執行，因此不能將本次記為追問 E2E 已通過。

### 限制

- strict schema 可限制回應形狀，不能證明每條主張在語意上受摘要支持；仍需人工 citation support 評估。
- 不自動重試或截斷，避免無提示消耗方案額度或把超限輸出偽裝成完整答案。

## EXP-010：追問近似輸入的 production routing

日期：2026-10-04

### 問題、證據與假設

問題：為何使用者預期追問第二篇，畫面卻再次顯示「完成 3 項研究整理」？

production `messages` 顯示實際輸入為 `二篇深入一點`，所有新訊息的 `target_item_id` 都是 null，且報告數增加到七份。假設成立：少了「第」使 ordinal regex 未命中，舊 fallback 將輸入當成預設研究。

### 修正與實際結果

- 新增完整匹配、具追問語氣的 ordinal shorthand；避免把一般「兩篇報告」廣泛當成第二篇。
- 追問結果移到既有報告之前顯示。
- 新增固定路由案例；targeted 32/32、完整 suite 189 項、固定路由 14/14、TypeScript 與 production build 通過。
- 修正後真實追問尚待重試，所以目前只能證明路由與 UI fixtures，不能記為 Luna follow-up E2E 通過。

### 限制

- 規則式 parser 無法消除所有自然語言歧義；高成本或會改變搜尋範圍的未知句型應優先拒絕或要求更明確輸入，而不是默認執行研究。

## EXP-011：arXiv HTML 全文升級與誠實降級

日期：2026-10-04

### 問題與假設

問題：摘要足以篩選候選，但通常不足以深入說明方法、證據與限制；如何提升證據而不誤宣稱讀過 PDF？

假設：對 arXiv `/abs/` 來源先嘗試同站官方 `/html/`，只有安全讀取且正文達最低長度才標為 `full_text`；其餘情況沿用 API 摘要並保持 `abstract`。

### 設定與實際結果

- reader 使用既有 SSRF、DNS pinning、redirect、MIME、2 MB 與逾時防線；fixture 覆蓋成功升級、短內容降級與非 arXiv URL。
- 型別檢查與相關測試 35/35 通過。
- opt-in 真實 E2E 同時搜尋目前 arXiv 結果並讀取 HTML；在允許公開網路後 2/2 通過。此測試不呼叫 ChatGPT，因此不消耗方案額度。

### 限制

- arXiv HTML 並非每篇都有；目前不解析 PDF，失敗時仍只有摘要級證據。
- 正文長度門檻只能排除明顯錯誤頁，不能證明 HTML 轉換完整或表格、公式語意沒有遺失。
- 已證明內容可以安全取得，尚未以真實模型報告量測全文是否實際改善 claim 忠實度。

## EXP-012：有界主查詢與缺口補查

日期：2026-10-04

### 問題與假設

問題：單次固定查詢可能被某個熱門子題淹沒，但無界 Agent 重試會增加用量、延遲與失控風險。

假設：主查詢後以候選標題／摘要檢查顯式主題概念與最低候選數；不足時只允許一次 targeted supplemental query，即可改善涵蓋並保留可預測成本。

### 設定與實際結果

- fixture 覆蓋一次即停止、缺少 RAG 時補查、三主題仍有缺口時達兩次上限、停用補查及第二次搜尋取消。
- 實際查詢 trace、未涵蓋概念與候選短缺會進入 UI 與報告；不合格來源不會用來補足數量。
- 完整 suite 203 項、路由 15/15、排序 5/5；真實 arXiv 搜尋／HTML／orchestrator 3/3，production snapshot 1/1，production build 通過。

### 限制

- 概念切分與涵蓋判斷是 deterministic 文字規則，對同義詞、縮寫與隱含關係可能漏判。
- 補查只重用同一 provider；尚未自動在 arXiv、官方文件與 repository 間切換。
- 目前缺口在候選 metadata 後判斷，尚未依全文閱讀後的證據充分性決定是否補查。

## EXP-013：追問的新證據補查與持久化

日期：2026-10-04

### 問題與假設

問題：原本的追問只能重用舊證據；使用者要求「最新」或「找 GitHub」時若直接交給模型，會產生未搜尋卻聲稱搜尋、或引用未讀來源的風險。

假設：先由普通程式鎖定固定項目、執行同一套有界搜尋與安全閱讀，再把新證據加入該項目的暫時引用白名單，模型即可在不改寫原報告的前提下產生可追溯回答。

### 設定與實際結果

- fixture 涵蓋 repository 明確 opt-in、最新證據 30 天範圍、零結果停止、新舊證據合併、新來源 citation allowlist 與 SQLite v7 重啟恢復。
- 完整 suite 210 項、路由 15/15、排序 5/5；正式 SQLite v6 的暫存副本遷移與既有報告驗收 1/1，完整 build 通過。

### 限制

- 論文與 repository 是否為同一作者的官方實作，目前只靠搜尋相關性；回答必須把身份關聯列為尚未驗證，尚未建立 repository ownership 的 deterministic verifier。
- 官方 Web Search 與最後的追問生成都會使用方案額度；真實 E2E 尚未執行。
- 補查證據保存在追問紀錄，不會無提示改寫原報告的項目或原始引用。

## EXP-014：精確數值 grounding 警告

日期：2026-10-04

### 問題與假設

問題：citation ID 存在不代表 claim 內的精確數字真的出現在引用證據；但直接做語意硬性 gate 可能因格式差異大量誤判。

假設：先建立 deterministic 數字出現檢查並保持 warning，透過 production 報告量測 false positive，再擴充等價格式，比未量測就拒絕報告安全。

### 設定與實際結果

- 固定集涵蓋支持／不支持百分比、全形與千分位、k 數量級、LaTeX 倍數、多來源聯集及單位字首邊界，6/6 通過。
- production 初測 18/33 警告；加入 `percent`、k、`\\times` 與倍數等價後降至 4/33，再修正 `200 bariatric` 被誤讀為 `200b` 後為 2/33。
- 剩餘兩條都是摘要未明寫的 `95%`，因此保留 warning。完整 suite 218 項、production snapshot 2/2、build 通過。

### 限制

- 數值出現只能證明 token 存在，不能證明指標、比較方向、母體或因果描述正確。
- 目前不拒絕生成結果；要升級成硬性 gate 前，需累積更多由人標註的真陽性／假陽性資料。
- 非數值主張仍需人工 citation worksheet 或未來受控語意 evaluator。

## EXP-015：全文 section windows 與 repository 關聯 gate

日期：2026-10-04

### 問題與假設

問題一：固定截取長論文前 30,000 字會偏向摘要與前言。問題二：搜尋到 GitHub 頁面不代表它與目標論文是同一研究。

假設：在相同 context 額度中加入結果、限制、結論與分散區段，並保留原始範圍，可改善證據覆蓋而不增加用量；repository 只接受可重現的強連結規則，可避免把 retrieval relevance 誤報為官方身份。

### 設定與實際結果

- 長文 fixture 驗證 Results、Limitations、Conclusion 與範圍標記都能在 30,000 字硬上限內出現；短全文維持完整輸入。
- repository fixtures 驗證論文直連、arXiv ID、完整標題三種通過路徑，以及相似名稱不通過；另驗證未通過時會注入警語並拒絕「官方實作」主張。
- 完整 suite 226 項通過、5 項 opt-in 跳過；三組既有 evaluation baseline 無退步。

### 限制

- section heading 是字面 heuristic，尚未以人工標註的多篇論文量測 recall；HTML 轉純文字也可能破壞標題結構。
- 標為 `verified` 只代表 repository 內容與論文存在強文字連結，不證明維護者帳號就是作者本人，也不代表程式可執行或重現論文結果。
- 本次沒有呼叫 ChatGPT；真實 GitHub 補查與 Luna 追問仍需另行 opt-in 實機驗證。

## EXP-016：深入追問字面新穎度 gate

日期：2026-10-04

### 問題與假設

問題：模型可以產生語句通順但只重述原報告的「深入」回答；只增加 prompt 無法形成可測驗收條件。

假設：在保存前要求來源細節相對原項目有字面新穎度，並依全文可用性要求一項或兩項不同細節，可以攔截最明顯的空泛重複，同時讓摘要不足時誠實降級。

### 設定與實際結果

- fixtures 覆蓋原句重複、全文只有一項、兩項相同、全文兩項不同，以及摘要自動加入限制警語。
- 完整 suite 228 項通過、5 項 opt-in 跳過；既有路由、來源排序與數值 grounding baseline 無退步。

### 限制

- 目前是正規化字串與高比例包含檢查，不是語意相似度模型；可能漏掉同義改寫，也可能對必要重述過度敏感。
- 尚未執行新版 Luna 真實追問，因此不能宣稱實際生成已達到主觀上「更深入」；需用固定報告與使用者評分比較。

## EXP-017：主動監測的去重、排程與背景模型上限

日期：2026-10-04

### 問題與假設

問題：長時間執行的 Agent 若每次輪詢都呼叫模型、重複通知同一來源，會快速消耗 ChatGPT 方案用量，也無法在重啟後維持可靠狀態。

假設：將 arXiv discovery 與 Luna briefing 分開，以 SQLite 固定來源 ID 去重，並用 transaction 實作所有規則共用的每日一次模型額度，可以在持續監測的同時保持可預測成本。

### 設定與實際結果

- fixtures 覆蓋規則輸入、到期時間、一次搜尋上限、來源重複、失敗延後、取消、scheduler 不可重入、前景讓路、inbox 狀態及重啟保存。
- 模型摘要 fixtures 覆蓋來源 ID 白名單、缺項、重複 ID、額外 ID、摘要保存與跨規則同日 quota 競爭。
- 監測相關 35/35；完整 suite 241 項通過、7 項 opt-in 跳過；production build 通過。
- 正式 SQLite 已成功由 v7 遷移至 v8，`integrity_check` 為 `ok`、外鍵違規 0，既有九份報告與一份追問仍在。
- production 首輪 E2E 在 23 秒內找到 12 個新來源，以 `gpt-5.6-luna` 保存 3 份摘要；立即重跑後來源與摘要分別維持 12／3，資料庫當日背景模型計數為 1。

### 限制

- 已量測一次真實背景流程時間，但樣本只有一次，不能代表日常延遲或摘要品質；Windows toast 的實際視覺顯示仍待人工 demo。
- 目前 discovery 只使用 arXiv metadata，一次最多 12 個候選；brief 只根據摘要且一次最多三項，不代表讀過全文。
- 每日模型額度採 at-most-once：請求開始前就 claim，模型失敗也不在同日自動重試。這降低失控用量，但可能漏掉當日摘要。
