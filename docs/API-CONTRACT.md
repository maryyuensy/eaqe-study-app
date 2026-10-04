# 第一版 API 契約

更新：2026-10-04。下列端點已有程式及本機測試，尚待真實 Supabase／Vercel 驗收。付款、AI、歷史遷移及財務刪除流程沒有實作端點。

## 共通規則

- 同源 `/api`；登入由後端呼叫 Supabase Auth 官方協定。access／refresh token 只經 HttpOnly Cookie，回覆 JSON 不包含憑證。
- 所有回覆 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`；錯誤包含伺服器產生的請求 ID。
- 寫入要求 `Origin` 與 `APP_BASE_URL` origin 相同、`X-App-Request: 1`、`Content-Type: application/json`；cross-site fetch 拒絕。
- 私人端點要求 `X-App-Account: <目前已登入 UUID>`。它只檢查 Cookie 帳戶一致性，不授權指定另一帳戶；伺服器身份始終來自 Auth。`GET /api/account` 不帶此 header 可探索當前 Cookie 帳戶。
- 不接受 `user_id`、`correct`、`score`、`paid` 等客戶端權威欄位。未知 JSON 欄位拒絕，常規 request body 上限 16 KiB，usage 上限 64 KiB。
- 唯一 `eventId` 為 UUID。相同事件及內容重送回原結果；同 ID 改內容拒絕。前端必須先持久保存事件，再提交。

## 端點

| 方法／路徑 | 輸入及用途 |
| --- | --- |
| `GET /api/config` | 帳戶啟用狀態、條款及私隱版本、密碼下限；無秘密 |
| `GET/HEAD /api/health` | 存活檢查，不代表外部服務已連線 |
| `POST /api/auth/signup` | `email,password,acceptedTerms:true,termsVersion,privacyVersion`；寄信後泛化提示，不自動登入 |
| `POST /api/auth/login` | `email,password`；電郵已驗證才發 Cookie |
| `POST /api/auth/forgot`、`/resend` | `email`；不透露地址是否存在 |
| `POST /api/auth/callback` | `tokenHash,type`；type 僅 signup／recovery。signup 驗證後要求密碼登入；recovery 發十分鐘、單次使用的簽署證明 |
| `POST /api/auth/refresh` | `{}`；只以 HttpOnly refresh Cookie 更新；沒有回傳 token |
| `POST /api/auth/reset` | `password`；需要 recovery Cookie；更新後回 `sessionsRevoked`，false 必須如實提示 |
| `POST /api/auth/logout` | `{}` 及目前帳戶 header；撤銷本次會話後清 Cookie，服務失敗不假成功 |
| `GET /api/account` | 本人資料、設定版本、伺服器時間、已核准目錄及可續做 session ID；通行證／訂單摘要尚待 CP5 接入 |
| `GET /api/settings` | 本人設定及版本 |
| `PUT /api/settings` | `expectedVersion,settings:{track,examDate}`；版本衝突 409。track 為 eaqe／sqe，examDate 空字串或有效日期 |
| `POST /api/practice-sessions` | `eventId,track,mode,count?,part?,questionIds?`；每輪 1–50 題、綱要 1–8；mode practice／review，權限及內容核准由伺服器判斷 |
| `GET /api/practice-sessions?id=<UUID>` | 本人練習、固定題序與選項 ID；未提交的題不揭答案 |
| `PATCH /api/practice-sessions` | `sessionId,expectedVersion`；更新下一題，舊版本不覆蓋新進度 |
| `POST /api/attempts` | 下列作答格式；交易中評分、歷史及重溫一同保存 |
| `POST /api/review-events` | `eventId,attemptId`；作答後仍不確定，引用本人作答並重新加入待重溫 |
| `GET /api/review-concepts?track=eaqe&after=&limit=50` | 本人未完成重溫的概念、套用及提示；每頁 1–50，使用回覆的 cursor 作下一頁 after。每次核對內容核准及現時授權，不含題幹、選項或答案；新裝置毋須先載入舊 session |
| `GET /api/sync?cursor=0&limit=100` | 每頁 1–100；游標只使用此回覆值，不能採寫入回覆最大序號以免跳過未讀事件 |
| `POST /api/usage` | `eventId,deviceId,segments`；device ID 最長 100 字，最多 100 段，每段最多 300 秒；相同區段不重複、同種類跨裝置重疊取聯集 |
| `GET /api/export` | 本人設定、作答、重溫及時間摘要；不包含完整題幹、答案或解說。尚沒有付款訂單資料 |
| `DELETE /api/account` | `password,confirmation:'DELETE'`；近期重新驗密碼、service-only 刪除準備、Auth 管理刪除。含財務授權先拒絕，待政策與 CP6 工作流程 |

## 作答與時間範例

所有值是合成資料，不能作正式題目匯入。

```json
{
  "eventId": "11111111-1111-4111-8111-111111111111",
  "sessionId": "22222222-2222-4222-8222-222222222222",
  "sessionVersion": 1,
  "questionId": "synthetic-question",
  "questionVersion": 1,
  "optionId": "opt_2",
  "uncertain": false,
  "seconds": 18,
  "clientOccurredAt": "2026-10-04T03:00:00Z"
}
```

`optionId` 從 session 選項取得，字母／展示位置不是穩定答案 ID。`seconds` 可為 null 或 0–10,800 整數；缺少時顯示未記錄。clientOccurredAt 只記延遲同步，不能決定重溫日期或付費有效期。

概念接口回傳 `items[{questionId,questionVersion,part,concept,core,apply,memory}]`、`cursor` 及 `hasMore`。待重溫摘要存在但內容已撤下、尚未核准或授權已到期時，不返回該內容；前端須區分「沒有待重溫紀錄」與「有紀錄但目前沒有可取得的內容」。

```json
{
  "eventId": "33333333-3333-4333-8333-333333333333",
  "deviceId": "synthetic-device",
  "segments": [{
    "id": "44444444-4444-4444-8444-444444444444",
    "startAt": "2026-10-04T03:00:00Z",
    "endAt": "2026-10-04T03:00:30Z",
    "kind": "effective"
  }]
}
```

kind 為 foreground／effective；前端背景停止，連續兩分鐘無操作停止有效時間。資料庫限制異常區段及未來時間；這些紀錄不是防作弊證據。

## 錯誤與重試

| HTTP／code | 處理 |
| --- | --- |
| 400 invalid_request | 非法 JSON／未知欄位；修正後再送，不自動無限重試 |
| 401 unauthenticated | 最多刷新一次；仍失敗就停佇列，保留原帳戶資料並要求登入 |
| 403 forbidden | 無權／未驗證／停用／跨來源；不宣稱保存成功 |
| 409 account_mismatch | Cookie 已換帳戶；原事件暫停保留，原帳戶回來才重送 |
| 409 conflict | 版本或同 ID 不同內容；重新拉取狀態、由用戶重新確認，不覆蓋歷史 |
| 413 payload_too_large | 拆成合法批次，不傳原始錯誤內容到日誌 |
| 422 unprocessable | 欄位值／題目／選項不合法，修正後再送 |
| 429 rate_limited | 有限退避；參考 Retry-After，不循環快速送出 |
| 500 internal_error、503 service_unavailable | 保留同 event ID，以有限退避或手動重試；不顯示已同步 |

共享限流包含 Auth 每種操作的總量及每地址限制、每帳戶 API／直接資料庫 RPC 限制、重設／刪除的獨立限制。失敗 SQL 交易可回滾限流計數，無效請求仍須 gateway 防護。這不是完整 DDoS 或容量管理方案。

## 未完成接口 ⭕️

Checkout、Webhook、訂單／退款、AI 解說／提問、舊本機紀錄遷移、持久刪除工作與備份 tombstone 都尚未提供。不要呼叫不存在的接口後在前端偽造成功。詳見 [上線清單](COMMERCIAL-LAUNCH-TODO.md)。
