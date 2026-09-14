const express = require('express');
const methodOverride = require('method-override');
const path = require('path');
const { initDb, getDb } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3847;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CRM_USER = process.env.CRM_USER || 'playa';
const CRM_PASSWORD = process.env.CRM_PASSWORD || '';

// Production requires CRM_PASSWORD — refuse to start without it
if (IS_PRODUCTION && !CRM_PASSWORD) {
  console.error(
    'FATAL: CRM_PASSWORD is required when NODE_ENV=production.\n' +
      'Set CRM_PASSWORD (and optionally CRM_USER) in the host environment.\n' +
      'Never commit the password to git.'
  );
  process.exit(1);
}

/**
 * HTTP Basic Auth — protects every route including static assets.
 * - If CRM_PASSWORD is set: enforce auth (dev and prod)
 * - If CRM_PASSWORD is unset (dev only): open access
 */
function basicAuth(req, res, next) {
  if (!CRM_PASSWORD) {
    return next();
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Playa CRM"');
    return res.status(401).send('Authentication required');
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    res.set('WWW-Authenticate', 'Basic realm="Playa CRM"');
    return res.status(401).send('Invalid credentials');
  }

  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);

  if (user === CRM_USER && pass === CRM_PASSWORD) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Playa CRM"');
  return res.status(401).send('Invalid credentials');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Auth BEFORE static + routes so CSS and all pages are protected
app.use(basicAuth);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.locals.SOURCES = ['outreach', 'referral', 'instagram', 'google'];
app.locals.STATUSES = ['cold', 'contacted', 'warm', 'active_client', 'do_not_contact'];
app.locals.STAGES = [
  'new', 'first_touch_sent', 'replied', 'qualified', 'estimating',
  'proposal_sent', 'won', 'lost', 'nurture',
];
app.locals.SCOPE_TYPES = ['trim', 'drywall', 'both'];
app.locals.CHANNELS = ['email', 'call', 'ig'];
app.locals.DIRECTIONS = ['in', 'out'];
app.locals.BID_STATUSES = ['draft', 'needs_mike_approval', 'sent', 'accepted', 'rejected'];
app.locals.SERVICE_AREA = 'Stuart–Boca';

app.locals.fmtMoney = (n) => {
  if (n == null || n === '') return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n));
};
app.locals.fmtDate = (d) => {
  if (!d) return '—';
  return d;
};
app.locals.label = (s) => (s || '').replace(/_/g, ' ');
app.locals.today = () => new Date().toISOString().slice(0, 10);

function db() {
  return getDb();
}

