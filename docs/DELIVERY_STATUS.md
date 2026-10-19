# 交付與實機驗證狀態

最後更新：2026-10-06（Asia/Taipei）

## 已完成並驗證

- 官方 Sign in with ChatGPT、plan usage 授權、安全憑證保存、登出、帳號模型目錄及真實最小模型回應。
- `gpt-5.6-luna` 真實 Web Search 能力探測；成功條件包含工具事件、公開來源與完成文字。
- arXiv 有日期論文搜尋、官方 HTML 全文優先／摘要降級閱讀、明確的近期／不限日期模式、來源去重、讀取失敗記錄與有界取消流程。
- 結構化報告、引用 ID 白名單、固定項目 ID、來源主張／助理分析分離、Markdown 改寫與第二篇追問。
- SQLite 長期偏好、歷史報告、來源、失敗紀錄及對話持久化；OAuth token 不寫入 SQLite。
- 自動驗證：TypeScript 通過；完整 fixture／整合／固定 evaluation suite 持續回歸，外部與 production E2E 維持 opt-in，不會在一般測試消耗方案用量。
- arXiv 真實外部 E2E 3/3 已另外執行通過；涵蓋 metadata、官方 HTML 全文與有界 orchestrator。日常 `npm test` 會明確跳過它，以避免反覆存取外部服務。
- production SQLite snapshot E2E 已另外執行通過；真實報告可在暫存副本完成比較表改寫、第二篇固定 ID、偏好作用域與重啟恢復，正式資料不會被測試修改。
- 正式 SQLite 已保存九份真實研究報告與一份 `item_02` 追問；既有固定項目、引用與來源內容均可讀取。
- production SQLite 目前 schema v10；v8 新增監測基礎，v9 新增回饋與深入報告連結，v10 新增每日彙報時間、通知時間與背景執行紀錄。
- 數值 citation grounding 固定集 6/6；先前 production 8 份報告共有 33 條數值 claim，格式正規化後剩 2 條 `95%` 警告，均因保存摘要未明寫信賴水準。
- 主動監測 fixtures 已涵蓋規則驗證、到期計算、來源去重、失敗延後、不可重入排程、取消、inbox 狀態、摘要來源白名單、摘要保存與跨規則每日一次模型額度。
- 背景搜尋不使用 LLM；自動摘要必須由使用者明確啟用，固定使用帳號可用的 Luna，一次最多三項且所有規則每天合計最多一個模型請求。
- 主動監測 production E2E 已由正在執行的正式 App 完成：首次找到 12 個新來源，以 `gpt-5.6-luna` 保存 3 份摘要；立即重跑後仍為 12／3，當日背景模型計數為 1。

- 主動監測現在合併 arXiv 與 OpenAI News、Hugging Face Blog、Google Blog 公開 feeds；單一 feed 失敗不影響其他 provider，RSS MIME、安全 URL host 與日期未知行為皆有 fixtures。
- 收件匣支援明確回饋排序、一鍵固定來源深入研究、每日指定時段彙整通知、晚啟動補送與背景 run history。
- 可攜備份包含研究 SQLite 快照與 SHA-256，不含 OAuth token；round-trip、篡改拒絕與 SQLite quick_check 已自動驗證。
- Windows app.asar 已以 Electron runtime 真正啟動、建立 167,936-byte SQLite 並以退出碼 0 完成 smoke test。

## 階段 B 實機驗收結果

- 2026-10-04 從桌面 UI 使用 `gpt-5.6-luna` 送出預設研究指令，確認目前 SIWC 路線接受 `text.format` strict JSON schema。
- 最新報告主題為「AI Agent 與 RAG」、日期為 2026-09-28～2026-10-04；3 個項目及所有 3 個被引用來源都符合日期範圍。
- 普通程式重新核對：項目數與資料庫列一致、固定項目 ID 正確、所有 citation／primary source ID 存在、每個 primary source 支持該項至少一條主張、已引用內容非空、所有原始 URL 均出現在 Markdown。
- 人工逐項比對已儲存摘要後，問題、方法與數值證據均能在對應摘要中找到支持；未發現跨論文錯置。此檢查是本次助理抽查，不等於已建立由使用者標註的固定品質集。
- 所有來源的 `evidenceLevel` 都是 `abstract`；本次驗收不宣稱讀過 PDF 全文。
- arXiv 有界候選加入 deterministic 主題涵蓋度排序；真實 arXiv E2E 在非 sandbox 網路環境重跑 1/1 通過。

## 第一版刻意保留的限制

- 一般研究目前以 arXiv 為預設，優先讀官方 HTML 全文但不解析 PDF；這仍不等於完整 web search。
- 官方 Web Search 已成為明確切換的替代 provider；fixture 已驗證 `web + recent` 在工具呼叫前拒絕、`web + 日期不限` 可跑完研究管線。整合後的真實研究 E2E 尚未由使用者觸發，且第一版不會自動混合 arXiv 與 Web 候選。
- repository 已有保守的強連結 gate（論文直連、相同 arXiv ID、完整標題），但不驗證 GitHub 帳號所有權或可重現性；因此一般研究的「只看有開源程式碼」仍會拒絕，明確 GitHub 追問則可回報已驗證關聯或候選來源。
- 已建立 15 案例的固定任務路由 baseline；已有真實報告可作為第一份品質樣本，但尚未完成使用者人工標註的固定品質集。引用結構可驗證，摘要忠實度、重要性排序與實驗建議品質仍需 baseline。
- 主動監測使用 arXiv metadata 與有限官方 feeds；不在背景自動執行一般 Web Search，也不自動讀取所有全文，避免不可預測的模型與網路用量。
- Windows 通知與系統匣已實作，成功結果已走過通知呼叫路徑；toast 是否在目前桌面顯示仍留給人工 demo 確認。
- electron-builder 26.15.3 透過本機 electronDist 已成功產生 NSIS x64 Setup EXE 與 ZIP 便攜版；產物未做可信程式碼簽章，安裝／解除安裝 E2E 尚未執行。
- 不提供多 Agent、向量資料庫、雲端部署或付費 API key fallback。

## 下一個開發單元

1. 由使用者從桌面 UI demo 檢視多來源 inbox、回饋排序、每日彙整通知與一鍵深入研究。
2. 由使用者對真實報告至少三條 claim 進行 citation support 標註並匯入，建立第一份可重跑品質 baseline。
3. 明確執行一次「使用官方 Web Search，日期不限」真實研究 E2E；此路徑通常會使用一次搜尋工具請求與一次報告生成請求。
4. 真實驗證一次「第二篇找 GitHub 實作」；這會使用官方 Web Search 與追問生成額度，並檢查 deterministic repository linkage 結果是否正確呈現。
