# CP1–CP3 後端安全與整合覆核

覆核日期：2026-10-04。這是本輪程式閱讀、合成重現及測試紀錄，不是全系統安全認證。沒有使用真實登入、付款或外部帳戶；本機 PostgreSQL 執行結果與真實 Supabase 驗收分開記錄。

範圍：`lib/application.mjs`、`lib/api.mjs`、`lib/cookies.mjs`、`lib/recovery.mjs`、`lib/supabase.mjs`、資料庫 migrations、`dist/cloud.js`、`dist/app.js`，以及相關測試。下列狀態反映本輪最後程式檢視及本機重測；外部服務仍待驗收。

## ✅ 已檢視的防護

- 權限身分來自伺服器驗證的 Supabase 使用者；學習 RPC 以 `auth.uid()` 查詢，客戶不能提交 `user_id`、分數、付費資格或掌握狀態作權限依據。
- `app_private` schema／資料表撤銷 `anon`、`authenticated` 直接讀寫權限，表格啟用 RLS。敏感服務角色呼叫集中在限流、recovery nonce、刪除準備及刪除使用者；一般學習 RPC 使用使用者 token。這仍須以真實環境確認 grants 沒有額外被開放。
- SQL `SECURITY DEFINER` functions 明確固定空 `search_path`，內部資料表及 helper 以 schema 限定。
- 帳戶刪除先重新輸入密碼核對同一使用者，先凍結帳戶再刪除 Auth 使用者；含 access grant 的帳戶拒絕自動刪除，避免在財務保留政策未完成前直接清除。
- POST／PUT／PATCH／DELETE 要求設定的網站 Origin、JSON 及自訂 mutation header；cross-site fetch 拒絕，body 大小及欄位採白名單。
- Cookie 使用 HttpOnly、SameSite=Lax；HTTPS 環境加 Secure。重複、非法 cookie 值拒絕，API 回應 `no-store`，錯誤及日誌不輸出密碼、token 或原始例外。
- 作答答案由資料庫依題目版本評分，重送同事件同內容回原結果，同 ID 不同內容拒絕；同一練習位置有唯一約束，版本比對避免兩部裝置覆寫。
- 到期權限在建立、恢復及提交練習時重核；伺服器日期決定日別與重溫，不以客戶日期計算權利或掌握。

這些是程式中可觀察的防護，不表示所有入口、設定或實際部署都已通過。

## 已發現問題及修復狀態

| 編號 | 優先級 | 有證據的問題 | 本輪處理狀態 |
| --- | --- | --- | --- |
| S01 | 高 | 僅 Node API 有每使用者限流，但 authenticated 可直接執行 SQL RPC，繞過 API 限流後持續建立 session、event 或 usage | ✅ private helper 加入每使用者 120 次／分鐘；本機 PostgreSQL 共享限流及併發測試通過。失敗交易回滾限制仍需 gateway 補充 |
| S02 | 高 | 跨分頁登入 B 後，仍認作 A 的頁面可把 A 待同步 usage／settings 送到 B cookie 帳戶 | ✅ 前後端帳戶一致性檢查；同 fixture 重測拒絕錯帳戶寫入／登出，保留 A 待同步事件 |
| S03 | 高 | 登出或全域撤銷後，未過期 access JWT 仍可通過只查 `auth.uid()` 的直接 SQL RPC | ✅ SQL 校驗 session ID、使用者、會話期限及封鎖狀態；本機拒絕測試通過。真實 Supabase 撤銷行為仍待驗收 |
| S04 | 高 | reset 只因 cookie 叫 `pe_recovery` 就信任普通 access token；普通登入 token 改放此 cookie 可更新密碼 | ✅ recovery 專屬簽署、使用者／十分鐘期限及資料庫單次 nonce；普通 JWT、竄改、過期、重播測試通過 |
| S05 | 中 | DELETE 帳戶重新驗密碼沒有獨立限流，原上限比正常登入寬 | ✅ 每帳戶 3 次／15 分鐘；耗盡時在再次驗密碼前回 429，合成重測通過 |
| S06 | 高（可用性） | authenticated 可直接執行 `app_prepare_delete`，跳過 Node 重新驗密碼後永久掛起自己的帳戶 | ✅ 改為 service-only UUID 參數；API 先核對密碼重新認證為同一帳戶。本機普通／匿名呼叫拒絕及金融 gate 通過 |
| I01 | 高（整合） | DB 解說是 `core/apply/options/memory`，前端讀其他欄位，合法題目作答後無法顯示完整解說 | ✅ 完整欄位顯示並按洗牌後穩定 option ID 對應解說，前端測試通過 |
| I02 | 中（整合） | 將 account_mismatch 的 409 當成永久事件衝突，原帳戶回來後也不能再同步該事件 | ✅ 保留可重試事件；重新登入 A 後同一 event ID 只接受一次，整合測試通過 |
| I03 | 中（整合） | 晚加「不確定」事件與原作答 confidence 分開，session restore 可能把 UI 後加標記覆蓋 | ✅ 已檢視獨立 `postUncertain`、原作答信心及 authoritative review 狀態的處理；現有前端回歸測試通過，真實跨裝置流程待驗收 |

