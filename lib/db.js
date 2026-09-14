const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'playa.db');

let SQL = null;
let db = null;

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function persist() {
  ensureDir();
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function normalize(params = []) {
  return params.map((v) => (v === undefined ? null : v));
}

function run(sql, params = []) {
  db.run(sql, normalize(params));
  persist();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  const p = normalize(params);
  if (p.length) stmt.bind(p);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const p = normalize(params);
  if (p.length) stmt.bind(p);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function exec(sql) {
  db.exec(sql);
  persist();
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      primary_contact TEXT,
      email TEXT,
      phone TEXT,
      county TEXT,
      website TEXT,
      source TEXT DEFAULT 'outreach',
      status TEXT DEFAULT 'cold',
      last_touch_date TEXT,
      next_action TEXT,
      next_action_due TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      scope_type TEXT DEFAULT 'trim',
      job_city TEXT,
      estimated_value REAL DEFAULT 0,
      probability INTEGER DEFAULT 20,
      owner TEXT DEFAULT 'Mike',
      linked_bid_url TEXT,
      next_step TEXT,
      stage TEXT DEFAULT 'new',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      channel TEXT DEFAULT 'email',
      direction TEXT DEFAULT 'out',
      summary TEXT,
      next_action TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      deal_id INTEGER,
      scope_type TEXT DEFAULT 'trim',
      title TEXT NOT NULL,
      amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft',
      file_url TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (deal_id) REFERENCES deals(id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      deal_id INTEGER,
      title TEXT NOT NULL,
      job_city TEXT,
      scope_type TEXT DEFAULT 'trim',
      contract_value REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      start_date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (deal_id) REFERENCES deals(id)
    );
  `);
}

async function initDb(forceSeed = false) {
  SQL = await initSqlJs();
  ensureDir();
  const exists = fs.existsSync(DB_PATH);
  if (exists) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
    createSchema();
    persist();
  }

  // Ensure schema exists even on old empty files
  createSchema();

  const count = get('SELECT COUNT(*) AS c FROM accounts');
  if (!count || count.c === 0 || forceSeed) {
    try {
      const { seed } = require('./seed');
      seed({ run, get, all, exec, persist });
    } catch (err) {
      console.warn('Seed skipped (no outreach workbook yet):', err && err.message ? err.message : err);
    }
  }

  return { db, run, get, all, exec, persist };
}

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return { db, run, get, all, exec, persist };
}

module.exports = { initDb, getDb, DB_PATH };
