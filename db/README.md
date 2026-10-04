# CP1／CP3 資料庫與 RPC

此目錄是可套用至**空白 Supabase 開發專案**的 PostgreSQL migration。它沒有教材題目、私人作答資料、真實付款資料或金鑰。建立結構與測試通過，不等於已接入 Supabase、完成手機實測、取得內容商業使用權或可以公開收費。

## 套用與權限

1. 在獨立開發專案按檔名順序套用 `migrations/*.sql`，不要在現有生產資料庫盲目執行。
2. `app_private` 不應加入 Supabase Data API 的 exposed schemas。所有私人表另啟用 RLS，撤銷 `PUBLIC`、`anon`、`authenticated` 的直接 schema／table／helper function 權限。
3. 正常學習 API 以已驗證使用者的 access token 呼叫 `public.app_*` RPC。SQL 只從 `auth.uid()` 取得身份，另查 `auth.users.email_confirmed_at`、`is_anonymous`、伺服器封禁狀態，以及 JWT 的 `session_id` 是否仍屬於本人且未過期。已登出／已刪除的 session 即使 JWT 尚未到 `exp` 亦不能再存取；不相信個人 metadata、前端 user ID、分數或通行證欄位。
4. 公開 RPC 為 `SECURITY DEFINER`，固定空白 `search_path`，完整限定內部資料表名稱，逐查本人資料及題庫授權。只有 `authenticated` 能呼叫；後端仍應先檢查登入、驗證電郵、CSRF、輸入大小及速率限制。
5. `service_role` 是受信任伺服器／維護角色，通常可繞過 RLS。它只應用於已審核內容匯入、正式付款授權的未來維護工作、身份管理及共享限流；不得交給瀏覽器。具此權限的營運人員仍需流程與操作稽核。

## 資料與事件規則

- `profiles`、`user_settings`、`practice_sessions`、`attempts`、`review_state`、`user_events`、`usage_segments`、`reading_progress` 保存私人資料，刪除 `auth.users` 後級聯刪除。
- `question_versions` 保存穩定題目與選項 ID。已有作答的版本不可修改題幹、選項、答案、解說、分類或個案；更正須增加新版本。版本 ID 及歷史評分一直保留。
- 每個穩定題目 ID 最多一個 `published` 版本，既有唯一索引保留；發布新版本前先撤下舊版。已儲存的舊作答分數及 session reference 不會重寫，但撤下版本不能再透過舊 session 取得題幹／解說或提交新答案。新練習、目錄及弱點概念選取最新已發布及核准版本；未發布草稿不取代現行版本。
- 題目必須 `published = true`、`rights_status = approved`、`review_status = approved` 及有 `verified_at` 才能提供。發布亦檢查完整概念、套用、每個選項分析及提示。**這些欄位只是批准流程的記錄，不是系統替內容取得版權。** 現有 484 題不在 migration 內，亦未獲本目錄批准。
- 私人匯入工具 `scripts/prepare-question-import.mjs` 的批准記錄同時需要 `fingerprint`（題幹／答案／解說）及 `publicationFingerprint(question)`（另綁定 ID、版本、狀態、題型、綱要、考試類別及免費範圍）。更改分類或把付費題改成免費題會使批准失效；兩個指紋都不能代替人工答案、教學及使用權覆核。目前工具只投影獨立題，個案題在共同題幹映射完成前拒絕匯入。資料庫本身支援個案，不代表此匯入工具已完整接入。
- 付費題另外查本人有效 `access_grants`：類別匹配、開始時間已到、結束時間未到及未撤銷。沒有建立付款、退款或續期政策；不存在由使用者自行發出 grant 的 RPC。
- 每位使用者的寫入與同步均先鎖 `profiles` 那一列；`change_seq` 在同一交易增加。它不是全域先領號後提交的序列，因此較小游標的交易不會在裝置越過游標後才提交而造成漏項。
- 一個 `(user_id, event_id)` 只接受一次。同 event ID、相同 JSONB 內容回傳原結果；不同內容或不同類型拒絕 `APP_CONFLICT`。真正重做必須新 event ID／新練習 session。
- 作答、伺服器評分、重溫狀態及事件在同一交易儲存，失敗則全數回滾。裝置提供的時間僅標示延遲，不能追溯累加不同日期的成功。
- 兩個不同香港日期答對且未標記不確定後，標為 `completed`；當日重複答對不再累加。錯答或表示不確定重設為待重溫。這表示「完成重溫」，不宣稱驗證了理由。所有歷史作答仍保留。
- 同步及匯出只含個人摘要、題目／版本／選項 reference，不含題幹、正確答案或完整解說。題幹與作答後解說由 session／attempt RPC 重新檢查授權後提供。
- 學習 RPC 另有每帳戶每分鐘 120 次成功交易的資料庫限流，直接呼叫 Supabase RPC 亦不能繞過；使用者不能呼叫或重設 service-only 限流接口。失敗交易會回滾計數，因此登入錯誤及惡意無效請求仍須由 API／Supabase gateway 的限流防護，不能把此層宣稱為完整 DDoS 保護。
- 用時以 UTC 區段保存；相同 segment ID 內容不能改寫。前景及有效用時分別用 PostgreSQL range union，跨裝置重疊不相加；有效區段必須被同帳戶已保存的前景區段涵蓋。區段最大 30 分鐘，最多每批 100 個，接受最近 30 日的補送；香港每日統計按午夜切開後再 union。