### S01：直接 RPC 與資源使用

初始 SQL 明確把公開學習 RPC `EXECUTE` 授予 authenticated；Node 的 `authenticated()` 才呼叫 `user-api` limiter。使用者即使不能直接修改私有表格，仍可跳過 Node 呼叫獲准 RPC，故不能把 Node 120 次／分鐘當作全部入口都受限。

已修復：`lock_user()` 呼叫不可讓客戶重設的 `app_private.throttle_user()`，按使用者 UUID 的 SHA-256 key 實施資料庫共享限流；limiter RPC 維持 service-only 權限。失敗 SQL transaction 的計數可 rollback，因此仍需 API／gateway 層限制無效請求；長期資料容量、保留政策亦須另外處理。沒有把這項修復描述為完整 DDoS 防護。

### S02：跨分頁共享 Cookie 的帳戶競態

以合成 `createApplication` provider 及 `AccountOutbox` 重現：outbox owner 為 A，HTTP cookie 已由另一頁面切換至 B，伺服器驗證為 B。原版成功呼叫 `app_add_usage`，並清空 A 該事件。generation guard 只在頁面已知道帳戶改變時有效，不能驗證共享 cookie 是否已先改變。

已修復並重測：使用 `X-App-Account` 作一致性檢查，伺服器仍只由已驗證 cookie 決定使用者，header 不授權另一帳戶。已驗證 ID 與 header 不同時回 409，未執行寫入或登出副作用；GET account discovery 用於辨認當前 cookie 帳戶。錯帳戶拒絕後原事件仍可重試，原帳戶重新登入後以同一 event ID 接受一次。

這是錯帳戶寫入及待同步資料遺失風險；沒有證據顯示可用自己的身分讀取另一帳戶完整紀錄。作答的 session owner 檢查已能拒絕另一帳戶的 session ID。

### S03：會話撤銷與直接 RPC

