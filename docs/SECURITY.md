# 安全邊界與威脅模型

最後更新：2026-10-02

這是本機個人專案的工程 threat model，不是第三方資安稽核或安全認證。

## 需要保護的資產

- ChatGPT OAuth access／refresh token 與 granted scopes。
- 使用者的研究指令、長期偏好、來源內容、報告與追問。
- 本機檔案、localhost、私有網段服務及 Windows 使用者權限。
- 報告引用的正確來源對應，避免虛構 URL 或跨項目錯置。

## 信任邊界

### 1. OAuth 與方案授權

- 只使用官方 Sign in with ChatGPT devkit、loopback callback、PKCE、state 與 nonce。
- token 留在 Electron main process 的官方 protected storage，透過 `safeStorage` 加密；不傳到 renderer、不寫 SQLite、不記錄 log。
- Connected 與 `chatgpt.tokens.use.direct` 分開判斷；只有真實 `response.completed` 才算模型整合成功。
- 尚存風險：SIWC 是 preview，帳號／workspace policy、模型 route 與共享額度可能隨時間改變。

### 2. Renderer 與 main process IPC

- BrowserWindow 啟用 sandbox、context isolation，停用 node integration 與 DevTools；CSP 禁止外部 script、connect、frame、object 與 form。
- preload 只暴露明確 bridge；main 驗證 sender、main frame 與自訂安全 scheme。
- `ipc-input.ts` 在執行時驗證文字型別、長度與控制字元，不依賴 TypeScript 型別。
- single-instance lock 避免多個主程序同時寫相同 SQLite。
- 尚存風險：Electron／Chromium 或依賴套件本身的未知漏洞不在此專案測試範圍。

### 3. URL、DNS 與內容讀取

- 只接受無帳密的公開 HTTP(S)，拒絕 localhost、單標籤／內部網域、私有／保留 IPv4 與非 global-unicast IPv6。
- 每次 redirect 都重新正規化 URL、解析 DNS、確認所有結果為公開 IP，並把實際連線固定到已檢查的 IP，降低 DNS rebinding／TOCTOU。
- 限制 redirect、timeout、bytes、文字長度、MIME 與 content encoding；不執行頁面 script，HTML 只轉純文字。
- IPv4-mapped IPv6、NAT64 特殊範圍與 encoded loopback 有 fixtures。
- 尚存風險：HTML 正文抽取是規則式 baseline，不保證取得語意上完整的文章；PDF 尚不解析。

### 4. 外部內容與 LLM

- prompt 明確把來源內容視為不可信資料；一般研究流程不讓來源文字觸發本機工具。
- 模型只收到有上限的已讀證據與 source ID，不收到可自行改寫的 URL。
- strict JSON schema 限制形狀；app-side validator 再檢查數量、文字、citation 白名單、項目歸屬與去重。
- URL、固定 `item_XX` 與 Markdown 由普通程式產生。
- 尚存風險：結構正確不等於語意忠實；citation support 仍需固定標註集與人工／受控評估。
- 匯入評估工作表只讀取使用者在系統對話框選取的 Markdown，限制為 2 MB；內容只作為文字解析，不執行 HTML、連結或內嵌指令，且必須與目前報告 ID／claim ID 完整對齊。

### 5. SQLite 與匯出

- 報告、來源、失敗、項目與訊息用 transaction 寫入；失敗 rollback。
- 重載時重新驗證 JSON，並與 `report_sources`、`report_items` 關聯列交叉核對。
- messages v2 保存固定 target item；不從舊回答猜測「剛才那個方法」。
- Markdown 評估工作表會 escape 外部文字；匯出內容仍可能含敏感研究資料，使用者需自行保護檔案。
- 尚存風險：SQLite 未另行做檔案層加密；它依賴 Windows 使用者帳號與資料目錄權限。

## 明確不做的事情

- 不擷取 ChatGPT cookies，不借用其他應用憑證，不使用非官方反向代理。
- 不在額度不足時偷偷切換 API key 或付費服務。
- 不讓網頁內容改寫系統規則、讀本機檔案、連 localhost 或執行任意命令。
- 不把 mock、fixture、結構檢查或可點擊引用當成真實模型能力與語意品質已通過。

## 回報問題時可保留／不可保留

可保留：錯誤 code、HTTP status、request ID、stage、模型 slug、來源 ID。

不可貼入 issue、log 或聊天：access token、refresh token、authorization header、密碼、cookies、完整私人研究資料庫。
