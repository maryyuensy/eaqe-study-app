# 後端接入與驗收步驟

更新：2026-10-04。CP1–CP3 的程式及本機資料庫測試已建立；真實服務、寄信、預覽部署及兩部裝置驗收尚未完成。付款與 AI 保持關閉。

## ✅ 已完成的程式

- 電郵註冊、驗證回呼、登入、重寄驗證信、忘記／重設密碼、刷新及登出 API；密碼交由 Supabase Auth 驗證。
- 登入憑證只在 `/api` 的 HttpOnly、SameSite=Lax Cookie；HTTPS 加 Secure。瀏覽器不保存 access／refresh token。
- JSON 欄位白名單、大小限制、同源及 CSRF 檢查、固定錯誤碼、無秘密日誌、共享資料庫限流。
- 作答、題目版本、練習續做、設定版本、錯題、不確定事件、分頁同步及分開的有效／前景時間。
- 私人 schema、RLS、表格及 function grants、真正 PostgreSQL 16 空白重建及角色拒絕／並發驗證。
- 每帳戶隔離的持久待同步佇列；同一事件重送不重複作答，跨分頁 Cookie 換帳戶不能把 A 資料存入 B。
- 匯出私人學習摘要、重新驗密碼的帳戶刪除。含財務授權的帳戶停止自動刪除，待資料及退款政策定案。
- 題庫覆核阻擋清單及核准匯入門檻；目前沒有已核准商用題目。

服務設定缺失時，API 拒絕啟用，不提供假的登入成功或付款開通。`GET /api/health` 只是存活檢查；`GET /api/config` 顯示帳戶功能是否啟用，不包含服務金鑰。

## 1. 本機與 CI

使用 Node.js 24，從專案根目錄執行：

```sh
npm ci --ignore-scripts
npm run test:ci
npm run dev
```

開啟 <http://localhost:5173/>。沒有服務設定時只能使用訪客原型；登入頁明確顯示尚未啟用。CI 的 PostgreSQL 容器和 `db/tests/bootstrap.sql` 都是可銷毀的合成測試環境，不能在真實 Supabase 執行 bootstrap。

完整瀏覽器測試另需 Playwright 及可啟動的 Chrome；真機測試不能由 Node 測試代替。執行結果見 [安全覆核](BACKEND-SECURITY-REVIEW.md)、[驗收紀錄](QA-ACCEPTANCE.md)及[上線清單](COMMERCIAL-LAUNCH-TODO.md)。

## 2. 建立獨立測試專案 ⭕️

1. 由有權限的管理員建立／提供 Supabase 測試專案及受保護 Vercel 預覽專案。預覽不連正式客戶資料，記錄專案識別但不記錄秘密值。
2. 在真實 Supabase 空白資料庫依次執行 `db/migrations/202610040001_learning_backend.sql`、`db/migrations/202610040002_account_services.sql`、`db/migrations/202610040003_review_concepts.sql`。先閱讀 [資料庫契約](../db/README.md)，留意會讀取 `auth.users` 與 `auth.sessions`。不得把 `db/tests/bootstrap.sql` 的合成 Auth 結構套用到 Supabase。
3. 檢查 Data API exposed schema 沒有 `app_private`；`anon`／`authenticated` 沒有私表讀寫或服務管理 RPC 權限。服務角色只供後端。
4. 以兩個真正測試帳戶檢查 migration 與實際 Auth 欄位、session_id、撤銷狀態及 grants。合成 auth shim 測試通過不能代替這一步。
5. 不匯入建立者私人作答、錯題、教材來源或 `study/` 資料。首次連線只使用明確標示的合成題；正式題目另走內容核准流程。

## 3. 設定秘密及帳戶開關 ⭕️

本機複製 `.env.example` 至 `.env.local`；Vercel 以平台環境變數管理。不要把金鑰貼入對話、Markdown、題庫或 Git。

| 設定 | 用途 |
| --- | --- |
| `APP_ENV` | `local`／`test`／`preview`／`production`；須與平台一致 |
| `APP_BASE_URL` | 網站 origin；遠端必須 HTTPS，不能有路徑、query 或 fragment |
| `DATA_ENV` | 明示獨立資料環境；須與 APP_ENV 一致 |
| `SUPABASE_URL` | 已選測試專案的 HTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | 該專案公開 API key；後端呼叫 Auth／帶本人 token 的 RPC |
| `SUPABASE_SECRET_KEY` | 僅後端的 secret／service-role key；管理、限流及 recovery nonce 使用 |
| `DATABASE_URL` | 管理 migrations 的私人資料庫連線，不傳給瀏覽器 |
| `APP_TERMS_VERSION`、`APP_PRIVACY_VERSION` | 實際完成並發布的文件版本，不能用測試字樣假稱正式條款 |
| `AUTH_ENABLED` | 先維持 `false`；設定、文件與寄信驗收完成後才改 `true` |
| `PAYMENTS_MODE` | 維持 `disabled`；本輪沒有 Checkout／Webhook，`test` 設定也不代表可付款 |

