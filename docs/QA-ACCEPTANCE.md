# CP7 本機驗收紀錄

日期：2026-10-04。以下區分實際執行結果及尚待外部環境驗收的項目。本輪只測試本機預覽、隔離的瀏覽器訪客資料及合成測試帳戶，沒有操作真實付款或外部使用者。

## ✅ 已執行

| 項目 | 方法及觀察結果 | 狀態 |
| --- | --- | --- |
| 原型資料與覆核政策一致 | `qa.mjs --core-only` 通過；17 個已知阻擋 ID 全部從訪客題池排除 | ✅ |
| 實際數量 | 原始資料 484 題；排除後 EAQE 467、SQE 428；目前可試的免費題目 19 題。這些數字不代表已完成逐題內容或商業使用權核准 | ✅ |
| 訪客首次作答 | 真實 Chrome／Playwright 提交錯誤答案後，結果、核心概念及選項解說顯示；作答及錯題寫入本機，重新整理仍保留 | ✅ |
| 重溫及錯題減少 | 兩個不同日期答對後，待重溫清單及弱項概念清空；核心測試另驗證同日不重複計數、再次答錯重設進度、不確定答案加入重溫 | ✅ |
| 付費資格防偽 | 瀏覽器 localStorage 偽造 `plan:paid` 及遠期到期日仍不能解鎖；EAQE 七個非免費部分維持鎖定。直接進入付費章節仍顯示付款未開放，不提供教材練習 | ✅ |
| 題目阻擋 | 預存含已阻擋題 ID 的舊 session，重新載入後清除。覆核 JSON 回 404 時顯示練習暫停，不能開始作答 | ✅ |
| EAQE／SQE 範圍 | 切換 SQE 顯示六部分，末部分顯示 06；題庫數量按政策過濾後計算，沒有沿用原始 442 作可用數量 | ✅ |
| 付款保持關閉 | 方案顯示 HK$359，點擊試行方案明示目前不收款；沒有建立真實 checkout | ✅ |
| 舊私人資料清理 | 舊原型及測試版本的 localStorage key 在載入後被清除，沒有上傳私人紀錄 | ✅ |
| 手機與電腦版面 | Chrome 模擬 320、390、768、1440px，在主頁、學習、題庫、進度、方案、登入、註冊、忘記密碼、條款、私隱及使用指南共十一個頁面，沒有水平溢出 | ✅ |
| 免費題數文案一致 | 主頁及方案使用實際訪客題池／伺服器目錄；本輪可用免費題為 19，沒有沿用原始 20 作可用數量。沒有補入未核准替代題 | ✅ |
| 外置 bootstrap／CSP | `index.html` 只使用外置 defer bootstrap；本機實施與 Vercel 設定一致的 script-src self，Chrome 載入及 file:// 提示均通過 | ✅ |
| 本機開啟提示 | `file://` 顯示「請開啟網站預覽」；瀏覽器流程沒有 `pageerror` | ✅ |
| 全部 Node 回歸 | `node --test tests/*.test.mjs` 共 134 項：129 通過、0 失敗；5 個資料庫 opt-in entry 在預設執行中 skipped，下兩列另有實際執行結果。合成 provider 不能代替真實 Auth | ✅ |
| 本機 HTTP → PostgreSQL 整合 | 新增 `tests/database-http.test.mjs`，使用真實 localhost HTTP、`createApplication`、實際 PostgreSQL 16 RPC／roles；主測試及四項子測試共 5 項通過、0 skipped | ✅ |
| 真正資料庫／備份驗證 | PostgreSQL 16 共 132 項 SQL 檢查；HTTP／並發一同執行 8 項通過、0 skipped；另外隔離合成備份還原 1 項通過、0 skipped。非 Supabase 備份／tombstone 驗收 | ✅ |
| 新裝置弱項概念 | 前端測試取得雲端分頁概念，不依賴載入舊題目；帳戶／track 快取隔離、完成重溫後清除、錯誤及失去授權不假稱沒有弱項。實際 SQL 亦驗證本人與內容授權 | ✅ |
| 錯誤參考碼 | 真實 localhost HTTP fetch 保留合法 UUID 的 server request ID；非法／未知欄位不顯示，佇列原 event ID 及 payload 不變 | ✅ |
| 付款／AI 準備 | 13 項付款契約及 12 項 AI 上下文測試通過；兩者都是純函式，沒有簽署、付款持久交易、模型呼叫或對外接口 | ✅ |
| 正式內容發布阻擋 | 0 題核准，正常商用 build 與題目匯入均退出 1 並清除舊產物；明示空預覽實際輸出 0 題、9 固定資產及 3 JSON。兩個 Vercel 設定均要求核准建置 | ✅ |