// ——— Home / Today ———
app.get('/', (req, res) => {
  const { all, get } = db();
  const today = app.locals.today();
  const dueFollowups = all(
    `SELECT * FROM accounts
     WHERE next_action_due IS NOT NULL AND next_action_due != ''
       AND status != 'do_not_contact'
     ORDER BY next_action_due ASC`
  );
  const openReplies = all(
    `SELECT t.*, a.company FROM touches t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.direction = 'in'
     ORDER BY t.date DESC LIMIT 15`
  );
  const mikeBids = all(
    `SELECT b.*, a.company FROM bids b
     JOIN accounts a ON a.id = b.account_id
     WHERE b.status = 'needs_mike_approval'
     ORDER BY b.updated_at DESC`
  );
  const stats = {
    accounts: get('SELECT COUNT(*) AS c FROM accounts').c,
    openDeals: get(`SELECT COUNT(*) AS c FROM deals WHERE stage NOT IN ('won','lost')`).c,
    activeJobs: get(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'active'`).c,
    pipelineValue: get(
      `SELECT COALESCE(SUM(estimated_value),0) AS v FROM deals WHERE stage NOT IN ('won','lost')`
    ).v,
  };
  res.render('home', {
    title: 'Today',
    dueFollowups,
    openReplies,
    mikeBids,
    stats,
    today,
  });
});

// ——— Accounts ———
app.get('/accounts', (req, res) => {
  const { all } = db();
  const status = req.query.status || '';
  let accounts;
  if (status) {
    accounts = all('SELECT * FROM accounts WHERE status = ? ORDER BY company', [status]);
  } else {
    accounts = all('SELECT * FROM accounts ORDER BY company');
  }
  res.render('accounts/index', { title: 'Accounts', accounts, filterStatus: status });
});

app.get('/accounts/new', (req, res) => {
  res.render('accounts/form', { title: 'New Account', account: null });
});

app.post('/accounts', (req, res) => {
  const { run } = db();
  const b = req.body;
  run(
    `INSERT INTO accounts (company, primary_contact, email, phone, county, website, source, status, last_touch_date, next_action, next_action_due, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      b.company, b.primary_contact, b.email, b.phone, b.county, b.website,
      b.source || 'outreach', b.status || 'cold', b.last_touch_date || null,
      b.next_action, b.next_action_due || null, b.notes,
    ]
  );
  res.redirect('/accounts');
});

app.get('/accounts/:id', (req, res) => {
  const { get, all } = db();
  const account = get('SELECT * FROM accounts WHERE id = ?', [req.params.id]);
  if (!account) return res.status(404).send('Account not found');
  const deals = all('SELECT * FROM deals WHERE account_id = ? ORDER BY id DESC', [account.id]);
  const touches = all('SELECT * FROM touches WHERE account_id = ? ORDER BY date DESC, id DESC', [account.id]);
  const bids = all('SELECT * FROM bids WHERE account_id = ? ORDER BY id DESC', [account.id]);
  const jobs = all('SELECT * FROM jobs WHERE account_id = ? ORDER BY id DESC', [account.id]);
  res.render('accounts/show', { title: account.company, account, deals, touches, bids, jobs });
});

app.get('/accounts/:id/edit', (req, res) => {
  const { get } = db();
  const account = get('SELECT * FROM accounts WHERE id = ?', [req.params.id]);
  if (!account) return res.status(404).send('Account not found');
  res.render('accounts/form', { title: 'Edit Account', account });
});

app.put('/accounts/:id', (req, res) => {
  const { run } = db();
  const b = req.body;
  run(
    `UPDATE accounts SET company=?, primary_contact=?, email=?, phone=?, county=?, website=?,
     source=?, status=?, last_touch_date=?, next_action=?, next_action_due=?, notes=?,
     updated_at=datetime('now') WHERE id=?`,
    [
      b.company, b.primary_contact, b.email, b.phone, b.county, b.website,
      b.source, b.status, b.last_touch_date || null, b.next_action, b.next_action_due || null,
      b.notes, req.params.id,
    ]
  );
  res.redirect('/accounts/' + req.params.id);
});

app.delete('/accounts/:id', (req, res) => {
  const { run } = db();
  const id = req.params.id;
  run('DELETE FROM touches WHERE account_id = ?', [id]);
  run('DELETE FROM bids WHERE account_id = ?', [id]);
  run('DELETE FROM jobs WHERE account_id = ?', [id]);
  run('DELETE FROM deals WHERE account_id = ?', [id]);
  run('DELETE FROM accounts WHERE id = ?', [id]);
  res.redirect('/accounts');
});

// ——— Pipeline ———
app.get('/pipeline', (req, res) => {
  const { all } = db();
  const deals = all(
    `SELECT d.*, a.company FROM deals d
     JOIN accounts a ON a.id = d.account_id
     ORDER BY d.stage, d.estimated_value DESC`
  );
  const byStage = {};
  for (const s of app.locals.STAGES) byStage[s] = [];
  for (const d of deals) {
    if (!byStage[d.stage]) byStage[d.stage] = [];
    byStage[d.stage].push(d);
  }
  res.render('pipeline/index', { title: 'Pipeline', byStage, deals });
});

app.get('/pipeline/new', (req, res) => {
  const { all, get } = db();
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  const accountId = req.query.account_id || '';
  res.render('pipeline/form', { title: 'New Deal', deal: null, accounts, accountId });
});

app.post('/pipeline', (req, res) => {
  const { run } = db();
  const b = req.body;
  run(
    `INSERT INTO deals (account_id, scope_type, job_city, estimated_value, probability, owner, linked_bid_url, next_step, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      b.account_id, b.scope_type || 'trim', b.job_city, Number(b.estimated_value) || 0,
      Number(b.probability) || 20, b.owner || 'Mike', b.linked_bid_url, b.next_step, b.stage || 'new',
    ]
  );
  res.redirect('/pipeline');
});

app.get('/pipeline/:id/edit', (req, res) => {
  const { get, all } = db();
  const deal = get('SELECT * FROM deals WHERE id = ?', [req.params.id]);
  if (!deal) return res.status(404).send('Deal not found');
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  res.render('pipeline/form', { title: 'Edit Deal', deal, accounts, accountId: deal.account_id });
});

app.put('/pipeline/:id', (req, res) => {
  const { run, get } = db();
  const b = req.body;
  run(
    `UPDATE deals SET account_id=?, scope_type=?, job_city=?, estimated_value=?, probability=?,
     owner=?, linked_bid_url=?, next_step=?, stage=?, updated_at=datetime('now') WHERE id=?`,
    [
      b.account_id, b.scope_type, b.job_city, Number(b.estimated_value) || 0,
      Number(b.probability) || 0, b.owner || 'Mike', b.linked_bid_url, b.next_step, b.stage,
      req.params.id,
    ]
  );
  // Light jobs: if won, create job if none linked
  if (b.stage === 'won') {
    const deal = get('SELECT * FROM deals WHERE id = ?', [req.params.id]);
    const existing = get('SELECT id FROM jobs WHERE deal_id = ?', [deal.id]);
    if (!existing) {
      const acct = get('SELECT company FROM accounts WHERE id = ?', [deal.account_id]);
      run(
        `INSERT INTO jobs (account_id, deal_id, title, job_city, scope_type, contract_value, status, start_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'active', date('now'), ?)`,
        [
          deal.account_id, deal.id,
          `${acct.company} — ${deal.scope_type}`,
          deal.job_city, deal.scope_type, deal.estimated_value,
          'Auto-created from won deal',
        ]
      );
    }
  }
  res.redirect('/pipeline');
});

app.delete('/pipeline/:id', (req, res) => {
  const { run } = db();
  run('UPDATE bids SET deal_id = NULL WHERE deal_id = ?', [req.params.id]);
  run('UPDATE jobs SET deal_id = NULL WHERE deal_id = ?', [req.params.id]);
  run('DELETE FROM deals WHERE id = ?', [req.params.id]);
  res.redirect('/pipeline');
});

// ——— Touches ———
app.get('/touches', (req, res) => {
  const { all } = db();
  const accountId = req.query.account_id || '';
  let touches;
  if (accountId) {
    touches = all(
      `SELECT t.*, a.company FROM touches t JOIN accounts a ON a.id = t.account_id
       WHERE t.account_id = ? ORDER BY t.date DESC, t.id DESC`,
      [accountId]
    );
  } else {
    touches = all(
      `SELECT t.*, a.company FROM touches t JOIN accounts a ON a.id = t.account_id
       ORDER BY t.date DESC, t.id DESC LIMIT 100`
    );
  }
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  res.render('touches/index', { title: 'Touches', touches, accounts, filterAccount: accountId });
});

app.get('/touches/new', (req, res) => {
  const { all } = db();
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  res.render('touches/form', {
    title: 'Log Touch',
    touch: null,
    accounts,
    accountId: req.query.account_id || '',
  });
});

app.post('/touches', (req, res) => {
  const { run } = db();
  const b = req.body;
  run(
    `INSERT INTO touches (account_id, date, channel, direction, summary, next_action)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [b.account_id, b.date || app.locals.today(), b.channel, b.direction, b.summary, b.next_action]
  );
  // Update account last_touch + next action
  run(
    `UPDATE accounts SET last_touch_date=?, next_action=COALESCE(NULLIF(?, ''), next_action),
     updated_at=datetime('now') WHERE id=?`,
    [b.date || app.locals.today(), b.next_action || '', b.account_id]
  );
  if (b.next_action_due) {
    run('UPDATE accounts SET next_action_due=? WHERE id=?', [b.next_action_due, b.account_id]);
  }
  res.redirect(b.account_id ? '/accounts/' + b.account_id : '/touches');
});

app.get('/touches/:id/edit', (req, res) => {
  const { get, all } = db();
  const touch = get('SELECT * FROM touches WHERE id = ?', [req.params.id]);
  if (!touch) return res.status(404).send('Touch not found');
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  res.render('touches/form', { title: 'Edit Touch', touch, accounts, accountId: touch.account_id });
});

app.put('/touches/:id', (req, res) => {
  const { run } = db();
  const b = req.body;
  run(
    `UPDATE touches SET account_id=?, date=?, channel=?, direction=?, summary=?, next_action=? WHERE id=?`,
    [b.account_id, b.date, b.channel, b.direction, b.summary, b.next_action, req.params.id]
  );
  res.redirect('/touches');
});

app.delete('/touches/:id', (req, res) => {
  const { run } = db();
  run('DELETE FROM touches WHERE id = ?', [req.params.id]);
  res.redirect('/touches');
});

// ——— Bids ———
app.get('/bids', (req, res) => {
  const { all } = db();
  const status = req.query.status || '';
  let bids;
  if (status) {
    bids = all(
      `SELECT b.*, a.company FROM bids b JOIN accounts a ON a.id = b.account_id
       WHERE b.status = ? ORDER BY b.id DESC`,
      [status]
    );
  } else {
    bids = all(
      `SELECT b.*, a.company FROM bids b JOIN accounts a ON a.id = b.account_id ORDER BY b.id DESC`
    );
  }
  res.render('bids/index', { title: 'Bids', bids, filterStatus: status });
});

app.get('/bids/new', (req, res) => {
  const { all } = db();
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  const deals = all(
    `SELECT d.id, d.job_city, d.stage, a.company FROM deals d
     JOIN accounts a ON a.id = d.account_id ORDER BY d.id DESC`
  );
  res.render('bids/form', {
    title: 'New Bid',
    bid: null,
    accounts,
    deals,
    accountId: req.query.account_id || '',
    dealId: req.query.deal_id || '',
  });
});

app.post('/bids', (req, res) => {
  const { run } = db();
  const b = req.body;
  let status = b.status || 'draft';
  // Default: proposals needing review flag for Mike
  if (b.flag_mike === 'on' || b.flag_mike === '1') status = 'needs_mike_approval';
  run(
    `INSERT INTO bids (account_id, deal_id, scope_type, title, amount, status, file_url, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      b.account_id,
      b.deal_id || null,
      b.scope_type || 'trim',
      b.title,
      Number(b.amount) || 0,
      status,
      b.file_url,
      b.notes,
    ]
  );
  res.redirect('/bids');
});

app.get('/bids/:id/edit', (req, res) => {
  const { get, all } = db();
  const bid = get('SELECT * FROM bids WHERE id = ?', [req.params.id]);
  if (!bid) return res.status(404).send('Bid not found');
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  const deals = all(
    `SELECT d.id, d.job_city, d.stage, a.company FROM deals d
     JOIN accounts a ON a.id = d.account_id ORDER BY d.id DESC`
  );
  res.render('bids/form', {
    title: 'Edit Bid',
    bid,
    accounts,
    deals,
    accountId: bid.account_id,
    dealId: bid.deal_id || '',
  });
});

app.put('/bids/:id', (req, res) => {
  const { run } = db();
  const b = req.body;
  let status = b.status || 'draft';
  if (b.flag_mike === 'on' || b.flag_mike === '1') status = 'needs_mike_approval';
  run(
    `UPDATE bids SET account_id=?, deal_id=?, scope_type=?, title=?, amount=?, status=?,
     file_url=?, notes=?, updated_at=datetime('now') WHERE id=?`,
    [
      b.account_id,
      b.deal_id || null,
      b.scope_type,
      b.title,
      Number(b.amount) || 0,
      status,
      b.file_url,
      b.notes,
      req.params.id,
    ]
  );
  res.redirect('/bids');
});

app.delete('/bids/:id', (req, res) => {
  const { run } = db();
  run('DELETE FROM bids WHERE id = ?', [req.params.id]);
  res.redirect('/bids');
});

// ——— Jobs ———
app.get('/jobs', (req, res) => {
  const { all } = db();
  const jobs = all(
    `SELECT j.*, a.company FROM jobs j JOIN accounts a ON a.id = j.account_id ORDER BY j.id DESC`
  );
  res.render('jobs/index', { title: 'Jobs', jobs });
});

app.get('/jobs/new', (req, res) => {
  const { all } = db();
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  const deals = all(
    `SELECT d.id, d.job_city, d.stage, a.company FROM deals d
     JOIN accounts a ON a.id = d.account_id WHERE d.stage = 'won' ORDER BY d.id DESC`
  );
  res.render('jobs/form', { title: 'New Job', job: null, accounts, deals });
});

app.post('/jobs', (req, res) => {
  const { run } = db();
  const b = req.body;
  run(
    `INSERT INTO jobs (account_id, deal_id, title, job_city, scope_type, contract_value, status, start_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      b.account_id, b.deal_id || null, b.title, b.job_city, b.scope_type || 'trim',
      Number(b.contract_value) || 0, b.status || 'active', b.start_date || null, b.notes,
    ]
  );
  res.redirect('/jobs');
});

app.get('/jobs/:id/edit', (req, res) => {
  const { get, all } = db();
  const job = get('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).send('Job not found');
  const accounts = all('SELECT id, company FROM accounts ORDER BY company');
  const deals = all(
    `SELECT d.id, d.job_city, d.stage, a.company FROM deals d
     JOIN accounts a ON a.id = d.account_id ORDER BY d.id DESC`
  );
  res.render('jobs/form', { title: 'Edit Job', job, accounts, deals });
});

app.put('/jobs/:id', (req, res) => {
  const { run } = db();
  const b = req.body;
  run(
    `UPDATE jobs SET account_id=?, deal_id=?, title=?, job_city=?, scope_type=?,
     contract_value=?, status=?, start_date=?, notes=? WHERE id=?`,
    [
      b.account_id, b.deal_id || null, b.title, b.job_city, b.scope_type,
      Number(b.contract_value) || 0, b.status, b.start_date || null, b.notes, req.params.id,
    ]
  );
  res.redirect('/jobs');
});

app.delete('/jobs/:id', (req, res) => {
  const { run } = db();
  run('DELETE FROM jobs WHERE id = ?', [req.params.id]);
  res.redirect('/jobs');
});

app.use((err, req, res, next) => {
  console.error('ROUTE ERROR', req.method, req.url, err);
  res.status(500).send(String(err && err.message ? err.message : err));
});

async function start() {
  await initDb();
  app.listen(PORT, '0.0.0.0', () => {
    const authNote = CRM_PASSWORD
      ? `Basic Auth ON (user=${CRM_USER})`
      : 'Basic Auth OFF (set CRM_PASSWORD to enable)';
    console.log(`Playa CRM v1 → http://localhost:${PORT}  [${authNote}]`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
