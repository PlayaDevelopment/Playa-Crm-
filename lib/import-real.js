/**
 * Import Mike Entenza's real Stuart–Boca outreach from Playa_CRM.xlsx.
 * Filters to Palm Beach / Martin / Broward only (excludes expansion-market rows).
 *
 * Usage: npm run import:real
 * Env:   PLAYA_XLSX=/path/to/Playa_CRM.xlsx
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ALLOWED_COUNTIES = new Set(['Palm Beach', 'Martin', 'Broward']);

const DEFAULT_XLSX_CANDIDATES = [
  process.env.PLAYA_XLSX,
  // Prefer Mike's master workbook when available; fall back to packaged filtered copy
  '/workspace/playa/Playa_CRM.xlsx',
  path.join(__dirname, '..', '..', 'playa', 'Playa_CRM.xlsx'),
  path.join(__dirname, '..', 'data', 'Playa_CRM.xlsx'),
].filter(Boolean);

function resolveXlsx() {
  for (const p of DEFAULT_XLSX_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    'Playa_CRM.xlsx not found. Place it at data/Playa_CRM.xlsx or set PLAYA_XLSX.'
  );
}

function sheetToObjects(wb, name) {
  const sheet = wb.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
}

function parseCounties(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedCounties(raw) {
  const parts = parseCounties(raw);
  if (!parts.length) return false;
  // Must include at least one Stuart–Boca county; exclude expansion-only rows
  if (!parts.some((p) => ALLOWED_COUNTIES.has(p))) return false;
  // Hard skip if the only county listed is outside the service area
  if (parts.every((p) => !ALLOWED_COUNTIES.has(p))) return false;
  return true;
}

function toDateOnly(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function parseDueFromNextAction(text) {
  if (!text) return null;
  const m = String(text).match(/due\s*~?\s*(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : null;
}

function mapStatus(sheetStatus) {
  const s = String(sheetStatus || '').trim().toLowerCase();
  if (!s) return 'cold';
  if (s.includes('active client')) return 'active_client';
  if (s.includes('do not') || s.includes('dnc')) return 'do_not_contact';
  if (s.startsWith('replied')) return 'warm';
  if (s === 'sent' || s.includes('contacted')) return 'contacted';
  if (s.includes('warm') || s.includes('estimat') || s.includes('proposal') || s.includes('won')) {
    return 'warm';
  }
  if (s.includes('need email') || s === 'cold') return 'cold';
  return 'contacted';
}

function mapSource(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'outreach';
  if (s.includes('advisor') || s.includes('referral')) return 'referral';
  if (s.includes('instagram') || s === 'ig') return 'instagram';
  if (s.includes('google')) return 'google';
  return 'outreach';
}

function mapChannel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.includes('call') || s.includes('phone')) return 'call';
  if (s.includes('ig') || s.includes('instagram')) return 'ig';
  return 'email';
}

function mapDirection(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('in') || s === 'inbound') return 'in';
  return 'out';
}

function dealForStatus(sheetStatus, nextAction) {
  const s = String(sheetStatus || '').trim().toLowerCase();
  if (!s) return null;
  // Light pipeline for anything past cold / need-email
  if (s.includes('need email')) return null;
  if (s.includes('active client') || s.includes('won')) {
    return { stage: 'won', probability: 100, next_step: nextAction || 'Maintain client relationship' };
  }
  if (s.includes('bid invite') || s.includes('estimat')) {
    return { stage: 'estimating', probability: 55, next_step: nextAction || 'Prepare bid' };
  }
  if (s.includes('bid list') || s.includes('meet') || s.includes('qualified')) {
    return { stage: 'qualified', probability: 50, next_step: nextAction || 'Schedule meet' };
  }
  if (s.includes('on file') || s.includes('nurture')) {
    return { stage: 'nurture', probability: 15, next_step: nextAction || 'Revisit on warm signal' };
  }
  if (s.startsWith('replied') || s.includes('scheduling') || s.includes('warm')) {
    return { stage: 'replied', probability: 40, next_step: nextAction || 'Follow up' };
  }
  if (s === 'sent' || s.includes('contacted') || s.includes('first touch')) {
    return { stage: 'first_touch_sent', probability: 20, next_step: nextAction || 'Await reply / bump' };
  }
  if (s.includes('proposal')) {
    return { stage: 'proposal_sent', probability: 60, next_step: nextAction || 'Await decision' };
  }
  return null;
}

function combineNotes(whyFit, notes, marketDetail) {
  const parts = [];
  if (whyFit) parts.push(String(whyFit).trim());
  if (marketDetail) parts.push(`Market: ${String(marketDetail).trim()}`);
  if (notes) parts.push(String(notes).trim());
  return parts.join('\n\n') || null;
}

function containsBlockedMarket(text) {
  // Privacy: never persist expansion-market labels from excluded rows.
  // (Defensive — allowed rows should not contain this.)
  return /\bhernando\b/i.test(String(text || ''));
}

function clearTables(run) {
  run('DELETE FROM jobs');
  run('DELETE FROM bids');
  run('DELETE FROM touches');
  run('DELETE FROM deals');
  run('DELETE FROM accounts');
}

/**
 * @param {{ run: Function, get: Function, all?: Function }} dbApi
 * @param {{ xlsxPath?: string }} [opts]
 */
