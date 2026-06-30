-- ============================================================================
-- CellarTrek v15 → v16 — IN-PLACE database migration
-- Run this ONCE against your EXISTING production database (the one already
-- created from schema.sql). schema.sql itself is for fresh installs; this file
-- adds only what v16 introduces, without touching existing data.
--
--   psql "$DATABASE_URL" -f migrate_v16.sql
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / ADD COLUMN IF
-- NOT EXISTS). Index builds use CONCURRENTLY so they do not lock tables — run
-- this file OUTSIDE a transaction (psql does that by default).
-- ============================================================================

-- ── Stripe billing columns (PayPal → Stripe) ───────────────────────────────
-- PayPal columns are kept for any in-flight legacy subscriptions; remove them
-- in a later migration once those have lapsed.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_customer_id     VARCHAR(255);

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_customer_id     VARCHAR(255);

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS stripe_event_id VARCHAR(255);

-- Webhook pivots on the subscription id → must be unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscriptions_stripe_sub
  ON subscriptions (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_users_stripe_sub
  ON users (stripe_subscription_id);

-- IDEMPOTENCY (correctness): Stripe retries webhooks on any non-2xx response.
-- This unique index is what makes the server's ON CONFLICT (stripe_event_id)
-- DO NOTHING work, so a redelivered invoice.paid cannot double-credit a month.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_events_stripe_event
  ON payment_events (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;


-- ── Guest-RSVP duplication fix ──────────────────────────────────────────────
-- Guests are inserted with user_id = NULL, so the old ON CONFLICT (event_id,
-- user_id) never fired (NULL != NULL) and a guest could RSVP repeatedly.
-- Split uniqueness: members on (event,user), guests on (event,email).

-- If duplicate guest rows already exist, dedupe FIRST (keeps newest per pair):
DELETE FROM event_invitations a
USING event_invitations b
WHERE a.user_id IS NULL AND b.user_id IS NULL
  AND a.event_id = b.event_id
  AND a.guest_email = b.guest_email
  AND a.guest_email IS NOT NULL
  AND a.ctid < b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_inv_member
  ON event_invitations (event_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_inv_guest
  ON event_invitations (event_id, guest_email)
  WHERE user_id IS NULL AND guest_email IS NOT NULL;


-- ── Read-path indexes (performance; optional but recommended) ───────────────
-- Matched to real WHERE clauses in server_production.js. CONCURRENTLY = no lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wines_user_mode        ON wines (user_id, mode);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wines_venue            ON wines (venue_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shop_items_seller_act  ON shop_items (seller_id, is_active);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shop_items_category    ON shop_items (category);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shop_orders_user       ON shop_orders (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_members_venue    ON venue_members (venue_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_venue_members_user     ON venue_members (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_user     ON subscriptions (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_events_user    ON payment_events (user_id);

-- Done. Deploy server_production.js + cellartrek_v12.html (v16.0) alongside this.
