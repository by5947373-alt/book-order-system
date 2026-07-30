// 書籍訂購系統 — 零依賴伺服器：靜態頁面 + SQLite 訂單 API + 簡易後台。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

// 資料庫放在獨立資料夾，方便掛載成持久化 volume（重新部署不會消失）。
const DB_DIR = process.env.DB_DIR || join(__dirname, 'data');
mkdirSync(DB_DIR, { recursive: true });
const db = new DatabaseSync(join(DB_DIR, 'orders.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    phone      TEXT NOT NULL DEFAULT '',
    book       TEXT NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 1,
    delivery   TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const listStmt = db.prepare(
  `SELECT id, name, email, phone, book, quantity, delivery, note, status, created_at
   FROM orders ORDER BY id DESC LIMIT 500`
);
const insertStmt = db.prepare(
  `INSERT INTO orders (name, email, phone, book, quantity, delivery, note)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const getByIdStmt = db.prepare(
  `SELECT id, name, email, phone, book, quantity, delivery, note, status, created_at
   FROM orders WHERE id = ?`
);
const updateStatusStmt = db.prepare('UPDATE orders SET status = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM orders WHERE id = ?');

// 各欄位長度上限（防呆＋防塞爆）。
const LIMITS = { name: 40, email: 120, phone: 40, book: 120, delivery: 20, note: 500 };
const STATUSES = new Set(['pending', 'confirmed', 'cancelled']);

// 管理者權杖只從環境變數讀取 —— 絕不寫死 / 進版控。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Email 訂單通知（Resend）。金鑰只從環境變數讀取；未設定時自動略過寄信。
const SITE_NAME = '木語書坊';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ORDER_NOTIFY_TO = process.env.ORDER_NOTIFY_TO || 'by5947373@gmail.com';
const ORDER_FROM = process.env.ORDER_FROM || 'onboarding@resend.dev';

const escHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 顧客送出訂單後，寄一封通知信給店家。fire-and-forget：寄信失敗不影響下單。
async function notifyNewOrder(o) {
  if (!RESEND_API_KEY) return; // 尚未設定寄信金鑰 → 略過
  const rows = [
    ['書名', `《${o.book}》`],
    ['數量', o.quantity],
    ['姓名', o.name],
    ['Email', o.email],
    ['電話', o.phone || '—'],
    ['取貨方式', o.delivery || '—'],
    ['備註', o.note || '—'],
    ['訂單編號', `#${o.id}`],
    ['時間', o.created_at],
  ]
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 14px;color:#6b5b49;white-space:nowrap">${k}</td>` +
        `<td style="padding:6px 14px;color:#3a2e23;font-weight:600">${escHtml(v)}</td></tr>`
    )
    .join('');
  const html =
    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">` +
    `<h2 style="color:#4a3625">🛒 ${SITE_NAME}・新訂單通知</h2>` +
    `<p style="color:#6b5b49">有一筆新的購買問卷送出囉：</p>` +
    `<table style="border-collapse:collapse;background:#fffdf8;border:1px solid #e4d8c6;border-radius:8px">${rows}</table>` +
    `<p style="color:#8b6a47;font-size:13px;margin-top:18px">直接回覆這封信即可聯絡顧客（${escHtml(o.email)}）。</p>` +
    `</div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${SITE_NAME} <${ORDER_FROM}>`,
        to: [ORDER_NOTIFY_TO],
        reply_to: o.email,
        subject: `🛒 新訂單 #${o.id}：${o.book}`,
        html,
      }),
    });
    if (!res.ok) {
      console.error('訂單通知信寄送失敗', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('訂單通知信例外：', e?.message || e);
  }
}

// 常數時間比對 Bearer token；未設定管理權杖時一律視為非管理者。
function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const auth = req.headers['authorization'] || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveFile(res, name, type) {
  try {
    const data = await readFile(join(__dirname, name));
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // --- API ---
  // 讓後台 UI 先確認權杖是否正確，再顯示管理功能。
  if (path === '/api/admin/check' && req.method === 'GET') {
    return sendJSON(res, isAdmin(req) ? 200 : 401, { ok: isAdmin(req) });
  }

  // 顧客送出購買問卷 → 建立訂單。
  if (path === '/api/orders' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJSON(res, 400, { error: '格式錯誤' });
    }
    const name = String(payload?.name ?? '').trim();
    const email = String(payload?.email ?? '').trim();
    const phone = String(payload?.phone ?? '').trim();
    const book = String(payload?.book ?? '').trim();
    const delivery = String(payload?.delivery ?? '').trim();
    const note = String(payload?.note ?? '').trim();
    let quantity = Number.parseInt(payload?.quantity, 10);
    if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
    if (quantity > 999) quantity = 999;

    if (!name || !email || !book) {
      return sendJSON(res, 400, { error: '姓名、Email、書名為必填' });
    }
    // 很寬鬆的 Email 格式檢查，只擋明顯錯誤。
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJSON(res, 400, { error: 'Email 格式看起來不太對' });
    }
    if (
      name.length > LIMITS.name ||
      email.length > LIMITS.email ||
      phone.length > LIMITS.phone ||
      book.length > LIMITS.book ||
      delivery.length > LIMITS.delivery ||
      note.length > LIMITS.note
    ) {
      return sendJSON(res, 400, { error: '有欄位超過字數上限' });
    }
    const info = insertStmt.run(name, email, phone, book, quantity, delivery, note);
    const row = getByIdStmt.get(info.lastInsertRowid);
    notifyNewOrder(row); // fire-and-forget：不 await，寄信不擋回應
    return sendJSON(res, 201, { order: row });
  }

  // 列出所有訂單（管理者限定）。
  if (path === '/api/orders' && req.method === 'GET') {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: '需要管理權限' });
    return sendJSON(res, 200, { orders: listStmt.all() });
  }

  // 更新訂單狀態：確認 / 取消（管理者限定）。
  const statusMatch = path.match(/^\/api\/orders\/(\d+)\/status$/);
  if (statusMatch && req.method === 'PATCH') {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: '需要管理權限' });
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJSON(res, 400, { error: '格式錯誤' });
    }
    const status = String(payload?.status ?? '').trim();
    if (!STATUSES.has(status)) return sendJSON(res, 400, { error: '狀態不合法' });
    const info = updateStatusStmt.run(status, Number(statusMatch[1]));
    if (info.changes === 0) return sendJSON(res, 404, { error: '找不到這筆訂單' });
    return sendJSON(res, 200, { order: getByIdStmt.get(Number(statusMatch[1])) });
  }

  // 刪除訂單（管理者限定）。
  const delMatch = path.match(/^\/api\/orders\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    if (!isAdmin(req)) return sendJSON(res, 401, { error: '需要管理權限' });
    const info = deleteStmt.run(Number(delMatch[1]));
    if (info.changes === 0) return sendJSON(res, 404, { error: '找不到這筆訂單' });
    return sendJSON(res, 200, { ok: true });
  }

  // --- 靜態頁面 ---
  if (path === '/' || path === '/index.html') {
    return serveFile(res, 'index.html', 'text/html; charset=utf-8');
  }
  if (path === '/admin' || path === '/admin.html') {
    return serveFile(res, 'admin.html', 'text/html; charset=utf-8');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`書籍訂購系統 listening on :${PORT} (db: ${DB_DIR})`);
});
