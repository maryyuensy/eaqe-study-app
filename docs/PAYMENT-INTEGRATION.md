# CP5 付款接入：契約與待辦

目前只完成供應商無關的純函式驗證，位於 `lib/payment-contract.mjs`。沒有付款服務呼叫、訂單／付款事件資料表、簽署驗證、grant 寫入或新 API。`matched_payment_evidence` 只表示輸入資料匹配，並不代表付款真實、已入帳或已開通。測試通過不能當作 CP5 付款驗收。

## 已完成的契約

- [x] 待付款訂單只接受瀏覽器的 `{examSittingId, track}`；額外價格、幣別、user ID、付款模式、日期、期限或權限欄位一律拒絕。 ✅
- [x] 已驗證帳戶 ID、後端生成的訂單 ID、官方場次登記、環境及 UTC 時鐘由可信後端 context 提供。 ✅
- [x] 首批方案固定為 `sitting-trial-hkd359-v1`、`HKD 35900` 最小貨幣單位、`one_time`。不是 HK$35,900，也不是自動續訂。 ✅
- [x] 窗口依指定場次的開始時間減 60 日，至結束時間加 10 日；不是付款時間加 70 日。開放瞬間包含在內，到期瞬間已不包含。 ✅
- [x] 已正規化付款事件須為實際已付款狀態，且訂單、付款 ID、帳戶、金額、幣別、單次模式、場次、考試類別與環境全部符合。 ✅
- [x] 未核實／不存在／重複／取消場次、非法 UTC、付款早於訂單或晚於伺服器現在時間、過期窗口的新訂單、訂單快照與現行場次時間不符均拒絕。 ✅
- [x] 固定價格、考前／到期邊界、香港午夜、閏日、偽造欄位、未付款、環境混用及改期停止的 13 項純函式測試通過。 ✅

`examTrack` 只表示所購**考試場次的類別**，並沒有決定這個方案解鎖 EAQE、SQE 或兩者題庫。函式不返回 grant 或 `accessTracks`。是否允許未到開放日預購／考後新購仍需正式 Checkout 前確認；純函式的未過期訂單資料不代表此銷售政策已批准。

## 官方場次的資料來源