## RPC 合約

刪除及 recovery 的身份參數屬 service-only RPC，只有後端可傳入已驗證的 user ID；普通使用者不能自選此身份或繞過密碼重認證。

所有參數名須與 PostgREST `/rest/v1/rpc/<name>` JSON 欄位一致。一般 user RPC 沒有 `user_id` 參數。`cursor` 是字串，以免 JavaScript 大整數精度損失；新裝置從 `"0"` 同步，不能把 `app_get_account` 的 watermark 當作已下載游標。

| RPC | 輸入 | 回應 |
| --- | --- | --- |
| `app_get_account()` | 無 | `profile`、`settings`、`settingsVersion`、`cursor`、`activeSessionId`、`catalog[{track,part,total,free,available}]` |
| `app_save_settings` | `p_expected_version`、`p_settings:{track,examDate}` | 新設定、版本、游標；舊版本拒絕 |
| `app_create_session` | `p_request:{eventId,track,mode,questionIds?,count?,part?}` | `sessionId`、`sessionVersion`、`session`、游標 |
| `app_get_session` | `p_session_id` UUID | `session`；已提交當前題包含 `result`、`explanation` |
| `app_get_review_concepts` | `p_track`、`p_after`（預設空字串）、`p_limit`（1–50） | 本人未完成重溫的 `items[{questionId,questionVersion,part,concept,core,apply,memory}]`、最後送出 ID 的 `cursor`、`hasMore`；逐頁核對現有題庫授權，不含題幹、選項或答案欄位 |
| `app_submit_attempt` | `p_request:{eventId,sessionId,sessionVersion,questionId,questionVersion,optionId,uncertain,seconds?,clientOccurredAt?}` | `attempt`、`review`、`sessionVersion`、`cursor`、`explanation:{answerOptionId,content}` |
| `app_advance_session` | `p_session_id`、`p_expected_version` | 新進度、版本、`session`、游標；必須先提交當前題 |
| `app_mark_uncertain` | `p_request:{eventId,attemptId}` | `attemptId`、`questionId`、重設後 `review`、游標 |
| `app_sync` | `p_cursor`（預設 `"0"`）、`p_limit`（1–100） | `events`、實際最後回傳的 `cursor`、`hasMore`、設定版本、`profile`、`usage`、`dailyUsage` |
| `app_add_usage` | `p_request:{eventId,deviceId,segments:[{id,startAt,endAt,kind}]}` | 合併後 `totals`、游標；`kind = foreground / effective` |
| `app_export()` | 無 | 私人設定、作答、重溫、session reference、用時及閱讀摘要；不含題庫 |
| `app_prepare_delete` | **僅 service role**：`p_user_id`；後端先驗證登入身份、密碼重新登入為同一帳戶及專用限流，再傳受信任 user ID | 沒有 grant 時先暫停帳戶並回 `prepared / userId`；其後後端須用 admin API 刪 `auth.users`。同帳戶可重試；有任何 grant 時拒絕，等待財務／刪除政策。普通 access JWT 不能直接呼叫暫停操作 |
| `app_rate_limit` | **僅 service role**：`p_key` HMAC 64 位小寫十六進制、`p_limit`（1–10000）、`p_window_seconds`（1–86400） | `allowed`、`remaining`、`retryAfter`；共享固定窗口計數 |
| `app_register_recovery` | **僅 service role**：`p_nonce_hash`、`p_user_id`、`p_expires_at`（最多 10 分鐘） | `registered:true`；只在後端確認 recovery OTP 後發出專用簽署 cookie，普通登入 JWT 不能代替此證據 |
| `app_consume_recovery` | **僅 service role**：`p_nonce_hash`、`p_user_id` | `consumed:true`；原子消耗未到期且匹配帳戶的 nonce，再由後端改密碼。重播／過期／另一帳戶全部拒絕 |

`track` 為 `eaqe / sqe`；`mode` 為 `practice / review`。短測最多 50 題，題量不足時回實際題量，不重複抽題。個案共同題幹隨每題返回，同一個案在 sample 內保持相鄰；此功能不是完整限時模擬卷的承諾。每 session 保存實際亂序題序與 option ID 順序；選項字母只是顯示名稱。

`attempt` 含 `id / sessionId / questionId / questionVersion / part / concept / optionId / correct / uncertain / at / day / seconds / mode / delayed`。`concept` 僅概念分類標籤，不是題庫解說。未提供用時則 `seconds = null`。

