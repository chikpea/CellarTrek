# CellarTrek v16 → v17 — What changed in this release

**New in v17.0**
- **Venue Branding — "Import from my website"** (assisted brand extraction with human confirmation).
  Venues can point CellarTrek at their existing website; a headless browser reads the
  site's actual colors, fonts, and logo and presents them as a draft for confirmation on
  the Branding page. Nothing is published until the venue reviews and presses Save Branding.
- **New file** `branding-worker.js` — the headless extraction worker. The server spawns it
  as a child process. **It must sit beside `server_production.js`** (the endpoint resolves it
  with `path.join(__dirname, 'branding-worker.js')`).
- **New endpoint** `POST /api/venue-admin/branding/extract` (venue-authenticated). Validates the
  submitted URL, spawns the worker with a 30s timeout, and returns a draft theme.
- **New dependency: Playwright + Chromium.** This is the first feature that runs a real browser
  on the server. See "Browser setup" below — this is the one genuinely new install step.
- **`package.json` added.** Previously the bundle shipped without one. It now declares all runtime
  deps (`bcrypt`, `jsonwebtoken`, `pg`, `playwright`) so `npm install` works on a fresh box.

**Database:** none. This release makes **no schema changes** — there is no migration SQL to run.
The extracted draft is persisted only through the existing branding PUT (the same flat columns
as v16: brand color, logo, cover). Richer theme tokens (full palette, fonts) are carried in the
client draft for forward-compatibility but are not yet stored.

**Browser setup (required for extraction to work):**
```bash
cd /path/to/cellartrek
npm install                                  # installs deps; postinstall fetches Chromium
npx playwright install-deps chromium         # one-time, needs sudo — system libraries
node branding-worker.js https://example.com  # smoke test — expect JSON with "ok": true
```
The browser must be installed by the **same OS user that runs the Node process**, or Chromium
won't be found at runtime. If they differ, set `PLAYWRIGHT_BROWSERS_PATH` to a shared path and
install as that user. If `apt` is blocked during deploys, run `install-deps` once manually.

**No new environment variables.** The residential-IP Anthropic API block is irrelevant to this
feature — extraction fetches the venue's own public website, not the Anthropic API.

**Security:** the submitted URL is SSRF-guarded twice — the endpoint validates with the worker's
exported `validateUrl()` before spawning, and the worker re-checks before navigating. Both reject
non-http(s) schemes, localhost, loopback, private/CGNAT/link-local ranges, the cloud metadata IP,
dotless hosts, and IPv6 literals. Run the Node process (and therefore Chromium) as a
low-privilege user.

**Known gaps (deferred to a later version):**
- Extracted logo/hero URLs point at the venue's own server; they are not yet copied to S3.
- No UI yet to upload a commercially-licensed web-font (such fonts are flagged with a free
  substitute offered).
- AI role-assignment for tokens is not in this version; extraction is extract + manual confirm only.

**Full step-by-step:** see `Venue_Branding_Deployment_Guide.docx` in this bundle.

---

## Rollback
Restore the previous `server_production.js` and `venue-admin.html`. You can leave
`branding-worker.js` and the installed Chromium in place — with the old server the route is
not registered, so they are inert. No database changes were made, so there is nothing to revert.
