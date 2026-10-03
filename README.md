# 地產牌研所（PropExam HK）

香港地產代理資格考試（EAQE，大牌）及營業員資格考試（SQE，細牌）的備試網站原型。

公開網站：<https://eaqe-prototype.vercel.app/>

## 功能

- 按地產代理監管局考試綱要八個部分整理題目及概念。
- 分別呈現 EAQE 及 SQE 範圍；第 6、8 部分只屬 EAQE。
- 每題提交後顯示正確答案、核心概念、完整解說及各選項分析。
- 公開題庫採用獨立題序。
- 答錯或標記「仍然不確定」的題目，自動加入該使用者的重溫清單；在兩個不同日期答對後自動移出。
- 顯示首次正確率、題庫覆蓋、各部分表現及最近七日使用時間。
- 免費試做 20 題；首批試行價為 HK$359／每場考期。通行證按所選場次於考前 60 日開始、考試結束後 10 日到期；未合格後報考下一場須重新購買，不自動續訂。長期價格仍待試用數據確認。

付款、登入、AI 解說及跨裝置同步尚未啟用。現時不會收取款項；作答紀錄只保存在使用者目前的瀏覽器。官方紙本考試成績一般在考後第 14 個工作天公布，因此成績可能在通行證到期後才公布；期限不延至成績公布日。

目前的內容分級只供產品原型測試。正式收費前，完整題庫必須改由伺服器按已登入帳戶及有效通行證提供，不能依賴瀏覽器內的權限狀態。

## 私隱及內容資料

公開題庫不包含私人教材名稱、頁碼、圖片名稱、舊有作答結果或原建立者的錯題紀錄。個別題目來源及商業使用權仍須逐題審核，未核准項目不得作為收費內容。

每位使用者在公開版本產生的作答、錯題及不確定標記，使用獨立的 `localStorage` 資料保存。清除瀏覽器網站資料會同時清除這些紀錄。

## 本機執行

使用 Node.js 24；版本記錄於 `.nvmrc` 及 `package.json`。

```bash
npm run dev
```

然後開啟 <http://localhost:5173/>。

## 驗證

```bash
npm ci --ignore-scripts
npm run test:core
npm run test:launch
npm run test:backend
npm run audit:questions
npm run audit:content-rights
npm run test:ci
```

核心測試涵蓋題庫結構、私人欄位掃描、EAQE／SQE 分流、免費內容限制、作答及錯題狀態；後端測試涵蓋輸入限制、錯誤遮蔽、身份驗證接口及環境設定。CI 執行這些無瀏覽器測試。

完整瀏覽器回歸使用 `npm test`，需要另外配置 Playwright（`PLAYWRIGHT_PATH` 指向模組檔案）及可由 Playwright `chrome` channel 啟動的 Chrome；它才會檢查重新整理、主要頁面及 320–1440px 版面。完整瀏覽器及真機驗收仍待完成。內容使用權登記冊只供逐題審核，不代表任何題目已獲商業使用許可。

## 後端開發準備

已建立 `/api/health` 存活檢查、API 共用層、伺服器身份驗證接口及環境設定檢查。存活檢查只表示處理函式可運行；登入、資料庫、付款及 AI 仍未接入。

```bash
cp .env.example .env.local
node --env-file=.env.local scripts/check-environment.mjs
```

檢查只列出設定名稱與狀態，不輸出秘密值。要求特定服務設定時使用 `--require=auth,database`。通過設定結構檢查仍需實測連線、授權及環境隔離。詳細步驟及待辦見 [後端開發準備](docs/BACKEND-SETUP.md) 和 [商業上線清單](docs/COMMERCIAL-LAUNCH-TODO.md)。

## 部署

介面由 `dist` 提供；`api/` 是待驗證部署的 Vercel Functions。`vercel.json` 指定 `dist` 為輸出目錄，沒有額外建置指令。新增 API 的部署、平台 runtime、環境設定及預覽保護仍須在有權限的 Vercel 專案驗收。

`.env*` 私密設定不進 Git 或部署來源；`docs/`、本機草稿及測試也不加入 Vercel 上傳來源。GitHub Actions 只執行測試，不啟用收款或正式部署。既有公開原型仍可下載完整題庫，商業版本須在 CP4 移除公開付費題目並建立伺服器授權。

本網站是獨立備試平台，並非地產代理監管局官方網站。考試日期、費用、合格要求及規則以地產代理監管局最新公布為準。
