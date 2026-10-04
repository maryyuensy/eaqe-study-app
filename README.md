# 地產牌研所（PropExam HK）

香港地產代理資格考試（EAQE，大牌）及營業員資格考試（SQE，細牌）的備試網站。支援電腦與手機瀏覽，以作答、逐題解說、錯題重溫及學習分析為主。

既有公開原型：[eaqe-prototype.vercel.app](https://eaqe-prototype.vercel.app/)。**本輪後端改動尚未公開部署；正式登入、寄信、付款與 AI 均未啟用。**

## ✅ 本輪完成

- 註冊、電郵驗證回呼、登入、刷新、忘記／重設密碼、登出、帳戶及資料匯出／刪除入口。
- 伺服器評分、事件去重、題目與選項穩定 ID、練習續做、設定版本、分頁同步及錯題狀態。
- 答錯、作答時或作答後標記不確定加入重溫；兩個不同香港日期答對且確定才移出，歷史保留。
- 私人資料庫權限、HttpOnly Cookie、同源 CSRF、共享限流；跨分頁換帳戶不能把原帳戶佇列存給新帳戶。
- 分開前景及有效學習時間，背景／閒置停止；區段重送與跨裝置重疊不重複計時。
- 題庫覆核清單、核准匯入及獨立商用建置；沒有核准題目就阻擋正式建置。
- 新裝置可讀自己的弱項概念、簡短使用指南及可追查的安全錯誤參考碼。
- 供應商無關的付款／考期期限契約及 AI 上下文投影；尚未建立實際付款或模型接口。
- 本機 Node、真正 PostgreSQL 16 角色與並發、localhost HTTP→SQL 整合，以及 Chrome 訪客流程和 320–1440px 版面驗收。

上述是程式與本機驗證成果，不表示真實 Supabase、SMTP、Vercel 或手機／電腦雲端流程已驗收。服務缺設定時顯示尚未啟用，不提供假的登入成功。

## 題庫狀態

原始原型資料有 484 題（EAQE 484／SQE 442），20 題原標記免費。內容檢查登記了 17 題阻擋，其中兩題有確定答案／解說錯誤；原型練習排除後為 EAQE 467、SQE 428、免費 19。

**全部 484 題商業使用權仍未審核，正式核准題數為 0。**結構檢查、洗牌或改名都不代表取得版權許可，也沒有把其餘 467 題宣稱為全部正確。148 題內部草稿維持未發布，不屬商業正式題庫。

個別題目來源及商業使用權仍須逐題審核，答案與教學亦須覆核。通過後才填入 `docs/content-release-approvals.json`；匯入工具同時核對內容及分類 fingerprint。詳見[內容覆核](docs/QUESTION-CONTENT-REVIEW.md)。

## 私人資料

原建立者的作答、私人錯題、教材名稱／頁碼／圖片及 `study/` 資料不匯入公眾帳戶。訪客只存本機；登入版有每帳戶隔離的待同步佇列，取得伺服器確認才顯示已同步。訪客舊紀錄不會自動併入第一個登入帳戶，舊公開版遷移工具尚未實作。

含財務授權的帳戶暫停自動刪除，待付款及保留政策完成。備份清理、持久刪除工作及正式私隱文件仍未完成。

## 本機執行與驗證

使用 Node.js 24：

```sh
npm ci --ignore-scripts
npm run test:ci
npm run dev
```

開啟 [localhost:5173](http://localhost:5173/)。完整 Chrome 訪客回歸為 `npm test`，需要既有 Playwright runtime 及可啟動的 Chrome；可用 `PLAYWRIGHT_PATH` 指定模組。真機與正式帳戶驗收仍待完成。

資料庫 CI 使用可銷毀 PostgreSQL 與合成 Auth shim。`RUN_DATABASE_TESTS=1` 且 `PGDATABASE=app_test` 才執行實際並發／HTTP→SQL 測試；預設 skipped 不能當作通過。實跑方法見 [db/README.md](db/README.md)。不要在真實 Supabase 執行 `db/tests/bootstrap.sql`。

## 商用建置

```sh
npm run build:review-policy
npm run prepare:question-import
npm run build:commercial
```

目前核准 0 題，後兩個指令**應阻擋**，沒有可發布的商用題庫。只有明示空題庫預覽才可執行 `node scripts/build-commercial.mjs --allow-empty-preview`，不提供任何公開題目。

商用輸出是忽略於 Git 的 `release/site`；固定資產白名單只加入已核准免費題，付費內容由私人資料庫供應。預設 `vercel.json` 及 `vercel.commercial.json` 均要求商用核准建置，避免下一次 Git／CLI 建置直接發布原型 `dist`。目前 0 題核准，兩者均應失敗；沒有觸發部署，現有已部署版本不因此被撤下。本機仍由 `server.mjs` 讀取 `dist`，只作內容待覆核的原型驗證。

CLI 上傳的 `.vercelignore` 目前排除 docs，故須先在完整授權 checkout 構建或另驗證必要輸入；不能略過核准檢查以解決缺檔。

**既有 `dist/questions.json`、公開 GitHub 歷史及舊 Vercel 部署仍包含完整原型題庫。**新建置不會撤回已公開副本；清理、使用權及部署驗收完成前不可稱付費內容已受完整保護。本輪沒有公開部署或重寫 Git 歷史。

## 上線規則與依賴

首批試行價 HK$359／每場考期；每場考期獨立購買，考前 60 日開始、考試結束後 10 日到期。重考須另購下一場，不自動續訂。正式收款服務、方案範圍、退款／付款爭議及官方改期安排仍待確認。

紙本考試成績一般於考後第 14 個工作天公布，成績可能在通行證到期後才公布；期限不延至成績公布日。考期與成績以[監管局公布](https://www.eaa.org.hk/zh-hk/Examination/Qualifying-examinations-results)為準。

還需要測試 Supabase／Vercel 存取權、SMTP／網域設定、正式條款及私隱文件、內容核准、付款與 AI 的供應商／預算／用量／資料政策。所有秘密只在服務端環境設定，不貼在對話或提交 Git。

- [上線工作清單](docs/COMMERCIAL-LAUNCH-TODO.md)：✅ 已完成項置前，⭕️ 未完成項置後。
- [後端接入](docs/BACKEND-SETUP.md)、[API 契約](docs/API-CONTRACT.md)、[資料庫契約](db/README.md)。
- [安全覆核](docs/BACKEND-SECURITY-REVIEW.md)、[本機驗收](docs/QA-ACCEPTANCE.md)、[內容覆核](docs/QUESTION-CONTENT-REVIEW.md)。
- [付款接入](docs/PAYMENT-INTEGRATION.md)、[AI 接入](docs/AI-INTEGRATION.md)、[營運手冊](docs/OPERATIONS-RUNBOOK.md)。

本網站是獨立備試平台，並非地產代理監管局官方網站；考試、法例與規則以官方最新公布為準。