function importReal({ run, get }, opts = {}) {
  const xlsxPath = opts.xlsxPath || resolveXlsx();
  const wb = XLSX.readFile(xlsxPath, { cellDates: true });

  const allAccounts = sheetToObjects(wb, 'All Accounts');
  const touchLog = sheetToObjects(wb, 'Touch Log');
  const replies = sheetToObjects(wb, 'Replies');

  clearTables(run);

  const imported = [];
  const companyIds = {};

  for (const row of allAccounts) {
    const company = (row.Company || '').trim();
    if (!company) continue;
    const countiesRaw = row.Counties;
    if (!isAllowedCounties(countiesRaw)) continue;

    const whyFit = row['Why Fit'];
    const notesRaw = row.Notes;
    const market = row['Market Detail'];
    const notes = combineNotes(whyFit, notesRaw, market);
    if (containsBlockedMarket(notes) || containsBlockedMarket(countiesRaw) || containsBlockedMarket(company)) {
      // Skip any row that would leak excluded-market strings into the CRM
      continue;
    }

    const sheetStatus = row.Status;
    const status = mapStatus(sheetStatus);
    const nextAction = row['Next Action'] ? String(row['Next Action']).trim() : null;
    const lastTouch = toDateOnly(row['Last Touch']);
    const nextDue = parseDueFromNextAction(nextAction);

    run(
      `INSERT INTO accounts (company, primary_contact, email, phone, county, website, source, status, last_touch_date, next_action, next_action_due, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        company,
        row['Contact Name'] ? String(row['Contact Name']).trim() : null,
        row.Email ? String(row.Email).trim() : null,
        row.Phone ? String(row.Phone).trim() : null,
        String(countiesRaw).trim(),
        null,
        mapSource(row.Source),
        status,
        lastTouch,
        nextAction,
        nextDue,
        notes,
      ]
    );

    const id = get('SELECT id FROM accounts WHERE company = ?', [company]).id;
    companyIds[company.toLowerCase()] = id;
    imported.push({ company, id, sheetStatus, status, nextAction });
  }

  // Enrich / update from Replies (matching imported companies only)
  for (const row of replies) {
    const company = (row.Company || '').trim();
    if (!company) continue;
    if (!isAllowedCounties(row.Counties)) continue;
    const id = companyIds[company.toLowerCase()];
    if (!id) continue;
    if (containsBlockedMarket(row.Counties) && !isAllowedCounties(row.Counties)) continue;

    const contact = row.Contact ? String(row.Contact).trim() : null;
    const email = row.Email ? String(row.Email).trim() : null;
    const nextAction = row['Next action'] ? String(row['Next action']).trim() : null;
    const sheetStatus = row.Status;
    const theirAsk = row['Their ask / summary'] ? String(row['Their ask / summary']).trim() : null;
    const ourReply = row['Our reply'] ? String(row['Our reply']).trim() : null;
    const dateReceived = toDateOnly(row['Date received ET']);

    const acct = get('SELECT * FROM accounts WHERE id = ?', [id]);
    const primary = contact || acct.primary_contact;
    const em = email || acct.email;
    const st = sheetStatus ? mapStatus(sheetStatus) : acct.status;
    const na = nextAction || acct.next_action;
    const due = parseDueFromNextAction(na) || acct.next_action_due;

    run(
      `UPDATE accounts SET primary_contact=?, email=?, status=?, next_action=?, next_action_due=?,
       last_touch_date=COALESCE(?, last_touch_date), updated_at=datetime('now') WHERE id=?`,
      [primary, em, st, na, due, dateReceived, id]
    );

    // Ensure inbound reply is logged as a touch (dedupe by date+summary prefix)
    if (theirAsk && !containsBlockedMarket(theirAsk)) {
      const existing = get(
        `SELECT id FROM touches WHERE account_id = ? AND direction = 'in' AND summary = ?`,
        [id, theirAsk]
      );
      if (!existing) {
        run(
          `INSERT INTO touches (account_id, date, channel, direction, summary, next_action)
           VALUES (?, ?, 'email', 'in', ?, ?)`,
          [id, dateReceived || toDateOnly(new Date().toISOString()), theirAsk, na]
        );
      }
    }
    if (ourReply && !/^no reply needed/i.test(ourReply) && !containsBlockedMarket(ourReply)) {
      const existing = get(
        `SELECT id FROM touches WHERE account_id = ? AND direction = 'out' AND summary = ?`,
        [id, ourReply]
      );
      if (!existing) {
        // Logged timestamp preferred when present
        const logged = toDateOnly(row.Logged) || dateReceived;
        run(
          `INSERT INTO touches (account_id, date, channel, direction, summary, next_action)
           VALUES (?, ?, 'email', 'out', ?, ?)`,
          [id, logged || toDateOnly(new Date().toISOString()), ourReply, na]
        );
      }
    }

    // Refresh deal mapping target
    const imp = imported.find((a) => a.id === id);
    if (imp && sheetStatus) {
      imp.sheetStatus = sheetStatus;
      imp.status = st;
      imp.nextAction = na;
    }
  }

  // Touch Log — only for imported companies, never expansion-only counties
  let touchesImported = 0;
  for (const row of touchLog) {
    const company = (row.Company || '').trim();
    if (!company) continue;
    if (!isAllowedCounties(row.Counties)) continue;
    const id = companyIds[company.toLowerCase()];
    if (!id) continue;
    const summary = row.Summary ? String(row.Summary).trim() : '';
    if (containsBlockedMarket(summary) || containsBlockedMarket(row.Counties)) continue;

    const date = toDateOnly(row['Timestamp ET']) || toDateOnly(new Date().toISOString());
    const channel = mapChannel(row.Channel);
    const direction = mapDirection(row.Direction);

    const dup = get(
      `SELECT id FROM touches WHERE account_id = ? AND date = ? AND direction = ? AND summary = ?`,
      [id, date, direction, summary]
    );
    if (dup) continue;

    run(
      `INSERT INTO touches (account_id, date, channel, direction, summary, next_action)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [id, date, channel, direction, summary]
    );
    touchesImported += 1;
  }

  // Light pipeline deals
  let dealsCreated = 0;
  for (const a of imported) {
    const spec = dealForStatus(a.sheetStatus, a.nextAction);
    if (!spec) continue;
    run(
      `INSERT INTO deals (account_id, scope_type, job_city, estimated_value, probability, owner, next_step, stage)
       VALUES (?, 'trim', NULL, 0, ?, 'Mike', ?, ?)`,
      [a.id, spec.probability, spec.next_step, spec.stage]
    );
    dealsCreated += 1;
  }

  // Final safety: purge any row that somehow contains blocked market string
  const scrubSql = [
    `DELETE FROM touches WHERE id IN (
       SELECT t.id FROM touches t JOIN accounts a ON a.id = t.account_id
       WHERE lower(coalesce(a.county,'')) LIKE '%hernando%'
          OR lower(coalesce(a.company,'')) LIKE '%hernando%'
          OR lower(coalesce(a.notes,'')) LIKE '%hernando%'
          OR lower(coalesce(t.summary,'')) LIKE '%hernando%'
     )`,
    `DELETE FROM deals WHERE account_id IN (
       SELECT id FROM accounts WHERE lower(coalesce(county,'')) LIKE '%hernando%'
          OR lower(coalesce(company,'')) LIKE '%hernando%'
          OR lower(coalesce(notes,'')) LIKE '%hernando%'
     )`,
    `DELETE FROM accounts WHERE lower(coalesce(county,'')) LIKE '%hernando%'
        OR lower(coalesce(company,'')) LIKE '%hernando%'
        OR lower(coalesce(notes,'')) LIKE '%hernando%'
        OR lower(coalesce(next_action,'')) LIKE '%hernando%'`,
  ];
  for (const sql of scrubSql) run(sql);

  const touchCount = get('SELECT COUNT(*) AS c FROM touches').c;
  const dealCount = get('SELECT COUNT(*) AS c FROM deals').c;
  const accountCount = get('SELECT COUNT(*) AS c FROM accounts').c;
  const companies = imported.map((a) => a.company).sort();

  return {
    xlsxPath,
    accounts: accountCount,
    touches: touchCount,
    touchesFromLog: touchesImported,
    deals: dealCount,
    companies,
  };
}

async function runCli() {
  const DB_PATH = path.join(__dirname, '..', 'data', 'playa.db');
  // Remove DB so schema + import start clean (sql.js file)
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  // Avoid auto demo-seed: init schema only, then import
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const { createSchemaStandalone, wrapDb } = (() => {
    // Inline minimal DB bootstrap to avoid seed recursion via initDb()
    const db = new SQL.Database();
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
    function persist() {
      const data = db.export();
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
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
    persist();
    return { createSchemaStandalone: null, wrapDb: { run, get, db, persist } };
  })();

  const api = wrapDb;
  const result = importReal(api);
  console.log('Import complete from', result.xlsxPath);
  console.log('Accounts:', result.accounts);
  console.log('Touches:', result.touches);
  console.log('Deals:', result.deals);
  console.log('Companies:');
  result.companies.forEach((c) => console.log(' -', c));
  process.exit(0);
}

if (require.main === module) {
  runCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { importReal, resolveXlsx, clearTables, runCli };
