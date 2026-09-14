-- Game Scheduler (club session organiser) schema
-- Enums are modeled as TEXT + CHECK constraints (sql.js is plain SQLite, no native enum type).

CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    dob TEXT,
    skill_level TEXT NOT NULL CHECK (skill_level IN ('A','B','C','D','E')),
    gender TEXT,
    membership_status TEXT NOT NULL CHECK (membership_status IN ('active','lapsed','guest')) DEFAULT 'active',
    membership_number TEXT,
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS courts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    court_number INTEGER NOT NULL UNIQUE CHECK (court_number BETWEEN 1 AND 32),
    label TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

-- Editable list of payment tiers (Member, Non-Member, Concession, etc.) -
-- what TYPE of player someone is, which is what pricing actually follows.
-- Prices are NOT stored here - they're set per session_template (and copied
-- into a session when started), since different session types charge
-- different prices, not one club-wide amount. is_system rows (the fixed
-- Cash/Card/Voucher set briefly used as ad-hoc-session categories) are kept
-- for historical payment records but hidden from the club's own Settings
-- list and never offered as a new category - "how someone paid" moved to
-- attendance.payment_method instead, a fixed field that follows whichever
-- real category (player type) was picked, not a category itself.
CREATE TABLE IF NOT EXISTS payment_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1))
);

CREATE TABLE IF NOT EXISTS session_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    day_of_week TEXT NOT NULL CHECK (day_of_week IN ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    default_mode TEXT NOT NULL CHECK (default_mode IN ('auto','manual','social')),
    -- doubles (4 a court) or singles (2 a court, e.g. squash)
    default_format TEXT NOT NULL DEFAULT 'doubles' CHECK (default_format IN ('doubles','singles')),
    default_max_capacity INTEGER,
    -- Null falls back to club_settings.default_game_minutes/default_break_minutes.
    default_game_minutes INTEGER,
    default_break_minutes INTEGER
);

CREATE TABLE IF NOT EXISTS session_template_courts (
    session_template_id INTEGER NOT NULL REFERENCES session_templates(id),
    court_id INTEGER NOT NULL REFERENCES courts(id),
    PRIMARY KEY (session_template_id, court_id)
);

-- Per-template payment prices (cents), e.g. a Friday social template prices
-- differently to a Monday competitive template. Copied into
-- session_payment_rates when a session is started from this template.
CREATE TABLE IF NOT EXISTS session_template_payment_rates (
    session_template_id INTEGER NOT NULL REFERENCES session_templates(id),
    payment_category_id INTEGER NOT NULL REFERENCES payment_categories(id),
    amount_cents INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_template_id, payment_category_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER REFERENCES session_templates(id),
    date TEXT NOT NULL,
    label TEXT,
    scheduled_start_time TEXT,
    scheduled_end_time TEXT,
    location TEXT,
    status TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
    mode TEXT NOT NULL CHECK (mode IN ('auto','manual','social')),
    format TEXT NOT NULL DEFAULT 'doubles' CHECK (format IN ('doubles','singles')),
    game_minutes INTEGER,
    break_minutes INTEGER,
    max_capacity INTEGER,
    current_phase TEXT NOT NULL CHECK (current_phase IN ('idle','game','break','awaiting_lineup','paused')) DEFAULT 'idle',
    phase_started_at TEXT,
    phase_ends_at TEXT,
    notes TEXT,
    paused_remaining_ms INTEGER,
    phase_paused_at TEXT,
    paused_from_phase TEXT CHECK (paused_from_phase IN ('game','break'))
);

CREATE TABLE IF NOT EXISTS session_courts (
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    court_id INTEGER NOT NULL REFERENCES courts(id),
    in_use INTEGER NOT NULL DEFAULT 1 CHECK (in_use IN (0,1)),
    PRIMARY KEY (session_id, court_id)
);

-- Actual prices for this specific session (cents), copied from the template
-- at start time and editable for that night only (mirrors session_courts).
CREATE TABLE IF NOT EXISTS session_payment_rates (
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    payment_category_id INTEGER NOT NULL REFERENCES payment_categories(id),
    amount_cents INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, payment_category_id)
);

CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    player_id INTEGER NOT NULL REFERENCES players(id),
    checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
    state TEXT NOT NULL CHECK (state IN ('checked_in','here_today','playing','booked','left')) DEFAULT 'checked_in',
    left_reason TEXT CHECK (left_reason IN ('no-show','departed','injured','session_ended','removed')),
    payment_category_id INTEGER REFERENCES payment_categories(id),
    payment_amount_cents INTEGER,
    payment_method TEXT CHECK (payment_method IN ('Cash','Card','Voucher')),
    payment_note TEXT,
    first_time INTEGER NOT NULL DEFAULT 0 CHECK (first_time IN (0,1)),
    new_member INTEGER NOT NULL DEFAULT 0 CHECK (new_member IN (0,1))
);

CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    court_id INTEGER NOT NULL REFERENCES courts(id),
    round_number INTEGER NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('singles','doubles')),
    mode TEXT NOT NULL CHECK (mode IN ('auto','manual')),
    status TEXT NOT NULL CHECK (status IN ('staged','active','completed')) DEFAULT 'staged',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT
);

CREATE TABLE IF NOT EXISTS game_players (
    game_id INTEGER NOT NULL REFERENCES games(id),
    player_id INTEGER NOT NULL REFERENCES players(id),
    side INTEGER NOT NULL CHECK (side IN (1,2)),
    skill_level_at_time TEXT NOT NULL CHECK (skill_level_at_time IN ('A','B','C','D','E')),
    PRIMARY KEY (game_id, player_id)
);

CREATE TABLE IF NOT EXISTS pairing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_a_id INTEGER NOT NULL REFERENCES players(id),
    player_b_id INTEGER NOT NULL REFERENCES players(id),
    rule_type TEXT NOT NULL CHECK (rule_type IN ('prefer','avoid')),
    scope TEXT NOT NULL CHECK (scope IN ('permanent','session_only')) DEFAULT 'permanent'
);

CREATE TABLE IF NOT EXISTS club_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    club_name TEXT NOT NULL DEFAULT 'My Club',
    default_game_minutes INTEGER NOT NULL DEFAULT 15,
    default_break_minutes INTEGER NOT NULL DEFAULT 3,
    max_capacity INTEGER,
    square_enabled INTEGER NOT NULL DEFAULT 0 CHECK (square_enabled IN (0,1)),
    -- Which provider's credentials below are actually used to send the
    -- manual end-of-night summary email (see lib/sendEmail.js). Only one
    -- provider is active at a time - a club picks whichever they already
    -- have an account with.
    email_provider TEXT NOT NULL DEFAULT 'smtp2go' CHECK (email_provider IN ('smtp2go','mailgun','gmail')),
    smtp2go_api_key TEXT,
    smtp2go_sender_email TEXT,
    smtp2go_sender_name TEXT,
    mailgun_api_key TEXT,
    mailgun_domain TEXT,
    mailgun_sender_email TEXT,
    mailgun_sender_name TEXT,
    -- Gmail sends via SMTP with a Google "App Password" (not the account's
    -- real login password) - the account itself IS the sender, Gmail
    -- doesn't let you send as an arbitrary "from" address.
    gmail_user TEXT,
    gmail_app_password TEXT,
    -- Comma/newline-separated list - one club-wide list reused every
    -- session and by every provider, not per-session/per-provider config.
    summary_recipient_emails TEXT,
    square_access_token TEXT,
    square_location_id TEXT,
    -- Auto-generate prefers mixed pairs / same-gender courts over 3-1 or
    -- segregated-sides splits when on (see lib/autoGenerate.js).
    gender_aware_pairing INTEGER NOT NULL DEFAULT 1 CHECK (gender_aware_pairing IN (0,1)),
    -- Bumped on every custom icon upload (routes/branding.js), for
    -- cache-busting the favicon/header logo without a live push.
    club_icon_ver INTEGER NOT NULL DEFAULT 0,
    -- How dates are DISPLAYED throughout the app (DMY=DD/MM/YYYY,
    -- MDY=MM/DD/YYYY, YMD=YYYY-MM-DD) - purely cosmetic, every date is
    -- still stored/sent over the API as plain YYYY-MM-DD regardless. Native
    -- <input type="date"> pickers are a browser/OS thing this can't touch.
    date_format TEXT NOT NULL DEFAULT 'YMD' CHECK (date_format IN ('DMY','MDY','YMD')),
    -- Off: the server listens on this computer only (127.0.0.1), so Windows
    -- never asks to let Node.js through the firewall. On: it listens on the
    -- club's network too, so the External Display can be opened on another
    -- device (a TV on the wifi). Read once, at server start - see server.js.
    allow_network_access INTEGER NOT NULL DEFAULT 0 CHECK (allow_network_access IN (0,1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_compatibility (
    skill_a TEXT NOT NULL CHECK (skill_a IN ('A','B','C','D','E')),
    skill_b TEXT NOT NULL CHECK (skill_b IN ('A','B','C','D','E')),
    allowed INTEGER NOT NULL DEFAULT 1 CHECK (allowed IN (0,1)),
    PRIMARY KEY (skill_a, skill_b)
);

CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance(session_id);
CREATE INDEX IF NOT EXISTS idx_attendance_player ON attendance(player_id);
CREATE INDEX IF NOT EXISTS idx_games_session_round ON games(session_id, round_number);
CREATE INDEX IF NOT EXISTS idx_game_players_player ON game_players(player_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