已檢視桌面題庫及手機主頁的本機截圖，題目數量、鎖定章節、導覽及分流呈現與執行結果一致。本機 QA 圖片留在 `qa/`，不作題目或商業使用權核准證據。

`qa.mjs` 原有的錯誤預期已修正：不再要求偽造本機通行證可以解鎖；不再把原始 484／442 當作排除阻擋題後的訪客數量；明確標示原型內容及未完成商業驗收。瀏覽器測試採獨立 context，結束或失敗時均關閉 Chrome。

新增的 HTTP／資料庫測試以兩套 Cookie jar 模擬同帳戶兩部裝置，登入使用明確標示的合成 Auth adapter。實際 RPC 驗證：不同登入會話、作答前不送答案及詳解、穩定 option ID 由 SQL 判分、錯題及完整詳解可由第二裝置同步、設定 CAS 更新、平行 HTTP 重送只保存一次並不增加 cursor、另一帳戶不能讀取或提交原帳戶 session、錯帳戶 header 在 RPC 前回 409。測試結束後清理 unique 合成帳戶／題目／限流 key 並關閉隨機 localhost listener。未 opt-in 時明確記為 skipped，只有 `RUN_DATABASE_TESTS=1` 且 `PGDATABASE=app_test` 才允許接觸資料庫；沒有使用真實 Supabase Auth、JWT 簽署、郵件或 PostgREST。

## ⭕️ 尚待完成

| 項目 | 尚欠的驗收／處理 |
| --- | --- |
| 真實 Supabase 帳戶 | signup、不同裝置驗證信、SMTP、refresh、recovery 單次及逾期、被封鎖／撤銷會話、刪除與 provider 失敗重試。合成 provider 及本機 auth shim 不等於這些已通過 |
| 真實跨裝置同步 | 用手機及電腦登入同一測試帳戶，實際驗證作答／錯題／進度一致、離線待同步與重新登入；Chrome 的視窗尺寸模擬不代替兩部裝置 |
| 部署環境 | Supabase staging 的 grants、PostgREST schema exposure、JWT 及系統設定；Vercel preview 的 HTTPS Cookie、Set-Cookie、Origin、CSP 及 API 行為 |
| 全題庫內容及使用權 | 已知 17 題阻擋，尚未表示其餘 467 題答案與教學內容已全面核准；全部 484 題商業使用權仍待逐題覆核。詳見內容覆核報告 |
| 完整可及性與多瀏覽器 | 本輪測試基本標籤、可操作控制及水平溢出；Safari、Firefox、iOS／Android 真機、鍵盤全流程及讀屏仍待驗收 |
| 商業流程 | 真實付款、退款及爭議政策、AI 供應商與額度、資料保留及正式條款尚欠外部設定／使用者決定；沒有在 QA 中啟用 |

## 重跑

先在本機啟動 `node server.mjs`，再執行：

```sh
node --check qa.mjs
node qa.mjs --core-only
node qa.mjs
node --test tests/application.test.mjs tests/frontend-cloud.test.mjs tests/frontend-app.test.mjs tests/frontend-api-security.test.mjs tests/database-contract.test.mjs
```

HTTP／資料庫測試另需已套用測試 bootstrap 及 migrations 的一次性 `app_test`。沿用 `db/README.md` 的本機／CI 連線設定，再明確 opt-in：

```sh
RUN_DATABASE_TESTS=1 PGDATABASE=app_test node --test tests/database-http.test.mjs
```

`psql` 預設由 PATH 尋找；只有本機既有暫存 runtime 不在 PATH 時，才以 `PSQL_BIN` 指定其絕對位置。不得把測試 auth shim、合成資料或測試帳戶套用至正式專案。

瀏覽器預設使用 `http://localhost:5173` 及已安裝的 Google Chrome。可透過 `BASE_URL` 指向經授權的測試預覽、`PLAYWRIGHT_PATH` 指定既有 Playwright runtime；不要指向正式付費服務執行寫入測試。若 Chrome 或測試伺服器不可用，應記錄未執行，不能只因腳本存在便標為通過。
