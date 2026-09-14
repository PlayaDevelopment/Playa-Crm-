# Playa CRM v1

Internal ops CRM for **Playa Development** (luxury trim & drywall, South Florida).  
Tracks builders/GCs from first touch → reply → bid → job.

**Service area default:** Stuart–Boca  
**Note:** Drywall is bid separately from trim. Proposals can be flagged `needs_mike_approval`.

**Private host target:** `https://crm.playadevelopment.com`

## Stack

- Node.js + Express
- SQLite via [sql.js](https://sql.js.org/) (no native build tools required)
- EJS server-rendered HTML
- HTTP Basic Auth for private hosting
- Calm, mobile-friendly UI

## Screens

1. **Today** (`/`) — due follow-ups, open replies, bids needing Mike approval  
2. **Accounts** (`/accounts`) — list + detail create/edit  
3. **Pipeline** (`/pipeline`) — deals by stage  
4. **Touches** (`/touches`) — log history per account  
5. **Bids** (`/bids`) — trim/drywall estimates  
6. **Jobs** (`/jobs`) — won work (light)

## Local setup

```bash
cd playa-crm
npm install
npm run import:real   # optional: load Stuart–Boca outreach from Excel
npm start
```

Open: **http://localhost:3847**

Without `CRM_PASSWORD`, the app stays open (local/demo). With `CRM_PASSWORD` set, Basic Auth is enforced.

```bash
CRM_PASSWORD=secret npm start
```

### Import real Stuart–Boca outreach

```bash
npm run import:real
```

Reads `data/Playa_CRM.xlsx` (or `PLAYA_XLSX=/path/to/file.xlsx`), clears tables, and loads accounts / touches / light pipeline deals for **Palm Beach, Martin, and Broward** only.

Equivalent: `npm run seed`

## Environment variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `PORT` | no | `3847` | Host platform usually sets this |
| `NODE_ENV` | prod | — | Set to `production` on the host |
| `CRM_USER` | no | `playa` | Basic Auth username |
| `CRM_PASSWORD` | **yes in production** | — | Basic Auth password. **Never commit.** If unset while `NODE_ENV=production`, the process exits on start. If set in any env, auth is enforced on all routes (including static assets). |

## Deploy (private host → crm.playadevelopment.com)

1. **DNS** — Point `crm.playadevelopment.com` at your host (CNAME or A record).
2. **App** — Long-running Node web service (`node server.js`). Helpers included:
   - `Procfile` (Heroku-style)
   - `railway.toml` (Railway)
   - `render.yaml` (Render)
   - `Dockerfile` (any container host: Node 20, `npm ci --omit=dev`)
3. **Env** — Set at least:
   ```
   NODE_ENV=production
   CRM_USER=playa
   CRM_PASSWORD=<strong-secret>
   ```
4. **Persistent disk** — Mount a writable volume at `data/` so `data/playa.db` survives restarts. The app creates the directory if missing, but without a volume the DB is ephemeral.
5. **Never** commit `.env`, passwords, or `data/playa.db`.

### Docker example

```bash
docker build -t playa-crm .
docker run -d -p 3847:3847 \
  -e NODE_ENV=production \
  -e CRM_USER=playa \
  -e CRM_PASSWORD='your-secret' \
  -v playa-crm-data:/app/data \
  playa-crm
```

### Auth check

```bash
# Expect 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3847/

# Expect 200
curl -s -o /dev/null -w '%{http_code}\n' -u playa:your-secret http://localhost:3847/
```

## Data

SQLite file: `data/playa.db` (created on first run / import).  
**Production:** attach a persistent volume to `data/`.

Pipeline stages: `new` → `first_touch_sent` → `replied` → `qualified` → `estimating` → `proposal_sent` → `won` | `lost` | `nurture`

Marking a deal **won** auto-creates a job if one is not already linked.

## Port

Default port is `3847`. Override with `PORT=3000 npm start` (or the host’s `PORT`).
