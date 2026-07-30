# 木語書坊 · 書籍訂購系統（MVP v1）

一頁式書籍訂購 Landing Page + 購買問卷 + 簡易訂單後台。木質色調、簡潔風格。

## 功能（v1）
- **首頁 Hero**：品牌標語 + 立即訂購 CTA
- **服務特色**：三個賣點區塊
- **購買問卷**：姓名 / Email / 電話 / 書名 / 數量 / 取貨方式 / 備註，送出即建立訂單
- **聯絡資訊**：Email、服務時間
- **管理後台**（`/admin`）：權杖登入 → 檢視訂單列表、確認 / 取消 / 刪除

## 技術
- 零外部依賴的 Node 伺服器（`server.js`），使用內建 `node:sqlite`
- 前端純 HTML/CSS/JS，訂單列表以 `textContent` 渲染（防 XSS）
- 需 Node.js >= 22

## 本機執行
```bash
ADMIN_TOKEN=你的密碼 npm start
```
- 首頁：http://localhost:8080
- 後台：http://localhost:8080/admin （用上面的 ADMIN_TOKEN 登入）

資料庫檔在 `data/orders.db`（已被 `.gitignore` 忽略）。

## API
| 方法 | 路徑 | 說明 | 權限 |
|------|------|------|------|
| POST | `/api/orders` | 送出購買問卷、建立訂單 | 公開 |
| GET | `/api/orders` | 訂單列表 | 管理者 |
| PATCH | `/api/orders/:id/status` | 更新狀態（pending/confirmed/cancelled） | 管理者 |
| DELETE | `/api/orders/:id` | 刪除訂單 | 管理者 |
| GET | `/api/admin/check` | 驗證權杖 | — |

管理權限：`Authorization: Bearer <ADMIN_TOKEN>`，`ADMIN_TOKEN` 只從環境變數讀取，不寫死、不進版控。

## 之後要做（v2+）
- 會員登入系統、忘記密碼（Email 寄信）
- Email 訂單通知
- AI 客服 / 自動回信 / 庫存管理
- 線上金流訂購

## 部署
GitHub + Zeabur（Node 服務，`npm start`）。資料庫目錄建議掛載持久化 volume 至 `data/`。
