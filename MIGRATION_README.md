# CellarTrek v15 — Production Migration Guide
## IONOS Server: 66.179.241.138

---

## Prerequisites

- SSH access to the IONOS server
- The IONOS PostgreSQL connection string
- The current `JWT_SECRET` value (check existing `cellartrek.env` on IONOS)
- The Anthropic API key from console.anthropic.com

---

## Step 1 — Upload files

From your Mac, upload this zip to the IONOS server:

```bash
scp CellarTrek_v15_Migration.zip [user]@66.179.241.138:/home/[user]/
```

On the IONOS server, unzip:

```bash
cd /home/[user]
unzip -o CellarTrek_v15_Migration.zip
```

---

## Step 2 — Stop the running server

```bash
fuser -k 8081/tcp
# or
lsof -i :8081
kill -9 <PID>
```

---

## Step 3 — Back up the database

**Do this before anything else.**

```bash
source ~/cellartrek.env
pg_dump $DATABASE_URL > cellartrek_backup_$(date +%Y%m%d).sql
```

Keep this file. If anything goes wrong, restore with:

```bash
psql $DATABASE_URL < cellartrek_backup_YYYYMMDD.sql
```

---

## Step 4 — Run the schema migration

The schema uses `CREATE TABLE IF NOT EXISTS` throughout — it will not touch
existing tables, only create the new ones.

```bash
source ~/cellartrek.env
psql $DATABASE_URL -f schema.sql
```

Verify new tables were created:

```bash
psql $DATABASE_URL -c "\dt"
```

You should see these new tables:
- `education_progress`
- `education_content`
- `wine_catalog`
- `wine_catalog_sources`
- `admin_users`
- `api_usage_log`

---

## Step 5 — Update cellartrek.env

Open the env file:

```bash
nano ~/cellartrek.env
```

Ensure all of these are present and correct:

```bash
export DATABASE_URL="postgresql://[user]:[password]@localhost:5432/cellartrek"
export JWT_SECRET="[keep existing value — do not change, it will invalidate all user sessions]"
export ANTHROPIC_API_KEY="[current key from console.anthropic.com]"
export USE_LOCAL_STORAGE=true
export ADMIN_SETUP_KEY="chikpea-setup-2026"
```

**New required variable:** `ADMIN_SETUP_KEY` — needed to create the first
super-admin account. The server will start without it but setup will fail.

**Critical:** If `JWT_SECRET` is missing or blank, the server will refuse to
start and print a FATAL error. Do not change an existing JWT_SECRET value
without warning — it will log out all current users.

---

## Step 6 — Add production domain to CORS whitelist

Open `server_production.js` and find `ALLOWED_ORIGINS` near the top:

```bash
grep -n "ALLOWED_ORIGINS" server_production.js
```

Edit that block to add the production URL:

```javascript
const ALLOWED_ORIGINS = new Set([
  'http://66.179.241.138:8081',   // ← production IP
  'https://yourdomain.com',        // ← add when domain is live
  'https://localhost:8081',
  'http://localhost:8081',
]);
```

---

## Step 7 — Install npm packages

Rebuild native modules for the IONOS environment:

```bash
cd /home/[user]
rm -rf node_modules
npm install pg bcrypt jsonwebtoken
```

---

## Step 8 — Install Leaflet (if not already present)

```bash
mkdir -p /home/[user]/lib
curl -o /home/[user]/lib/leaflet.js https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -o /home/[user]/lib/leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
```

Verify:

```bash
ls -lh /home/[user]/lib/
```

---

## Step 9 — Start the server

```bash
source ~/cellartrek.env
node server_production.js
```

Expected output:

```
✅  CellarTrek Production Server — http://66.179.241.138:8081
    DB:      PostgreSQL connected
    Storage: Local ./uploads/ (AWS removed)
    Mode:    development
✅  PostgreSQL connected
```

If you see `FATAL: JWT_SECRET not set` — check Step 5.
If you see `EADDRINUSE` — the old server is still running, repeat Step 2.
If you see `PostgreSQL connection failed` — check DATABASE_URL in cellartrek.env.

---

## Step 10 — Create the super-admin account

Run this once only — it is permanently disabled after the first admin is created:

```bash
curl -X POST http://66.179.241.138:8081/api/superadmin/setup \
  -H "Content-Type: application/json" \
  -d '{
    "setupKey":"chikpea-setup-2026",
    "email":"akleinberg@chikpea.com",
    "password":"[choose a strong password, 10+ chars]",
    "name":"Adam Kleinberg"
  }'
```

Expected response: `{"ok":true,"admin":{...}}`

Then open the super-admin panel:
`http://66.179.241.138:8081/superadmin`

---

## Step 11 — Smoke test

Check each URL loads correctly:

| URL | Expected |
|-----|----------|
| `http://66.179.241.138:8081/` | CellarTrek app |
| `http://66.179.241.138:8081/superadmin` | Super-admin login |
| `http://66.179.241.138:8081/admin` | Venue admin login |
| `http://66.179.241.138:8081/venues` | Venue landing page |

Test the API:

```bash
curl http://66.179.241.138:8081/api/auth/login \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"wrongpassword"}'
```

Expected: `{"error":"Invalid credentials"}` (not "Not found", not a crash)

---

## What is new in v15

### New files (must be present alongside server_production.js)
- `superadmin.html` — super-admin panel at /superadmin
- `venue-material-table-card.html` — print template
- `venue-material-sticker.html` — print template
- `venue-material-wall-sign.html` — print template

### New database tables (created by schema.sql)
- `education_progress` — WSET learning progress per user
- `education_content` — cached AI-generated lessons and quizzes
- `wine_catalog` — shared organically-grown wine database
- `wine_catalog_sources` — audit trail of catalog contributions
- `admin_users` — super-admin accounts (separate from users)
- `api_usage_log` — per-call AI cost tracking

### New features
- Wine Education module (WSET L1/L2/L3, Regions, Grapes, Production, Tasting, Vintages)
- AI Explore (freeform wine education chat)
- Super-admin panel (/superadmin) with usage, catalog, financial, and user views
- Organically growing shared wine catalog fed by AI enrichment events
- Venue marketing materials generator (table card, window sticker, wall sign)
- Edit/Delete events (desktop split-panel now matches mobile)
- Open bottle workflow with quantity controls
- Full security audit applied (CORS whitelist, path traversal guards, body size limits, auth on AI proxy)

### Breaking changes
- **JWT_SECRET is now required** — server exits on startup if missing
- **CORS is now a whitelist** — production domain must be in ALLOWED_ORIGINS
- **AI proxy requires auth** — /api/anthropic now requires a valid user JWT

---

## If something goes wrong

### Rollback
```bash
# Stop server
fuser -k 8081/tcp

# Restore database
psql $DATABASE_URL < cellartrek_backup_YYYYMMDD.sql

# Restore old files (keep a copy before migration)
# Restart old server
```

### Logs
The server logs to stdout. Run with logging to a file:

```bash
source ~/cellartrek.env
node server_production.js 2>&1 | tee cellartrek.log
```

### Contact
Adam Kleinberg · akleinberg@chikpea.com · ChikPea, Inc.