Supabase 官方明示，sign out／global 撤銷 refresh session 後，access JWT 仍可有效至 `exp`；每個 JWT 的 `session_id` 可對應 `auth.sessions`。初版 `lock_user()` 只查使用者存在、電郵確認及非匿名，未查 session 是否仍存在，亦沒有檢查 `banned_until`。[Supabase 登出說明](https://supabase.com/docs/guides/auth/signout)、[會話說明](https://supabase.com/docs/guides/auth/sessions)。核實：2026-10-04。

故不能僅以清除瀏覽器 cookie 或 global logout 呼叫成功宣稱舊 access token 立刻不能執行資料庫 RPC。已修復：`verified_user()` 要求 JWT 具有有效 UUID 的 session ID、對應同使用者且尚未到期的 `auth.sessions`，並拒絕 `banned_until` 未到期帳戶。本機已刪會話、封鎖及會話期限拒絕測試通過；測試 shim 不等於真實 Supabase Auth 行為。

### S04：密碼重設必須驗證 recovery 證明

合成重現在沒有呼叫 callback／`/verify` 的情況，把普通登入 access token 放進 `pe_recovery`，reset endpoint 回 200 並呼叫 provider `PUT /user`。Cookie 名稱不能證明 token 來自已驗證 recovery callback；`Max-Age=600` 只控制瀏覽器，不構成伺服器上的十分鐘到期檢查。

已修復：經 provider `/verify` 後才發出 recovery 專屬 HMAC 證明，綁使用者、用途、伺服器十分鐘期限及隨機 nonce。資料庫只保存 nonce hash，service-only 消耗在更新密碼前以原子操作完成。合成重測：普通 token 改名回 401、callback 回 200、首次 reset 回 200、重播回 401，provider 密碼更新只發生一次；竄改及過期測試亦通過。單次證明在 provider 更新失敗後亦已消耗，使用者須重新取得重設連結。撤銷其他會話失敗時 API 回 `sessionsRevoked:false`，前端明示尚未全部撤銷。

另須驗收真實 Supabase 的直接 password update、secure password change／current password 設定；不能假定自訂 reset API 自動限制了 Auth provider 所有入口。[Supabase 密碼安全設定](https://supabase.com/docs/guides/auth/password-security)。核實：2026-10-04。

### S06：刪除準備不能旁路重新認證

初版 `app_prepare_delete()` 授予 authenticated，SQL 自身沒有重新輸入密碼的證據，會直接把 profile 設為 suspended。Node DELETE 的密碼驗證只能保護實際 Auth 刪除，不能阻止直接 RPC 掛起帳戶；目前亦沒有使用者自行解除掛起的入口。

已修復：`app_prepare_delete(p_user_id uuid)` 只授予 service role，撤銷 PUBLIC、anon、authenticated 執行權。後端先以目前已驗證帳戶的電郵及輸入密碼重新認證，再要求回傳 ID 等於原帳戶；最後把該受信任 ID 傳入 service-only RPC。已檢查 API／SQL 參數一致、SQL 驗證電郵／非匿名／非封鎖、金融資料 gate 及凍結後同帳戶重試仍保留。

合成反例重測：重新認證回傳 B 而 cookie 為 A 時回 403，刪除準備及 Auth 刪除均沒有執行。資料庫團隊本機實跑普通 authenticated／anon 呼叫均回權限拒絕（42501），未驗證 service user 拒絕、含 grant 帳戶仍回 `APP_CONFLICT`。這不是跨帳戶 ID 查詢漏洞；修復關閉跳過已要求密碼確認而造成永久掛起的入口。

## ⭕️ 外部環境與上線驗收

- 本機 PostgreSQL 16 已執行下列測試；真實 Supabase staging 的 Auth schema、PostgREST grants／exposure、JWT 驗證及系統設定仍須再驗收，不能以本機結果代替。
- 真實 Supabase signup、不同裝置驗證信、recovery 單次／逾期、刷新 token、global logout、被封鎖帳戶、刪除成功與 provider 失敗重試。
- Supabase email confirmation、redirect allowlist、SMTP 送信、登入及直接 Auth API rate limits、密碼更新安全設定；沒有服務憑證就不得宣稱已設定。
- Preview 及 production 的 HTTPS Cookie、同源部署 Origin、CSP、Set-Cookie 傳遞及保護 schema 設定；手機／電腦兩部真實裝置的同步驗收。
- 外部題庫匯入仍須逐題內容與使用權核准；目前全部 484 題未核准，已知 17 題存在內容問題。本報告不保證版權零風險。商業 build 不得把未核准完整題庫送至瀏覽器。
- 預設 `vercel.json` 及 `vercel.commercial.json` 均改用商用構建與 `release/site`，無核准內容時阻擋新構建；不是部署、下架或歷史清理證據。現有 Git 歷史／舊部署中的完整原型題庫仍須處理，Vercel 專案覆寫與 CLI 構建輸入須 staging 驗收。
- 真實收款、退款、AI 供應商、資料保留等未定政策另列阻擋，不因後端程式可測而自動啟用。

## 測試紀錄

初次重現時，`tests/backend.test.mjs` 加 `tests/frontend-cloud.test.mjs` 共 26 項通過；當時測試未覆蓋 cookie 在另一分頁更換，或把普通 access token 改放 recovery cookie。這一結果不構成上述問題已修復的證明。

最後修復後，本覆核者執行 `node --test tests/application.test.mjs tests/frontend-cloud.test.mjs tests/frontend-app.test.mjs tests/frontend-api-security.test.mjs tests/database-contract.test.mjs`：46 項通過、0 失敗、0 skipped。其中資料庫 contract 的 5 項是結構檢查，並非實際交易測試。另執行上述刪除相同使用者及專用限流合成反例，得到 403／429 並確認敏感副作用沒有執行。

資料庫團隊另在一次性 PostgreSQL 16.10、全新空白 schema 實跑 bootstrap → 兩份 migration → `learning.sql`：52 項斷言及 52 項拒絕檢查通過；多連線的重複提交、共享限流、單次 recovery nonce 共 3 項通過。摘要與重跑命令見 [db/README.md](../db/README.md)「2026-10-04 本機驗證」，原始合成資料執行紀錄保留於本機 `/private/tmp/eaqe-database-test.log`。這部分是團隊提供的實跑結果，本覆核者已讀取對應 migration／合約，沒有另行重跑真實 Supabase。

本輪有證據的 S01–S06 及 I01–I03 已有本機修復／驗證；上述外部環境與上線項目仍屬未驗收，不能宣稱整個系統「完全安全」或「已可商業上線」。

後續補充：前端 `CloudError` 只保留 UUID 格式的伺服器 request ID，既有錯誤提示及待同步錯誤顯示相同參考碼。來源為 `X-Request-ID` 或錯誤 JSON 的 request ID；沒有保存原始 provider body、token 或任意附加欄位，也沒有新增傳送、analytics 或日誌。`tests/frontend-cloud.test.mjs` 以一次性 `127.0.0.1` HTTP 伺服器及真實 fetch 驗證 header／body、非法或缺少 ID、不可讀回應及 outbox 原事件保留；伺服器結束後關閉。最後與前端畫面及 API 隔離測試一起執行：34 項通過、0 失敗、0 skipped。一般檔案沙箱禁止 listener 時須以允許本機測試的執行方式重跑；不是外部 Auth 或正式部署測試。