於 2026-10-04 核對[監管局考期時間表](https://www.eaa.org.hk/zh-hk/Examination/Registration-details-post-registration-matters)，紙本考試的官方場次如下。時間表可能更新，接入時須重新核對並保存來源與核實日期。

| 官方場次編號 | 類別 | 開始 UTC | 結束 UTC |
| --- | --- | --- | --- |
| `P71220926` | EAQE | `2026-09-22T06:30:00Z` | `2026-09-22T09:30:00Z` |
| `P72201026` | SQE | `2026-10-20T06:30:00Z` | `2026-10-20T09:00:00Z` |
| `P72171126` | SQE | `2026-11-17T06:30:00Z` | `2026-11-17T09:00:00Z` |
| `P71151226` | EAQE | `2026-12-15T06:30:00Z` | `2026-12-15T09:30:00Z` |

現有 `dist/exams.js` 的 `EAQE-20261215` 等是本網站的顯示 alias，並非上述官方場次編號。正式付款前要建立明確 mapping；不可把任意日期或 alias 當作已核實官方場次。

可信後端的 `verifiedSittings` 每條只包含：

```js
{
  id: 'P71151226',
  track: 'eaqe',
  startsAt: '2026-12-15T06:30:00Z',
  endsAt: '2026-12-15T09:30:00Z',
  verified: true,
  verifiedDate: '2026-10-04',
  sourceUrl: 'https://www.eaa.org.hk/zh-hk/Examination/Registration-details-post-registration-matters',
  status: 'scheduled'
}
```

這個範例未寫入 runtime 場次登記，也未建立可購買商品。`verified: true` 只能記錄後端的官方核查結果，函式本身不能核實網站內容；瀏覽器不得提供或修改此登記。核實日期不得晚於伺服器的香港日期，來源須為 HTTPS 官方 EAA／PEAK／VTC 網域。來源網址檢查不等於完成事實審核。

以上 EAQE 場次的窗口為香港時間 **2026-10-16 14:30 至 2026-12-25 17:30**；因此實際相距 70 日加該場 3 小時，而不是剛好 70 × 24 小時。UI 應顯示完整起訖日期時間，不只顯示「70 日」。窗口包含的考後 10 日也不保證覆蓋成績發放日；[官方時間表](https://www.eaa.org.hk/zh-hk/Examination/Registration-details-post-registration-matters)列明一般筆試成績於考後第 14 個工作天發放。

## 純函式合約

| 函式 | 必要輸入 | 輸出／限制 |
| --- | --- | --- |
| `sittingAccessWindow` | `{startsAt, endsAt}`，有效 UTC | `{opensAt, expiresAt}`；只是計算工具，不核實場次、不授權 |
| `accessWindowState` | 窗口、伺服器 `now` UTC | `not_open / open / expired`；不得使用瀏覽器時鐘作權限判斷 |
| `createPendingOrder` | `request`、`authenticatedUserId`、`orderId`、`verifiedSittings`、`paymentEnvironment`、`now` | 未持久化 `pending_payment` 訂單及場次／窗口快照 |
| `matchVerifiedPaymentEvent` | 已保存的 pending 訂單、已驗證且正規化的事件、可信 `expectedPaymentId`、現行場次登記、環境、伺服器時鐘 | 匹配證據及窗口狀態；固定 `authorizationCreated:false`、`requiresAtomicPersistence:true` |

事件的必要欄位：`eventId / orderId / paymentId / userId / amountMinor / currency / mode / environment / examSittingId / examTrack / paymentStatus / paidAt`。幣別使用正規化大寫 `HKD`，`paymentStatus` 必須是已完全收妥的 `paid`；供應商 adapter 須從可信付款物件取得實收金額，不能把授權中、處理中、部分付款或瀏覽器成功頁當成 `paid`。`expectedPaymentId` 必須來自已保存的供應商交易，或由後端按該已保存交易重新取得的付款物件；不可只把事件自己的 `paymentId` 複製過來便聲稱完成交易歸屬核對。

事件 ID／付款 ID 是各自必要識別值；本函式沒有資料庫，故同一事件再次呼叫仍只得到相同匹配資料，**這不是持久化去重**。已處理訂單的重播應在資料庫交易層返回既有處理結果；不要把 paid 訂單重新改成 pending 再呼叫本函式。

延遲事件可能在窗口到期後才收到；純函式回傳 `windowState:expired` 和沒有授權的匹配資料，不替營運方決定退款、補期限或繼續提供內容。場次取消／改期亦先拒絕並保留待處理事件，由已確認政策處理。

`paymentEnvironment` 的 `test / live` 是資料一致性標籤，不是啟用真實收款的開關。現有環境檢查仍只允許付款 `disabled / test`；此模組不修改該限制。

## 正式接入的順序

1. **確認上線政策及內容門檻。** 確認方案涵蓋題庫類別、銷售起訖／預購安排、退款及爭議、到期後內容、場次改期／取消、客服和資料保留；題庫權利與內容核准不得跳過。
2. **建立官方場次登記。** 把前端 alias 映射至官方編號；後端保存核實來源、UTC 開始／結束及狀態。更新場次不可無聲改寫既有訂單快照。
3. **選擇供應商及測試帳戶。** 由營運方完成商戶／收款帳戶；金鑰只放伺服器秘密設定。純函式沒有指定供應商，既有 Stripe 候選設定也不代表已定案或完成帳戶。
4. **建立私人訂單與付款事件表。** 客戶不能改金額、用戶、狀態或發出 grant；保存可信付款帳戶／環境／provider namespace。`eventId` 與 `paymentId` 的去重鍵須包含正確供應商和環境，防止跨環境 ID 碰撞。
5. **建立 Checkout 後端。** 驗證登入與電郵、CSRF、限流和輸入；使用服務端身份／ID／時鐘建立訂單並先持久化。只有訂單成功保存後才建立供應商交易；請求及重試使用穩定訂單／idempotency key。
6. **接入原始 body 的事件簽署驗證。** 按已選供應商的官方方法核對簽署、時間與帳戶／live-test環境；必要時由服務端重新讀取付款。不能由 ordinary user JWT 或前端 `signatureVerified:true` 代替。
7. **可靠接收並保存事件。** 留存必要付款證據、接收時間、處理狀態及精簡錯誤；接收確認與後續處理可重試，避免先回成功卻丟失事件。不可記錄卡號、CVC、秘密金鑰或多餘個人資料。
8. **在一個資料庫交易驗證及處理。** 鎖定對應訂單、查重、核對付款證據及場次快照，再決定訂單／事件狀態與單場授權；唯一鍵及原子交易須防止兩個 backend instance 同時開通兩次。任何步驟失敗須回滾或維持可追查待處理狀態。
9. **完成續送／對帳與財務流程。** 覆蓋通知重播、漏通知、重複付款、部分退款、退款及付款爭議；先按已確認政策實作，不能由此純函式自行推導處理結果。
10. **實際測試後再收款。** 在供應商 sandbox＋真實 staging 資料庫驗收正常付款、取消／失敗、不同帳戶、錯誤金額／幣別、偽造簽署、並發重播、時間邊界、改期及服務中斷恢復。之後另行核准正式收款與發布。

## 仍未完成

- [ ] ⭕️ 真實供應商／商戶、Checkout、簽署、可靠事件保存及補送。
- [ ] ⭕️ 私人訂單／付款事件 migrations、server-only 權限、付款 ID／事件 ID 的資料庫唯一鍵與原子交易。
- [ ] ⭕️ 授權明確綁定 `exam_sitting_id`；現有 CP3 的時間 grant 不能單獨完成單場付款規則。
- [ ] ⭕️ 方案題庫範圍、退款／爭議、到期、改期／取消與資料政策。
- [ ] ⭕️ 真實測試付款、退款與補送／對帳驗收；目前 CP5 未整體完成。

驗證命令：`node --test tests/payment-contract.test.mjs`。全部測試只用清楚標記的合成場次／訂單／事件，沒有建立真實交易。