```sh
cp .env.example .env.local
node --env-file=.env.local scripts/check-environment.mjs --require=auth,database
node --env-file=.env.local server.mjs
```

檢查只列設定名稱與狀態，不輸出設定值。設定格式通過仍需實測憑證、連線及專案隔離。現代 secret key 與舊 service-role JWT 的 gateway 行為亦須在實際專案核對。

## 4. Auth、SMTP 與電郵模板 ⭕️

Supabase 開啟電郵確認、最低 12 字密碼及適用的密碼安全／Auth 速率限制；配置正式 SMTP 及服務商要求的 DNS。不要把預設測試寄信當作正式送達驗收。

Site URL 設為該環境的網站 origin；redirect allowlist 限定該網站的 `/#auth-callback`，不要使用所有網域的萬用白名單。此實作使用 TokenHash 交由同源後端驗證，不接受 URL 中的 access／refresh token。

自訂電郵模板連結如下；`SiteURL` 必須是已核准 origin：

```html
<!-- Confirm sign up -->
<a href="{{ .SiteURL }}/#auth-callback?token_hash={{ .TokenHash }}&type=signup">驗證電郵</a>
<!-- Reset password -->
<a href="{{ .SiteURL }}/#auth-callback?token_hash={{ .TokenHash }}&type=recovery">重設密碼</a>
```

不要直接沿用把登入憑證傳至瀏覽器的預設回呼。前端先清除 fragment，再送到 `/api/auth/callback`；signup 驗證後要求本人以密碼登入。Recovery 另有伺服器簽署、十分鐘到期及跨實例單次 nonce。

寄信服務關閉連結追蹤，實測 Gmail、Outlook、手機郵件及連結掃描器；若掃描器會執行 JavaScript 並消耗驗證，要加明確確認步驟，不能稱目前已避免所有預取問題。重設後嘗試撤銷所有會話，失敗會如實提示；還須驗證直接 Auth 密碼更新入口與 secure password change 設定。

官方參考（2026-10-04 核查）：[電郵模板與 TokenHash](https://supabase.com/docs/guides/auth/auth-email-templates)、[密碼安全](https://supabase.com/docs/guides/auth/password-security)、[會話](https://supabase.com/docs/guides/auth/sessions)。

## 5. 部署與真實流程驗收 ⭕️

- 只在受保護預覽部署；核實 Vercel Node 24、`api/[...path].mjs` Web Request／Response 路由、Origin、複數 Set-Cookie 及 HTTPS Cookie。
- 瀏覽器只呼叫同源 API，CSP 的 `connect-src` 保持 `'self'`；不因接入後端就放寬至任意網域。
- 兩個帳戶及手機／電腦走註冊、驗證、登入、刷新、重設、登出、錯題、斷線重試、續做及設定衝突。付款／AI 不出現假成功。
- 帳戶刪除若 Auth 服務失敗，profile 會停止新寫入；管理員須完成刪除或受控恢復。跨重新整理的刪除工作狀態、財務保留及備份 tombstone 仍待 CP6，不能稱完整生命週期已完成。
- 核實平台請求日誌不保留密碼、token、原始請求內容；API 自身遮蔽錯誤不等於平台日誌已設定。
- `vercel.json` 及 `vercel.commercial.json` 均以商用核准建置為預設；0 題核准時阻擋新的部署產物，不能把 outputDirectory 改回 `dist` 或用空預覽參數略過正式發布門檻。另核對 Vercel project／CLI 沒有以設定覆寫此要求。既有已部署版本沒有被撤下，舊 GitHub／Vercel 副本與已下載內容不能由新授權系統撤回。

Vercel 參考：[Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)。沒有外部專案驗收，不將 CP1–CP3 整體標為完成。

## 6. 接入依賴

| 時點 | 需要營運者提供／確認 |
| --- | --- |
| 登入與同步 | 測試服務專案存取權、寄信／網域設定、已核准條款及私隱文件 |
| 題庫發布 | 內容、答案、逐項解說及商業使用權覆核；目前 0 題核准 |
| 付款 | 服務商／商戶、方案範圍、到期後權限、退款與爭議、官方改期／取消安排 |
| AI | 供應商／模型、免費及付費用量、月度與每帳戶成本上限、保存方式與期限 |
| 公開收費 | 正式網域、客服信箱、試用人選、預算、真機及真實付款驗收 |

可逆技術工作繼續由開發者完成；上述依賴取得前維持相關功能未啟用。
