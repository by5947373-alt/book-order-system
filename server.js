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
