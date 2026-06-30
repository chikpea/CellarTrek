# CellarTrek v16 — Deployment Package

## Files in this package

| File | Purpose |
|------|---------|
| `cellartrek_v12.html` | Main consumer app (entire SPA, ~410KB) |
| `server_production.js` | Node.js server — auth, DB, AI proxy, uploads, static serving |
| `venue-admin.html` | Venue admin panel — members, feed, shop, branding |
| `venue-signup.html` | Self-serve venue registration page |
| `reset-password.html` | Password reset page (consumer + venue) |
| `schema.sql` | PostgreSQL schema — all 21 tables, safe to re-run anytime |
| `cellartrek.env.template` | Environment variable template — copy and fill in |

## Quick start (LYSITHEA dev server)

```bash
# 1. Copy all files to /home/adam/
# 2. Set up environment (first time only)
cp cellartrek.env.template ~/cellartrek.env
nano ~/cellartrek.env   # fill in your values

# 3. Apply database schema (safe to re-run)
psql "postgresql://ct_app:PASSWORD@localhost:5432/cellartrek" -f schema.sql

# 4. Create local Leaflet folder (first time only — avoids 4s CDN load)
mkdir -p ~/lib
curl -o ~/lib/leaflet.js https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
curl -o ~/lib/leaflet.css https://unpkg.com/leaflet@1.9.4/dist/leaflet.css

# 5. Start server (ALWAYS source env first)
source ~/cellartrek.env
node server_production.js
```

Expected startup output:
```
✅  Local blob storage: ./uploads/labels/
✅  CellarTrek Production Server — https://localhost:8081
    DB:      PostgreSQL connected
✅  PostgreSQL connected
```

⚠️  If it shows `http://` instead of `https://` — the env file wasn't sourced.  
⚠️  Never use Ctrl+Z to stop the server — always use Ctrl+C.

## Production deployment (IONOS VPS)

See `CellarTrek_Production_Migration_Handoff_v12.8.docx` for the full 6-phase guide.

Key differences from dev:
- Nginx handles SSL (Certbot/Let's Encrypt) — Node runs HTTP internally
- Comment out SSL_CERT_PATH and SSL_KEY_PATH in cellartrek.env
- Use PM2 instead of running node directly
- All secrets must be rotated (JWT_SECRET, DB password, ANTHROPIC_API_KEY)

## Known constraints

- **Anthropic API**: Blocked from residential IPs (LYSITHEA). Works from IONOS VPS datacenter IP.
- **API credits**: Separate from claude.ai Max plan — fund at console.anthropic.com/billing
- **Leaflet**: Must be downloaded locally (see step 4 above) to avoid 4s CDN latency on LAN
- **Image uploads**: Stored in `uploads/` directory — include in backups

## Uploads directory structure

```
uploads/
  labels/      ← wine label photos
  venues/
    {venue-id}/
      logo.jpg
      cover.jpg
```

## Test accounts (LYSITHEA only — rotate before production)

- Consumer: akleinberg@chikpea.com
- Venue admin: /admin (Premier Cru, Elixir)
- Venue signup: /venue-signup
