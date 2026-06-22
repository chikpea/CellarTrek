-- ════════════════════════════════════════════════════════════════
-- CellarTrek Production Database Schema
-- PostgreSQL 14+
-- ════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USERS ──────────────────────────────────────────────────────
CREATE TABLE users (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email                  VARCHAR(255) UNIQUE NOT NULL,
    password_hash          TEXT NOT NULL,
    name                   VARCHAR(255),
    lang                   VARCHAR(5)  DEFAULT 'en',
    plan                   VARCHAR(20) DEFAULT 'free',  -- free|premium|exclusive
    plan_expires_at        TIMESTAMPTZ,
    paypal_subscription_id VARCHAR(255),
    created_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_users_email ON users(email);

-- ── WINES ──────────────────────────────────────────────────────
CREATE TABLE wines (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(500) NOT NULL,
    vintage     INTEGER,
    region      VARCHAR(500),
    grapes      TEXT[],
    mode        VARCHAR(20)  DEFAULT 'cellar',
    rating      INTEGER,
    notes       TEXT,
    story       TEXT,
    aromas      TEXT[],
    flavors     TEXT[],
    body        VARCHAR(50),
    finish      VARCHAR(50),
    occasion    VARCHAR(100),
    bc          VARCHAR(7),
    lc          VARCHAR(7),
    tradeable   BOOLEAN DEFAULT FALSE,
    ai_enriched BOOLEAN DEFAULT FALSE,
    label_img   TEXT,
    articles    JSONB,
    venue_id    VARCHAR(100),
    source      VARCHAR(50),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_wines_user  ON wines(user_id);
CREATE INDEX idx_wines_venue ON wines(venue_id);

-- ── BOTTLE INVENTORY ───────────────────────────────────────────
CREATE TABLE wine_inventory (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wine_id UUID REFERENCES wines(id) ON DELETE CASCADE,
    ml      INTEGER NOT NULL,
    qty     INTEGER DEFAULT 1
);
CREATE INDEX idx_inventory_wine ON wine_inventory(wine_id);

-- ── VENUE MEMBERSHIPS ──────────────────────────────────────────
CREATE TABLE venue_members (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID REFERENCES users(id) ON DELETE CASCADE,
    venue_id           VARCHAR(100) NOT NULL,
    joined_at          TIMESTAMPTZ DEFAULT NOW(),
    is_select_reviewer BOOLEAN DEFAULT FALSE,
    status             VARCHAR(20) DEFAULT 'active'
);
CREATE UNIQUE INDEX idx_members_user_venue ON venue_members(user_id, venue_id);

-- ── BOTTLE REQUESTS ────────────────────────────────────────────
CREATE TABLE bottle_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    venue_id    VARCHAR(100) NOT NULL,
    wine_name   VARCHAR(500) NOT NULL,
    producer    VARCHAR(255),
    vintage     INTEGER,
    notes       TEXT,
    status      VARCHAR(30) DEFAULT 'pending',
    venue_reply TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_requests_venue ON bottle_requests(venue_id, status);

-- ── MEMBER REVIEWS ─────────────────────────────────────────────
CREATE TABLE member_reviews (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    venue_id     VARCHAR(100),
    wine_id      UUID REFERENCES wines(id) ON DELETE SET NULL,
    wine_name    VARCHAR(500),
    rating       INTEGER CHECK (rating BETWEEN 0 AND 100),
    notes        TEXT,
    is_published BOOLEAN DEFAULT FALSE,
    published_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_reviews_venue ON member_reviews(venue_id, is_published);

-- ── SUBSCRIPTIONS ──────────────────────────────────────────────
CREATE TABLE subscriptions (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID REFERENCES users(id),
    paypal_subscription_id VARCHAR(255) UNIQUE,
    plan                   VARCHAR(20),
    status                 VARCHAR(20),
    amount_usd             DECIMAL(10,2),
    started_at             TIMESTAMPTZ,
    expires_at             TIMESTAMPTZ,
    created_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ── PAYMENT EVENTS ─────────────────────────────────────────────
CREATE TABLE payment_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id),
    subscription_id UUID REFERENCES subscriptions(id),
    event_type      VARCHAR(50),
    amount_usd      DECIMAL(10,2),
    paypal_event_id VARCHAR(255) UNIQUE,
    qb_synced       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_payments_qb ON payment_events(qb_synced) WHERE qb_synced = FALSE;

-- ── VENUE ACCOUNTS (admin login) ───────────────────────────────
CREATE TABLE venue_accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id      VARCHAR(100) UNIQUE NOT NULL,  -- e.g. "premiercru"
    venue_name    VARCHAR(255) NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_venue_accounts_venue ON venue_accounts(venue_id);

-- ── VENUE FEED (moved from flat JSON to DB) ────────────────────
CREATE TABLE venue_feed (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id     VARCHAR(100) NOT NULL,
    type         VARCHAR(30) NOT NULL,   -- event|promotion|arrival|announcement
    title        VARCHAR(500) NOT NULL,
    body         TEXT,
    cta_label    VARCHAR(100),
    cta_url      TEXT,
    wine_ref     UUID REFERENCES wines(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ
);
CREATE INDEX idx_venue_feed_venue ON venue_feed(venue_id, published_at DESC);

-- ── PASSWORD RESET TOKENS ───────────────────────────────────────
-- Covers both consumer users and venue accounts via account_type.
CREATE TABLE password_reset_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_type VARCHAR(20) NOT NULL,   -- 'user' | 'venue'
    account_id   UUID NOT NULL,           -- references users.id or venue_accounts.id depending on account_type
    token        VARCHAR(255) UNIQUE NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_reset_tokens_token ON password_reset_tokens(token);
CREATE INDEX idx_reset_tokens_account ON password_reset_tokens(account_type, account_id);

-- ── PRICE TRACKING (added) ──────────────────────────────────────
ALTER TABLE wines ADD COLUMN IF NOT EXISTS purchase_type  VARCHAR(20);   -- 'bottle' | 'glass'
ALTER TABLE wines ADD COLUMN IF NOT EXISTS price_paid     DECIMAL(10,2);
ALTER TABLE wines ADD COLUMN IF NOT EXISTS price_ml       INTEGER;
ALTER TABLE wines ADD COLUMN IF NOT EXISTS price_currency VARCHAR(5) DEFAULT 'USD';

-- ── USER PROFILE & THEME (added) ────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_emoji   VARCHAR(10);   -- emoji avatar, e.g. '🍷'
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_img     TEXT;          -- uploaded photo path, overrides emoji if set
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio            VARCHAR(280);  -- short tagline/bio
ALTER TABLE users ADD COLUMN IF NOT EXISTS city           VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_wines TEXT[];        -- free-text favourites, not linked to actual wine rows
ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_spots TEXT[];        -- favourite wine bars/shops/restaurants, free text
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_mode     VARCHAR(10) DEFAULT 'dark';   -- 'dark' | 'light'
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_accent   VARCHAR(7);    -- hex colour override, null = default burgundy/gold
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_public BOOLEAN DEFAULT true;  -- whether other users can view this profile

-- ── SOCIAL LAYER ─────────────────────────────────────────────────

-- Friendships / social graph
CREATE TABLE IF NOT EXISTS friendships (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        VARCHAR(20) DEFAULT 'pending',  -- pending | accepted | blocked
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);

-- Wine groups (free-floating OR venue-anchored)
CREATE TABLE IF NOT EXISTS wine_groups (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(255) NOT NULL,
    description   TEXT,
    type          VARCHAR(20) DEFAULT 'free',  -- free | venue
    venue_id      VARCHAR(100) REFERENCES venue_accounts(venue_id) ON DELETE SET NULL,
    created_by    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar_emoji  VARCHAR(10) DEFAULT '🍷',
    is_private    BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wine_groups_creator ON wine_groups(created_by);
CREATE INDEX IF NOT EXISTS idx_wine_groups_venue ON wine_groups(venue_id);

-- Group members
CREATE TABLE IF NOT EXISTS group_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id    UUID NOT NULL REFERENCES wine_groups(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        VARCHAR(20) DEFAULT 'member',  -- admin | member
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

-- Group events (pairings, dinners, tastings)
CREATE TABLE IF NOT EXISTS group_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id          UUID NOT NULL REFERENCES wine_groups(id) ON DELETE CASCADE,
    created_by        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title             VARCHAR(255) NOT NULL,
    description       TEXT,
    event_date        TIMESTAMPTZ,
    venue_id          VARCHAR(100),   -- optional venue reference
    venue_name        VARCHAR(255),   -- free-text venue name if not a CellarTrek venue
    venue_address     TEXT,
    pairing_menu      JSONB,          -- [{course, dish, wine_name, wine_id}]
    invitation_text   TEXT,           -- AI-generated invitation wording
    invitation_design TEXT,           -- AI-generated design style/notes
    shareable_token   VARCHAR(64) UNIQUE,  -- for public RSVP link
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_group_events_group ON group_events(group_id);
CREATE INDEX IF NOT EXISTS idx_group_events_token ON group_events(shareable_token);

-- Event invitations / RSVPs
CREATE TABLE IF NOT EXISTS event_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES group_events(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,  -- null for external guests
    guest_name      VARCHAR(255),   -- for external guests invited by email/link
    guest_email     VARCHAR(255),
    rsvp            VARCHAR(20) DEFAULT 'pending',  -- pending | yes | no | maybe
    checked_in      BOOLEAN DEFAULT false,
    checked_in_at   TIMESTAMPTZ,
    rsvp_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_invitations_event ON event_invitations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_invitations_user ON event_invitations(user_id);

-- Group trips
CREATE TABLE IF NOT EXISTS group_trips (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id      UUID NOT NULL REFERENCES wine_groups(id) ON DELETE CASCADE,
    created_by    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         VARCHAR(255) NOT NULL,
    regions       TEXT[],         -- wine regions to visit
    start_date    DATE,
    end_date      DATE,
    notes         TEXT,
    ai_itinerary  TEXT,           -- AI-generated group itinerary
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_group_trips_group ON group_trips(group_id);

-- Trip RSVPs (separate from event invitations)
CREATE TABLE IF NOT EXISTS trip_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id     UUID NOT NULL REFERENCES group_trips(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rsvp        VARCHAR(20) DEFAULT 'pending',  -- pending | yes | no | maybe
    notes       TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(trip_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_members_trip ON trip_members(trip_id);

-- ── SHOP / MARKETPLACE ───────────────────────────────────────────

-- Merchant accounts (venues use their existing venue_accounts, external sellers get their own)
CREATE TABLE IF NOT EXISTS shop_sellers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_type     VARCHAR(20) NOT NULL DEFAULT 'external', -- 'venue' | 'external'
    venue_id        VARCHAR(100) REFERENCES venue_accounts(venue_id) ON DELETE CASCADE,
    business_name   VARCHAR(255) NOT NULL,
    contact_name    VARCHAR(255),
    contact_email   VARCHAR(255) NOT NULL,
    contact_phone   VARCHAR(50),
    description     TEXT,
    logo_url        TEXT,
    website_url     TEXT,
    commission_pct  DECIMAL(5,2) DEFAULT 10.00, -- ChikPea commission %
    listing_fee     DECIMAL(10,2) DEFAULT 0.00, -- monthly listing fee
    status          VARCHAR(20) DEFAULT 'pending', -- pending | active | suspended
    approved_at     TIMESTAMPTZ,
    approved_by     VARCHAR(255),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(venue_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_sellers_venue ON shop_sellers(venue_id);
CREATE INDEX IF NOT EXISTS idx_shop_sellers_status ON shop_sellers(status);

-- Shop catalog items
CREATE TABLE IF NOT EXISTS shop_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id       UUID NOT NULL REFERENCES shop_sellers(id) ON DELETE CASCADE,
    category        VARCHAR(30) NOT NULL, -- 'wine' | 'accessory' | 'experience' | 'travel' | 'promotion'
    title           VARCHAR(255) NOT NULL,
    description     TEXT,
    price           DECIMAL(10,2),
    currency        VARCHAR(5) DEFAULT 'USD',
    price_label     VARCHAR(100), -- e.g. "per person", "per bottle", "from $X"
    image_url       TEXT,
    stock_qty       INTEGER,     -- null = unlimited
    is_active       BOOLEAN DEFAULT true,
    is_featured     BOOLEAN DEFAULT false,
    promotion_ends  TIMESTAMPTZ, -- for limited-time promotions
    external_url    TEXT,        -- if clicking through to seller's own site
    tags            TEXT[],
    sort_order      INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shop_items_seller ON shop_items(seller_id);
CREATE INDEX IF NOT EXISTS idx_shop_items_category ON shop_items(category);
CREATE INDEX IF NOT EXISTS idx_shop_items_active ON shop_items(is_active);
CREATE INDEX IF NOT EXISTS idx_shop_items_featured ON shop_items(is_featured);

-- Orders routed to sellers (CellarTrek does NOT handle payment)
CREATE TABLE IF NOT EXISTS shop_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id         UUID NOT NULL REFERENCES shop_items(id) ON DELETE RESTRICT,
    seller_id       UUID NOT NULL REFERENCES shop_sellers(id) ON DELETE RESTRICT,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    qty             INTEGER NOT NULL DEFAULT 1,
    unit_price      DECIMAL(10,2) NOT NULL,
    currency        VARCHAR(5) DEFAULT 'USD',
    total_price     DECIMAL(10,2) NOT NULL,
    user_name       VARCHAR(255),
    user_email      VARCHAR(255),
    user_phone      VARCHAR(50),
    delivery_notes  TEXT,
    status          VARCHAR(20) DEFAULT 'pending', -- pending | confirmed | fulfilled | cancelled
    seller_notes    TEXT,       -- seller's response/tracking info
    commission_due  DECIMAL(10,2), -- ChikPea's cut
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shop_orders_seller ON shop_orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_shop_orders_user ON shop_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_shop_orders_status ON shop_orders(status);

-- ── VENUE BRANDING & ONBOARDING ──────────────────────────────────
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS logo_url       TEXT;
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS cover_url      TEXT;
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS brand_color    VARCHAR(7);   -- hex e.g. #8b2240
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS description    TEXT;
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS address        TEXT;
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS city           VARCHAR(255);
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS country        VARCHAR(100);
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS phone          VARCHAR(50);
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS website        VARCHAR(500);
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS instagram      VARCHAR(100);
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS facebook       VARCHAR(100);
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS opening_hours  TEXT;
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS venue_type     VARCHAR(50);  -- wine bar | restaurant | shop | winery | hotel
ALTER TABLE venue_accounts ADD COLUMN IF NOT EXISTS is_public      BOOLEAN DEFAULT true;

-- ── WINE INVENTORY UNIQUE CONSTRAINT ─────────────────────────────
-- Required for ON CONFLICT in qty update endpoint
ALTER TABLE wine_inventory ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wine_inventory_wine_id_ml_key'
  ) THEN
    ALTER TABLE wine_inventory ADD CONSTRAINT wine_inventory_wine_id_ml_key UNIQUE (wine_id, ml);
  END IF;
END $$;