固定錯誤為 `APP_INVALID`、`APP_CONFLICT`、`APP_UNAUTHENTICATED`、`APP_UNVERIFIED`、`APP_FORBIDDEN`、`APP_NOT_FOUND`、`APP_IMMUTABLE_VERSION`、`APP_RATE_LIMIT`，由 API 層映射清楚的 HTTP 狀態；不要把原始資料庫錯誤、SQL 或憑證回給用戶。

重設密碼的 nonce 在改密碼前消耗；供應商在此後故障時，不可重播原票據，需要重新發 recovery 電郵。nonce 表不保存電郵、IP、JWT 或密碼；過期一小時後可在下一次登記時清理，刪除帳戶時亦級聯移除。

## 測試

`db/tests/bootstrap.sql` 是**一次性空白 PostgreSQL 16 CI 的 auth shim**，不是 Supabase migration，嚴禁套用至真實專案。`db/tests/learning.sql` 使用四個 `.invalid` 身份及合成題目，最後回滾；並發 Node 測試另建立及清理合成測試帳戶。

```sh
psql -X -v ON_ERROR_STOP=1 -f db/tests/bootstrap.sql
psql -X -v ON_ERROR_STOP=1 -f db/migrations/202610040001_learning_backend.sql
psql -X -v ON_ERROR_STOP=1 -f db/migrations/202610040002_account_services.sql
psql -X -v ON_ERROR_STOP=1 -f db/migrations/202610040003_review_concepts.sql
psql -X -v ON_ERROR_STOP=1 -f db/tests/learning.sql
psql -X -v ON_ERROR_STOP=1 -f db/tests/review_concepts.sql
RUN_DATABASE_TESTS=1 PGDATABASE=app_test node --test tests/database-postgres.test.mjs
node --test tests/database-contract.test.mjs
# 額外選用，只允許明確指定的本機 app_test；拒絕覆寫既有 app_restore_test。
RUN_DATABASE_TESTS=1 RUN_DATABASE_BACKUP_TESTS=1 PGHOST=localhost PGDATABASE=app_test node --test tests/database-backup.test.mjs
```

實際執行需用 `PGHOST / PGPORT / PGUSER / PGPASSWORD` 指向一次性 `app_test`，不要指向正式環境。沒有 PostgreSQL 時，並發測試明確顯示 `SKIP`，不能視為權限及交易通過。

2026-10-04 本機驗證：從 PostgreSQL 官方 16.10 原始碼及 SHA-256 校驗檔建立僅位於暫存資料夾的測試 runtime；三份 migration 成功套用至測試資料庫。加入刪除 service-only 限制後，`learning.sql` 的 52 項斷言及 52 項拒絕檢查通過；`review_concepts.sql` 的 22 項斷言及 6 項拒絕檢查通過，包括新裝置概念還原、授權與穩定分頁、版本替換後歷史保留及撤下內容拒絕存取。三項多連線測試（重複提交／游標與重溫排序、共享限流、recovery nonce 只消耗一次）及六項 migration 合約檢查通過。測試只使用合成資料，不接真實 Supabase。

另完成一次隔離備份還原測試：本機 `app_test` 經 `pg_dump`／`pg_restore` 還原至新建的 `app_restore_test`，核對合成作答、重溫、session、設定與用時一致，以及 RPC、RLS、grants 和刪除級聯仍有效；結束後清理目標資料庫及測試資料。這不等於 Supabase 備份驗收，也沒有實作刪除 tombstone、恢復後清理及付款重新對帳，因此清單 T30 仍不能整項標為完成。

仍需實際 Supabase staging 的 Auth、PostgREST、expired JWT、verification／recovery、schema exposure、RLS advisory 及跨裝置驗收。本地 auth shim 不測身份供應商、郵件傳送或 Supabase 系統設定。

## 官方參考

核對日期：2026-10-04。依 [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) 同時限制 grants 與列權限；依 [Supabase functions](https://supabase.com/docs/guides/database/functions) 及 [PostgreSQL 16 CREATE FUNCTION](https://www.postgresql.org/docs/16/sql-createfunction.html) 固定 definer 的搜尋路徑並撤銷預設公開執行權。使用 [PostgreSQL range／multirange](https://www.postgresql.org/docs/16/rangetypes.html) 合併時間區段。這些技術文件不構成內容商用授權或法律意見。

另依 [Supabase sessions](https://supabase.com/docs/guides/auth/sessions) 與 [signout](https://supabase.com/docs/guides/auth/signout) 檢查仍有效的 `session_id`，不只依賴 JWT 到期；`banned_until` 及 session 期限欄位參照 [Supabase Auth user model](https://github.com/supabase/auth/blob/master/internal/models/user.go) 與 [session cleanup](https://github.com/supabase/auth/blob/master/internal/models/cleanup.go)。

本機合成還原流程依 [PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) 及 [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html) 的 custom archive 與新資料庫還原方式；沒有備份或重設整個 cluster 的角色／正式系統設定。
