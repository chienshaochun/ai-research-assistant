# 階段 A：Sign in with ChatGPT 整合驗證紀錄

核對日期：2026-10-01（Asia/Taipei）

## 結論

官方文件目前明確提供本機個人／開源應用的 ChatGPT plan usage 路線。符合資格的 ChatGPT Plus 或 Pro 使用者，可在不提供一般 API key 的情況下，另行授權應用以方案額度完成合格的 Responses API 請求。

這不是「Plus 自動等於 API key」：身份登入與方案使用權限彼此獨立。應用必須檢查登入結果確實授予 `chatgpt.tokens.use.direct`，再以該帳號動態列出的模型完成真實串流請求。只有收到完成事件且結果非空，才能判定整合成功。

## 已核對的必要條件

- 初次動態註冊使用穩定、不含個資的 host ID；官方 devkit 產生並保存 `urn:uuid:...`。
- OAuth 使用系統瀏覽器、`127.0.0.1` loopback callback、state、nonce 與 PKCE。
- 不需要 API key、client secret，也不使用 ChatGPT cookies 或非官方 backend API。
- devkit 驗證 ID token 與 granted scopes；`session.sharing === true` 才代表方案使用權限存在。
- 模型清單由登入帳號的 `/v1/models` 結果取得；本專案不硬編文件中的示例模型名稱。
- 推論由官方 `@siwc/local` 的 `streamResponse()` 送往公開 Responses API。該 SDK 依此流程設定 `store: false`、`stream: true` 並等待 `response.completed`。
- preview 路線不支援一般 Responses API 的所有欄位；HTTP 不使用 `previous_response_id`，必要對話歷史須隨 `input` 提供。
- web search 是否可用仍取決於模型、帳號與 workspace policy，不能在登入前假設支援。
- ChatGPT 對話與既有記憶不會因這個授權而提供給應用。

## SDK 與範例追蹤

- 官方 repository：`https://github.com/openai/sign-in-with-chatgpt-devkit`
- 本機固定 commit：`f723814abdccec135b519c451fb6e1992ee5e933`
- commit 日期：2026-09-29
- 使用 workspace：`@siwc/local` 0.1.0、`@siwc/react` 0.1.0
- 授權：Sign-in with ChatGPT DevKit Noncommercial License v1.0

2026-10-01 實際執行 `npm view @siwc/local` 與 `npm view @siwc/react` 均得到 404。兩者是官方 repository 內的 private workspace，而非公開 npm package；因此本專案固定官方 repository 原始碼並由 workspace build，不從 npm registry 假裝安裝同名套件。

## 憑證保存

官方 local SDK 強制應用提供 credential encryption provider，沒有 plaintext fallback。本專案在 Electron main process 使用 `safeStorage`：

- access token、refresh token、ID token 與 registration state 加密後保存在 `%APPDATA%\AI Research Assistant\chatgpt`。
- renderer 只收到官方標示為可安全傳送的 `SessionState`、profile display data 與 model display data。
- token 不進入 SQLite、localStorage、一般設定、log、IPC 回傳或 Git。
- `chatgpt-host.json` 只含非祕密的 host ID。

## 真實驗證狀態

- [x] 官方文件與 devkit 可取得。
- [x] 專案可建置及以 fixtures／mock 測試關鍵授權判斷。
- [x] 使用者在系統瀏覽器完成登入與方案授權。
- [x] `session.sharing === true`。
- [x] 取得帳號模型清單（實測可見 `gpt-6-astra`）。
- [x] 真實模型請求收到完成事件與非空文字（五小時用量恢復後，目前帳號 catalog 列出的所有模型皆通過）。

2026-10-01 第一次真實請求已抵達服務端，但回傳 `subscription_sharing_usage_limit_exceeded`。這證明登入、方案 scope、模型列舉與推論路由均已接通；因未收到 `response.completed`，階段 A 仍未通過。依官方文件，此錯誤可能是 app-specific limit 或共享的 ChatGPT plan 使用限制，不能推斷整個方案已耗盡，也不能自行猜測重設時間。使用者需在 ChatGPT Settings → Usage 查看或調整實際限制；本專案不會自動切換到付費 API key 或購買 credits。

使用者逐一測試帳號列出的模型。第一次測試期間，GPT-5.6 Terra 與 GPT-5.6 Luna 完成真實驗證，之後各模型共同出現 sharing limit。等待五小時共享用量恢復後再次逐一測試，目前帳號 catalog 列出的所有模型皆完成真實驗證。因此階段 A 通過，且先前失敗歸類為用量受限，而非模型不相容。完整限制記錄於 `EXPERIMENTS.md`。

## 官方來源

- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://developers.openai.com/siwc/quickstart
- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- https://developers.openai.com/siwc/ui-ux-guidelines
