-- =====================================================================================
-- Skinote reference schema  ·  migration 0001  ·  2026-09-23
-- -------------------------------------------------------------------------------------
-- This file is the complete reference DDL for the two Skinote databases. The migration
-- runner splits it at the "@database" and "@seed" marker lines and applies each part to
-- its own file:
--
--   @database control   -> control.sqlite     (accounts, sessions, licences, plans,
--                                              resort templates, platform audit, backups)
--   @database shop      -> shop-<shop_id>.sqlite  (everything a shop owns)
--   @seed control / @seed shop -> code vocabularies (sys_*) for each file
--
-- There is no foreign key between the two files. Shop rows name accounts only by
-- actor keys and snapshots, so a shop file can move to its own server (or to a
-- PostgreSQL schema) without breaking a constraint.
--
-- Deployment is cloud-first (ADR-19, docs/architecture/deployment.md): control.sqlite and every
-- shop file live on our central server in Korea, one writer per shop file, each commit replicated
-- to object storage in another location within seconds. Counters and driver devices keep a
-- working copy (the same store code on SQLite WASM) and a signed send queue for offline work;
-- sys_offline_commands says which command each device kind may queue.
--
-- Read docs/architecture/data-model.md first. The rules this file follows:
--   * Every tenant table leads its key with shop_id; references between tenant rows are
--     composite foreign keys (shop_id, x_id) -> x(shop_id, id). A row of one shop cannot
--     point at a row of another shop.
--   * Ids are TEXT. Every new id is a ULID (26 chars, client-generatable, globally unique),
--     including rows made by shop.provision; the only fixed ids are the per-shop defaults
--     'main' (closing_scopes, calendars). Legacy ids from ski-rent-ops are imported with the
--     shop code as a prefix ('shop1.ski', 'shop1.van-1'; never ':' because actor and
--     conflict keys are ':'-delimited); the codec adds and strips it and
--     legacy_records keeps the original. So two shop files never share an id and can be
--     merged into one file with branches without re-keying.
--   * Several locations of ONE business are branches of one shop file; each closes its own
--     day through closing_scopes. Different businesses are always different tenants.
--   * Money is INTEGER in minor units of shops.currency (KRW: won). Percent is basis
--     points (10% = 1000). Signs come from sys_* vocabularies, not from column names.
--   * Instants are ISO-8601 UTC text with milliseconds and 'Z'. Local dates are
--     'YYYY-MM-DD', local times 'HH:MM', both in the shop time zone.
--   * Every money and stock row carries occurred_at, recorded_at, business_date (the
--     day it happened) and posting_date (the open day whose closing counts it).
--   * No CHECK enums. Vocabularies are sys_* rows (code-owned, FK targets) or shop
--     registry rows. CHECK is used only for permanent truths (booleans, signs, ranges,
--     net = gross - discount, end >= start).
--   * Business uniqueness is written as CREATE UNIQUE INDEX, never as an inline UNIQUE
--     constraint, so a rule can be relaxed later by dropping or replacing an index.
--   * Ledger tables are append-only and guarded by triggers (section 2.19). The update
--     guard names the 0001 columns (BEFORE UPDATE OF ...), so a column added later can be
--     back-filled by a migration and then gets its own 'set once' guard. Free-text columns
--     of ledgers may only be redacted (overwritten with '(지움)'), never edited.
--   * Later growth is additive only: new rows, new tables, nullable ADD COLUMN, typed
--     attribute rows. Migrations are forward-only; a table that holds rows is never
--     rebuilt, and there is no 'empty table' exception: a table that needs a new shape
--     gets a new name (*_v2) plus a view. See the lint rules in data-model.md section 7.
--
-- SQLite-only features used (each has a documented PostgreSQL equivalent, data-model.md 9):
--   [SQLite] STRICT tables             -> drop the keyword
--   [SQLite] GENERATED ... VIRTUAL     -> GENERATED ... STORED (or VIRTUAL on PG 18+)
--   [SQLite] trigger bodies with RAISE -> plpgsql trigger function or REVOKE UPDATE, DELETE
--   [SQLite] INTEGER PRIMARY KEY rowid -> bigint generated always as identity
--   [SQLite] connection PRAGMAs (set by the runner, not in this file):
--            auto_vacuum = INCREMENTAL (before the first CREATE TABLE on a new file),
--            journal_mode = WAL, foreign_keys = ON, synchronous = FULL, busy_timeout = 5000,
--            recursive_triggers = ON (REPLACE deletes fire the append-only DELETE guards;
--            every connection reads it back and refuses to start when it is 0). CI forbids
--            INSERT OR REPLACE, REPLACE INTO and INSERT OR IGNORE against ledger tables.
-- Everything else (partial indexes, composite FKs, CHECK, ON CONFLICT) is portable.
-- PostgreSQL port rules (data-model.md 9): control and shop tables live in separate schemas;
-- ids, keys and rank keys are COLLATE "C" (SQLite compares text as BINARY); instants, dates
-- and times stay TEXT forever behind format-checked domains (no later ALTER COLUMN TYPE);
-- foreign keys are emitted as ALTER TABLE ... ADD CONSTRAINT after all CREATE TABLEs,
-- because this file has forward and circular references.
-- =====================================================================================


-- @database control
-- =====================================================================================
-- PART 1 · CONTROL DATABASE (control.sqlite)
-- One per deployment: the central platform database on our server (ADR-19). A hybrid shop's
-- edge PC (after season 1, deployment.md 1-3) never writes control: it keeps a read-only copy of its
-- own slice (staff password and PIN verifiers, the signed licence, device public keys) so it can
-- authenticate while the internet is down, and the centre stays the only writer of this file.
-- Security state (lockouts, revocations) is updated in place; every change made through the
-- admin console also writes platform_audit_log.
-- =====================================================================================

CREATE TABLE schema_migrations (                  -- forward-only migration ledger of THIS file
  id            INTEGER NOT NULL PRIMARY KEY,      -- 1, 2, 3 ... never reused, never edited  [SQLite rowid]
  name          TEXT    NOT NULL,                  -- '0001_control'
  database_key  TEXT    NOT NULL,                  -- control | shop
  checksum      TEXT    NOT NULL,                  -- sha256 of the migration source; a mismatch refuses startup
  app_version   TEXT    NOT NULL,
  applied_at    TEXT    NOT NULL,
  duration_ms   INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX schema_migrations_name ON schema_migrations (name);

CREATE TABLE db_instance (                        -- identity of this physical file
  singleton                INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  instance_id              TEXT    NOT NULL,      -- ULID minted when the file is created
  epoch_id                 TEXT    NOT NULL,      -- new ULID at creation and after every restore
  epoch_no                 INTEGER NOT NULL DEFAULT 1,
  deployment_key           TEXT    NOT NULL,      -- cloud | edge (hybrid shop PC, later) | staging | drill | demo (code-owned)
  created_at               TEXT    NOT NULL,
  restored_at              TEXT,
  restored_from_backup_id  TEXT
) STRICT;

CREATE TABLE json_schemas (                       -- JSON Schema registry for every JSON column of this file
  key            TEXT    NOT NULL,                -- 'resort_template.content', 'licence.claims'
  version        INTEGER NOT NULL,
  json_schema    TEXT    NOT NULL,
  upcaster_key   TEXT,                            -- code id of the reader that lifts version-1 documents
  created_at     TEXT    NOT NULL,
  PRIMARY KEY (key, version)
) STRICT;

CREATE TABLE sys_features (                       -- same rows as the shop file's sys_features (both seeded by migrations)
  key              TEXT    NOT NULL PRIMARY KEY,
  label            TEXT    NOT NULL,
  description      TEXT,
  default_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (default_enabled IN (0,1)),
  depends_on_json  TEXT    NOT NULL DEFAULT '[]', -- feature keys that must also be on
  added_in         INTEGER NOT NULL
) STRICT;

CREATE TABLE businesses (                         -- the legal business that owns one or more shops (docs/04)
  id           TEXT    NOT NULL PRIMARY KEY,
  name         TEXT    NOT NULL,
  business_no  TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE tenants (                            -- shop directory: where each shop's data lives
  id             TEXT    NOT NULL PRIMARY KEY,    -- = shops.id inside the shop file
  business_id    TEXT    REFERENCES businesses(id),
  code           TEXT    NOT NULL,                -- short ASCII code used in URLs and support
  name           TEXT    NOT NULL,
  data_location  TEXT    NOT NULL,                -- where the writer of the shop is: 'sqlite://<host>/shop-<id>.sqlite' (a
                                                  -- server of ours) | 'edge://<device id>' (hybrid shop PC, later) |
                                                  -- 'pg://<cluster>/<schema>'; season 1 writes 'sqlite:shop-<id>.sqlite' (this server)
  status_key     TEXT    NOT NULL DEFAULT 'active',   -- active | suspended | closed (code-owned)
  is_test        INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),   -- demo shop: nothing reaches customers
  closing_requested_at TEXT,                      -- the shop ended its contract: limited mode, then export and destruction
                                                  -- (deployment.md 6-7)
  data_destroyed_at    TEXT,                      -- live file, replicas, snapshots, segments and the shop's data key destroyed
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX tenants_code ON tenants (code);

CREATE TABLE accounts (                           -- a person who can sign in (docs/45)
  id                    TEXT    NOT NULL PRIMARY KEY,   -- global ULID minted once by the central control; a copy elsewhere (a
                                                  -- hybrid shop PC's read-only slice, a PostgreSQL move) keeps it, never re-mints
  login_realm           TEXT    NOT NULL DEFAULT 'platform',   -- tenant code ('shop1') for shop staff, 'platform' for admins;
                                                  -- logins such as 'counter1' may repeat across shops, so the realm is part of the key
  login_id              TEXT,                     -- lower-cased; NULL for imported legacy actors that cannot sign in
  display_name          TEXT    NOT NULL,         -- shown as '삭제된 계정' once deleted_at is set
  password_hash         TEXT,                     -- PHC string (scrypt / argon2id); never leaves the server
  pin_hash              TEXT,                     -- short PIN for quick staff switch on a registered shop device: a slow hash
                                                  -- of HMAC(pepper, PIN) where the pepper is a server secret outside every
                                                  -- database and backup (a leaked control copy alone cannot be brute-forced);
                                                  -- never sent to devices (they keep their own verifiers, sync doc 7)
  must_change_password  INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  failed_count          INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until          TEXT,                     -- 5 failures -> 10 minutes (setting)
  pin_failed_count      INTEGER NOT NULL DEFAULT 0 CHECK (pin_failed_count >= 0),
  pin_locked_until      TEXT,
  status_key            TEXT    NOT NULL DEFAULT 'active',   -- invited | active | suspended | deleted | legacy
  last_login_at         TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  deleted_at            TEXT,                     -- rows are never removed
  version               INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX accounts_login ON accounts (login_realm, login_id) WHERE login_id IS NOT NULL;

CREATE TABLE account_tenants (                    -- directory cache: which shops an account may choose at sign-in
  account_id  TEXT    NOT NULL REFERENCES accounts(id),
  tenant_id   TEXT    NOT NULL REFERENCES tenants(id),
  status_key  TEXT    NOT NULL DEFAULT 'active', -- mirrors staff_members.status_key in the shop file (the authority)
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (account_id, tenant_id)
) STRICT;

CREATE TABLE platform_admins (                    -- hidden admin console access (never in the Pages demo)
  account_id  TEXT    NOT NULL PRIMARY KEY REFERENCES accounts(id),
  role_key    TEXT    NOT NULL,                   -- owner | support | readonly (code-owned)
  granted_at  TEXT    NOT NULL,
  granted_by  TEXT    REFERENCES accounts(id),
  revoked_at  TEXT
) STRICT;

CREATE TABLE sessions (                           -- bearer sessions; the token itself is never stored
  id              TEXT    NOT NULL PRIMARY KEY,
  token_hash      TEXT    NOT NULL,               -- sha256 of the bearer token
  kind_key        TEXT    NOT NULL,               -- staff | admin | agent (code-owned); old access-file tokens are NOT imported:
                                                  -- every device enrols again at the cutover (migration-plan 5-1)
  account_id      TEXT    REFERENCES accounts(id),
  tenant_id       TEXT    REFERENCES tenants(id), -- chosen shop; NULL for the admin console
  device_id       TEXT,                           -- devices.id in the shop file (no cross-file FK)
  staff_member_id TEXT,                           -- staff_members.id in the shop file, set after shop choice or PIN switch
  legacy_actor_json TEXT,                         -- stays NULL: old access-file tokens are not imported (the actor mapping lives in
                                                  -- staff_members.legacy_actor_key)
  created_at      TEXT    NOT NULL,
  last_used_at    TEXT    NOT NULL,
  idle_timeout_s  INTEGER NOT NULL CHECK (idle_timeout_s > 0),   -- driver devices: long (14 days) behind an app lock; counter: shift
  expires_at      TEXT    NOT NULL,
  revoked_at      TEXT,
  revoke_reason   TEXT,
  ip_hash         TEXT,                           -- keyed HMAC of the address (key rotated, deployment.md 10-4), not a bare sha256
  user_agent      TEXT
) STRICT;
CREATE UNIQUE INDEX sessions_token ON sessions (token_hash);
CREATE INDEX sessions_account ON sessions (account_id, revoked_at);
CREATE INDEX sessions_device ON sessions (tenant_id, device_id) WHERE device_id IS NOT NULL;

CREATE TABLE login_attempts (
  id          INTEGER NOT NULL PRIMARY KEY,       -- [SQLite rowid]
  login_id    TEXT    NOT NULL,
  account_id  TEXT    REFERENCES accounts(id),
  tenant_id   TEXT,
  device_id   TEXT,
  method_key  TEXT    NOT NULL,                   -- password | pin | enrollment (a device entering an enrolment code) (code-owned)
  succeeded   INTEGER NOT NULL CHECK (succeeded IN (0,1)),
  reason_key  TEXT,                               -- bad_password | locked | suspended | not_enrolled_device | ok
  ip_hash     TEXT,                               -- keyed HMAC; lockouts and back-off are per (account, device or address)
  at          TEXT    NOT NULL
) STRICT;
CREATE INDEX login_attempts_login ON login_attempts (login_id, at);

CREATE TABLE plans (                              -- licence plans; the billing unit is still open (docs/45)
  key            TEXT    NOT NULL PRIMARY KEY,    -- trial | standard | ... vendor-fixed keys, shipped like sys rows
  label          TEXT    NOT NULL,
  device_limit   INTEGER,                         -- NULL = unlimited
  account_limit  INTEGER,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;

CREATE TABLE plan_features (                      -- a feature is available when the plan allows it AND the shop turns it on
  plan_key     TEXT NOT NULL REFERENCES plans(key),
  feature_key  TEXT NOT NULL REFERENCES sys_features(key),
  PRIMARY KEY (plan_key, feature_key)
) STRICT;

CREATE TABLE licence_signing_keys (               -- PUBLIC keys only; no private key enters any database
  key_id       TEXT NOT NULL PRIMARY KEY,
  algorithm    TEXT NOT NULL,                     -- 'Ed25519'
  public_key   TEXT NOT NULL,                     -- base64
  purpose_key  TEXT NOT NULL DEFAULT 'licence',   -- licence: the offline root key (developer's hardware key / safe) that signs
                                                  -- shop licences and the certificates of device-token keys; the app ships
                                                  -- only root public keys | device_token: an online key of the server that signs
                                                  -- short device tokens, rotated often, certified by a root key (code-owned)
  certified_by TEXT REFERENCES licence_signing_keys(key_id),   -- device_token keys: the root key that signed the certificate
  certificate  TEXT,                              -- root signature over (key_id, public_key, purpose_key, not_after, test_only)
  not_after    TEXT,                              -- a device refuses tokens signed by a device_token key after this
  test_only    INTEGER NOT NULL DEFAULT 0 CHECK (test_only IN (0,1)),   -- staging key: its tokens are valid only for is_test shops
  created_at   TEXT NOT NULL,
  retired_at   TEXT
) STRICT;

CREATE TABLE licences (                           -- one live licence per shop (docs/45 A03)
  id                     TEXT    NOT NULL PRIMARY KEY,
  tenant_id              TEXT    NOT NULL REFERENCES tenants(id),
  licence_no             TEXT    NOT NULL,
  plan_key               TEXT    NOT NULL REFERENCES plans(key),
  starts_on              TEXT    NOT NULL,        -- local date
  expires_on             TEXT    NOT NULL,        -- 'expiring' is derived, never stored
  device_limit           INTEGER,                 -- NULL = plan default
  account_limit          INTEGER,
  feature_overrides_json TEXT    NOT NULL DEFAULT '{}',   -- {"lessons": true}
  offline_grace_days     INTEGER NOT NULL DEFAULT 14 CHECK (offline_grace_days BETWEEN 1 AND 60),
                                                  -- a device keeps full use on its cached signed device token this long after
                                                  -- its last contact with the server (refresh_by); after that only new orders
                                                  -- stop on that device, money and returns never do (deployment.md 5)
  expiry_grace_days      INTEGER NOT NULL DEFAULT 14 CHECK (expiry_grace_days BETWEEN 0 AND 60),
                                                  -- full use after expires_on; then limited mode (no new orders, no settings,
                                                  -- no new devices); money, returns, closing and data export always work
  status_key             TEXT    NOT NULL DEFAULT 'active', -- active | suspended | deleted
  token                  TEXT    NOT NULL,        -- vendor-signed claims (Ed25519, offline root key). The central server checks them
                                                  -- at every session start and signs short device tokens with an online
                                                  -- device_token key certified by the root; a device checks the certificate chain
                                                  -- with the root public key built into the app, so editing a row unlocks nothing.
                                                  -- The device check is guidance for the screen, not enforcement: records that
                                                  -- already happened offline are always accepted (deployment.md 5-5)
  signing_key_id         TEXT    NOT NULL REFERENCES licence_signing_keys(key_id),
  suspended_reason       TEXT,
  issued_at              TEXT    NOT NULL,
  issued_by              TEXT    REFERENCES accounts(id),
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  CHECK (expires_on >= starts_on)
) STRICT;
CREATE UNIQUE INDEX licences_no ON licences (licence_no);
CREATE UNIQUE INDEX licences_one_live ON licences (tenant_id) WHERE status_key <> 'deleted';

CREATE TABLE resort_templates (                   -- central resort starter data (docs/45 A05)
  id                   TEXT    NOT NULL PRIMARY KEY,   -- vendor-fixed ULID shipped with the template package, so every shop file,
                                                       -- a staging copy and the central database agree (template_applications.template_id)
  key                  TEXT    NOT NULL,          -- muju_deogyusan, jisan_forest ...
  name                 TEXT    NOT NULL,          -- '무주덕유산리조트'
  region               TEXT,
  status_key           TEXT    NOT NULL DEFAULT 'draft',   -- draft | published | retired
  published_version_no INTEGER,                   -- pointer to the version shops receive
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX resort_templates_key ON resort_templates (key);

CREATE TABLE resort_template_versions (           -- immutable documents; editing creates a new version
  template_id     TEXT    NOT NULL REFERENCES resort_templates(id),
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  content_schema  INTEGER NOT NULL,               -- json_schemas('resort_template.content', n)
  content_json    TEXT    NOT NULL,               -- {areas:[{key,name,places:[{key,name,uses}]}], return_slots:[...],
                                                  --  pickup_times:[...], ticket_products:[...], vendors:[...]}
  note            TEXT,
  created_at      TEXT    NOT NULL,
  created_by      TEXT    REFERENCES accounts(id),
  PRIMARY KEY (template_id, version_no)
) STRICT;

CREATE TABLE template_usage (                     -- '적용 매장 수'; the shop file keeps the authoritative record
  tenant_id    TEXT    NOT NULL REFERENCES tenants(id),
  template_id  TEXT    NOT NULL REFERENCES resort_templates(id),
  version_no   INTEGER NOT NULL,
  applied_at   TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, template_id, version_no),
  FOREIGN KEY (template_id, version_no) REFERENCES resort_template_versions(template_id, version_no)
) STRICT;

CREATE TABLE platform_audit_log (                 -- 사용 내역 of the platform: logins, accounts, licences, templates,
                                                  -- backups, restores, exports. Hash-chained for tamper evidence.
  chain_id     TEXT    NOT NULL,                  -- db_instance.instance_id of the file that wrote it: chains of several files
                                                  -- (a restored copy, a later PostgreSQL move) merge without renumbering
  seq          INTEGER NOT NULL CHECK (seq >= 1), -- gapless order inside the chain (PostgreSQL: appends serialised per chain)
  id           TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  tenant_id    TEXT,                              -- NULL = platform scope
  account_id   TEXT,
  actor_label  TEXT    NOT NULL,
  device_id    TEXT,
  session_id   TEXT,
  ip_hash      TEXT,                              -- keyed HMAC, not a bare sha256
  category_key TEXT    NOT NULL,                  -- login | account | licence | template | settings | export | backup | restore |
                                                  -- support (supplier data view, remote screen, break-glass file access) | error
  action_key   TEXT    NOT NULL,                  -- 'licence.extend', 'account.suspend', 'backup.verified' ...
  target_type  TEXT,
  target_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  request_id   TEXT,
  outcome_key  TEXT    NOT NULL,                  -- ok | denied | failed
  message      TEXT,
  prev_hash    TEXT    NOT NULL,
  hash         TEXT    NOT NULL,                  -- sha256(prev_hash || canonical(row without hash))
  PRIMARY KEY (chain_id, seq)
) STRICT;
CREATE UNIQUE INDEX platform_audit_log_id ON platform_audit_log (id);
CREATE INDEX platform_audit_log_tenant ON platform_audit_log (tenant_id, at);
CREATE INDEX platform_audit_log_account ON platform_audit_log (account_id, at);
CREATE INDEX platform_audit_log_category ON platform_audit_log (category_key, at);

CREATE TABLE usage_daily (                        -- admin dashboard counters, written once a day per shop by the central worker
  tenant_id   TEXT    NOT NULL REFERENCES tenants(id),
  date        TEXT    NOT NULL,
  metric_key  TEXT    NOT NULL,                   -- commands | orders | logins | errors | sync_bytes | devices_active | db_bytes
  value       INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, date, metric_key)
) STRICT;

CREATE TABLE backups (                            -- catalogue of every backup file of this deployment
  id            TEXT    NOT NULL PRIMARY KEY,
  tenant_id     TEXT    REFERENCES tenants(id),   -- NULL = the control file itself
  database_key  TEXT    NOT NULL,                 -- control | shop
  kind_key      TEXT    NOT NULL,                 -- daily | weekly_scrubbed | season_scrubbed (no customer PII) | pre_migration |
                                                  -- post_migration | pre_import | manual | owner_export | owner_export_scrubbed
                                                  -- (code-owned, deployment.md 6). A VACUUM INTO snapshot is its own restore
                                                  -- point: WAL frames of the live file cannot be replayed on it (the replication
                                                  -- tool restores from its own generations); journal segments continue it
  file_name     TEXT    NOT NULL,                 -- object key in the backup store of the other location (or the owner's file name)
  bytes         INTEGER NOT NULL CHECK (bytes >= 0),
  sha256        TEXT    NOT NULL,
  epoch_id      TEXT    NOT NULL,
  max_rev       INTEGER,                          -- shop files: highest rev inside the copy
  last_hash     TEXT,                             -- shop files: journal hash at max_rev (chain continuity on restore)
  encrypted     INTEGER NOT NULL DEFAULT 1 CHECK (encrypted IN (0,1)),
  key_id        TEXT,                             -- the shop's data key (public-key encryption, e.g. an age recipient); the
                                                  -- server holds public keys only, and destroying a shop's key makes every
                                                  -- copy of that shop unreadable (deployment.md 6-7, 10-1)
  status_key    TEXT    NOT NULL,                 -- written | verified | offsite | failed | expired
  created_at    TEXT    NOT NULL,
  verified_at   TEXT,
  offsite_at    TEXT,
  expires_at    TEXT,
  note          TEXT
) STRICT;
CREATE INDEX backups_tenant ON backups (tenant_id, created_at);

CREATE TABLE restore_drills (                     -- restore test on a fresh VM in the isolated drill box (deployment.md 6-3):
                                                  -- the replication tool's own generation + WAL to a point in time, or a VACUUM
                                                  -- INTO snapshot + journal segments, or segments only; then integrity_check,
                                                  -- verifier, chain and row digests; finished_at - started_at is the measured RTO
  id           TEXT    NOT NULL PRIMARY KEY,
  tenant_id    TEXT    REFERENCES tenants(id),    -- NULL = the control file or the whole server
  backup_id    TEXT    REFERENCES backups(id),    -- the snapshot a snapshot drill started from; NULL for a replica or segment drill
  source_key   TEXT    NOT NULL DEFAULT 'replica',   -- replica (PITR from the tool's generation) | snapshot | journal (code-owned)
  provider_key TEXT    NOT NULL DEFAULT 'primary',   -- primary | second (the other company's store, region-loss drill)
  replica_generation TEXT,                        -- the replication tool's generation id the drill restored
  target_at    TEXT,                              -- point in time restored to
  target_rev   INTEGER,                           -- rev R reached; checks compare the chain hash and ledger digests at R
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  outcome_key  TEXT    NOT NULL,                  -- passed | failed
  report_json  TEXT    NOT NULL                   -- integrity_check, verifier findings, row counts, replayed segments
) STRICT;

CREATE TABLE tenant_epochs (                      -- every epoch of every shop; survives the loss of the shop file
  tenant_id           TEXT    NOT NULL REFERENCES tenants(id),
  epoch_no            INTEGER NOT NULL CHECK (epoch_no >= 1),
  epoch_id            TEXT    NOT NULL,
  started_at          TEXT    NOT NULL,
  restored_from_backup_id TEXT REFERENCES backups(id),
  restored_up_to_rev  INTEGER,
  rev_floor           INTEGER NOT NULL DEFAULT 0, -- = max rev EVER issued for this shop (all epochs, backups, segments,
                                                  --   devices' reports) + 1,000,000; never relative to the restored backup
  max_rev_seen        INTEGER NOT NULL DEFAULT 0, -- raised by segment exports, backups and device reports
  PRIMARY KEY (tenant_id, epoch_no)
) STRICT;
CREATE UNIQUE INDEX tenant_epochs_id ON tenant_epochs (epoch_id);

-- Routing before the shop is known (SMS / card / payment callbacks, intake links, online booking).
-- Shop files are per tenant, so the platform keeps the directory and a relay inbox; the writer of
-- the shop (the central server, or a hybrid shop's edge PC behind NAT) pulls from it; under
-- PostgreSQL row security these rows are read before skinote.shop_id is set.
CREATE TABLE public_links (                       -- capability tokens handed to customers (intake form, online booking)
  token_hash   TEXT    NOT NULL PRIMARY KEY,      -- sha256 of the token in the URL fragment
  tenant_id    TEXT    NOT NULL REFERENCES tenants(id),
  kind_key     TEXT    NOT NULL,                  -- intake | booking | receipt (code-owned)
  target_id    TEXT    NOT NULL,                  -- id inside the shop file (intake_requests.id ...)
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT,
  created_at   TEXT    NOT NULL
) STRICT;
CREATE INDEX public_links_tenant ON public_links (tenant_id, kind_key);

CREATE TABLE external_refs (                      -- provider ids that come back without a shop (SMS message id, PG order id)
  provider_key  TEXT    NOT NULL,                 -- sms:<vendor> | pg:<vendor> | van:<vendor>
  external_id   TEXT    NOT NULL,
  tenant_id     TEXT    NOT NULL REFERENCES tenants(id),
  entity_type   TEXT    NOT NULL,                 -- message_deliveries | payment_intents | outbox
  entity_id     TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (provider_key, external_id)
) STRICT;

CREATE TABLE inbound_events (                     -- relay inbox: callbacks received centrally, pulled by the shop's writer
  id            TEXT    NOT NULL PRIMARY KEY,     -- ULID; also the request id of the system command the shop records
  tenant_id     TEXT,                             -- NULL until routed through public_links / external_refs
  provider_key  TEXT    NOT NULL,
  external_id   TEXT,
  payload_json  TEXT    NOT NULL,                 -- only after the provider signature (HMAC) verified; money results are
                                                  -- re-queried from the provider API before they are recorded (sync doc 9).
                                                  -- May carry a phone number: emptied to '{}' 30 days after pulled
  received_at   TEXT    NOT NULL,
  routed_at     TEXT,
  pulled_at     TEXT,                             -- the shop's writer acknowledged it (idempotent by id)
  payload_purged_at TEXT,
  status_key    TEXT    NOT NULL DEFAULT 'received'   -- received | routed | pulled | unroutable
) STRICT;
CREATE INDEX inbound_events_pending ON inbound_events (tenant_id, received_at) WHERE pulled_at IS NULL;

CREATE TABLE enrollment_routes (                  -- device enrolment codes, routed before the shop is known (deployment.md 5-3): a new
                                                  -- device enters the code at the one app address and the centre finds the shop here
  code_hash    TEXT    NOT NULL PRIMARY KEY,      -- sha256 of the code; global, so two shops never hold the same live code
  tenant_id    TEXT    NOT NULL REFERENCES tenants(id),
  code_id      TEXT    NOT NULL,                  -- device_enrollment_codes.id in the shop file (no cross-file FK)
  origin_key   TEXT    NOT NULL DEFAULT 'shop',   -- shop | supplier: a code the supplier made joins only after the owner approves
  expires_at   TEXT    NOT NULL,                  -- 15 minutes
  claimed_at   TEXT,                              -- a device entered it; the device joins only after approval on the admin screen
  used_at      TEXT,
  created_at   TEXT    NOT NULL
) STRICT;
CREATE INDEX enrollment_routes_tenant ON enrollment_routes (tenant_id, created_at);

CREATE TABLE support_access_grants (              -- the shop's time-limited permission for the supplier (deployment.md 9, 10-2):
                                                  -- unmasked data view or one remote-screen session; every use is written to
                                                  -- platform_audit_log (category support) and shown in the shop's notice slot
  id                  TEXT    NOT NULL PRIMARY KEY,
  tenant_id           TEXT    NOT NULL REFERENCES tenants(id),
  kind_key            TEXT    NOT NULL,           -- data_unmasked | remote_screen (code-owned)
  granted_by          TEXT    NOT NULL REFERENCES accounts(id),   -- the owner or manager who pressed 공급자 도움 허락 in 관리
  reason              TEXT    NOT NULL,
  confirm_words_hash  TEXT,                       -- remote_screen: the one-time two words the supplier has to say first
  starts_at           TEXT    NOT NULL,
  expires_at          TEXT    NOT NULL,           -- e.g. 2 hours
  revoked_at          TEXT,
  created_at          TEXT    NOT NULL,
  CHECK (expires_at > starts_at)
) STRICT;
CREATE INDEX support_access_grants_live ON support_access_grants (tenant_id, expires_at) WHERE revoked_at IS NULL;

-- control.sqlite has its own recovery journal (accounts, PINs, sessions, enrolments change here),
-- exported in segments exactly like the shop journal (sync doc 10). Secrets travel only inside the
-- encrypted segment file; the rows are purged after the retention window.
CREATE TABLE control_changes (
  seq         INTEGER NOT NULL PRIMARY KEY,       -- [SQLite rowid]
  at          TEXT    NOT NULL,
  table_name  TEXT    NOT NULL,
  row_key     TEXT    NOT NULL,
  op_key      TEXT    NOT NULL,                   -- upsert | delete
  row_json    TEXT,                               -- after-image; NULL for delete
  purge_after TEXT    NOT NULL
) STRICT;
CREATE INDEX control_changes_purge ON control_changes (purge_after);

CREATE TABLE control_journal_exports (
  id          TEXT    NOT NULL PRIMARY KEY,
  from_seq    INTEGER NOT NULL,
  to_seq      INTEGER NOT NULL,
  file_name   TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  target_key  TEXT    NOT NULL,                   -- second_store (another company's store in Korea, every minute) |
                                                  -- edge_peer (a hybrid shop, later)
  status_key  TEXT    NOT NULL,                   -- written | verified | offsite | failed
  created_at  TEXT    NOT NULL,
  CHECK (to_seq >= from_seq)
) STRICT;

CREATE TRIGGER platform_audit_log_no_update BEFORE UPDATE OF
  chain_id, seq, id, at, tenant_id, account_id, actor_label, device_id, session_id, ip_hash, category_key,
  action_key, target_type, target_id, before_json, after_json, request_id, outcome_key, message, prev_hash, hash
  ON platform_audit_log BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY platform_audit_log'); END;
CREATE TRIGGER platform_audit_log_no_delete BEFORE DELETE ON platform_audit_log BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY platform_audit_log'); END;
CREATE TRIGGER resort_template_versions_no_update BEFORE UPDATE OF
  template_id, version_no, content_schema, content_json, note, created_at, created_by
  ON resort_template_versions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY resort_template_versions'); END;
CREATE TRIGGER resort_template_versions_no_delete BEFORE DELETE ON resort_template_versions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY resort_template_versions'); END;


-- @database shop
-- =====================================================================================
-- PART 2 · SHOP DATABASE (shop-<shop_id>.sqlite)
-- Everything one shop owns. shop_id is still on every row, so the same DDL serves
-- PostgreSQL with many shops per schema (row-level security on shop_id).
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 2.1 Meta
-- -------------------------------------------------------------------------------------
CREATE TABLE schema_migrations (
  id            INTEGER NOT NULL PRIMARY KEY,      -- [SQLite rowid]
  name          TEXT    NOT NULL,
  database_key  TEXT    NOT NULL,                  -- control | shop
  checksum      TEXT    NOT NULL,
  app_version   TEXT    NOT NULL,
  applied_at    TEXT    NOT NULL,
  duration_ms   INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX schema_migrations_name ON schema_migrations (name);

CREATE TABLE db_instance (                        -- identity of this physical file only (epochs are per shop: shop_instance)
  singleton                INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  instance_id              TEXT    NOT NULL,      -- also the chain_id of anything this file hash-chains
  deployment_key           TEXT    NOT NULL,      -- cloud | edge | staging | drill | demo
  created_at               TEXT    NOT NULL
) STRICT;

CREATE TABLE json_schemas (                       -- JSON Schema for every JSON column in this file
  key            TEXT    NOT NULL,                -- 'setting.prepayment_mode', 'print_layout', 'closing.report', 'command:order.create'
  version        INTEGER NOT NULL,
  json_schema    TEXT    NOT NULL,
  upcaster_key   TEXT,                            -- code id of the reader that lifts version n-1
  created_at     TEXT    NOT NULL,
  PRIMARY KEY (key, version)
) STRICT;

CREATE TABLE sys_soft_references (                -- reference columns added later by ADD COLUMN (no composite FK possible);
                                                  -- the verifier checks existence and same-shop for every row listed here
  table_name     TEXT    NOT NULL,
  column_name    TEXT    NOT NULL,
  target_table   TEXT    NOT NULL,
  added_in       INTEGER NOT NULL,
  note           TEXT,
  PRIMARY KEY (table_name, column_name)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.2 Code vocabularies (sys_*). Inserted only by numbered migrations shipped with the
-- code that understands them. They are FK targets, so a typo can never enter a business
-- row, and a new value is an INSERT, never a CHECK rebuild. Behaviour flags are typed
-- columns so the database can enforce them.
-- -------------------------------------------------------------------------------------
CREATE TABLE sys_features (
  key                TEXT    NOT NULL PRIMARY KEY,   -- vehicles, night_collection, lift_tickets, lessons, ...
  label              TEXT    NOT NULL,
  description        TEXT,
  default_enabled    INTEGER NOT NULL DEFAULT 0 CHECK (default_enabled IN (0,1)),
  depends_on_json    TEXT    NOT NULL DEFAULT '[]',  -- ["vehicles"] for night_collection
  config_schema_key  TEXT,                           -- json_schemas key for shop_features.config_json
  added_in           INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_permissions (
  key          TEXT    NOT NULL PRIMARY KEY,         -- order.create, payment.refund, route.reorder, task.pin ...
  label        TEXT    NOT NULL,
  group_key    TEXT    NOT NULL,                     -- order | money | stock | dispatch | settings | admin
  scopes_json  TEXT    NOT NULL DEFAULT '["shop"]',  -- allowed scopes: shop | own_vehicle | own_orders
  sensitive    INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0,1)),   -- money-changing or destructive: always audited
  added_in     INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_setting_definitions (
  key               TEXT    NOT NULL PRIMARY KEY,    -- prepayment_mode, payment_timing_default, rounding_policy ...
  label             TEXT    NOT NULL,
  value_schema_key  TEXT    NOT NULL,                -- json_schemas key; shop_settings.value_json is validated against it
  default_value     TEXT    NOT NULL,                -- JSON
  effective_dated   INTEGER NOT NULL DEFAULT 0 CHECK (effective_dated IN (0,1)),  -- 1: records snapshot the version used
  added_in          INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_device_kinds (                     -- what a registered device is
  key       TEXT    NOT NULL PRIMARY KEY,           -- pos, driver_tablet, driver_phone, admin_console, print_agent, card_agent
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_device_classes (                   -- layout classes; the pixel values live in code (DeviceProfile)
  key       TEXT    NOT NULL PRIMARY KEY,           -- pos, pos_narrow, driver_tablet, driver_phone, print, admin
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_return_policies (                  -- does a line wait for its units to come back?
  key                TEXT    NOT NULL PRIMARY KEY,  -- required | optional | none
  label              TEXT    NOT NULL,
  blocks_completion  INTEGER NOT NULL CHECK (blocks_completion IN (0,1)),   -- required: yes; optional/none: no
  added_in           INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_fulfillment_modes (                -- behaviour family of an item kind
  key                        TEXT    NOT NULL PRIMARY KEY,   -- rental, ticket, service, sale, fee, bundle, placeholder
  label                      TEXT    NOT NULL,
  has_custody                INTEGER NOT NULL CHECK (has_custody IN (0,1)),
  needs_issue                INTEGER NOT NULL CHECK (needs_issue IN (0,1)),
  default_return_policy_key  TEXT    NOT NULL REFERENCES sys_return_policies(key),
  completion_rule_key        TEXT    NOT NULL,      -- code key: custody | service_closed | children_complete | immediate | never
  added_in                   INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_tracking_modes (
  key       TEXT    NOT NULL PRIMARY KEY,           -- unit (one assets row per unit) | count (stock_balances) | none
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_price_bases (
  key                   TEXT    NOT NULL PRIMARY KEY,   -- per_day, per_unit, per_session, per_person_session, per_hour, half_day, flat
  label                 TEXT    NOT NULL,
  multiplies_days       INTEGER NOT NULL CHECK (multiplies_days IN (0,1)),
  multiplies_headcount  INTEGER NOT NULL CHECK (multiplies_headcount IN (0,1)),
  uses_tiers            INTEGER NOT NULL CHECK (uses_tiers IN (0,1)),
  added_in              INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_discount_kinds (
  key               TEXT    NOT NULL PRIMARY KEY,   -- per_unit_day, percent, amount, package, manual_amount, manual_percent
  label             TEXT    NOT NULL,
  target_scope_key  TEXT    NOT NULL,               -- line | group (code-owned)
  added_in          INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_location_kinds (
  key       TEXT    NOT NULL PRIMARY KEY,           -- external, shop, storage, vehicle, customer, counterparty, other_shop, void
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_movement_kinds (
  key            TEXT    NOT NULL PRIMARY KEY,
  label          TEXT    NOT NULL,
  reversible     INTEGER NOT NULL CHECK (reversible IN (0,1)),
  creates_stock  INTEGER NOT NULL CHECK (creates_stock IN (0,1)),
  added_in       INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_movement_routes (                  -- the only legal (kind, from, to) combinations
  movement_kind_key  TEXT    NOT NULL REFERENCES sys_movement_kinds(key),
  from_kind_key      TEXT    NOT NULL REFERENCES sys_location_kinds(key),
  to_kind_key        TEXT    NOT NULL REFERENCES sys_location_kinds(key),
  driver_allowed     INTEGER NOT NULL CHECK (driver_allowed IN (0,1)),
  offline_allowed    INTEGER NOT NULL DEFAULT 0 CHECK (offline_allowed IN (0,1)),   -- may be queued offline (counter or driver
                                                    -- device, by sys_offline_commands); a later migration may raise it 0 -> 1
                                                    -- (lint allows exactly that UPDATE), never lower it
  added_in           INTEGER NOT NULL,
  PRIMARY KEY (movement_kind_key, from_kind_key, to_kind_key)
) STRICT;

CREATE TABLE sys_claim_lanes (                      -- independent kinds of hold on a unit; exclusive = one active claim per unit
  key        TEXT    NOT NULL PRIMARY KEY,          -- preparation, transport, disposition, composition, ticket_window
  label      TEXT    NOT NULL,
  exclusive  INTEGER NOT NULL CHECK (exclusive IN (0,1)),
  bound      INTEGER NOT NULL DEFAULT 1 CHECK (bound IN (0,1)),   -- 1: a claim must hang on the unit's one active
                                                    -- asset_bindings row (same order / purpose across lanes); composition: 0
  added_in   INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sys_claim_lanes_key_exclusive ON sys_claim_lanes (key, exclusive, bound);

CREATE TABLE sys_claim_types (
  key        TEXT    NOT NULL PRIMARY KEY,          -- preparation, task_delivery, task_collection, vendor_refund, partner_lending,
                                                    -- exchange_hold, component_of, line_fulfillment
  label      TEXT    NOT NULL,
  lane_key   TEXT    NOT NULL REFERENCES sys_claim_lanes(key),
  windowed   INTEGER NOT NULL CHECK (windowed IN (0,1)),   -- ticket reuse by time window (overlap checked in code; PG: EXCLUDE)
  added_in   INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sys_claim_types_key_lane ON sys_claim_types (key, lane_key);

CREATE TABLE sys_task_kinds (
  key                TEXT    NOT NULL PRIMARY KEY,  -- delivery, collection, vendor_refund, shop_transfer
  label              TEXT    NOT NULL,
  movement_kind_key  TEXT    REFERENCES sys_movement_kinds(key),
  added_in           INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_promise_types (
  key       TEXT    NOT NULL PRIMARY KEY,           -- pickup | return
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_fulfillment_methods (
  key               TEXT    NOT NULL PRIMARY KEY,   -- shop_counter, vehicle_delivery, shop_direct, vehicle_collection
  promise_type_key  TEXT    NOT NULL REFERENCES sys_promise_types(key),
  label             TEXT    NOT NULL,
  requires_vehicle  INTEGER NOT NULL CHECK (requires_vehicle IN (0,1)),
  requires_place    INTEGER NOT NULL CHECK (requires_place IN (0,1)),
  task_kind_key     TEXT    REFERENCES sys_task_kinds(key),
  added_in          INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sys_fulfillment_methods_key_type ON sys_fulfillment_methods (key, promise_type_key);

CREATE TABLE sys_payment_timings (
  key       TEXT    NOT NULL PRIMARY KEY,           -- at_intake, at_issue, at_return, later, by_other_order, partner_postpaid
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_payment_kinds (                    -- signs decide every balance; there is no other place to look
  key                 TEXT    NOT NULL PRIMARY KEY, -- payment, refund, legacy_refund, deposit_in, deposit_out, deposit_apply
  label               TEXT    NOT NULL,
  balance_sign        INTEGER NOT NULL CHECK (balance_sign IN (-1,0,1)),   -- effect on net paid toward charges
  deposit_sign        INTEGER NOT NULL CHECK (deposit_sign IN (-1,0,1)),   -- effect on deposit held
  cash_sign           INTEGER NOT NULL CHECK (cash_sign IN (-1,0,1)),      -- effect on the drawer when the method moves cash
  requires_refund_of  INTEGER NOT NULL DEFAULT 0 CHECK (requires_refund_of IN (0,1)),  -- payments.refund_of_payment_id required
  requires_deposit    INTEGER NOT NULL DEFAULT 0 CHECK (requires_deposit IN (0,1)),    -- payments.deposit_id required
  added_in            INTEGER NOT NULL
) STRICT;
-- FK target: payments copy these flags and the database checks the links they demand
CREATE UNIQUE INDEX sys_payment_kinds_rules ON sys_payment_kinds (key, requires_refund_of, requires_deposit, cash_sign);

CREATE TABLE sys_payment_purposes (
  key       TEXT    NOT NULL PRIMARY KEY,           -- charge (수납) | prepayment (예약금·선입금) | deposit (보증금)
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

-- Deposits (보증금) are counted in units: a deposit rule (2.4) says how much per unit, when it is taken, how a
-- returned unit's deposit goes back and what happens to a unit that never comes back (data-model 4-12 · 4-18,
-- catalog 11-1). Whether a kind must come back at all is its return policy (sys_return_policies), a separate choice.
CREATE TABLE sys_deposit_timings (                  -- when a rule's deposit is taken
  key       TEXT    NOT NULL PRIMARY KEY,           -- at_intake (접수할 때) | at_issue (지급할 때: 권을 줄 때)
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_deposit_refund_methods (           -- how a returned unit's deposit goes back: the preselected choice of the
                                                    -- return window; staff may pick another one there
  key       TEXT    NOT NULL PRIMARY KEY,           -- cash (현금으로 돌려드림: counter drawer or the van wallet) | offset_due (미수에서
                                                    -- 빼기: deposit_apply, the rest in cash) | same_method (받은 수단으로: card cancel)
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_deposit_unreturned_actions (       -- what happens to the deposit of a unit that does not come back
  key       TEXT    NOT NULL PRIMARY KEY,           -- keep (보증금에서 뺌: the shop keeps it) | charge_loss (분실 값을 청구하고
                                                    -- 보증금으로 먼저 냄: a loss adjustment + deposit_apply)
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_deposit_entry_kinds (              -- rows of a deposit's unit ledger (deposit_entries) and the money kind each
                                                    -- row must point at, so a refund row can only name a deposit_out payment
  key               TEXT    NOT NULL PRIMARY KEY,   -- take | refund | apply | keep | restore
  label             TEXT    NOT NULL,
  unit_sign         INTEGER NOT NULL CHECK (unit_sign IN (-1,1)),   -- effect on the held units: take, restore +1; refund, apply, keep -1
  payment_kind_key  TEXT    NOT NULL REFERENCES sys_payment_kinds(key),
  added_in          INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sys_deposit_entry_kinds_payment ON sys_deposit_entry_kinds (key, payment_kind_key);   -- FK target

CREATE TABLE sys_counterparty_roles (
  key       TEXT    NOT NULL PRIMARY KEY,           -- resort_vendor, partner_shop, lesson_team, lodging_affiliate, billing_company
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_trade_kinds (
  key             TEXT    NOT NULL PRIMARY KEY,
  label           TEXT    NOT NULL,
  direction_sign  INTEGER NOT NULL CHECK (direction_sign IN (-1,1)),   -- +1 they owe us, -1 we owe them
  added_in        INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_entity_types (                     -- owners of typed attribute values
  key       TEXT    NOT NULL PRIMARY KEY,           -- order, order_line, order_person, customer, catalog_item, item_variant,
                                                    -- asset, task, place, counterparty
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_attribute_data_types (
  key           TEXT    NOT NULL PRIMARY KEY,       -- text, int, decimal, bool, date, time, option, measurement, money
  value_column  TEXT    NOT NULL,                   -- value_text | value_int | value_real | option_id (money: value_int, minor units)
  added_in      INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_attribute_placements (             -- form / document slots where an attribute is asked or shown
  key       TEXT    NOT NULL PRIMARY KEY,           -- intake_form, order_form, prep_sheet, team_label, slip, receipt, task_sheet
                                                    -- (tabular views - ledger, driver rows, collection list - use
                                                    --  ledger_view_columns with renderer 'attribute', never a placement)
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_reason_domains (
  key       TEXT    NOT NULL PRIMARY KEY,           -- visit_result, early_return, exchange, handover, asset_condition, found,
                                                    -- cash_entry, refund, cancellation, adjustment, closing_difference, reallocation
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_stamp_rules (                      -- how a stamp cell derives todo | partial | done | na from records
  key          TEXT    NOT NULL PRIMARY KEY,        -- qty_prepared, qty_loaded, qty_issued, qty_collected, qty_returned,
                                                    -- ticket_secured, service_closed, order_due_zero, task_done, task_received
  scope_key    TEXT    NOT NULL,                    -- line | order | task (code-owned)
  description  TEXT    NOT NULL,
  added_in     INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_outbox_channels (
  key         TEXT    NOT NULL PRIMARY KEY,         -- sms, print, card_terminal, webhook, backup_upload
  label       TEXT    NOT NULL,
  auto_retry  INTEGER NOT NULL CHECK (auto_retry IN (0,1)),   -- 0: time-sensitive or money: never resent automatically
  added_in    INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_print_renderers (
  key       TEXT    NOT NULL PRIMARY KEY,           -- receipt_slip, collection_list_a4, prep_sheet_a4, team_label, closing_sheet ...
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_screen_templates (                 -- code-owned screen layouts that ledger_views instantiate
  key       TEXT    NOT NULL PRIMARY KEY,           -- ledger, slip, checklist, collection_list, driver_list, tiles, form, split
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_column_renderers (                 -- code-owned cell renderers of the ledger
  key          TEXT    NOT NULL PRIMARY KEY,        -- time, team, items, promise, place, money, stamp, attribute, text, vehicle, action
  label        TEXT    NOT NULL,
  binding_key  TEXT    NOT NULL DEFAULT 'none',     -- none | stamp_step | attribute | action: which binding column the
                                                    -- column row must fill (checked by the config command and the verifier)
  added_in     INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_ledger_filters (                   -- named server-side filters behind index tabs
  key       TEXT    NOT NULL PRIMARY KEY,           -- all, pickup, return, unpaid, vehicle, lessons, open_tasks, collected
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_ledger_metrics (                   -- named footer figures
  key       TEXT    NOT NULL PRIMARY KEY,           -- team_count, issued_count, returned_count, due_total, collected_count,
                                                    -- remaining_count, pending_count, vehicle_load
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

-- UI vocabularies: every code-owned key a UI configuration row can name is an FK target, so a
-- typo from a manager, a template or an import is refused by the database (ui doc 2).
CREATE TABLE sys_workspaces (
  key       TEXT    NOT NULL PRIMARY KEY,           -- pos, management, driver
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_screens (                          -- every routable screen (menus, deep links, back navigation, desktop wrapper)
  key                TEXT    NOT NULL PRIMARY KEY,  -- day_ledger, order_slip, collection_list, driver_list, new_order, closing ...
  label              TEXT    NOT NULL,
  route_pattern      TEXT    NOT NULL,              -- '/ledger/:date', '/orders/:orderId'
  template_key       TEXT    REFERENCES sys_screen_templates(key),
  params_schema_key  TEXT,                          -- json_schemas key of the route params
  added_in           INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_group_keys (
  key       TEXT    NOT NULL PRIMARY KEY,           -- time_bucket, return_slot, place, area, vehicle
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_sort_keys (                        -- also the fields a now-line can be placed against (is_time = 1)
  key       TEXT    NOT NULL PRIMARY KEY,           -- next_due_at, manual_route, receipt_no, promised_at
  label     TEXT    NOT NULL,
  is_time   INTEGER NOT NULL CHECK (is_time IN (0,1)),
  added_in  INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX sys_sort_keys_time ON sys_sort_keys (key, is_time);

CREATE TABLE sys_fit_modes (                        -- text-fitting engine modes
  key       TEXT    NOT NULL PRIMARY KEY,           -- parts, items, words, alts
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_fold_modes (                       -- how a dropped column is drawn inside its host column
  key       TEXT    NOT NULL PRIMARY KEY,           -- prefix ('09:10 · 김민수 · 0025') | second_line (when the row height allows)
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_align_keys (
  key       TEXT    NOT NULL PRIMARY KEY,           -- start, center, end
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_overflow_modes (                   -- what a config-driven list does when it has more rows than the class holds
  key       TEXT    NOT NULL PRIMARY KEY,           -- more_sheet ('더 보기' sheet, paged) | page | fold | two_column
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_tones (                            -- colour tokens; the rule checker reads late_only and is_seal
  key        TEXT    NOT NULL PRIMARY KEY,          -- red (late only), seal (vermilion stamp ink), orange, green, blue, purple, grey, ink
  label      TEXT    NOT NULL,
  late_only  INTEGER NOT NULL DEFAULT 0 CHECK (late_only IN (0,1)),   -- may only paint something that is late (N8)
  is_seal    INTEGER NOT NULL DEFAULT 0 CHECK (is_seal IN (0,1)),     -- stamp ink: exempt from the red rule, never used for alerts
  added_in   INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_icons (
  key       TEXT    NOT NULL PRIMARY KEY,           -- ski, board, clothing, helmet, ticket, lesson, goggles, protector, boots, generic
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_picker_placements (
  key       TEXT    NOT NULL PRIMARY KEY,           -- tile | grouped (behind one tile, e.g. lift ticket kinds) | hidden
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_conditions (                       -- named conditions evaluated by code
  key        TEXT    NOT NULL PRIMARY KEY,          -- always, vehicle_pickup, vehicle_return, return_required (line);
                                                    -- before_last_return_slot, after_last_return_slot (view)
  scope_key  TEXT    NOT NULL,                      -- line | order | task | view (code-owned)
  label      TEXT    NOT NULL,
  added_in   INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_status_keys (                      -- every code-owned status value, per domain; status_terms can only word these
  domain_key     TEXT    NOT NULL,                  -- order | line | task | pay_state | promise | stamp
  key            TEXT    NOT NULL,
  default_label  TEXT    NOT NULL,                  -- fallback wording (ko-KR) when a shop has no status_terms row: never the raw key
  added_in       INTEGER NOT NULL,
  PRIMARY KEY (domain_key, key)
) STRICT;

CREATE TABLE sys_confirm_templates (                -- confirm windows; the code picks the unit / count / none form by tracking_key
  key       TEXT    NOT NULL PRIMARY KEY,           -- issue, return, load, collect, receive, pay, ticket_secure, lesson_close, prepare
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_actions (                          -- what a stamp, a primary button or a side action does
  key                   TEXT    NOT NULL PRIMARY KEY,   -- stamp.issue, stamp.return, new_order, close_day, receive_to_shop, call, not_collected ...
  label                 TEXT    NOT NULL,
  kind_key              TEXT    NOT NULL,           -- stamp | command | screen | device (code-owned)
  command_key           TEXT    REFERENCES sys_event_types(key),
  confirm_template_key  TEXT    REFERENCES sys_confirm_templates(key),
  undo_command_key      TEXT    REFERENCES sys_event_types(key),
  screen_key            TEXT    REFERENCES sys_screens(key),
  rule_scope_key        TEXT,                       -- line | order | task: the stamp rules this action is compatible with
  added_in              INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_input_widgets (                    -- how an attribute is entered
  key       TEXT    NOT NULL PRIMARY KEY,           -- keypad, option_grid (paged), toggle, slot_buttons, text (OS keyboard), date_picker
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_display_formats (                  -- how an attribute value is shown
  key       TEXT    NOT NULL PRIMARY KEY,           -- plain, number_unit ('265mm'), money, local_time, relative_date, option_label
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_stamp_states (                     -- states a stamp cell can take (ui doc 3-2)
  key       TEXT    NOT NULL PRIMARY KEY,           -- todo, partial, done, na, blocked, scheduled, delegated
  label     TEXT    NOT NULL,
  tone_key  TEXT    NOT NULL REFERENCES sys_tones(key),
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_stamp_rollups (                    -- how a team-level cell sums line-level stamp states
  key          TEXT    NOT NULL PRIMARY KEY,        -- worst_of (ignores na; partial when mixed) | first_open (chain: first not-done step)
  label        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  added_in     INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_row_grains (                       -- what one row of a ledger view is
  key           TEXT    NOT NULL PRIMARY KEY,       -- order, order_line, task, service_booking, asset
  label         TEXT    NOT NULL,
  added_in      INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_row_grain_entities (               -- which attribute owners a grain can show, and how the server joins them
  row_grain_key    TEXT    NOT NULL REFERENCES sys_row_grains(key),
  entity_type_key  TEXT    NOT NULL REFERENCES sys_entity_types(key),
  join_path_key    TEXT    NOT NULL,                -- code id of the join (task -> order -> customer ...)
  added_in         INTEGER NOT NULL,
  PRIMARY KEY (row_grain_key, entity_type_key)
) STRICT;

CREATE TABLE sys_tax_categories (                   -- VAT treatment of what a line sells (현금영수증 · 세금계산서)
  key                TEXT    NOT NULL PRIMARY KEY,  -- taxable, exempt, zero_rated, agency (resold lift tickets: commission only)
  label              TEXT    NOT NULL,
  rate_bp            INTEGER NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
  revenue_basis_key  TEXT    NOT NULL,              -- gross | commission (code-owned)
  added_in           INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_place_uses (                       -- what a place can be used for
  key       TEXT    NOT NULL PRIMARY KEY,           -- pickup, return, lodging, meeting (lessons), parking, locker, bus_stop
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_cash_sources (                     -- which ledger produced a cash_movements row; each kind of money has
                                                    -- exactly ONE cash-bearing ledger (vendor refund money is a settlement)
  key       TEXT    NOT NULL PRIMARY KEY,           -- payment, cash_entry, cash_transfer, cash_transfer_confirmation, counterparty_settlement
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_booking_channels (
  key       TEXT    NOT NULL PRIMARY KEY,           -- walk_in, phone, intake_form, ticket_reservation, driver_field, legacy
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_review_kinds (                     -- what can land on the counter's '확인 필요' list, with its plain sentence
  key               TEXT    NOT NULL PRIMARY KEY,   -- already_returned, collect_exceeds, plan_displaced, late_money, overpaid,
                                                    -- card_unknown, sms_unknown, task_cancelled, ticket_unavailable, ...
  label             TEXT    NOT NULL,
  message_template  TEXT    NOT NULL,               -- '{team} 팀 {item} {qty}개는 매장에서 이미 받았습니다.' (ko-KR default;
                                                    -- other locales in the strings table of the app, keyed by this key)
  severity_key      TEXT    NOT NULL,               -- info | action | blocking (code-owned)
  routing_key       TEXT    NOT NULL DEFAULT 'manager',   -- manager (backlog list) | origin_device (the device/actor that
                                                    -- caused it, in context) | order_banner | dialog_step (blocks the open dialog)
  added_in          INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_event_types (                      -- catalogue of command types (journal rows); drives audit labels
  key               TEXT    NOT NULL PRIMARY KEY,   -- 'order.create', 'payment.take', 'legacy:finance.payment' ...
  category_key      TEXT    NOT NULL,               -- order | money | stock | dispatch | settings | sync | system | import
  class_key         TEXT    NOT NULL,               -- fact | intent | commutative | system (conflict class, sync doc 4)
  audit_label       TEXT    NOT NULL,               -- Korean label for 사용 내역
  is_money          INTEGER NOT NULL DEFAULT 0 CHECK (is_money IN (0,1)),
  offline_allowed   INTEGER NOT NULL DEFAULT 0 CHECK (offline_allowed IN (0,1)),   -- 1 = some device kind may queue it offline
                                                    -- (the union of sys_offline_commands; tests keep the two equal). A later
                                                    -- migration that adds a sys_offline_commands row may raise it 0 -> 1 (lint
                                                    -- allows exactly that UPDATE, like engine_key), never lower it
  current_version   INTEGER NOT NULL DEFAULT 1,
  payload_schema_key TEXT,                          -- json_schemas key; CI checks it has no PII fields
  engine_key        TEXT    NOT NULL DEFAULT 'native',   -- native | legacy (facade) during the transition
  added_in          INTEGER NOT NULL
) STRICT;

CREATE TABLE sys_offline_commands (                 -- which command each device kind may queue while offline (sync doc 8-2):
                                                    -- counters (pos) since the cloud-first decision (ADR-19), drivers as before
  event_type_key   TEXT    NOT NULL REFERENCES sys_event_types(key),
  device_kind_key  TEXT    NOT NULL REFERENCES sys_device_kinds(key),
  limit_key        TEXT    REFERENCES sys_offline_limits(key),   -- extra offline rule the command layer checks on the device
  added_in         INTEGER NOT NULL,
  PRIMARY KEY (event_type_key, device_kind_key)
) STRICT;

CREATE TABLE sys_offline_limits (                   -- the extra rules a device checks before it queues a command offline (sync doc 8-2);
                                                    -- a queued command that breaks one on arrival is still recorded, with a review item
  key       TEXT    NOT NULL PRIMARY KEY,           -- walk_in_cached_quote | own_payer_cached_quote | cached_quote | shop_ticket_stock |
                                                    -- same_line_swap
  label     TEXT    NOT NULL,
  added_in  INTEGER NOT NULL
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.3 Shop, staff, devices, settings, counters, business days
-- Actor columns (*_by, actor_key) hold an actor key, not a foreign key:
--   'staff:<staff_members.id>' | 'system:<worker>' | 'form:<intake_requests.id>' | 'legacy:<role>:<id>'
-- so ledgers survive account deletion and the shop file can live apart from control.
-- -------------------------------------------------------------------------------------
CREATE TABLE shops (
  id                   TEXT    NOT NULL PRIMARY KEY,       -- = control.tenants.id
  code                 TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  phone                TEXT,
  address              TEXT,
  link_url             TEXT,
  logo_ref             TEXT,
  timezone             TEXT    NOT NULL DEFAULT 'Asia/Seoul',  -- IANA zone; every business_date is computed with it
  business_day_cutoff  TEXT    NOT NULL DEFAULT '00:00',       -- local HH:MM; earlier records belong to the previous day.
                                                               -- shop.provision writes the ski-shop default 06:00 (a night
                                                               -- return at 00:40 counts to the evening's ledger); 00:00 is
                                                               -- only the technical fallback (data-model 3-3)
  currency             TEXT    NOT NULL DEFAULT 'KRW',
  currency_exponent    INTEGER NOT NULL DEFAULT 0 CHECK (currency_exponent >= 0),
  locale               TEXT    NOT NULL DEFAULT 'ko-KR',
  status_key           TEXT    NOT NULL DEFAULT 'active',      -- active | suspended | closed
  is_test              INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),   -- demo / practice shop: outbox goes to a sink
  config_rev           INTEGER NOT NULL DEFAULT 0,             -- bumped by any registry or settings change
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  updated_rev          INTEGER NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX shops_code ON shops (code);

CREATE TABLE shop_instance (                      -- epoch of ONE shop (one row per shop, also when many shops share a
                                                  -- PostgreSQL schema); control.tenant_epochs keeps every epoch
  shop_id                  TEXT    NOT NULL PRIMARY KEY REFERENCES shops(id),
  epoch_id                 TEXT    NOT NULL,      -- sent with every API response and in every command basis
  epoch_no                 INTEGER NOT NULL DEFAULT 1 CHECK (epoch_no >= 1),
  restored_at              TEXT,
  restored_from_backup_id  TEXT,                  -- control.backups.id
  restored_up_to_rev       INTEGER,               -- last rev present after restore + segment replay
  rev_floor                INTEGER NOT NULL DEFAULT 0,   -- every new rev is above this: max rev ever issued + 1,000,000
  updated_at               TEXT    NOT NULL
) STRICT;

CREATE TABLE branches (                           -- a location of the same business inside this shop file (docs/04)
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  updated_rev  INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;

CREATE TABLE closing_scopes (                     -- a unit that closes its own day: 'main' for one-counter shops; a branch or
                                                  -- a separately closing counter building gets its own row (feature branches)
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,                  -- 'main' is created by shop.provision; others are ULIDs
  key          TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  branch_id    TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  updated_rev  INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX closing_scopes_key ON closing_scopes (shop_id, key);

CREATE TABLE roles (                              -- manager, counter, driver, lesson_desk ... (data, not an enum)
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  updated_rev  INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX roles_key ON roles (shop_id, key);

CREATE TABLE role_permissions (
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  role_id         TEXT    NOT NULL,
  permission_key  TEXT    NOT NULL REFERENCES sys_permissions(key),
  scope_key       TEXT    NOT NULL DEFAULT 'shop',   -- shop | own_vehicle | own_orders (must be in sys_permissions.scopes_json)
  limits_json     TEXT,                              -- {"max_discount_amount": 10000}
  PRIMARY KEY (shop_id, role_id, permission_key),
  FOREIGN KEY (shop_id, role_id) REFERENCES roles(shop_id, id)
) STRICT;

CREATE TABLE staff_members (                      -- membership: an account working in this shop, with a role
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  account_id          TEXT,                       -- control.accounts.id (no cross-file FK); NULL for legacy actors
  display_name        TEXT    NOT NULL,           -- name printed on slips and shown in history
  role_id             TEXT    NOT NULL,
  phone               TEXT,
  default_vehicle_id  TEXT,
  branch_id           TEXT,
  legacy_actor_key    TEXT,                       -- 'store:counter-1' from the old access file
  status_key          TEXT    NOT NULL DEFAULT 'active',   -- active | suspended | ended | legacy
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  updated_rev         INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, role_id) REFERENCES roles(shop_id, id),
  FOREIGN KEY (shop_id, default_vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX staff_members_account ON staff_members (shop_id, account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX staff_members_legacy ON staff_members (shop_id, legacy_actor_key) WHERE legacy_actor_key IS NOT NULL;

CREATE TABLE staff_permission_overrides (         -- per-person grant or deny on top of the role
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  staff_member_id  TEXT    NOT NULL,
  permission_key   TEXT    NOT NULL REFERENCES sys_permissions(key),
  effect_key       TEXT    NOT NULL,              -- grant | deny
  scope_key        TEXT    NOT NULL DEFAULT 'shop',
  limits_json      TEXT,
  created_at       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  PRIMARY KEY (shop_id, staff_member_id, permission_key),
  FOREIGN KEY (shop_id, staff_member_id) REFERENCES staff_members(shop_id, id)
) STRICT;

CREATE TABLE devices (                            -- registered POS PCs, driver tablets, phones, print and card agents
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,        -- ULID made on first run, kept in the device's IndexedDB
  kind_key               TEXT    NOT NULL REFERENCES sys_device_kinds(key),
  label                  TEXT    NOT NULL,        -- '카운터 1', '1호차 태블릿'
  vehicle_id             TEXT,                    -- driver devices: the van it rides in
  branch_id              TEXT,
  closing_scope_id       TEXT,                    -- counter devices: the scope their non-cash money posts to (NULL = 'main')
  short_no               INTEGER CHECK (short_no IS NULL OR short_no >= 1),   -- 기기 번호 given by the server at enrolment from
                                                  -- shop_counters('device_short_no'), never reused (revoked devices keep theirs; a
                                                  -- restore skips the counter by 10, sync doc 10-2): the lead of an offline
                                                  -- counter's provisional receipt number ('임시 1-12', orders.provisional_receipt_no)
  public_key             TEXT,                    -- non-extractable WebCrypto key; signs queued commands (actor assertion)
  counts_toward_licence  INTEGER NOT NULL DEFAULT 1 CHECK (counts_toward_licence IN (0,1)),
  enrolled_by_supplier   INTEGER NOT NULL DEFAULT 0 CHECK (enrolled_by_supplier IN (0,1)),   -- joined with a code the supplier
                                                  -- made (after the owner approved it); the device list shows '공급자 기기'
  app_version            TEXT,
  command_contract       INTEGER,                 -- highest command version the device speaks
  last_device_seq        INTEGER NOT NULL DEFAULT 0 CHECK (last_device_seq >= 0),   -- high-water mark, not a strict order
  last_seen_at           TEXT,
  offline_capable        INTEGER NOT NULL DEFAULT 0 CHECK (offline_capable IN (0,1)),  -- 1 only after navigator.storage.persist();
                                                  -- counters and driver devices alike keep a working copy and a send queue
  status_key             TEXT    NOT NULL DEFAULT 'active',   -- active | revoked
  registered_at          TEXT    NOT NULL,
  registered_by          TEXT    NOT NULL,
  revoked_at             TEXT,                    -- stops new sessions; the next contact wipes the working copy. Judged by what the
                                                  -- SERVER saw, not by the time the device claims: commands of this device that
                                                  -- arrived before revoked_at are normal; those arriving after it are held
                                                  -- (command_log 'held', not applied to any projection) until a manager presses
                                                  -- 넣기 on revoked_device_record (sync doc 7)
  revoke_reason          TEXT,
  updated_rev            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX devices_short_no ON devices (shop_id, short_no) WHERE short_no IS NOT NULL;

CREATE TABLE device_sign_ins (                    -- who was signed in on which device when (append-only): the server checks the
                                                  -- actor a queued command names against this, not against the flushing session
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  device_id        TEXT    NOT NULL,
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  staff_member_id  TEXT    NOT NULL,
  method_key       TEXT    NOT NULL,              -- password | pin (code-owned; old access-file tokens are not imported)
  signed_in_at     TEXT    NOT NULL,
  session_id       TEXT,                          -- control.sessions.id
  created_rev      INTEGER NOT NULL,
  PRIMARY KEY (shop_id, device_id, seq),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  FOREIGN KEY (shop_id, staff_member_id) REFERENCES staff_members(shop_id, id)
) STRICT;
CREATE INDEX device_sign_ins_at ON device_sign_ins (shop_id, device_id, signed_in_at);

CREATE TABLE device_enrollment_codes (            -- one-time code a manager shows to register a new device
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  code_hash    TEXT    NOT NULL,                  -- sha256 of the code (12 characters without look-alikes, or a QR); routed by
                                                  -- control enrollment_routes, which is globally unique
  kind_key     TEXT    NOT NULL REFERENCES sys_device_kinds(key),
  vehicle_id   TEXT,
  label        TEXT    NOT NULL,
  origin_key   TEXT    NOT NULL DEFAULT 'shop',   -- shop | supplier (made in the admin console: the owner has to approve)
  expires_at   TEXT    NOT NULL,
  claimed_at   TEXT,                              -- a new device entered the code; it joins only after approval (two steps)
  claimed_agent TEXT,                             -- what the claiming device said it is ('Windows · Chrome'), shown when approving
  approved_at  TEXT,
  approved_by  TEXT,                              -- actor key of the person who approved it on the screen that made the code
  used_at      TEXT,
  device_id    TEXT,
  created_at   TEXT    NOT NULL,
  created_by   TEXT    NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX device_enrollment_codes_hash ON device_enrollment_codes (shop_id, code_hash);

CREATE TABLE shop_features (                      -- 사용 기능: off = gone from menus, tabs, pickers and confirm rows; data kept
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  feature_key    TEXT    NOT NULL REFERENCES sys_features(key),
  scope_key      TEXT    NOT NULL DEFAULT '',     -- '' = whole shop; 'branch:<id>' | 'closing_scope:<id>' overrides it there
  enabled        INTEGER NOT NULL CHECK (enabled IN (0,1)),
  config_json    TEXT,                            -- validated against sys_features.config_schema_key
  config_schema  INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT    NOT NULL,
  updated_by     TEXT    NOT NULL,
  updated_rev    INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, feature_key, scope_key)
) STRICT;

CREATE TABLE shop_settings (                      -- versioned policies; rows are never updated (trigger 2.19)
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  setting_key     TEXT    NOT NULL REFERENCES sys_setting_definitions(key),
  scope_key       TEXT    NOT NULL DEFAULT '',    -- '' = whole shop; 'branch:<id>' | 'closing_scope:<id>' override
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  value_json      TEXT    NOT NULL,
  value_schema    INTEGER NOT NULL DEFAULT 1,
  effective_from  TEXT    NOT NULL,               -- instant; the current value is the highest version already effective
  created_at      TEXT    NOT NULL,
  created_by      TEXT    NOT NULL,
  request_id      TEXT,
  created_rev     INTEGER NOT NULL,
  PRIMARY KEY (shop_id, setting_key, scope_key, version_no)
) STRICT;

CREATE TABLE shop_counters (                      -- rev (sync cursor), receipt numbers per day, group codes ...
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  counter_key  TEXT    NOT NULL,                  -- rev | receipt | intake_group | payment_group | print_no | device_short_no
  scope_key    TEXT    NOT NULL DEFAULT '',       -- '' or a business date / season key
  value        INTEGER NOT NULL,
  PRIMARY KEY (shop_id, counter_key, scope_key)
) STRICT;

CREATE TABLE business_days (                      -- one row per closing scope and business date; the closing lock
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  closing_scope_id   TEXT    NOT NULL DEFAULT 'main',
  business_date      TEXT    NOT NULL,
  active_closing_id  TEXT,                        -- NULL = open; set by closing.close, cleared by closing.reopen
  last_version_no    INTEGER NOT NULL DEFAULT 0 CHECK (last_version_no >= 0),
  opening_note       TEXT,
  updated_at         TEXT    NOT NULL,
  updated_rev        INTEGER NOT NULL DEFAULT 0,
  version            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, closing_scope_id, business_date),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  -- the active closing must be a closing of this very scope and date
  FOREIGN KEY (shop_id, active_closing_id, closing_scope_id, business_date) REFERENCES closings(shop_id, id, closing_scope_id, business_date)
) STRICT;
CREATE INDEX business_days_open ON business_days (shop_id, closing_scope_id, business_date) WHERE active_closing_id IS NULL;
CREATE INDEX business_days_closed ON business_days (shop_id, closing_scope_id, business_date) WHERE active_closing_id IS NOT NULL;

CREATE TABLE config_changes (                     -- row-level history of every registry and settings edit
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  config_rev   INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  entity_type  TEXT    NOT NULL,                  -- table name: 'places', 'return_slots', 'item_kinds' ...
  entity_id    TEXT    NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  actor_key    TEXT    NOT NULL,
  request_id   TEXT,
  at           TEXT    NOT NULL,
  PRIMARY KEY (shop_id, config_rev, seq)
) STRICT;
CREATE INDEX config_changes_entity ON config_changes (shop_id, entity_type, entity_id);

CREATE TABLE template_applications (              -- a resort template applied: only missing rows added, never prices
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  template_id       TEXT    NOT NULL,             -- control.resort_templates.id
  template_version  INTEGER NOT NULL,
  added_json        TEXT    NOT NULL,             -- {"areas":[ids],"places":[ids],"return_slots":[ids],"catalog_items":[ids]}
  skipped_json      TEXT    NOT NULL,             -- already present (matched by template_ref)
  applied_at        TEXT    NOT NULL,
  applied_by        TEXT    NOT NULL,
  request_id        TEXT,
  PRIMARY KEY (shop_id, id)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.4 Registries: money, catalog, attributes, places, fleet, counterparties
-- Registry rows are edited in place (row version + config_changes history), deactivated
-- with active = 0 or archived_at, never deleted.
-- -------------------------------------------------------------------------------------
CREATE TABLE payment_methods (
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  id                   TEXT    NOT NULL,
  key                  TEXT    NOT NULL,          -- cash, card, transfer, internal, easy_pay, voucher, on_account ...
  label                TEXT    NOT NULL,
  affects_cash_drawer  INTEGER NOT NULL CHECK (affects_cash_drawer IN (0,1)),
  requires_terminal    INTEGER NOT NULL DEFAULT 0 CHECK (requires_terminal IN (0,1)),
  requires_reference   INTEGER NOT NULL DEFAULT 0 CHECK (requires_reference IN (0,1)),
  refundable           INTEGER NOT NULL DEFAULT 1 CHECK (refundable IN (0,1)),
  driver_allowed       INTEGER NOT NULL DEFAULT 0 CHECK (driver_allowed IN (0,1)),   -- offered for field collection
  quick                INTEGER NOT NULL DEFAULT 1 CHECK (quick IN (0,1)),   -- shown as a button in the method row; the rest
                                                  -- sit behind '다른 수단' (the class decides how many quick buttons fit)
  short_label          TEXT,                      -- for fixed-width buttons
  sort                 INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_system            INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  updated_rev          INTEGER NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX payment_methods_key ON payment_methods (shop_id, key);
-- FK target: payments copy affects_cash_drawer, so the flag cannot be edited while money rows use the method
CREATE UNIQUE INDEX payment_methods_cash ON payment_methods (shop_id, id, affects_cash_drawer);

CREATE TABLE payment_sections (                   -- rows of the confirm window: gear, lift, lesson, ...
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  key                 TEXT    NOT NULL,
  label               TEXT    NOT NULL,           -- '장비', '리프트권', '강습'
  default_method_id   TEXT,                       -- gear: card, lift: cash (docs/44)
  default_timing_key  TEXT    REFERENCES sys_payment_timings(key),
  feature_key         TEXT    REFERENCES sys_features(key),   -- the row disappears when the feature is off
  priority            INTEGER NOT NULL DEFAULT 0,             -- capacity model: lower priority pages out first
  overflow_key        TEXT    NOT NULL DEFAULT 'page' REFERENCES sys_overflow_modes(key),   -- confirm window pages sections
  sort                INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_system           INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  updated_rev         INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, default_method_id) REFERENCES payment_methods(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX payment_sections_key ON payment_sections (shop_id, key);

CREATE TABLE discount_groups (                    -- stacking groups: one discount per group (docs/44)
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  id                   TEXT    NOT NULL,
  key                  TEXT    NOT NULL,          -- gear | lift | lesson
  label                TEXT    NOT NULL,
  stacking_policy_key  TEXT    NOT NULL DEFAULT 'exclusive',   -- exclusive (one rule incl. manual) | additive (code-owned)
  sort                 INTEGER NOT NULL DEFAULT 0,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  updated_rev          INTEGER NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX discount_groups_key ON discount_groups (shop_id, key);

CREATE TABLE discount_group_kinds (               -- which discount kinds a group offers (gear: per_unit_day/percent/amount)
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  discount_group_id  TEXT    NOT NULL,
  discount_kind_key  TEXT    NOT NULL REFERENCES sys_discount_kinds(key),
  sort               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, discount_group_id, discount_kind_key),
  FOREIGN KEY (shop_id, discount_group_id) REFERENCES discount_groups(shop_id, id)
) STRICT;

CREATE TABLE item_kinds (                         -- behaviour of a family of products; replaces the 4-value enum
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  id                       TEXT    NOT NULL,
  key                      TEXT    NOT NULL,      -- equipment, clothing, helmet, lift_ticket, lesson, goggles, protector ...
  label                    TEXT    NOT NULL,
  fulfillment_mode_key     TEXT    NOT NULL REFERENCES sys_fulfillment_modes(key),
  tracking_key             TEXT    NOT NULL REFERENCES sys_tracking_modes(key),     -- unit | count | none
  return_policy_key        TEXT    NOT NULL REFERENCES sys_return_policies(key),    -- required | optional | none
  default_price_basis_key  TEXT    NOT NULL REFERENCES sys_price_bases(key),
  payment_section_id       TEXT    NOT NULL,      -- confirm-window row
  discount_group_id        TEXT    NOT NULL,      -- stacking group
  sized                    INTEGER NOT NULL DEFAULT 0 CHECK (sized IN (0,1)),         -- has size fields / variant axes
  exchangeable             INTEGER NOT NULL DEFAULT 0 CHECK (exchangeable IN (0,1)),
  extendable               INTEGER NOT NULL DEFAULT 1 CHECK (extendable IN (0,1)),
  preparable               INTEGER NOT NULL DEFAULT 1 CHECK (preparable IN (0,1)),    -- 규격·준비 step
  delivery_allowed         INTEGER NOT NULL DEFAULT 1 CHECK (delivery_allowed IN (0,1)),
  ends_same_day            INTEGER NOT NULL DEFAULT 0 CHECK (ends_same_day IN (0,1)),  -- use start = end (lift tickets)
  ticketed                 INTEGER NOT NULL DEFAULT 0 CHECK (ticketed IN (0,1)),       -- validity window, vendor, allocation
  requires_time_slot       INTEGER NOT NULL DEFAULT 0 CHECK (requires_time_slot IN (0,1)),   -- lessons
  requires_headcount       INTEGER NOT NULL DEFAULT 0 CHECK (requires_headcount IN (0,1)),
  partial_cancel_allowed   INTEGER NOT NULL DEFAULT 1 CHECK (partial_cancel_allowed IN (0,1)),
  settlement_role_key      TEXT    REFERENCES sys_counterparty_roles(key),   -- lesson_team: whom the line is settled with
  tax_category_key         TEXT    REFERENCES sys_tax_categories(key),       -- NULL = tax not recorded (lines snapshot it)
  feature_key              TEXT    REFERENCES sys_features(key),             -- kind disappears when the feature is off
  picker_placement_key     TEXT    NOT NULL DEFAULT 'tile' REFERENCES sys_picker_placements(key),   -- tile | grouped | hidden
  unit_label               TEXT    NOT NULL,      -- 대 / 벌 / 개 / 매 / 명
  stock_metric_label       TEXT,                  -- van load summary label '스키'
  tone_key                 TEXT    REFERENCES sys_tones(key),
  icon_key                 TEXT    REFERENCES sys_icons(key),
  sort                     INTEGER NOT NULL DEFAULT 0,
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_system                INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  template_ref             TEXT,
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL,
  updated_rev              INTEGER NOT NULL DEFAULT 0,
  version                  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, payment_section_id) REFERENCES payment_sections(shop_id, id),
  FOREIGN KEY (shop_id, discount_group_id) REFERENCES discount_groups(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX item_kinds_key ON item_kinds (shop_id, key);

CREATE TABLE price_groups (                       -- a named set of SKUs priced together ('프리미엄 보드', '어린이 장비')
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  updated_rev  INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX price_groups_key ON price_groups (shop_id, key);

CREATE TABLE catalog_items (                      -- the sellable product (SKU) in the picker
  shop_id                     TEXT    NOT NULL REFERENCES shops(id),
  id                          TEXT    NOT NULL,   -- ULID; legacy ids kept with the shop prefix ('shop1.ski', 'shop1.ticket-4h')
  item_kind_id                TEXT    NOT NULL,
  price_group_id              TEXT,               -- price rules may target the group instead of each SKU
  tax_category_key            TEXT    REFERENCES sys_tax_categories(key),   -- NULL = kind value
  code                        TEXT,
  label                       TEXT    NOT NULL,
  short_label                 TEXT,
  unit_label                  TEXT,               -- NULL = kind unit
  tracking_key                TEXT    REFERENCES sys_tracking_modes(key),      -- NULL = kind default
  return_policy_key           TEXT    REFERENCES sys_return_policies(key),     -- NULL = kind default
  price_basis_key             TEXT    REFERENCES sys_price_bases(key),         -- NULL = kind default
  exchangeable                INTEGER CHECK (exchangeable IN (0,1)),           -- NULL = kind default
  is_bundle                   INTEGER NOT NULL DEFAULT 0 CHECK (is_bundle IN (0,1)),
  hidden_in_picker            INTEGER NOT NULL DEFAULT 0 CHECK (hidden_in_picker IN (0,1)),   -- components sold only in sets
  requires_type_confirmation  INTEGER NOT NULL DEFAULT 0 CHECK (requires_type_confirmation IN (0,1)),  -- migrated 'legacy-' SKUs
  favorite                    INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  photo_ref                   TEXT,
  sort                        INTEGER NOT NULL DEFAULT 0,
  active                      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  archived_at                 TEXT,
  template_ref                TEXT,
  created_at                  TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL,
  updated_rev                 INTEGER NOT NULL DEFAULT 0,
  version                     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, price_group_id) REFERENCES price_groups(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX catalog_items_code ON catalog_items (shop_id, code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX catalog_items_template ON catalog_items (shop_id, template_ref) WHERE template_ref IS NOT NULL;
CREATE INDEX catalog_items_kind ON catalog_items (shop_id, item_kind_id, active, sort);

CREATE TABLE ticket_products (                    -- lift-ticket details of a catalog item (1:1)
  shop_id                 TEXT    NOT NULL REFERENCES shops(id),
  catalog_item_id         TEXT    NOT NULL,
  vendor_counterparty_id  TEXT,                   -- resort ticket office
  resort_name             TEXT,
  hours                   INTEGER CHECK (hours IS NULL OR hours > 0),
  audience_class_id       TEXT,                   -- adult / child
  window_start            TEXT,                   -- local HH:MM, NULL = whole business day
  window_end              TEXT,
  validity_days           INTEGER NOT NULL DEFAULT 1 CHECK (validity_days >= 1),
  base_cost_amount        INTEGER CHECK (base_cost_amount IS NULL OR base_cost_amount >= 0),  -- NULL = '미산정'
  template_ref            TEXT,
  PRIMARY KEY (shop_id, catalog_item_id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, vendor_counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, audience_class_id) REFERENCES customer_classes(shop_id, id)
) STRICT;

CREATE TABLE catalog_item_components (            -- sets: 스키 세트 = 스키 + 부츠 + 폴; family package = 4 sets
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  bundle_item_id     TEXT    NOT NULL,
  component_item_id  TEXT    NOT NULL,
  quantity           INTEGER NOT NULL CHECK (quantity >= 1),
  component_mode_key TEXT    NOT NULL DEFAULT 'tracked',   -- tracked (own zero-price line, own custody) | implied
  exchangeable       INTEGER NOT NULL DEFAULT 1 CHECK (exchangeable IN (0,1)),
  price_share_bp     INTEGER CHECK (price_share_bp IS NULL OR (price_share_bp >= 0 AND price_share_bp <= 10000)),  -- reports only
  sort               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, bundle_item_id, component_item_id),
  FOREIGN KEY (shop_id, bundle_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, component_item_id) REFERENCES catalog_items(shop_id, id),
  CHECK (bundle_item_id <> component_item_id)
) STRICT;

CREATE TABLE deposit_rules (                      -- 보증금 규칙: a per-unit deposit that every SKU of a kind, or one SKU, takes
                                                  -- ('리프트권 보증금 · 1매 5,000원'). No row = no deposit: the shop chooses, and
                                                  -- another shop or resort may have none. Held deposits snapshot the rule (deposits)
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  key                    TEXT    NOT NULL,        -- lift_ticket_card
  label                  TEXT    NOT NULL,        -- '리프트권 보증금' (confirm-window row, slip money line, closing)
  item_kind_id           TEXT,                    -- target: every SKU of a kind ...
  catalog_item_id        TEXT,                    -- ... or one SKU. Exactly one target; a SKU rule wins over its kind's rule
  unit_amount            INTEGER NOT NULL CHECK (unit_amount > 0),   -- per unit in minor units (this shop: 5,000 per 매)
  timing_key             TEXT    NOT NULL REFERENCES sys_deposit_timings(key),   -- at_intake | at_issue
  payment_section_id     TEXT,                    -- confirm-window row that asks for it ('리프트권 보증금'); NULL = the kind's row
  refund_default_key     TEXT    NOT NULL REFERENCES sys_deposit_refund_methods(key),   -- preselected in the return window
  unreturned_key         TEXT    NOT NULL REFERENCES sys_deposit_unreturned_actions(key),   -- keep | charge_loss
  unreturned_after_days  INTEGER CHECK (unreturned_after_days IS NULL OR unreturned_after_days >= 0),
                                                  -- NULL: only a person applies it (deposit.keep); N: the closing N business days
                                                  -- after the day the unit was due back applies it (0 = that day's closing)
  loss_amount            INTEGER CHECK (loss_amount IS NULL OR loss_amount > 0),   -- charge_loss: lost-unit charge per unit
  effective_from         TEXT    NOT NULL,        -- local date; a new amount next season is a new row, not an edit
  effective_to           TEXT,
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort                   INTEGER NOT NULL DEFAULT 0,
  template_ref           TEXT,
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  updated_rev            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, payment_section_id) REFERENCES payment_sections(shop_id, id),
  CHECK ((item_kind_id IS NOT NULL) + (catalog_item_id IS NOT NULL) = 1),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
) STRICT;
CREATE UNIQUE INDEX deposit_rules_key ON deposit_rules (shop_id, key);
CREATE INDEX deposit_rules_kind ON deposit_rules (shop_id, item_kind_id, effective_from) WHERE item_kind_id IS NOT NULL;
CREATE INDEX deposit_rules_item ON deposit_rules (shop_id, catalog_item_id, effective_from) WHERE catalog_item_id IS NOT NULL;

CREATE TABLE item_variants (                      -- sizes and grades counted separately (boots 250 mm, helmet M, ski 140 cm)
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  catalog_item_id  TEXT    NOT NULL,
  code             TEXT,
  label            TEXT    NOT NULL,
  sort             INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX item_variants_item_id ON item_variants (shop_id, catalog_item_id, id);   -- FK target: variant of THIS item
CREATE INDEX item_variants_item ON item_variants (shop_id, catalog_item_id, sort);

CREATE TABLE attribute_definitions (              -- shop-defined fields: sizes, measurements, room number, level ...
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  entity_type_key  TEXT    NOT NULL REFERENCES sys_entity_types(key),
  key              TEXT    NOT NULL,              -- height_cm, foot_mm, clothing_size, boot_mm, room_no, discipline ...
  label            TEXT    NOT NULL,
  short_label      TEXT,                          -- for narrow slots (labels, driver rows); the fit check uses it
  data_type_key    TEXT    NOT NULL REFERENCES sys_attribute_data_types(key),
  multi_valued     INTEGER NOT NULL DEFAULT 0 CHECK (multi_valued IN (0,1)),   -- 1: several value rows (value_seq 1..n)
  input_widget_key    TEXT REFERENCES sys_input_widgets(key),     -- NULL = default for the data type
  display_format_key  TEXT REFERENCES sys_display_formats(key),   -- NULL = default for the data type
  unit_label       TEXT,
  min_value        REAL,
  max_value        REAL,
  step_value       REAL,                          -- boot_mm 220..300 step 5 -> option grid of 17, paged
  max_length       INTEGER CHECK (max_length IS NULL OR max_length > 0),
  is_pii           INTEGER NOT NULL DEFAULT 0 CHECK (is_pii IN (0,1)),   -- blanked by anonymisation
  searchable       INTEGER NOT NULL DEFAULT 0 CHECK (searchable IN (0,1)),   -- value indexes are used for search
  sort             INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_system        INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  promoted_to      TEXT,                          -- 'orders.lodging_room_no' once promoted to a column (E10)
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX attribute_definitions_key ON attribute_definitions (shop_id, entity_type_key, key);
CREATE UNIQUE INDEX attribute_definitions_entity ON attribute_definitions (shop_id, id, entity_type_key);   -- FK target

CREATE TABLE attribute_options (
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  id            TEXT    NOT NULL,
  attribute_id  TEXT    NOT NULL,
  key           TEXT    NOT NULL,                 -- ski | board ; S | M | L ; beginner | intermediate
  label         TEXT    NOT NULL,
  sort          INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, attribute_id) REFERENCES attribute_definitions(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX attribute_options_key ON attribute_options (shop_id, attribute_id, key);
CREATE UNIQUE INDEX attribute_options_attr ON attribute_options (shop_id, attribute_id, id);   -- FK target: option of THIS attribute

CREATE TABLE attribute_placements (               -- where an attribute is asked or shown on forms, slips and prints
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  attribute_id      TEXT    NOT NULL,
  placement_key     TEXT    NOT NULL REFERENCES sys_attribute_placements(key),
  device_class_key  TEXT    REFERENCES sys_device_classes(key),   -- NULL = every class; a class row overrides it
  seq               INTEGER NOT NULL DEFAULT 0,
  priority          INTEGER NOT NULL DEFAULT 0,   -- capacity model: lowest priority folds or pages first
  overflow_key      TEXT    NOT NULL DEFAULT 'more_sheet' REFERENCES sys_overflow_modes(key),
  fit_mode_key      TEXT    NOT NULL DEFAULT 'alts' REFERENCES sys_fit_modes(key),
  required          INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  label_override    TEXT,
  origin_key        TEXT    NOT NULL DEFAULT 'shop',   -- system | template | shop (ui doc 2: shipped defaults vs shop edits)
  default_rev       INTEGER,                      -- ui-defaults revision that wrote this row (system rows)
  customized_at     TEXT,                         -- set when the shop edits a system row; the defaults step leaves it alone
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, attribute_id) REFERENCES attribute_definitions(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX attribute_placements_slot ON attribute_placements (shop_id, attribute_id, placement_key, coalesce(device_class_key, ''));

CREATE TABLE item_kind_attributes (               -- which attributes a kind uses and how
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  item_kind_id  TEXT    NOT NULL,
  attribute_id  TEXT    NOT NULL,
  usage_key     TEXT    NOT NULL,                 -- variant_axis | line | person | asset (code-owned)
  required      INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  sort          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, item_kind_id, attribute_id, usage_key),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id) REFERENCES attribute_definitions(shop_id, id)
) STRICT;

CREATE TABLE customer_classes (                   -- adult, child, senior (price and ticket audience)
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  updated_rev  INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX customer_classes_key ON customer_classes (shop_id, key);

CREATE TABLE resorts (                            -- 스키장: a shop serving two resorts groups and filters areas by resort
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  id            TEXT    NOT NULL,
  name          TEXT    NOT NULL,                 -- '무주덕유산리조트'
  template_ref  TEXT,                             -- control.resort_templates.key it came from
  sort          INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  updated_rev   INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX resorts_template ON resorts (shop_id, template_ref) WHERE template_ref IS NOT NULL;

CREATE TABLE areas (                              -- 구역: 만선, 설천, 솔마을, 꽃마을
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  id            TEXT    NOT NULL,
  resort_id     TEXT,                             -- NULL = not tied to a resort (shop's own area)
  name          TEXT    NOT NULL,
  short_name    TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  template_ref  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  updated_rev   INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, resort_id) REFERENCES resorts(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX areas_template ON areas (shop_id, template_ref) WHERE template_ref IS NOT NULL;

CREATE TABLE places (                             -- 장소: 티롤 앞, 설천 주차장, 한솔동, 들국화 (uses: place_uses)
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  id            TEXT    NOT NULL,
  area_id       TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  short_name    TEXT,
  note          TEXT,
  latitude      REAL,
  longitude     REAL,
  guide_ref     TEXT,                             -- public guide photo or map
  sort          INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  template_ref  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  updated_rev   INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, area_id) REFERENCES areas(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX places_area_name ON places (shop_id, area_id, name);
CREATE UNIQUE INDEX places_template ON places (shop_id, template_ref) WHERE template_ref IS NOT NULL;
CREATE INDEX places_area ON places (shop_id, area_id, active, sort);

CREATE TABLE place_uses (                         -- a new use (parking, locker, bus stop) is a sys_place_uses row, not a column
  shop_id    TEXT    NOT NULL REFERENCES shops(id),
  place_id   TEXT    NOT NULL,
  use_key    TEXT    NOT NULL REFERENCES sys_place_uses(key),
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, place_id, use_key),
  FOREIGN KEY (shop_id, place_id) REFERENCES places(shop_id, id)
) STRICT;
CREATE INDEX place_uses_use ON place_uses (shop_id, use_key);

CREATE TABLE return_slots (                       -- 반납 타임
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  id              TEXT    NOT NULL,
  label           TEXT    NOT NULL,               -- '오전타임 후', '오후타임 후', '야간타임 후', '익일 오전'
  local_time      TEXT    NOT NULL,
  day_offset      INTEGER NOT NULL DEFAULT 0 CHECK (day_offset >= 0),   -- days after the last use day; no upper limit
  is_night        INTEGER NOT NULL DEFAULT 0 CHECK (is_night IN (0,1)),  -- night collection reminder in the now line
  effective_from  TEXT,
  effective_to    TEXT,
  sort            INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  template_ref    TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  updated_rev     INTEGER NOT NULL DEFAULT 0,
  version         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;

CREATE TABLE pickup_time_options (                -- replaces the hardcoded 09:00 / 12:00 / 17:00 buttons
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  local_time   TEXT    NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  updated_rev  INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;

CREATE TABLE service_slots (                      -- lesson time slots: 오전 10:00-12:00, 오후 13:30-15:30, 야간 22:30-00:30
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  id              TEXT    NOT NULL,
  item_kind_id    TEXT,
  label           TEXT    NOT NULL,
  start_time      TEXT    NOT NULL,
  end_time        TEXT    NOT NULL,
  end_day_offset  INTEGER NOT NULL DEFAULT 0 CHECK (end_day_offset >= 0),   -- 1: ends after midnight
  sort            INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  updated_rev     INTEGER NOT NULL DEFAULT 0,
  version         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  CHECK (end_day_offset > 0 OR end_time > start_time)
) STRICT;

CREATE TABLE vehicles (
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,                -- ULID; legacy 'van-1' imported as 'shop1.van-1'
  code           TEXT,
  name           TEXT    NOT NULL,                -- '1호 차량'
  plate          TEXT,
  capacity_note  TEXT,
  branch_id      TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  retired_at     TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  updated_rev    INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id)
) STRICT;

CREATE TABLE vehicle_assignments (                -- which driver drives which van, by business-date range
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  vehicle_id       TEXT    NOT NULL,
  staff_member_id  TEXT    NOT NULL,
  valid_from       TEXT    NOT NULL,
  valid_to         TEXT,                          -- NULL = open
  created_at       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  ended_at         TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, staff_member_id) REFERENCES staff_members(shop_id, id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
) STRICT;
CREATE INDEX vehicle_assignments_staff ON vehicle_assignments (shop_id, staff_member_id, valid_from);

CREATE TABLE cash_drawers (                       -- counter drawers, one wallet per vehicle, and two bookkeeping drawers
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  kind_key          TEXT    NOT NULL,             -- counter | vehicle | transit (handed over, not yet counted) |
                                                  -- over_short (counted differences with a reason) (code-owned)
  label             TEXT    NOT NULL,
  vehicle_id        TEXT,
  branch_id         TEXT,
  closing_scope_id  TEXT    NOT NULL DEFAULT 'main',   -- the closing that counts this drawer
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  updated_rev       INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX cash_drawers_vehicle ON cash_drawers (shop_id, vehicle_id) WHERE vehicle_id IS NOT NULL;
-- FK target: money rows that name a drawer carry the drawer's closing scope, checked by the database
CREATE UNIQUE INDEX cash_drawers_scope ON cash_drawers (shop_id, id, closing_scope_id);

CREATE TABLE card_terminals (
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  vendor_key   TEXT    NOT NULL,                  -- adapter key (VAN / PG provider)
  device_id    TEXT,                              -- device the terminal is attached to
  terminal_no  TEXT,
  config_json  TEXT,                              -- vendor extras; secrets live outside the database
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;

CREATE TABLE printers (                           -- print targets: browser print, label printer agent, receipt printer agent
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  label        TEXT    NOT NULL,                  -- '카운터 A4', '라벨 80x50'
  kind_key     TEXT    NOT NULL,                  -- browser | label_agent | receipt_agent (code-owned)
  device_id    TEXT,                              -- PC hosting the agent
  paper_key    TEXT    NOT NULL,                  -- a4_portrait | label_80x50 | receipt_80mm
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;

CREATE TABLE counterparties (                     -- resort ticket offices, partner shops, lesson teams (강습팀), lodgings, billing
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  phone          TEXT,
  contact_name   TEXT,
  address        TEXT,
  business_no    TEXT,
  is_internal    INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0,1)),   -- '우리 강사'
  note           TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  template_ref   TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  updated_rev    INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;

CREATE TABLE counterparty_roles (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  counterparty_id  TEXT    NOT NULL,
  role_key         TEXT    NOT NULL REFERENCES sys_counterparty_roles(key),
  PRIMARY KEY (shop_id, counterparty_id, role_key),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id)
) STRICT;

CREATE TABLE counterparty_rates (                 -- supply prices, lesson consignment fees, borrow and lend rates
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  counterparty_id  TEXT    NOT NULL,
  trade_kind_key   TEXT    NOT NULL REFERENCES sys_trade_kinds(key),
  catalog_item_id  TEXT,
  amount           INTEGER CHECK (amount IS NULL OR amount >= 0),
  percent_bp       INTEGER CHECK (percent_bp IS NULL OR (percent_bp >= 0 AND percent_bp <= 10000)),
  per_key          TEXT    NOT NULL DEFAULT 'unit',   -- unit | person | day | session (code-owned)
  effective_from   TEXT    NOT NULL,
  effective_to     TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.5 Pricing: versioned price lists, calendars, rules, tiers, discount rules
-- A published price-list version and its rules never change (triggers in 2.19). Orders
-- keep the version and rule they were priced with, so history never moves.
-- -------------------------------------------------------------------------------------
CREATE TABLE price_lists (                        -- standard, regular (단골), partner:<id>, cost (supply prices)
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  key                TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  purpose_key        TEXT    NOT NULL DEFAULT 'sale',   -- sale | cost (code-owned)
  counterparty_id    TEXT,                      -- partner rate list
  customer_class_id  TEXT,                      -- list only for one class (optional)
  priority           INTEGER NOT NULL DEFAULT 0,
  is_default         INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  updated_rev        INTEGER NOT NULL DEFAULT 0,
  version            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, customer_class_id) REFERENCES customer_classes(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX price_lists_key ON price_lists (shop_id, key);
CREATE UNIQUE INDEX price_lists_one_default ON price_lists (shop_id, purpose_key) WHERE is_default = 1;

CREATE TABLE price_list_versions (
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  id              TEXT    NOT NULL,
  price_list_id   TEXT    NOT NULL,
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  status_key      TEXT    NOT NULL DEFAULT 'draft',   -- draft | published | retired
  effective_from  TEXT    NOT NULL,             -- business date
  effective_to    TEXT,
  rounding_unit   INTEGER NOT NULL DEFAULT 10 CHECK (rounding_unit >= 1),
  note            TEXT,
  published_at    TEXT,
  published_by    TEXT,
  created_at      TEXT    NOT NULL,
  created_by      TEXT    NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, price_list_id) REFERENCES price_lists(shop_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
) STRICT;
CREATE UNIQUE INDEX price_list_versions_no ON price_list_versions (shop_id, price_list_id, version_no);

CREATE TABLE seasons (                            -- operating seasons and priced periods (also the archive unit)
  shop_id     TEXT    NOT NULL REFERENCES shops(id),
  id          TEXT    NOT NULL,
  key         TEXT    NOT NULL,                   -- 2026-27, peak_xmas, early
  label       TEXT    NOT NULL,
  kind_key    TEXT    NOT NULL DEFAULT 'operating',   -- operating | pricing (code-owned)
  start_date  TEXT    NOT NULL,
  end_date    TEXT    NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, id),
  CHECK (end_date >= start_date)
) STRICT;
CREATE UNIQUE INDEX seasons_key ON seasons (shop_id, key);

CREATE TABLE day_types (
  shop_id  TEXT    NOT NULL REFERENCES shops(id),
  id       TEXT    NOT NULL,
  key      TEXT    NOT NULL,                      -- weekday, weekend, holiday, peak
  label    TEXT    NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX day_types_key ON day_types (shop_id, key);

CREATE TABLE calendars (                          -- 'main' (made by shop.provision); a branch or resort with other peak days gets its own
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  branch_id    TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX calendars_key ON calendars (shop_id, key);

CREATE TABLE calendar_days (                      -- explicit day classification; missing dates use the weekday_day_types setting
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  calendar_id  TEXT    NOT NULL DEFAULT 'main',
  date         TEXT    NOT NULL,
  day_type_id  TEXT    NOT NULL,
  season_id    TEXT,
  note         TEXT,
  PRIMARY KEY (shop_id, calendar_id, date),
  FOREIGN KEY (shop_id, calendar_id) REFERENCES calendars(shop_id, id),
  FOREIGN KEY (shop_id, day_type_id) REFERENCES day_types(shop_id, id),
  FOREIGN KEY (shop_id, season_id) REFERENCES seasons(shop_id, id)
) STRICT;

CREATE TABLE price_rules (                        -- one priced condition; NULL condition = any
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  price_list_version_id  TEXT    NOT NULL,
  -- target: exactly one of SKU, kind ('all kids skis'), price group ('premium boards'); a SKU rule beats a group
  -- rule, a group rule beats a kind rule, then priority
  catalog_item_id        TEXT,
  item_kind_id           TEXT,
  price_group_id         TEXT,
  variant_id             TEXT,                    -- only with a SKU target
  customer_class_id      TEXT,                    -- child / adult
  day_type_id            TEXT,                    -- weekday / weekend / peak
  season_id              TEXT,
  time_band_key          TEXT,                    -- after_12 (오전타임 후 = half day) (code-owned)
  price_basis_key        TEXT    NOT NULL REFERENCES sys_price_bases(key),
  unit_amount            INTEGER CHECK (unit_amount IS NULL OR unit_amount >= 0),   -- NULL = '요금 미등록' (never 0)
  min_days               INTEGER CHECK (min_days IS NULL OR min_days >= 1),
  max_days               INTEGER,
  min_quantity           INTEGER CHECK (min_quantity IS NULL OR min_quantity >= 1),
  priority               INTEGER NOT NULL DEFAULT 0,
  note                   TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, price_list_version_id) REFERENCES price_list_versions(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, price_group_id) REFERENCES price_groups(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id, variant_id) REFERENCES item_variants(shop_id, catalog_item_id, id),
  FOREIGN KEY (shop_id, customer_class_id) REFERENCES customer_classes(shop_id, id),
  FOREIGN KEY (shop_id, day_type_id) REFERENCES day_types(shop_id, id),
  FOREIGN KEY (shop_id, season_id) REFERENCES seasons(shop_id, id),
  CHECK ((catalog_item_id IS NOT NULL) + (item_kind_id IS NOT NULL) + (price_group_id IS NOT NULL) = 1),
  CHECK (variant_id IS NULL OR catalog_item_id IS NOT NULL),
  CHECK (max_days IS NULL OR min_days IS NULL OR max_days >= min_days)
) STRICT;
CREATE INDEX price_rules_lookup ON price_rules (shop_id, price_list_version_id, catalog_item_id);
CREATE INDEX price_rules_kind ON price_rules (shop_id, price_list_version_id, item_kind_id) WHERE item_kind_id IS NOT NULL;
CREATE INDEX price_rules_group ON price_rules (shop_id, price_list_version_id, price_group_id) WHERE price_group_id IS NOT NULL;

CREATE TABLE price_rule_tiers (                   -- multi-day totals: 2 days = 38,000, 3 days = 54,000
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  price_rule_id  TEXT    NOT NULL,
  days           INTEGER NOT NULL CHECK (days >= 1),
  total_amount   INTEGER NOT NULL CHECK (total_amount >= 0),
  PRIMARY KEY (shop_id, price_rule_id, days),
  FOREIGN KEY (shop_id, price_rule_id) REFERENCES price_rules(shop_id, id)
) STRICT;

CREATE TABLE discount_rules (                     -- quick discount presets and packages (docs/44)
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  id                       TEXT    NOT NULL,
  label                    TEXT    NOT NULL,      -- '단골 5,000원', '장비 10%', '리프트권 25%', '가족 4세트', '스키+리프트권 10%'
  discount_kind_key        TEXT    NOT NULL REFERENCES sys_discount_kinds(key),
  discount_group_id        TEXT    NOT NULL,      -- the group it competes in (gear / lift / lesson, or a 'package' group
                                                  -- whose rules span kinds of several groups: discount_rule_targets)
  item_kind_id             TEXT,                  -- single target shortcut; several targets: discount_rule_targets
  catalog_item_id          TEXT,                  -- per_unit_day target
  amount                   INTEGER CHECK (amount IS NULL OR amount >= 0),
  percent_bp               INTEGER CHECK (percent_bp IS NULL OR (percent_bp >= 0 AND percent_bp <= 10000)),
  rounding_unit            INTEGER NOT NULL DEFAULT 10 CHECK (rounding_unit >= 1),
  min_quantity             INTEGER CHECK (min_quantity IS NULL OR min_quantity >= 1),   -- package condition
  customer_class_id        TEXT,
  day_type_id              TEXT,
  required_permission_key  TEXT    REFERENCES sys_permissions(key),
  effective_from           TEXT,
  effective_to             TEXT,
  sort                     INTEGER NOT NULL DEFAULT 0,
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL,
  updated_rev              INTEGER NOT NULL DEFAULT 0,
  version                  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, discount_group_id) REFERENCES discount_groups(shop_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, customer_class_id) REFERENCES customer_classes(shop_id, id),
  FOREIGN KEY (shop_id, day_type_id) REFERENCES day_types(shop_id, id)
) STRICT;

CREATE TABLE discount_rule_targets (              -- what a rule applies to when it names more than one thing (packages)
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  discount_rule_id  TEXT    NOT NULL,
  seq               INTEGER NOT NULL CHECK (seq >= 1),
  item_kind_id      TEXT,
  catalog_item_id   TEXT,
  price_group_id    TEXT,
  min_quantity      INTEGER CHECK (min_quantity IS NULL OR min_quantity >= 1),   -- '스키 세트 1 + 리프트권 1'
  PRIMARY KEY (shop_id, discount_rule_id, seq),
  FOREIGN KEY (shop_id, discount_rule_id) REFERENCES discount_rules(shop_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, price_group_id) REFERENCES price_groups(shop_id, id),
  CHECK ((item_kind_id IS NOT NULL) + (catalog_item_id IS NOT NULL) + (price_group_id IS NOT NULL) = 1)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.6 Other registries, versioned templates, UI configuration as data
-- -------------------------------------------------------------------------------------
CREATE TABLE adjustment_types (
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  key               TEXT    NOT NULL,           -- extension, cancellation, cancellation_fee, late_fee, damage, loss,
                                                -- price_correction, discount_change, rounding, legacy_charge
  label             TEXT    NOT NULL,
  report_group_key  TEXT    NOT NULL,           -- charge | discount | fee | correction
  sign              INTEGER NOT NULL CHECK (sign IN (-1,0,1)),   -- cancellation -1, extension/fee/damage/loss +1,
                                                -- price_correction/discount_change/rounding 0 (either way); copied onto rows
  is_system         INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  sort              INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX adjustment_types_key ON adjustment_types (shop_id, key);
CREATE UNIQUE INDEX adjustment_types_sign ON adjustment_types (shop_id, id, sign);   -- FK target (the sign cannot drift)

CREATE TABLE reason_codes (
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  domain_key     TEXT    NOT NULL REFERENCES sys_reason_domains(key),
  key            TEXT    NOT NULL,              -- absent, place_changed, not_received, injury, schedule, size, damage ...
  label          TEXT    NOT NULL,
  requires_memo  INTEGER NOT NULL DEFAULT 0 CHECK (requires_memo IN (0,1)),
  is_system      INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  sort           INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX reason_codes_key ON reason_codes (shop_id, domain_key, key);

CREATE TABLE asset_conditions (                   -- per-shop maintenance states with behaviour flags
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  key                TEXT    NOT NULL,            -- ready, cleaning, inspection, repair, damaged, lost, retired
  label              TEXT    NOT NULL,
  issuable           INTEGER NOT NULL CHECK (issuable IN (0,1)),
  needs_attention    INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0,1)),
  is_lost            INTEGER NOT NULL DEFAULT 0 CHECK (is_lost IN (0,1)),
  is_retired         INTEGER NOT NULL DEFAULT 0 CHECK (is_retired IN (0,1)),
  settable_manually  INTEGER NOT NULL DEFAULT 1 CHECK (settable_manually IN (0,1)),
  is_system          INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  sort               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX asset_conditions_key ON asset_conditions (shop_id, key);

CREATE TABLE customer_tags (                      -- 단골 / 제휴 / 단체
  shop_id  TEXT    NOT NULL REFERENCES shops(id),
  id       TEXT    NOT NULL,
  key      TEXT    NOT NULL,
  label    TEXT    NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX customer_tags_key ON customer_tags (shop_id, key);

CREATE TABLE print_templates (                    -- the template identity; layouts live in versions
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  key                 TEXT    NOT NULL,           -- receipt_slip, collection_list_a4, prep_sheet_a4, team_label_80x50
  renderer_key        TEXT    NOT NULL REFERENCES sys_print_renderers(key),
  label               TEXT    NOT NULL,
  paper_key           TEXT    NOT NULL,           -- a4_portrait | label_80x50 | receipt_80mm
  source_view_id      TEXT,                       -- the ledger view (print class) whose columns and placements it prints,
                                                  -- so a new column or field reaches the paper without editing JSON
  current_version_no  INTEGER,                    -- version used for new jobs
  default_printer_id  TEXT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  updated_rev         INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, default_printer_id) REFERENCES printers(shop_id, id),
  FOREIGN KEY (shop_id, source_view_id) REFERENCES ledger_views(shop_id, id),
  FOREIGN KEY (shop_id, id, current_version_no) REFERENCES print_template_versions(shop_id, template_id, version_no)
) STRICT;
CREATE UNIQUE INDEX print_templates_key ON print_templates (shop_id, key);

CREATE TABLE print_template_versions (            -- immutable layouts; a reprint uses the frozen job document
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  template_id    TEXT    NOT NULL,
  version_no     INTEGER NOT NULL CHECK (version_no >= 1),
  layout_schema  INTEGER NOT NULL,                -- json_schemas('print_layout', n)
  layout_json    TEXT    NOT NULL,                -- paper parameters (size, margins, font) + the RESOLVED snapshot of the
                                                  -- source view's columns and placements at the time the version was made
  created_at     TEXT    NOT NULL,
  created_by     TEXT    NOT NULL,
  PRIMARY KEY (shop_id, template_id, version_no),
  FOREIGN KEY (shop_id, template_id) REFERENCES print_templates(shop_id, id)
) STRICT;

CREATE TABLE message_templates (                  -- SMS templates; time-sensitive ones get outbox.not_after
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  key                    TEXT    NOT NULL,        -- size_form_link, departure_notice, return_reminder
  channel_key            TEXT    NOT NULL REFERENCES sys_outbox_channels(key),
  label                  TEXT    NOT NULL,
  time_sensitive         INTEGER NOT NULL DEFAULT 0 CHECK (time_sensitive IN (0,1)),
  expires_after_minutes  INTEGER CHECK (expires_after_minutes IS NULL OR expires_after_minutes > 0),
  current_version_no     INTEGER,
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at             TEXT    NOT NULL,
  updated_at             TEXT    NOT NULL,
  updated_rev            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, id, current_version_no) REFERENCES message_template_versions(shop_id, template_id, version_no)
) STRICT;
CREATE UNIQUE INDEX message_templates_key ON message_templates (shop_id, key);

CREATE TABLE message_template_versions (
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  template_id     TEXT    NOT NULL,
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  body            TEXT    NOT NULL,
  variables_json  TEXT    NOT NULL DEFAULT '[]',
  created_at      TEXT    NOT NULL,
  created_by      TEXT    NOT NULL,
  PRIMARY KEY (shop_id, template_id, version_no),
  FOREIGN KEY (shop_id, template_id) REFERENCES message_templates(shop_id, id)
) STRICT;

-- UI configuration rows (stamp steps, ledger views, menus, status words) carry origin_key /
-- default_rev / customized_at: rows shipped in packages/contract/ui-defaults.json are 'system'
-- rows, and the forward-only ui_defaults.apply(rev) step of the migration runner inserts the
-- missing ones (feature-gated rows too), updates system rows the shop has not customised, and
-- lists the rest on 확인 필요 (ui doc 2). Every code-owned key they name is an FK to a sys_* row.
CREATE TABLE stamp_steps (                        -- one step a line / order / task goes through: 지급, 반납, 수납, 적재, 발권, 강습
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  id                       TEXT    NOT NULL,
  key                      TEXT    NOT NULL,      -- issue, return, pay, load, ticket_secure, collect, receive, lesson_done
  label                    TEXT    NOT NULL,      -- column header
  short_label              TEXT,                  -- for narrow columns and collapsed stamp groups
  stamp_text               TEXT    NOT NULL,      -- text inside the stamp (seal ink, never alert red)
  checklist_label          TEXT    NOT NULL,      -- B2 remaining-steps wording: '장비 지급', '장비 값 받기'
  rule_key                 TEXT    NOT NULL REFERENCES sys_stamp_rules(key),
  action_key               TEXT    NOT NULL REFERENCES sys_actions(key),   -- command + confirm window + undo, as one code-owned bundle
  required_permission_key  TEXT    REFERENCES sys_permissions(key),
  urgency_out              INTEGER NOT NULL DEFAULT 0,   -- sort rank on the outbound side (ASCII keys, not labels)
  urgency_back             INTEGER NOT NULL DEFAULT 0,
  tone_key                 TEXT    REFERENCES sys_tones(key),
  shows_time               INTEGER NOT NULL DEFAULT 0 CHECK (shows_time IN (0,1)),   -- '받음 21:42' (the column min width follows)
  feature_key              TEXT    REFERENCES sys_features(key),
  sort                     INTEGER NOT NULL DEFAULT 0,
  active                   INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_system                INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  origin_key               TEXT    NOT NULL DEFAULT 'shop',   -- system | template | shop
  default_rev              INTEGER,
  customized_at            TEXT,
  updated_at               TEXT    NOT NULL,
  updated_rev              INTEGER NOT NULL DEFAULT 0,
  version                  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX stamp_steps_key ON stamp_steps (shop_id, key);

CREATE TABLE item_kind_stamp_steps (              -- rental: issue, return (+ load with a delivery promise); ticket: ticket_secure, issue
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  item_kind_id   TEXT    NOT NULL,
  stamp_step_id  TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  condition_key  TEXT    NOT NULL DEFAULT 'always' REFERENCES sys_conditions(key),   -- always | vehicle_pickup | vehicle_return ...
  origin_key     TEXT    NOT NULL DEFAULT 'shop',
  default_rev    INTEGER,
  customized_at  TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, stamp_step_id) REFERENCES stamp_steps(shop_id, id)
) STRICT;
-- a step may appear twice for a kind under different conditions (적재 for a delivery and for an exchange run)
CREATE UNIQUE INDEX item_kind_stamp_steps_key ON item_kind_stamp_steps (shop_id, item_kind_id, stamp_step_id, condition_key);

CREATE TABLE ledger_views (                       -- a screen instance: day ledger, slip, collection list, driver list
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  key                 TEXT    NOT NULL,           -- day_ledger, order_slip, collection_list, driver_list, unreturned_list
  label               TEXT    NOT NULL,           -- one heading per page
  screen_key          TEXT    REFERENCES sys_screens(key),   -- route it answers (NULL = print-only view)
  template_key        TEXT    NOT NULL REFERENCES sys_screen_templates(key),
  device_class_key    TEXT    NOT NULL REFERENCES sys_device_classes(key),
  base_view_id        TEXT,                       -- class variant: inherits the base view's columns, tabs and metrics and
                                                  -- overrides only what it lists (fallback pos_narrow -> pos, driver_phone -> driver_tablet)
  row_grain_key       TEXT    NOT NULL DEFAULT 'order' REFERENCES sys_row_grains(key),   -- what one row is
  group_by_key        TEXT    REFERENCES sys_group_keys(key),      -- time_bucket | return_slot | place | vehicle
  subgroup_by_key     TEXT    REFERENCES sys_group_keys(key),      -- second level shown as a label, not a heading
  sort_key            TEXT    REFERENCES sys_sort_keys(key),       -- next_due_at | manual_route | receipt_no
  now_line_field      TEXT,                       -- which time the '지금' line is placed against (a time sort key)
  now_line_is_time    INTEGER NOT NULL DEFAULT 1 CHECK (now_line_is_time = 1),
  reorderable         INTEGER NOT NULL DEFAULT 0 CHECK (reorderable IN (0,1)),   -- A3 ▲▼ (inside one group only)
  pin_urgent          INTEGER NOT NULL DEFAULT 0 CHECK (pin_urgent IN (0,1)),    -- 빨리 확인 rows first
  feature_key         TEXT    REFERENCES sys_features(key),
  feature_on          INTEGER NOT NULL DEFAULT 1 CHECK (feature_on IN (0,1)),   -- 0: shown only while the feature is OFF
  sort                INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  origin_key          TEXT    NOT NULL DEFAULT 'shop',
  default_rev         INTEGER,
  customized_at       TEXT,
  updated_at          TEXT    NOT NULL,
  updated_rev         INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, base_view_id) REFERENCES ledger_views(shop_id, id),
  FOREIGN KEY (now_line_field, now_line_is_time) REFERENCES sys_sort_keys(key, is_time),
  CHECK (base_view_id IS NULL OR base_view_id <> id)
) STRICT;
CREATE UNIQUE INDEX ledger_views_key ON ledger_views (shop_id, key, device_class_key);

CREATE TABLE ledger_view_columns (                -- widths are in em of the class's base font (DeviceProfile), not px
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  ledger_view_id         TEXT    NOT NULL,
  column_key             TEXT    NOT NULL,        -- time, team, items, promise, money, stamp:issue, attr:room_no, action:call
  seq                    INTEGER NOT NULL,
  header_label           TEXT    NOT NULL,
  short_header_label     TEXT,
  renderer_key           TEXT    NOT NULL REFERENCES sys_column_renderers(key),
  stamp_step_id          TEXT,                    -- binding 'stamp_step' (a chain of steps: ledger_view_column_steps)
  stamp_rollup_key       TEXT    REFERENCES sys_stamp_rollups(key),   -- team-level cell over line-level stamps
  attribute_id           TEXT,                    -- binding 'attribute' (entity checked against the view's row grain)
  action_key             TEXT    REFERENCES sys_actions(key),        -- binding 'action' (call, 못 받음)
  min_width_em           REAL    NOT NULL CHECK (min_width_em >= 2.5),
  preferred_width_em     REAL    NOT NULL CHECK (preferred_width_em >= 2.5),
  weight                 INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),   -- share of leftover width
  drop_priority          INTEGER NOT NULL DEFAULT 0,   -- higher drops (or folds) first when width runs out; 0 = never
  fold_into_column_key   TEXT,                    -- instead of disappearing, render inside this column (time -> team)
  fold_mode_key          TEXT    NOT NULL DEFAULT 'prefix' REFERENCES sys_fold_modes(key),   -- prefix | second_line
  fold_min_share_em      REAL    NOT NULL DEFAULT 0 CHECK (fold_min_share_em >= 0),   -- min width the host absorbs when folded
  collapse_group_key     TEXT,                    -- stamp columns with the same key collapse into ONE cell (next open step)
                                                  -- when width runs out; the full set stays on the slip
  fit_mode_key           TEXT    NOT NULL DEFAULT 'parts' REFERENCES sys_fit_modes(key),   -- parts | items | words | alts
  align_key              TEXT    NOT NULL DEFAULT 'start' REFERENCES sys_align_keys(key),
  feature_key            TEXT    REFERENCES sys_features(key),
  feature_on             INTEGER NOT NULL DEFAULT 1 CHECK (feature_on IN (0,1)),   -- 0: shown only while the feature is OFF
  origin_key             TEXT    NOT NULL DEFAULT 'shop',
  default_rev            INTEGER,
  customized_at          TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, ledger_view_id) REFERENCES ledger_views(shop_id, id),
  FOREIGN KEY (shop_id, stamp_step_id) REFERENCES stamp_steps(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id) REFERENCES attribute_definitions(shop_id, id),
  FOREIGN KEY (shop_id, ledger_view_id, fold_into_column_key) REFERENCES ledger_view_columns(shop_id, ledger_view_id, column_key),
  CHECK (preferred_width_em >= min_width_em),
  CHECK (fold_into_column_key IS NULL OR fold_into_column_key <> column_key),
  CHECK ((stamp_step_id IS NOT NULL) + (attribute_id IS NOT NULL) + (action_key IS NOT NULL) <= 1)
) STRICT;
CREATE UNIQUE INDEX ledger_view_columns_key ON ledger_view_columns (shop_id, ledger_view_id, column_key);   -- FK target (fold)

CREATE TABLE ledger_view_column_steps (           -- a stamp column bound to an ordered chain: 지급 cell shows 적재 first, then 지급
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  column_id       TEXT    NOT NULL,
  seq             INTEGER NOT NULL CHECK (seq >= 1),
  stamp_step_id   TEXT    NOT NULL,
  PRIMARY KEY (shop_id, column_id, seq),
  FOREIGN KEY (shop_id, column_id) REFERENCES ledger_view_columns(shop_id, id),
  FOREIGN KEY (shop_id, stamp_step_id) REFERENCES stamp_steps(shop_id, id)
) STRICT;

CREATE TABLE ledger_view_tabs (                   -- index tabs: 전체 / 수령 / 반납 / 미수 / 차량 / 강습
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  ledger_view_id     TEXT    NOT NULL,
  tab_key            TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  short_label        TEXT,
  filter_key         TEXT    NOT NULL REFERENCES sys_ledger_filters(key),
  params_json        TEXT,                        -- parameters of the filter (json_schemas 'filter:<key>')
  seq                INTEGER NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,  -- capacity model: lowest priority goes to '더 보기' first
  overflow_key       TEXT    NOT NULL DEFAULT 'more_sheet' REFERENCES sys_overflow_modes(key),
  shows_count        INTEGER NOT NULL DEFAULT 1 CHECK (shows_count IN (0,1)),
  feature_key        TEXT    REFERENCES sys_features(key),
  feature_on         INTEGER NOT NULL DEFAULT 1 CHECK (feature_on IN (0,1)),
  origin_key         TEXT    NOT NULL DEFAULT 'shop',
  default_rev        INTEGER,
  customized_at      TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, ledger_view_id) REFERENCES ledger_views(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX ledger_view_tabs_key ON ledger_view_tabs (shop_id, ledger_view_id, tab_key);

CREATE TABLE ledger_view_metrics (                -- footer figures: '합계 · 18팀 · 지급 14 · 반납 9 · 미수 485,000원'
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  ledger_view_id     TEXT    NOT NULL,
  metric_key         TEXT    NOT NULL REFERENCES sys_ledger_metrics(key),
  params_json        TEXT,                        -- {"vehicle_id": ...} for one van's load on the counter's list
  seq                INTEGER NOT NULL,
  label              TEXT    NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,
  overflow_key       TEXT    NOT NULL DEFAULT 'fold' REFERENCES sys_overflow_modes(key),
  fit_mode_key       TEXT    NOT NULL DEFAULT 'items' REFERENCES sys_fit_modes(key),
  feature_key        TEXT    REFERENCES sys_features(key),
  feature_on         INTEGER NOT NULL DEFAULT 1 CHECK (feature_on IN (0,1)),
  origin_key         TEXT    NOT NULL DEFAULT 'shop',
  default_rev        INTEGER,
  customized_at      TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, ledger_view_id) REFERENCES ledger_views(shop_id, id)
) STRICT;
CREATE INDEX ledger_view_metrics_view ON ledger_view_metrics (shop_id, ledger_view_id, seq);

CREATE TABLE ledger_view_primary_actions (        -- the one orange button, first matching condition wins (N7)
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  ledger_view_id  TEXT    NOT NULL,
  seq             INTEGER NOT NULL CHECK (seq >= 1),
  action_key      TEXT    NOT NULL REFERENCES sys_actions(key),        -- new_order, close_day, receive_to_shop ...
  condition_key   TEXT    NOT NULL DEFAULT 'always' REFERENCES sys_conditions(key),   -- after_last_return_slot ...
  origin_key      TEXT    NOT NULL DEFAULT 'shop',
  default_rev     INTEGER,
  customized_at   TEXT,
  PRIMARY KEY (shop_id, ledger_view_id, seq),
  FOREIGN KEY (shop_id, ledger_view_id) REFERENCES ledger_views(shop_id, id)
) STRICT;

CREATE TABLE ledger_view_actions (                -- side actions of a slip or row (교환, 연장, 취소, 조기 반납, 인쇄, 전화 ...)
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  ledger_view_id     TEXT    NOT NULL,
  action_key         TEXT    NOT NULL REFERENCES sys_actions(key),
  condition_key      TEXT    NOT NULL DEFAULT 'always' REFERENCES sys_conditions(key),   -- capability, e.g. line exchangeable
  seq                INTEGER NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,
  overflow_key       TEXT    NOT NULL DEFAULT 'more_sheet' REFERENCES sys_overflow_modes(key),
  required_permission_key TEXT REFERENCES sys_permissions(key),
  feature_key        TEXT    REFERENCES sys_features(key),
  feature_on         INTEGER NOT NULL DEFAULT 1 CHECK (feature_on IN (0,1)),
  origin_key         TEXT    NOT NULL DEFAULT 'shop',
  default_rev        INTEGER,
  customized_at      TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, ledger_view_id) REFERENCES ledger_views(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX ledger_view_actions_key ON ledger_view_actions (shop_id, ledger_view_id, action_key, condition_key);

CREATE TABLE menu_entries (                       -- header menu / index; filtered by feature, permission and device class
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  workspace_key      TEXT    NOT NULL REFERENCES sys_workspaces(key),   -- pos | management | driver
  key                TEXT    NOT NULL,
  label              TEXT    NOT NULL,            -- '리프트권' (lessons off) and '리프트권·강습' (lessons on) are two rows
  short_label        TEXT,
  screen_key         TEXT    NOT NULL REFERENCES sys_screens(key),
  seq                INTEGER NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 0,  -- capacity model: lowest priority goes to '더 보기' first
  overflow_key       TEXT    NOT NULL DEFAULT 'more_sheet' REFERENCES sys_overflow_modes(key),
  feature_key        TEXT    REFERENCES sys_features(key),
  feature_on         INTEGER NOT NULL DEFAULT 1 CHECK (feature_on IN (0,1)),   -- 0: shown only while the feature is OFF
  permission_key     TEXT    REFERENCES sys_permissions(key),
  device_class_key   TEXT    REFERENCES sys_device_classes(key),   -- NULL = every class
  pinned_end         INTEGER NOT NULL DEFAULT 0 CHECK (pinned_end IN (0,1)),   -- '관리' stays last
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  origin_key         TEXT    NOT NULL DEFAULT 'shop',
  default_rev        INTEGER,
  customized_at      TEXT,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX menu_entries_key ON menu_entries (shop_id, workspace_key, key, coalesce(device_class_key, ''));

CREATE TABLE status_terms (                       -- display words for code-owned status keys; UI compares keys only
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  domain_key     TEXT    NOT NULL,                -- order | line | task | pay_state | promise | stamp
  key            TEXT    NOT NULL,                -- in_use, awaiting_load, partial_return ...
  locale         TEXT    NOT NULL DEFAULT 'ko-KR',
  label          TEXT    NOT NULL,                -- '이용 중', '차량 적재 대기'
  tone_key       TEXT    NOT NULL REFERENCES sys_tones(key),   -- red is late_only: the checker refuses it on a status that is not late
  rank           INTEGER NOT NULL DEFAULT 0,
  origin_key     TEXT    NOT NULL DEFAULT 'shop',
  default_rev    INTEGER,
  customized_at  TEXT,
  PRIMARY KEY (shop_id, domain_key, key, locale),
  FOREIGN KEY (domain_key, key) REFERENCES sys_status_keys(domain_key, key)
) STRICT;

CREATE TABLE label_translations (                 -- other-locale words for shop registry rows (English staff screen, receipts)
  shop_id     TEXT    NOT NULL REFERENCES shops(id),
  table_name  TEXT    NOT NULL,                   -- item_kinds | catalog_items | places | stamp_steps | menu_entries ...
  row_id      TEXT    NOT NULL,
  field_key   TEXT    NOT NULL,                   -- label | short_label | stamp_text | checklist_label
  locale      TEXT    NOT NULL,                   -- 'en-US'
  text        TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, table_name, row_id, field_key, locale)
) STRICT;

CREATE TABLE ui_default_applications (            -- which ui-defaults revision was applied, what was added / kept / listed
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  default_rev   INTEGER NOT NULL,
  applied_at    TEXT    NOT NULL,
  added_json    TEXT    NOT NULL,                 -- {"ledger_view_columns":[ids], ...}
  updated_json  TEXT    NOT NULL,                 -- system rows the shop had not customised
  kept_json     TEXT    NOT NULL,                 -- customised rows left alone (also listed on 확인 필요)
  request_id    TEXT    NOT NULL,
  PRIMARY KEY (shop_id, default_rev)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.7 Customers and the order aggregate
-- A child row that belongs to an order carries order_id and references its parent with
-- (shop_id, order_id, x_id), so the database guarantees it belongs to THE SAME order.
-- -------------------------------------------------------------------------------------
CREATE TABLE customers (                          -- per shop; never merged automatically, never shared between shops
  shop_id                    TEXT    NOT NULL REFERENCES shops(id),
  id                         TEXT    NOT NULL,
  name                       TEXT    NOT NULL,    -- PII
  phone_display              TEXT,                -- PII
  phone_normalized           TEXT,                -- digits only; search key, never an automatic merge key
  phone_last4                TEXT GENERATED ALWAYS AS (substr(phone_normalized, -4)) VIRTUAL,   -- [SQLite VIRTUAL]
  customer_class_id          TEXT,
  affiliate_counterparty_id  TEXT,                -- lodging / partner that gives them a price (not the payer)
  note                       TEXT,
  anonymized_at              TEXT,                -- PIPA retention: PII blanked, row kept
  created_at                 TEXT    NOT NULL,
  created_by                 TEXT    NOT NULL,
  updated_at                 TEXT    NOT NULL,
  updated_rev                INTEGER NOT NULL DEFAULT 0,
  version                    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, customer_class_id) REFERENCES customer_classes(shop_id, id),
  FOREIGN KEY (shop_id, affiliate_counterparty_id) REFERENCES counterparties(shop_id, id)
) STRICT;
CREATE INDEX customers_phone ON customers (shop_id, phone_normalized);
CREATE INDEX customers_last4 ON customers (shop_id, phone_last4);
CREATE INDEX customers_name ON customers (shop_id, name);

CREATE TABLE customer_tag_assignments (
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  customer_id  TEXT    NOT NULL,
  tag_id       TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  created_by   TEXT    NOT NULL,
  PRIMARY KEY (shop_id, customer_id, tag_id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id),
  FOREIGN KEY (shop_id, tag_id) REFERENCES customer_tags(shop_id, id)
) STRICT;

CREATE TABLE orders (                             -- 통합접수: one team, recorded under its representative
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  receipt_no            TEXT,                     -- 'YYMMDD-NNN' from shop_counters, given by the server when the create is applied
                                                  -- (a queued offline create gets it on arrival); NULL only on the device meanwhile
  provisional_receipt_no TEXT,                    -- '<devices.short_no>-<n>' an offline counter printed ('임시 1-12'); the device counts
                                                  -- n up and never resets it, so no two devices or days collide. Kept after the
                                                  -- final receipt_no so the paper slip still finds the team (sync doc 8-3)
  customer_id           TEXT,
  customer_name         TEXT    NOT NULL,         -- snapshot of the representative (PII, redactable)
  customer_phone        TEXT,                     -- snapshot (PII); optional for walk-ins by setting
  customer_phone_last4  TEXT GENERATED ALWAYS AS (substr(replace(replace(customer_phone, '-', ''), ' ', ''), -4)) VIRTUAL,  -- [SQLite VIRTUAL]
  booking_channel_key   TEXT    NOT NULL REFERENCES sys_booking_channels(key),
  headcount_expected    INTEGER CHECK (headcount_expected IS NULL OR headcount_expected >= 1),
  price_list_id         TEXT,                     -- list chosen for this team (standard / regular / partner)
  branch_id             TEXT,
  business_date         TEXT    NOT NULL,         -- intake business day
  config_rev            INTEGER NOT NULL,         -- shops.config_rev at creation
  note                  TEXT,                     -- free text (PII risk): redactable, kept out of the hashed journal
  -- a migrated total-only charge lives in ONE place: a charge_adjustments row of type legacy_charge
  -- projections, written in the same transaction as the records and verified (never the truth)
  status_key            TEXT    NOT NULL DEFAULT 'booked',   -- legacy precedence + awaiting_load, completed (data-model 6)
  is_open               INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0,1)),
  first_service_date    TEXT,
  last_service_date     TEXT,
  next_due_at           TEXT,                     -- earliest open promise: the ledger's time key and now-line sort key
  charged_amount        INTEGER NOT NULL DEFAULT 0,
  net_paid_amount       INTEGER NOT NULL DEFAULT 0,
  due_amount            INTEGER NOT NULL DEFAULT 0,
  credit_amount         INTEGER NOT NULL DEFAULT 0,     -- overpaid / refund pending, never netted against another order
  deposit_held_amount   INTEGER NOT NULL DEFAULT 0,
  promised_by_other_amount INTEGER NOT NULL DEFAULT 0,  -- due covered by another team's payment promise
  collect_for_others_amount INTEGER NOT NULL DEFAULT 0, -- open promises where THIS team is the payer, less what reached them;
                                                  -- the payer is not 'paid' until this is 0 (M15)
  pay_state_key         TEXT    NOT NULL DEFAULT 'unpaid',   -- paid | partial | unpaid | promised (by another team) | none
  anonymized_at         TEXT,
  created_at            TEXT    NOT NULL,
  created_by            TEXT    NOT NULL,
  device_id             TEXT,
  request_id            TEXT,
  created_rev           INTEGER NOT NULL,
  updated_at            TEXT    NOT NULL,
  updated_rev           INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id),
  FOREIGN KEY (shop_id, price_list_id) REFERENCES price_lists(shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (charged_amount >= 0),
  CHECK (due_amount >= 0 AND credit_amount >= 0 AND deposit_held_amount >= 0 AND collect_for_others_amount >= 0),
  CHECK (provisional_receipt_no IS NULL OR device_id IS NOT NULL)   -- only a device prints a provisional number
) STRICT;
CREATE UNIQUE INDEX orders_receipt ON orders (shop_id, receipt_no) WHERE receipt_no IS NOT NULL;
CREATE UNIQUE INDEX orders_provisional_receipt ON orders (shop_id, provisional_receipt_no) WHERE provisional_receipt_no IS NOT NULL;
CREATE INDEX orders_business_date ON orders (shop_id, business_date);
CREATE INDEX orders_service_dates ON orders (shop_id, last_service_date, first_service_date);
CREATE INDEX orders_open ON orders (shop_id, next_due_at) WHERE is_open = 1;
CREATE INDEX orders_due ON orders (shop_id, due_amount) WHERE due_amount > 0;
CREATE INDEX orders_customer ON orders (shop_id, customer_id);
CREATE INDEX orders_last4 ON orders (shop_id, customer_phone_last4);
CREATE INDEX orders_rev ON orders (shop_id, updated_rev);

CREATE TABLE order_links (                        -- merged reservations, same party, family groups
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,
  linked_order_id  TEXT    NOT NULL,
  link_kind_key    TEXT    NOT NULL,              -- merged_reservation | same_party | family_group (code-owned)
  note             TEXT,
  created_at       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  ended_at         TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, linked_order_id) REFERENCES orders(shop_id, id),
  CHECK (order_id <> linked_order_id)
) STRICT;
CREATE INDEX order_links_linked ON order_links (shop_id, linked_order_id);

CREATE TABLE order_batches (                      -- 접수 차수: first intake, late companions, field additions
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  label          TEXT    NOT NULL,                -- '첫 접수', '추가 접수 2', '배달 중 추가'
  source_key     TEXT    NOT NULL DEFAULT 'counter',   -- counter | driver_field | intake_form | legacy
  -- the charges of a batch (its lines' net amounts) are counted by the closing of posting_date, like money:
  -- a line added offline at 22:50 and synced after the 23:00 closing posts to the next open day
  closing_scope_id  TEXT NOT NULL DEFAULT 'main',
  business_date  TEXT    NOT NULL,
  posting_date   TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  created_by     TEXT    NOT NULL,
  device_id      TEXT,
  request_id     TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE UNIQUE INDEX order_batches_seq ON order_batches (shop_id, order_id, seq);
CREATE UNIQUE INDEX order_batches_order_id ON order_batches (shop_id, order_id, id);    -- FK target

CREATE TABLE order_people (                       -- companions exist only for size pre-input; walk-ins record none
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  order_id           TEXT    NOT NULL,
  seq                INTEGER NOT NULL CHECK (seq >= 1),
  name               TEXT,                        -- NULL -> '일행 N' (PII, redactable)
  customer_class_id  TEXT,
  note               TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  updated_rev        INTEGER NOT NULL DEFAULT 0,
  version            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, customer_class_id) REFERENCES customer_classes(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX order_people_seq ON order_people (shop_id, order_id, seq);
CREATE UNIQUE INDEX order_people_order_id ON order_people (shop_id, order_id, id);    -- FK target

CREATE TABLE order_lines (                        -- one item line; label, unit, mode and price are snapshots
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  order_id               TEXT    NOT NULL,
  batch_id               TEXT    NOT NULL,
  parent_line_id         TEXT,                    -- component lines point at the priced bundle line of the same order
  person_id              TEXT,                    -- NULL = shared by the team (split never picks people)
  catalog_item_id        TEXT,                    -- NULL only for a headcount placeholder line
  variant_id             TEXT,
  item_kind_id           TEXT    NOT NULL,
  fulfillment_mode_key   TEXT    NOT NULL REFERENCES sys_fulfillment_modes(key),   -- snapshot
  tracking_key           TEXT    NOT NULL REFERENCES sys_tracking_modes(key),      -- snapshot
  return_policy_key      TEXT    NOT NULL REFERENCES sys_return_policies(key),     -- snapshot
  payment_section_id     TEXT    NOT NULL,
  discount_group_id      TEXT    NOT NULL,
  label                  TEXT    NOT NULL,        -- snapshot '스키', '야간권 성인'
  unit_label             TEXT    NOT NULL,        -- snapshot
  quantity               INTEGER NOT NULL CHECK (quantity >= 1),
  start_date             TEXT    NOT NULL,        -- billed use days, inclusive
  end_date               TEXT    NOT NULL,
  window_start_time      TEXT,                    -- ticket / lesson window (local HH:MM)
  window_end_time        TEXT,
  issue_planned_date     TEXT,                    -- ticket: planned issue day (발권 예정일), not the use day
  customer_class_id      TEXT,
  headcount              INTEGER CHECK (headcount IS NULL OR headcount >= 1),   -- lessons, placeholder '인원 N명'
  price_basis_key        TEXT    NOT NULL REFERENCES sys_price_bases(key),
  billable_units         INTEGER NOT NULL CHECK (billable_units >= 1),          -- days, sessions, hours or 1
  unit_price             INTEGER NOT NULL CHECK (unit_price >= 0),
  gross_amount           INTEGER NOT NULL CHECK (gross_amount >= 0),
  discount_amount        INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  net_amount             INTEGER NOT NULL,
  price_list_version_id  TEXT,
  price_rule_id          TEXT,
  price_source_key       TEXT    NOT NULL,        -- rule | manual | free | legacy_total_only (code-owned)
  price_engine_key       TEXT    NOT NULL,        -- 'per_day@1', 'tiers@1', 'legacy_total_only@1'
  quote_hash             TEXT,                    -- hash of the server quote the client agreed to
  price_note             TEXT,                    -- reason for a manual or free price
  tax_category_key       TEXT    REFERENCES sys_tax_categories(key),   -- snapshot; NULL = tax not recorded
  supply_amount          INTEGER,                 -- net_amount split for tax documents (NULL with the category)
  tax_amount             INTEGER,
  -- everything above is frozen once the line exists (trigger order_lines_frozen): a later change is a
  -- cancellation line, an extension line or a charge adjustment, never an edit
  -- projections (rebuilt from movements, claims, service bookings, cancellations, extensions)
  current_end_date       TEXT,                    -- end after extensions (NULL = end_date)
  current_end_time       TEXT,
  qty_cancelled          INTEGER NOT NULL DEFAULT 0,
  qty_prepared           INTEGER NOT NULL DEFAULT 0 CHECK (qty_prepared >= 0),
  qty_loaded             INTEGER NOT NULL DEFAULT 0 CHECK (qty_loaded >= 0),
  qty_issued             INTEGER NOT NULL DEFAULT 0 CHECK (qty_issued >= 0),
  qty_with_customer      INTEGER NOT NULL DEFAULT 0 CHECK (qty_with_customer >= 0),
  qty_in_vehicle         INTEGER NOT NULL DEFAULT 0 CHECK (qty_in_vehicle >= 0),
  qty_returned           INTEGER NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
  qty_not_returned       INTEGER NOT NULL DEFAULT 0 CHECK (qty_not_returned >= 0),   -- lost / written off
  qty_unknown            INTEGER NOT NULL DEFAULT 0 CHECK (qty_unknown >= 0),
  qty_service_closed     INTEGER NOT NULL DEFAULT 0 CHECK (qty_service_closed >= 0),
  progress_key           TEXT    NOT NULL DEFAULT 'todo',   -- todo | partial | done | na
  created_at             TEXT    NOT NULL,
  created_by             TEXT    NOT NULL,
  request_id             TEXT,
  created_rev            INTEGER NOT NULL,
  updated_at             TEXT    NOT NULL,
  updated_rev            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, batch_id) REFERENCES order_batches(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, parent_line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, person_id) REFERENCES order_people(shop_id, order_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id, variant_id) REFERENCES item_variants(shop_id, catalog_item_id, id),
  FOREIGN KEY (shop_id, item_kind_id) REFERENCES item_kinds(shop_id, id),
  FOREIGN KEY (shop_id, payment_section_id) REFERENCES payment_sections(shop_id, id),
  FOREIGN KEY (shop_id, discount_group_id) REFERENCES discount_groups(shop_id, id),
  FOREIGN KEY (shop_id, customer_class_id) REFERENCES customer_classes(shop_id, id),
  FOREIGN KEY (shop_id, price_list_version_id) REFERENCES price_list_versions(shop_id, id),
  FOREIGN KEY (shop_id, price_rule_id) REFERENCES price_rules(shop_id, id),
  CHECK (end_date >= start_date),
  CHECK (discount_amount <= gross_amount),
  CHECK (net_amount = gross_amount - discount_amount),
  CHECK (tax_amount IS NULL OR (supply_amount IS NOT NULL AND supply_amount + tax_amount = net_amount)),
  CHECK (qty_cancelled >= 0 AND qty_cancelled <= quantity)
) STRICT;
CREATE UNIQUE INDEX order_lines_order_id ON order_lines (shop_id, order_id, id);    -- FK target: line of THIS order
CREATE INDEX order_lines_dates ON order_lines (shop_id, start_date, end_date);
CREATE INDEX order_lines_issue_plan ON order_lines (shop_id, issue_planned_date) WHERE issue_planned_date IS NOT NULL;
CREATE INDEX order_lines_item ON order_lines (shop_id, catalog_item_id, start_date);
CREATE INDEX order_lines_parent ON order_lines (shop_id, parent_line_id) WHERE parent_line_id IS NOT NULL;

CREATE TABLE discount_applications (              -- which rule was applied, with its value snapshot (append-only)
  shop_id                 TEXT    NOT NULL REFERENCES shops(id),
  id                      TEXT    NOT NULL,
  order_id                TEXT    NOT NULL,
  batch_id                TEXT    NOT NULL,
  discount_group_id       TEXT    NOT NULL,
  discount_rule_id        TEXT,                   -- NULL = manual entry (needs discount.manual)
  kind_key                TEXT    NOT NULL REFERENCES sys_discount_kinds(key),
  label                   TEXT    NOT NULL,       -- snapshot '장비 10%'
  value_amount            INTEGER,                -- snapshot
  value_percent_bp        INTEGER,                -- snapshot
  rounding_unit           INTEGER NOT NULL CHECK (rounding_unit >= 1),
  total_amount            INTEGER NOT NULL CHECK (total_amount >= 0),
  supersedes_application_id TEXT,                 -- a later change is a new row plus an adjustment, never an edit
  reason                  TEXT,
  occurred_at             TEXT    NOT NULL,
  recorded_at             TEXT    NOT NULL,
  actor_key               TEXT    NOT NULL,
  actor_name              TEXT    NOT NULL,
  request_id              TEXT    NOT NULL,
  created_rev             INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, batch_id) REFERENCES order_batches(shop_id, order_id, id),
  FOREIGN KEY (shop_id, discount_group_id) REFERENCES discount_groups(shop_id, id),
  FOREIGN KEY (shop_id, discount_rule_id) REFERENCES discount_rules(shop_id, id),
  FOREIGN KEY (shop_id, order_id, supersedes_application_id) REFERENCES discount_applications(shop_id, order_id, id)
) STRICT;
CREATE UNIQUE INDEX discount_applications_order_id ON discount_applications (shop_id, order_id, id);   -- FK target

CREATE TABLE line_price_components (              -- sum(amount) over a line = order_lines.net_amount (append-only)
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  order_id                 TEXT    NOT NULL,
  line_id                  TEXT    NOT NULL,
  seq                      INTEGER NOT NULL CHECK (seq >= 1),
  component_key            TEXT    NOT NULL,      -- base | tier | day_type | season | class | discount | manual_discount |
                                                  -- manual | rounding | legacy (code-owned)
  price_rule_id            TEXT,
  discount_application_id  TEXT,
  label                    TEXT    NOT NULL,      -- snapshot '스키 1일 20,000원 × 2대 × 2일'
  quantity                 INTEGER,
  units                    INTEGER,
  unit_amount              INTEGER,
  percent_bp               INTEGER,
  service_date             TEXT,                  -- per-date rows (weekend day, peak day)
  amount                   INTEGER NOT NULL,      -- signed
  reason                   TEXT,
  created_at               TEXT    NOT NULL,
  created_rev              INTEGER NOT NULL,
  PRIMARY KEY (shop_id, line_id, seq),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, price_rule_id) REFERENCES price_rules(shop_id, id),
  FOREIGN KEY (shop_id, order_id, discount_application_id) REFERENCES discount_applications(shop_id, order_id, id)
) STRICT;
CREATE INDEX line_price_components_discount ON line_price_components (shop_id, discount_application_id) WHERE discount_application_id IS NOT NULL;

CREATE TABLE line_promises (                      -- pickup and return promise per line or part of its quantity; superseded, never edited
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  order_id               TEXT    NOT NULL,
  line_id                TEXT    NOT NULL,
  promise_type_key       TEXT    NOT NULL REFERENCES sys_promise_types(key),
  method_key             TEXT    NOT NULL,
  quantity               INTEGER NOT NULL CHECK (quantity >= 1),
  promised_date          TEXT    NOT NULL,
  promised_time          TEXT,                    -- NULL = during opening hours / now
  return_slot_id         TEXT,
  pickup_option_id       TEXT,
  slot_label             TEXT,                    -- snapshot '야간타임 후'
  slot_local_time        TEXT,                    -- snapshot
  slot_day_offset        INTEGER,                 -- snapshot
  place_id               TEXT,                    -- NULL = shop counter or free-text place
  area_name              TEXT,                    -- snapshot '솔마을'
  place_name             TEXT,                    -- snapshot '한솔동' or free text
  place_note             TEXT,                    -- room, gate, '로비'
  vehicle_id             TEXT,
  task_id                TEXT,                    -- delivery / collection task that fulfils it
  config_rev             INTEGER NOT NULL,
  status_key             TEXT    NOT NULL DEFAULT 'active',   -- active | superseded | fulfilled | cancelled
  supersedes_promise_id  TEXT,
  reason                 TEXT,
  created_at             TEXT    NOT NULL,
  created_by             TEXT    NOT NULL,
  request_id             TEXT,
  ended_at               TEXT,
  created_rev            INTEGER NOT NULL,
  updated_rev            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (method_key, promise_type_key) REFERENCES sys_fulfillment_methods(key, promise_type_key),
  FOREIGN KEY (shop_id, return_slot_id) REFERENCES return_slots(shop_id, id),
  FOREIGN KEY (shop_id, pickup_option_id) REFERENCES pickup_time_options(shop_id, id),
  FOREIGN KEY (shop_id, place_id) REFERENCES places(shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, order_id, supersedes_promise_id) REFERENCES line_promises(shop_id, order_id, id)
) STRICT;
CREATE UNIQUE INDEX line_promises_order_id ON line_promises (shop_id, order_id, id);   -- FK target
CREATE INDEX line_promises_line ON line_promises (shop_id, line_id, promise_type_key) WHERE status_key = 'active';
CREATE INDEX line_promises_order ON line_promises (shop_id, order_id, promise_type_key) WHERE status_key = 'active';
CREATE INDEX line_promises_due ON line_promises (shop_id, promise_type_key, promised_date, promised_time) WHERE status_key = 'active';
CREATE INDEX line_promises_task ON line_promises (shop_id, task_id) WHERE task_id IS NOT NULL;

CREATE TABLE line_promise_assets (                -- optional binding of a promise to units (2 of 4 skis extended)
  shop_id     TEXT    NOT NULL REFERENCES shops(id),
  promise_id  TEXT    NOT NULL,
  asset_id    TEXT    NOT NULL,
  PRIMARY KEY (shop_id, promise_id, asset_id),
  FOREIGN KEY (shop_id, promise_id) REFERENCES line_promises(shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id)
) STRICT;

CREATE TABLE payment_promises (                   -- who pays, when, how much must be prepaid ('김OO 팀 결제 예정')
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  id                       TEXT    NOT NULL,
  order_id                 TEXT    NOT NULL,
  line_id                  TEXT,                  -- NULL = whole order or whole section
  payment_section_id       TEXT,
  purpose_key              TEXT    NOT NULL REFERENCES sys_payment_purposes(key),   -- charge | prepayment | deposit
  timing_key               TEXT    NOT NULL REFERENCES sys_payment_timings(key),
  payer_order_id           TEXT,                  -- another team pays (by_other_order)
  bill_to_counterparty_id  TEXT,                  -- partner postpaid billing
  expected_amount          INTEGER CHECK (expected_amount IS NULL OR expected_amount >= 0),   -- NULL = whatever is due
  due_date                 TEXT,
  status_key               TEXT    NOT NULL DEFAULT 'open',   -- open | kept | superseded | waived
  supersedes_promise_id    TEXT,
  note                     TEXT,
  created_at               TEXT    NOT NULL,
  created_by               TEXT    NOT NULL,
  request_id               TEXT,
  ended_at                 TEXT,
  created_rev              INTEGER NOT NULL,
  updated_rev              INTEGER NOT NULL DEFAULT 0,
  version                  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, payment_section_id) REFERENCES payment_sections(shop_id, id),
  FOREIGN KEY (shop_id, payer_order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, bill_to_counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, supersedes_promise_id) REFERENCES payment_promises(shop_id, id),
  CHECK (payer_order_id IS NULL OR payer_order_id <> order_id)
) STRICT;
CREATE INDEX payment_promises_order ON payment_promises (shop_id, order_id) WHERE status_key = 'open';
CREATE INDEX payment_promises_payer ON payment_promises (shop_id, payer_order_id) WHERE payer_order_id IS NOT NULL AND status_key = 'open';

CREATE TABLE service_bookings (                   -- lessons (강습): team, discipline, headcount, slot; several sessions per line allowed
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  order_id              TEXT    NOT NULL,
  line_id               TEXT    NOT NULL,
  session_no            INTEGER NOT NULL DEFAULT 1 CHECK (session_no >= 1),
  counterparty_id       TEXT,                     -- lesson team (role lesson_team) or the internal '우리 강사' row;
                                                  -- NULL = sold before a team is assigned (status 'unassigned')
  discipline_option_id  TEXT,                     -- attribute option: ski | board
  headcount             INTEGER NOT NULL CHECK (headcount >= 1),
  service_date          TEXT    NOT NULL,
  start_time            TEXT,
  end_time              TEXT,
  end_day_offset        INTEGER NOT NULL DEFAULT 0 CHECK (end_day_offset >= 0),   -- night lesson 22:30-00:30: 1
  service_slot_id       TEXT,
  slot_label            TEXT,                     -- snapshot
  instructor_name       TEXT,
  meeting_place_id      TEXT,
  meeting_place_name    TEXT,                     -- snapshot
  status_key            TEXT    NOT NULL DEFAULT 'reserved',   -- unassigned | reserved | done | cancelled | no_show
                                                  -- (after settlement only lesson.correct changes it: cancel + reissue the trade)
  closed_at             TEXT,
  closed_by             TEXT,
  note                  TEXT,
  created_at            TEXT    NOT NULL,
  created_by            TEXT    NOT NULL,
  request_id            TEXT,
  updated_at            TEXT    NOT NULL,
  updated_rev           INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, discipline_option_id) REFERENCES attribute_options(shop_id, id),
  FOREIGN KEY (shop_id, service_slot_id) REFERENCES service_slots(shop_id, id),
  FOREIGN KEY (shop_id, meeting_place_id) REFERENCES places(shop_id, id),
  CHECK (end_time IS NULL OR start_time IS NULL OR end_day_offset > 0 OR end_time > start_time)
) STRICT;
CREATE UNIQUE INDEX service_bookings_session ON service_bookings (shop_id, line_id, session_no);
CREATE INDEX service_bookings_day ON service_bookings (shop_id, service_date, start_time);

CREATE TABLE order_cancellations (                -- append-only; partial quantities allowed
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  id                   TEXT    NOT NULL,
  order_id             TEXT    NOT NULL,
  reason_code_id       TEXT,
  reason               TEXT    NOT NULL,
  refund_decision_key  TEXT    NOT NULL,          -- refund | no_refund | not_applicable (default from the shop setting)
  total_amount         INTEGER NOT NULL CHECK (total_amount >= 0),   -- = sum of its lines = -(sum of linked adjustments) (verifier)
  occurred_at          TEXT    NOT NULL,
  recorded_at          TEXT    NOT NULL,
  closing_scope_id     TEXT    NOT NULL DEFAULT 'main',
  business_date        TEXT    NOT NULL,
  posting_date         TEXT    NOT NULL,
  actor_key            TEXT    NOT NULL,
  actor_name           TEXT    NOT NULL,
  device_id            TEXT,
  request_id           TEXT    NOT NULL,
  created_rev          INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE UNIQUE INDEX order_cancellations_order_id ON order_cancellations (shop_id, order_id, id);   -- FK target

CREATE TABLE order_cancellation_lines (           -- 2 of 5 skis cancelled
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  cancellation_id  TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,
  line_id          TEXT    NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity >= 1),
  amount           INTEGER NOT NULL CHECK (amount >= 0),   -- charge removed = pro rata of the line's price components
                                                  -- (net x q / quantity; the last cancellation of a line takes the remainder)
  adjustment_id    TEXT,                          -- the mirroring charge_adjustments row: required when amount > 0
  PRIMARY KEY (shop_id, cancellation_id, line_id),
  FOREIGN KEY (shop_id, order_id, cancellation_id) REFERENCES order_cancellations(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, adjustment_id) REFERENCES charge_adjustments(shop_id, id),
  CHECK (amount = 0 OR adjustment_id IS NOT NULL)
) STRICT;

CREATE TABLE order_extensions (                   -- append-only
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,
  reason         TEXT,
  total_amount   INTEGER NOT NULL CHECK (total_amount >= 0),   -- = sum of its lines = sum of linked adjustments (verifier)
  occurred_at    TEXT    NOT NULL,
  recorded_at    TEXT    NOT NULL,
  closing_scope_id TEXT  NOT NULL DEFAULT 'main',
  business_date  TEXT    NOT NULL,
  posting_date   TEXT    NOT NULL,
  actor_key      TEXT    NOT NULL,
  actor_name     TEXT    NOT NULL,
  device_id      TEXT,
  request_id     TEXT    NOT NULL,
  created_rev    INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE UNIQUE INDEX order_extensions_order_id ON order_extensions (shop_id, order_id, id);   -- FK target

CREATE TABLE order_extension_lines (              -- later date, later time on the same date (오후 -> 야간), half day -> full day,
                                                  -- per_hour + 2 hours, ticket 3h -> 6h: all priced here, never as a manual correction
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  extension_id       TEXT    NOT NULL,
  order_id           TEXT    NOT NULL,
  line_id            TEXT    NOT NULL,
  scope_key          TEXT    NOT NULL,            -- line | assets
  quantity           INTEGER NOT NULL CHECK (quantity >= 1),
  before_end_date    TEXT    NOT NULL,
  before_end_time    TEXT,                        -- local HH:MM; required (both sides) for a same-day extension
  after_end_date     TEXT    NOT NULL,
  after_end_time     TEXT,
  return_slot_id     TEXT,                        -- the new return slot, with its snapshot
  slot_label         TEXT,
  slot_local_time    TEXT,
  price_basis_key    TEXT    NOT NULL REFERENCES sys_price_bases(key),   -- unit of added_units (per_day, per_hour, half_day ...)
  added_units        INTEGER NOT NULL CHECK (added_units >= 0),          -- 0: same-day change priced by the upgrade rule
  added_minutes      INTEGER CHECK (added_minutes IS NULL OR added_minutes >= 0),
  amount             INTEGER NOT NULL CHECK (amount >= 0),
  adjustment_id      TEXT,                        -- required when amount > 0
  new_promise_id     TEXT,
  PRIMARY KEY (shop_id, extension_id, line_id),
  FOREIGN KEY (shop_id, order_id, extension_id) REFERENCES order_extensions(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, return_slot_id) REFERENCES return_slots(shop_id, id),
  FOREIGN KEY (shop_id, adjustment_id) REFERENCES charge_adjustments(shop_id, id),
  FOREIGN KEY (shop_id, order_id, new_promise_id) REFERENCES line_promises(shop_id, order_id, id),
  CHECK (after_end_date > before_end_date
         OR (after_end_date = before_end_date AND before_end_time IS NOT NULL AND after_end_time IS NOT NULL
             AND after_end_time > before_end_time)),
  CHECK (amount = 0 OR adjustment_id IS NOT NULL)
) STRICT;

CREATE TABLE order_extension_assets (             -- per-unit end after a partial extension (legacy assetTerms)
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  extension_id     TEXT    NOT NULL,
  line_id          TEXT    NOT NULL,
  asset_id         TEXT    NOT NULL,
  before_end_date  TEXT    NOT NULL,
  before_end_time  TEXT,
  after_end_date   TEXT    NOT NULL,
  after_end_time   TEXT,
  PRIMARY KEY (shop_id, extension_id, asset_id),
  FOREIGN KEY (shop_id, extension_id, line_id) REFERENCES order_extension_lines(shop_id, extension_id, line_id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  CHECK (after_end_date > before_end_date
         OR (after_end_date = before_end_date AND before_end_time IS NOT NULL AND after_end_time IS NOT NULL
             AND after_end_time > before_end_time))
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.8 Typed attribute values (shop-defined fields). One table per owner so every value
-- has a real FK; entity_type_key is pinned by CHECK and joined into the FK, so an order
-- field can never be stored on a line. At most one value column is set per row; a
-- multi-valued field (knee + wrist protectors, two contact numbers) uses value_seq 1..n, and
-- value_unit records the unit of a value entered in one of several units. A new value column
-- added later (value_json ...) is joined into the exclusivity rule by a BEFORE INSERT guard.
-- Money-like values (purchase cost) are value_int in minor units, never REAL.
-- -------------------------------------------------------------------------------------
CREATE TABLE order_attribute_values (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  order_id         TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'order' CHECK (entity_type_key = 'order'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, order_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE line_attribute_values (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  line_id          TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'order_line' CHECK (entity_type_key = 'order_line'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, line_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, line_id) REFERENCES order_lines(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE person_attribute_values (            -- height, foot, clothing size, level, by source
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  person_id         TEXT    NOT NULL,
  attribute_id      TEXT    NOT NULL,
  value_seq         INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  source_key        TEXT    NOT NULL,             -- preinput (customer) | review (staff confirmed) | measured | issued
  entity_type_key   TEXT    NOT NULL DEFAULT 'order_person' CHECK (entity_type_key = 'order_person'),
  value_text        TEXT,
  value_int         INTEGER,
  value_real        REAL,
  option_id         TEXT,
  value_unit        TEXT,                  -- unit of this value when the field allows several (US / mm)
  unknown_flag      INTEGER NOT NULL DEFAULT 0 CHECK (unknown_flag IN (0,1)),   -- '현장 확인'
  intake_review_id  TEXT,
  label_snapshot    TEXT,                         -- question label at that time
  recorded_at       TEXT    NOT NULL,
  recorded_by       TEXT    NOT NULL,
  updated_rev       INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, person_id, attribute_id, source_key, value_seq),
  FOREIGN KEY (shop_id, person_id) REFERENCES order_people(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  FOREIGN KEY (shop_id, intake_review_id) REFERENCES intake_reviews(shop_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE customer_attribute_values (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  customer_id      TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'customer' CHECK (entity_type_key = 'customer'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, customer_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE catalog_item_attribute_values (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  catalog_item_id  TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'catalog_item' CHECK (entity_type_key = 'catalog_item'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, catalog_item_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE variant_attribute_values (           -- size axes of a variant: boot_mm = 265, helmet_size = M
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  variant_id       TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'item_variant' CHECK (entity_type_key = 'item_variant'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, variant_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE asset_attribute_values (             -- brand, model, length, purchase cost of one unit
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  asset_id         TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'asset' CHECK (entity_type_key = 'asset'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, asset_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE task_attribute_values (              -- e.g. gate code, parking spot for a delivery
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  task_id          TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'task' CHECK (entity_type_key = 'task'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, task_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE place_attribute_values (             -- e.g. lodging front-desk phone, van stop description
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  place_id         TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'place' CHECK (entity_type_key = 'place'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, place_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, place_id) REFERENCES places(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

CREATE TABLE counterparty_attribute_values (      -- e.g. settlement account, commission note
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  counterparty_id  TEXT    NOT NULL,
  attribute_id     TEXT    NOT NULL,
  value_seq        INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  entity_type_key  TEXT    NOT NULL DEFAULT 'counterparty' CHECK (entity_type_key = 'counterparty'),
  value_text       TEXT,
  value_int        INTEGER,
  value_real       REAL,
  option_id        TEXT,
  value_unit       TEXT,                  -- unit of this value when the field allows several (US / mm)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT    NOT NULL,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, counterparty_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, entity_type_key) REFERENCES attribute_definitions(shop_id, id, entity_type_key),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id),
  CHECK ((value_text IS NOT NULL) + (value_int IS NOT NULL) + (value_real IS NOT NULL) + (option_id IS NOT NULL) <= 1)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.9 Size pre-input (사이즈 요청): versioned question templates, capability links,
-- immutable submissions and staff reviews
-- -------------------------------------------------------------------------------------
CREATE TABLE intake_templates (                   -- each row is one version of a template
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  key          TEXT    NOT NULL,
  version_no   INTEGER NOT NULL CHECK (version_no >= 1),
  label        TEXT    NOT NULL,
  status_key   TEXT    NOT NULL DEFAULT 'draft',  -- draft | published | retired
  created_at   TEXT    NOT NULL,
  created_by   TEXT    NOT NULL,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX intake_templates_version ON intake_templates (shop_id, key, version_no);

CREATE TABLE intake_template_questions (
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  template_id              TEXT    NOT NULL,
  seq                      INTEGER NOT NULL,
  attribute_id             TEXT    NOT NULL,
  required                 INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  shown                    INTEGER NOT NULL DEFAULT 1 CHECK (shown IN (0,1)),
  unknown_allowed          INTEGER NOT NULL DEFAULT 1 CHECK (unknown_allowed IN (0,1)),   -- '현장에서 확인'
  applies_to_item_kind_id  TEXT,
  label_override           TEXT,
  PRIMARY KEY (shop_id, template_id, seq),
  FOREIGN KEY (shop_id, template_id) REFERENCES intake_templates(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id) REFERENCES attribute_definitions(shop_id, id),
  FOREIGN KEY (shop_id, applies_to_item_kind_id) REFERENCES item_kinds(shop_id, id)
) STRICT;

CREATE TABLE intake_requests (                    -- one link per request; every request belongs to an order
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,
  template_id      TEXT    NOT NULL,
  group_code       TEXT    NOT NULL,              -- 'T001' (shop_counters)
  expected_people  INTEGER NOT NULL CHECK (expected_people >= 1),
  token_hash       TEXT    NOT NULL,              -- sha256 of the capability token (the token is only in the URL fragment)
  expires_at       TEXT    NOT NULL,
  revoked_at       TEXT,
  status_key       TEXT    NOT NULL DEFAULT 'prepared',   -- projection: prepared | sent | partial | submitted | reviewed | prepared_gear
  created_at       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  request_id       TEXT,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, template_id) REFERENCES intake_templates(shop_id, id)
) STRICT;
-- the customer's link is routed by control.public_links (token_hash -> tenant) first; this index then finds the row
CREATE UNIQUE INDEX intake_requests_token ON intake_requests (token_hash);
CREATE INDEX intake_requests_order ON intake_requests (shop_id, order_id);

CREATE TABLE intake_submissions (                 -- customer answers, immutable per version (append-only)
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  intake_request_id  TEXT    NOT NULL,
  version_no         INTEGER NOT NULL CHECK (version_no >= 1),
  status_key         TEXT    NOT NULL,            -- draft | submitted
  submitted_at       TEXT    NOT NULL,
  client_ip_hash     TEXT,
  created_rev        INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, intake_request_id) REFERENCES intake_requests(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX intake_submissions_version ON intake_submissions (shop_id, intake_request_id, version_no);

CREATE TABLE intake_submission_people (
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  submission_id      TEXT    NOT NULL,
  seq                INTEGER NOT NULL,
  client_person_key  TEXT    NOT NULL,            -- stable key the form keeps across versions
  name               TEXT,                        -- PII
  order_person_id    TEXT,                        -- set once staff binds it
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, submission_id) REFERENCES intake_submissions(shop_id, id),
  FOREIGN KEY (shop_id, order_person_id) REFERENCES order_people(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX intake_submission_people_seq ON intake_submission_people (shop_id, submission_id, seq);

CREATE TABLE intake_answers (
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  submission_person_id     TEXT    NOT NULL,
  attribute_id             TEXT    NOT NULL,
  value_seq                INTEGER NOT NULL DEFAULT 0 CHECK (value_seq >= 0),   -- 0 = single value; 1..n for multi_valued
  value_text               TEXT,
  value_int                INTEGER,
  value_real               REAL,
  option_id                TEXT,
  value_unit               TEXT,                  -- unit of this value when the field allows several (US / mm)
  unknown_flag             INTEGER NOT NULL DEFAULT 0 CHECK (unknown_flag IN (0,1)),
  question_label_snapshot  TEXT    NOT NULL,
  PRIMARY KEY (shop_id, submission_person_id, attribute_id, value_seq),
  FOREIGN KEY (shop_id, submission_person_id) REFERENCES intake_submission_people(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id) REFERENCES attribute_definitions(shop_id, id),
  FOREIGN KEY (shop_id, attribute_id, option_id) REFERENCES attribute_options(shop_id, attribute_id, id)
) STRICT;

CREATE TABLE intake_reviews (                     -- staff confirmation of one submission version (append-only)
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  intake_request_id     TEXT    NOT NULL,
  version_no            INTEGER NOT NULL CHECK (version_no >= 1),
  source_submission_id  TEXT    NOT NULL,
  reviewed_at           TEXT    NOT NULL,
  actor_key             TEXT    NOT NULL,
  actor_name            TEXT    NOT NULL,
  request_id            TEXT    NOT NULL,
  created_rev           INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, intake_request_id) REFERENCES intake_requests(shop_id, id),
  FOREIGN KEY (shop_id, source_submission_id) REFERENCES intake_submissions(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX intake_reviews_version ON intake_reviews (shop_id, intake_request_id, version_no);

-- -------------------------------------------------------------------------------------
-- 2.10 Stock: locations, units, tickets, count balances, movements, claims
-- Custody changes only through stock_movements on routes listed in sys_movement_routes.
-- Every place that can hold stock is a stock_locations row (one 'external' and one
-- 'void' row per shop too), so no movement column is ever polymorphic.
-- -------------------------------------------------------------------------------------
CREATE TABLE stock_locations (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  kind_key         TEXT    NOT NULL REFERENCES sys_location_kinds(key),
  label            TEXT    NOT NULL,
  vehicle_id       TEXT,                          -- kind vehicle
  counterparty_id  TEXT,                          -- kind counterparty (ticket office, partner shop)
  order_id         TEXT,                          -- kind customer: custody of one team
  other_shop_ref   TEXT,                          -- kind other_shop: control.tenants.id of another tenant (no FK); a
                                                  -- location of the same business is a branch's shop/storage row instead
  branch_id        TEXT,                          -- shop / storage locations of a branch
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at       TEXT    NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branches(shop_id, id),
  -- a later owner kind (locker at a lodging, phone runner) gets a 1:1 extension table with a composite FK
  -- (E5); 'at most one owner' across old and new owner columns is then checked by the verifier
  CHECK ((vehicle_id IS NOT NULL) + (counterparty_id IS NOT NULL) + (order_id IS NOT NULL) + (other_shop_ref IS NOT NULL) <= 1)
) STRICT;
CREATE UNIQUE INDEX stock_locations_kind ON stock_locations (shop_id, id, kind_key);          -- FK target (route check)
CREATE UNIQUE INDEX stock_locations_vehicle ON stock_locations (shop_id, vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE UNIQUE INDEX stock_locations_counterparty ON stock_locations (shop_id, counterparty_id) WHERE counterparty_id IS NOT NULL;
CREATE UNIQUE INDEX stock_locations_order ON stock_locations (shop_id, order_id) WHERE order_id IS NOT NULL;

CREATE TABLE lots (                               -- one stock intake (purchase, opening stock, partner borrow)
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  catalog_item_id        TEXT    NOT NULL,
  owner_counterparty_id  TEXT,                    -- NULL = our own stock
  source_reference       TEXT,                    -- dedupe key (legacy stockReferences)
  received_at            TEXT    NOT NULL,
  due_back_date          TEXT,                    -- borrowed stock
  note                   TEXT,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, owner_counterparty_id) REFERENCES counterparties(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX lots_source_reference ON lots (shop_id, source_reference) WHERE source_reference IS NOT NULL;

CREATE TABLE assets (                             -- one physical unit: every unit-tracked item and every lift ticket
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  catalog_item_id        TEXT    NOT NULL,        -- projection of asset_reclassifications (movement lines keep their own snapshot)
  variant_id             TEXT,                    -- structured size; a change is an asset_condition_changes or reclassification row
  size_text              TEXT,                    -- legacy free-text size until mapped to a variant
  lot_id                 TEXT,
  owner_counterparty_id  TEXT,                    -- NULL = own
  tag_code               TEXT,                    -- sticker / barcode (optional)
  serial_no              TEXT,
  location_id            TEXT    NOT NULL,        -- projection of the last non-reversed movement
  condition_id           TEXT    NOT NULL,        -- projection of the last condition change
  last_movement_id       TEXT,                    -- causal guard: a reversal must target this movement
  acquired_at            TEXT    NOT NULL,
  retired_at             TEXT,
  created_rev            INTEGER NOT NULL,
  updated_rev            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id, variant_id) REFERENCES item_variants(shop_id, catalog_item_id, id),
  FOREIGN KEY (shop_id, lot_id) REFERENCES lots(shop_id, id),
  FOREIGN KEY (shop_id, owner_counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, location_id) REFERENCES stock_locations(shop_id, id),
  FOREIGN KEY (shop_id, condition_id) REFERENCES asset_conditions(shop_id, id),
  FOREIGN KEY (shop_id, last_movement_id) REFERENCES stock_movements(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX assets_tag ON assets (shop_id, tag_code) WHERE tag_code IS NOT NULL;
CREATE INDEX assets_location ON assets (shop_id, location_id, catalog_item_id);
CREATE INDEX assets_item_condition ON assets (shop_id, catalog_item_id, condition_id);
CREATE INDEX assets_rev ON assets (shop_id, updated_rev);

CREATE TABLE ticket_units (                       -- ticket conditions of a ticket asset (1:1)
  shop_id                 TEXT    NOT NULL REFERENCES shops(id),
  asset_id                TEXT    NOT NULL,
  vendor_counterparty_id  TEXT    NOT NULL,
  valid_from              TEXT    NOT NULL,       -- instant
  valid_to                TEXT    NOT NULL,
  transferable            INTEGER NOT NULL CHECK (transferable IN (0,1)),
  ticket_no               TEXT,
  requires_confirmation   INTEGER NOT NULL DEFAULT 0 CHECK (requires_confirmation IN (0,1)),   -- migrated tickets
  cost_amount             INTEGER CHECK (cost_amount IS NULL OR cost_amount >= 0),
  issued_at               TEXT    NOT NULL,       -- bought at the ticket office
  issued_business_date    TEXT    NOT NULL,
  PRIMARY KEY (shop_id, asset_id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, vendor_counterparty_id) REFERENCES counterparties(shop_id, id),
  CHECK (valid_to > valid_from)
) STRICT;
CREATE INDEX ticket_units_validity ON ticket_units (shop_id, valid_to);

CREATE TABLE ticket_unit_accepts (                -- which ticket products a physical ticket satisfies (acceptedTypes)
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  asset_id         TEXT    NOT NULL,
  catalog_item_id  TEXT    NOT NULL,
  PRIMARY KEY (shop_id, asset_id, catalog_item_id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES ticket_units(shop_id, asset_id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id)
) STRICT;

CREATE TABLE stock_balances (                     -- count-tracked items (goggles, protectors): projection of movement lines
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  location_id   TEXT    NOT NULL,
  variant_id    TEXT    NOT NULL,                 -- count items always have at least one variant ('free size')
  condition_id  TEXT    NOT NULL,
  owner_key     TEXT    NOT NULL DEFAULT '',      -- '' = our own; else counterparties.id of the lender (borrowed goggles)
  lot_key       TEXT    NOT NULL DEFAULT '',      -- '' = not lot-tracked; else lots.id (hot packs with an expiry)
  quantity      INTEGER NOT NULL CHECK (quantity >= 0),
  updated_rev   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, location_id, variant_id, condition_id, owner_key, lot_key),
  FOREIGN KEY (shop_id, location_id) REFERENCES stock_locations(shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, condition_id) REFERENCES asset_conditions(shop_id, id)
) STRICT;

CREATE TABLE stock_holds (                        -- quantity holds on count-tracked stock (6 goggles M for a group)
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  variant_id     TEXT    NOT NULL,
  location_id    TEXT,                            -- NULL = any location of the shop
  quantity       INTEGER NOT NULL CHECK (quantity >= 1),
  order_id       TEXT,
  order_line_id  TEXT,
  task_id        TEXT,
  reason         TEXT,
  created_at     TEXT    NOT NULL,
  created_by     TEXT    NOT NULL,
  request_id     TEXT,
  ended_at       TEXT,
  end_reason_key TEXT,                            -- fulfilled | released | cancelled
  updated_rev    INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, location_id) REFERENCES stock_locations(shop_id, id),
  FOREIGN KEY (shop_id, order_id, order_line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id)
) STRICT;
CREATE INDEX stock_holds_active ON stock_holds (shop_id, variant_id) WHERE ended_at IS NULL;

CREATE TABLE stock_movements (                    -- append-only physical history; a correction is a new 'reversal'
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  kind_key              TEXT    NOT NULL REFERENCES sys_movement_kinds(key),
  from_location_id      TEXT    NOT NULL,
  from_kind_key         TEXT    NOT NULL,         -- copied from the location so the route FK can be checked
  to_location_id        TEXT    NOT NULL,
  to_kind_key           TEXT    NOT NULL,
  order_id              TEXT,                     -- single-order movements; multi-order ones (van -> shop) leave it NULL
  task_id               TEXT,
  counterparty_id       TEXT,
  exchange_id           TEXT,
  early_return_id       TEXT,
  vendor_refund_id      TEXT,
  equipment_loan_id     TEXT,
  intake_request_id     TEXT,
  reverses_movement_id  TEXT,
  transfer_ref          TEXT,                     -- global ULID of a shop-to-shop transfer: the same value on the sending
                                                  -- shop's shop_transfer and the receiving shop's movement (handshake)
  source_reference      TEXT,                     -- dedupe key for stock intake
  late_fact             INTEGER NOT NULL DEFAULT 0 CHECK (late_fact IN (0,1)),    -- 1: an offline fact older than the unit's
                                                  -- last applied movement; kept as history, the current location does not move
  skipped_hop           INTEGER NOT NULL DEFAULT 0 CHECK (skipped_hop IN (0,1)),  -- 1: an in-hand observation (direct return,
                                                  -- receive, scan) accepted although the recorded location was not 'from'
  reason_code_id        TEXT,
  reason                TEXT,
  memo                  TEXT,
  occurred_at           TEXT    NOT NULL,
  recorded_at           TEXT    NOT NULL,
  closing_scope_id      TEXT    NOT NULL DEFAULT 'main',
  business_date         TEXT    NOT NULL,
  posting_date          TEXT    NOT NULL,
  actor_key             TEXT    NOT NULL,
  actor_name            TEXT    NOT NULL,
  device_id             TEXT,
  request_id            TEXT    NOT NULL,
  created_rev           INTEGER NOT NULL,         -- application order: 'last movement' of a unit is by created_rev, never by id
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (kind_key, from_kind_key, to_kind_key) REFERENCES sys_movement_routes(movement_kind_key, from_kind_key, to_kind_key),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, from_location_id, from_kind_key) REFERENCES stock_locations(shop_id, id, kind_key),
  FOREIGN KEY (shop_id, to_location_id, to_kind_key) REFERENCES stock_locations(shop_id, id, kind_key),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, exchange_id) REFERENCES exchanges(shop_id, id),
  FOREIGN KEY (shop_id, early_return_id) REFERENCES early_returns(shop_id, id),
  FOREIGN KEY (shop_id, vendor_refund_id) REFERENCES vendor_refunds(shop_id, id),
  FOREIGN KEY (shop_id, equipment_loan_id) REFERENCES equipment_loans(shop_id, id),
  FOREIGN KEY (shop_id, intake_request_id) REFERENCES intake_requests(shop_id, id),
  FOREIGN KEY (shop_id, reverses_movement_id) REFERENCES stock_movements(shop_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (from_location_id <> to_location_id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX stock_movements_day ON stock_movements (shop_id, business_date);
CREATE INDEX stock_movements_order ON stock_movements (shop_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX stock_movements_task ON stock_movements (shop_id, task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX stock_movements_source_reference ON stock_movements (shop_id, source_reference) WHERE source_reference IS NOT NULL;
CREATE INDEX stock_movements_reverses ON stock_movements (shop_id, reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;
CREATE INDEX stock_movements_transfer ON stock_movements (shop_id, transfer_ref) WHERE transfer_ref IS NOT NULL;

CREATE TABLE stock_movement_lines (               -- one unit, or a quantity of one count variant (append-only)
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  movement_id          TEXT    NOT NULL,
  line_no              INTEGER NOT NULL CHECK (line_no >= 1),
  catalog_item_id      TEXT    NOT NULL,          -- SNAPSHOT of the unit's item at movement time: a unit can later be
                                                  -- reclassified (asset_reclassifications) without touching this row
  asset_id             TEXT,                      -- unit-tracked: exactly one unit per line
  variant_id           TEXT,                      -- count-tracked: the variant moved (unit lines: snapshot, optional)
  quantity             INTEGER NOT NULL CHECK (quantity >= 1),
  owner_counterparty_id TEXT,                     -- count lines: whose goggles (NULL = ours), kept apart in stock_balances
  lot_id               TEXT,                      -- count lines of lot-tracked stock
  order_id             TEXT,                      -- which order and line this unit served
  order_line_id        TEXT,
  claim_id             TEXT,                      -- claim fulfilled or returned by this line (a claim on THIS unit)
  before_condition_id  TEXT,                      -- unit lines: only when the movement changes condition;
  after_condition_id   TEXT,                      -- count lines: always (the condition the quantity leaves and enters)
  created_rev          INTEGER NOT NULL,
  PRIMARY KEY (shop_id, movement_id, line_no),
  FOREIGN KEY (shop_id, movement_id) REFERENCES stock_movements(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id, variant_id) REFERENCES item_variants(shop_id, catalog_item_id, id),
  FOREIGN KEY (shop_id, owner_counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, lot_id) REFERENCES lots(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, order_line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, claim_id, asset_id) REFERENCES asset_claims(shop_id, id, asset_id),
  FOREIGN KEY (shop_id, before_condition_id) REFERENCES asset_conditions(shop_id, id),
  FOREIGN KEY (shop_id, after_condition_id) REFERENCES asset_conditions(shop_id, id),
  CHECK (asset_id IS NULL OR quantity = 1),
  CHECK (asset_id IS NOT NULL OR variant_id IS NOT NULL),
  CHECK (asset_id IS NOT NULL OR (before_condition_id IS NOT NULL AND after_condition_id IS NOT NULL)),
  CHECK (claim_id IS NULL OR asset_id IS NOT NULL),
  CHECK (order_line_id IS NULL OR order_id IS NOT NULL)
) STRICT;
CREATE INDEX stock_movement_lines_asset ON stock_movement_lines (shop_id, asset_id, created_rev) WHERE asset_id IS NOT NULL;
CREATE INDEX stock_movement_lines_order_line ON stock_movement_lines (shop_id, order_line_id) WHERE order_line_id IS NOT NULL;
-- FK target of deposit_entries: the return that released deposit units moved units of that very order line
CREATE UNIQUE INDEX stock_movement_lines_line_ref ON stock_movement_lines (shop_id, movement_id, line_no, order_line_id);

CREATE TABLE stock_movement_reversals (           -- which reversal line undid which line; each line can be reversed once (append-only)
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  reversed_movement_id  TEXT    NOT NULL,
  reversed_line_no      INTEGER NOT NULL,
  reversal_movement_id  TEXT    NOT NULL,
  reversal_line_no      INTEGER NOT NULL,         -- the reversal's own line; the verifier checks it mirrors the reversed line
                                                  -- (same unit or variant and quantity, opposite route) and matches the header
  created_rev           INTEGER NOT NULL,
  PRIMARY KEY (shop_id, reversed_movement_id, reversed_line_no),
  FOREIGN KEY (shop_id, reversed_movement_id, reversed_line_no) REFERENCES stock_movement_lines(shop_id, movement_id, line_no),
  FOREIGN KEY (shop_id, reversal_movement_id, reversal_line_no) REFERENCES stock_movement_lines(shop_id, movement_id, line_no),
  CHECK (reversal_movement_id <> reversed_movement_id)
) STRICT;
CREATE INDEX stock_movement_reversals_by ON stock_movement_reversals (shop_id, reversal_movement_id);
CREATE UNIQUE INDEX stock_movement_reversals_line ON stock_movement_reversals (shop_id, reversal_movement_id, reversal_line_no);

CREATE TABLE asset_reclassifications (            -- a unit moved to another SKU or variant: regrade, fix a data-entry mistake,
                                                  -- merge duplicate SKUs, confirm a migrated 'legacy-*' ticket (append-only)
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  asset_id              TEXT    NOT NULL,
  from_catalog_item_id  TEXT    NOT NULL,
  to_catalog_item_id    TEXT    NOT NULL,
  from_variant_id       TEXT,
  to_variant_id         TEXT,
  reason_code_id        TEXT,
  reason                TEXT    NOT NULL,
  occurred_at           TEXT    NOT NULL,
  recorded_at           TEXT    NOT NULL,
  business_date         TEXT    NOT NULL,
  posting_date          TEXT    NOT NULL,
  actor_key             TEXT    NOT NULL,
  actor_name            TEXT    NOT NULL,
  device_id             TEXT,
  request_id            TEXT    NOT NULL,
  created_rev           INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, from_catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, to_catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, from_catalog_item_id, from_variant_id) REFERENCES item_variants(shop_id, catalog_item_id, id),
  FOREIGN KEY (shop_id, to_catalog_item_id, to_variant_id) REFERENCES item_variants(shop_id, catalog_item_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (to_catalog_item_id <> from_catalog_item_id OR to_variant_id IS NOT from_variant_id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX asset_reclassifications_asset ON asset_reclassifications (shop_id, asset_id, created_rev);

CREATE TABLE asset_bindings (                     -- what a unit is currently promised to: ONE active binding per unit.
                                                  -- Every bound claim hangs on it, so preparation for order A and a van
                                                  -- load for order B, or a vendor refund of a ticket another team holds,
                                                  -- cannot coexist whatever lanes they use.
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  asset_id          TEXT    NOT NULL,
  purpose_key       TEXT    NOT NULL,             -- order | ticket_pool (time-windowed reuse, windows checked in code /
                                                  -- PG EXCLUDE) | vendor_refund | partner_lending | exchange (code-owned)
  order_id          TEXT,                         -- purpose order / exchange
  vendor_refund_id  TEXT,
  equipment_loan_id TEXT,
  created_at        TEXT    NOT NULL,
  created_by        TEXT    NOT NULL,
  request_id        TEXT,
  created_rev       INTEGER NOT NULL,
  ended_at          TEXT,                         -- NULL = active; ended when its last claim ends or custody comes home
  end_reason_key    TEXT,
  updated_rev       INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, vendor_refund_id) REFERENCES vendor_refunds(shop_id, id),
  FOREIGN KEY (shop_id, equipment_loan_id) REFERENCES equipment_loans(shop_id, id),
  CHECK ((order_id IS NOT NULL) + (vendor_refund_id IS NOT NULL) + (equipment_loan_id IS NOT NULL) <= 1)
) STRICT;
CREATE UNIQUE INDEX asset_bindings_active ON asset_bindings (shop_id, asset_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX asset_bindings_asset ON asset_bindings (shop_id, id, asset_id);   -- FK target: binding of THIS unit

CREATE TABLE asset_claims (                       -- every hold on a unit, one table, one lane per kind of hold
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  asset_id               TEXT    NOT NULL,
  binding_id             TEXT,                    -- the unit's active binding (required when the lane is bound)
  claim_type_key         TEXT    NOT NULL,
  lane_key               TEXT    NOT NULL,        -- copied from sys_claim_types (FK below keeps it honest)
  lane_exclusive         INTEGER NOT NULL CHECK (lane_exclusive IN (0,1)),   -- copied from sys_claim_lanes (FK below)
  lane_bound             INTEGER NOT NULL DEFAULT 1 CHECK (lane_bound IN (0,1)),   -- copied from sys_claim_lanes (FK below)
  exclusive_key          TEXT,                    -- asset_id || '|' || lane_key when the lane is exclusive, else NULL
  order_id               TEXT,
  order_line_id          TEXT,
  task_id                TEXT,
  preparation_id         TEXT,
  exchange_id            TEXT,
  vendor_refund_id       TEXT,
  equipment_loan_id      TEXT,
  base_asset_id          TEXT,                    -- component_of: the ski these boots belong to
  window_start           TEXT,                    -- windowed claims (tickets): instant
  window_end             TEXT,
  source_key             TEXT,                    -- recovered_ticket | spare | legacy (code-owned)
  created_at             TEXT    NOT NULL,
  created_by             TEXT    NOT NULL,
  request_id             TEXT,
  created_rev            INTEGER NOT NULL,
  fulfilled_at           TEXT,
  fulfilled_movement_id  TEXT,
  returned_at            TEXT,
  returned_movement_id   TEXT,
  ended_at               TEXT,                    -- NULL = active
  end_reason_key         TEXT,                    -- released | fulfilled | returned | cancelled | reversed | expired |
                                                  -- displaced_by_fact (a physical fact overrode this plan: review item)
  ended_by               TEXT,
  updated_rev            INTEGER NOT NULL DEFAULT 0,
  version                INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (claim_type_key, lane_key) REFERENCES sys_claim_types(key, lane_key),
  FOREIGN KEY (lane_key, lane_exclusive, lane_bound) REFERENCES sys_claim_lanes(key, exclusive, bound),
  FOREIGN KEY (shop_id, binding_id, asset_id) REFERENCES asset_bindings(shop_id, id, asset_id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, order_line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, preparation_id) REFERENCES preparations(shop_id, id),
  FOREIGN KEY (shop_id, exchange_id) REFERENCES exchanges(shop_id, id),
  FOREIGN KEY (shop_id, vendor_refund_id) REFERENCES vendor_refunds(shop_id, id),
  FOREIGN KEY (shop_id, equipment_loan_id) REFERENCES equipment_loans(shop_id, id),
  FOREIGN KEY (shop_id, base_asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, fulfilled_movement_id) REFERENCES stock_movements(shop_id, id),
  FOREIGN KEY (shop_id, returned_movement_id) REFERENCES stock_movements(shop_id, id),
  CHECK ((lane_exclusive = 0 AND exclusive_key IS NULL) OR (lane_exclusive = 1 AND exclusive_key = asset_id || '|' || lane_key)),
  CHECK (lane_bound = 0 OR binding_id IS NOT NULL),
  CHECK (window_end IS NULL OR window_end > window_start),
  CHECK (order_line_id IS NULL OR order_id IS NOT NULL),
  CHECK (base_asset_id IS NULL OR base_asset_id <> asset_id)
) STRICT;
-- the guarantee the old code only had by scanning: one active claim per unit in each exclusive lane.
-- A prepared unit can still take its transport claim, because preparation and transport are different lanes;
-- both hang on the same binding (the same order), which asset_bindings_active makes the only one.
CREATE UNIQUE INDEX asset_claims_exclusive ON asset_claims (shop_id, exclusive_key) WHERE exclusive_key IS NOT NULL AND ended_at IS NULL;
CREATE UNIQUE INDEX asset_claims_asset ON asset_claims (shop_id, id, asset_id);   -- FK target: a claim on THIS unit
CREATE INDEX asset_claims_asset_active ON asset_claims (shop_id, asset_id, window_start) WHERE ended_at IS NULL;
CREATE INDEX asset_claims_line ON asset_claims (shop_id, order_line_id) WHERE order_line_id IS NOT NULL;
CREATE INDEX asset_claims_task ON asset_claims (shop_id, task_id) WHERE task_id IS NOT NULL AND ended_at IS NULL;

CREATE TABLE asset_condition_changes (            -- condition, loss, found and size history (append-only)
  shop_id                 TEXT    NOT NULL REFERENCES shops(id),
  id                      TEXT    NOT NULL,
  asset_id                TEXT    NOT NULL,
  from_condition_id       TEXT    NOT NULL,
  to_condition_id         TEXT    NOT NULL,
  from_variant_id         TEXT,                   -- size change (preparation re-sizing) is recorded, never silent
  to_variant_id           TEXT,
  last_known_location_id  TEXT,                   -- for lost units
  movement_id             TEXT,
  exchange_id             TEXT,
  reason_code_id          TEXT,
  reason                  TEXT,
  occurred_at             TEXT    NOT NULL,
  recorded_at             TEXT    NOT NULL,
  closing_scope_id        TEXT    NOT NULL DEFAULT 'main',
  business_date           TEXT    NOT NULL,
  posting_date            TEXT    NOT NULL,
  actor_key               TEXT    NOT NULL,
  actor_name              TEXT    NOT NULL,
  device_id               TEXT,
  request_id              TEXT    NOT NULL,
  created_rev             INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, from_condition_id) REFERENCES asset_conditions(shop_id, id),
  FOREIGN KEY (shop_id, to_condition_id) REFERENCES asset_conditions(shop_id, id),
  FOREIGN KEY (shop_id, from_variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, to_variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, last_known_location_id) REFERENCES stock_locations(shop_id, id),
  FOREIGN KEY (shop_id, movement_id) REFERENCES stock_movements(shop_id, id),
  FOREIGN KEY (shop_id, exchange_id) REFERENCES exchanges(shop_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX asset_condition_changes_asset ON asset_condition_changes (shop_id, asset_id, occurred_at);

-- -------------------------------------------------------------------------------------
-- 2.11 Stock processes: preparation, exchange, early return, partner loans, vendor refunds
-- -------------------------------------------------------------------------------------
CREATE TABLE preparations (                       -- 준비: units set aside and sized for an order before issue
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,
  status_key     TEXT    NOT NULL DEFAULT 'prepared',   -- prepared | issued | cancelled
  cancel_reason  TEXT,
  cancelled_at   TEXT,
  cancelled_by   TEXT,
  created_at     TEXT    NOT NULL,
  created_by     TEXT    NOT NULL,
  request_id     TEXT,
  updated_rev    INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX preparations_order_id ON preparations (shop_id, order_id, id);   -- FK target

CREATE TABLE preparation_items (                  -- one unit (with its claim) or a quantity of a count variant (with its hold)
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  preparation_id     TEXT    NOT NULL,
  seq                INTEGER NOT NULL CHECK (seq >= 1),
  order_id           TEXT    NOT NULL,
  asset_id           TEXT,
  line_id            TEXT    NOT NULL,
  person_id          TEXT,
  variant_before_id  TEXT,
  variant_after_id   TEXT,                        -- count lines: the variant set aside
  quantity           INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  size_text          TEXT,                        -- legacy free-text size
  claim_id           TEXT,                        -- unit lines: the preparation claim on THIS unit
  stock_hold_id      TEXT,                        -- count lines: the quantity hold
  PRIMARY KEY (shop_id, preparation_id, seq),
  FOREIGN KEY (shop_id, order_id, preparation_id) REFERENCES preparations(shop_id, order_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, person_id) REFERENCES order_people(shop_id, order_id, id),
  FOREIGN KEY (shop_id, variant_before_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, variant_after_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, claim_id, asset_id) REFERENCES asset_claims(shop_id, id, asset_id),
  FOREIGN KEY (shop_id, stock_hold_id) REFERENCES stock_holds(shop_id, id),
  CHECK ((asset_id IS NOT NULL AND claim_id IS NOT NULL AND quantity = 1)
         OR (asset_id IS NULL AND claim_id IS NULL AND variant_after_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX preparation_items_asset ON preparation_items (shop_id, preparation_id, asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE exchanges (                          -- 교환: any exchangeable kind or component (ski, boots, clothing, helmet)
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  order_id          TEXT    NOT NULL,
  line_id           TEXT    NOT NULL,
  catalog_item_id   TEXT    NOT NULL,             -- the exchanged item (base or component)
  reason_code_id    TEXT,
  old_size          TEXT,
  new_size          TEXT,
  old_variant_id    TEXT,
  new_variant_id    TEXT,
  memo              TEXT,
  method_key        TEXT    NOT NULL REFERENCES sys_fulfillment_methods(key),
  status_key        TEXT    NOT NULL DEFAULT 'open',   -- open | completed | cancelled
  cancel_reason     TEXT,
  cancelled_at      TEXT,
  created_at        TEXT    NOT NULL,
  created_by        TEXT    NOT NULL,
  request_id        TEXT,
  updated_rev       INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, old_variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, new_variant_id) REFERENCES item_variants(shop_id, id)
) STRICT;
CREATE INDEX exchanges_order ON exchanges (shop_id, order_id);
CREATE UNIQUE INDEX exchanges_order_id ON exchanges (shop_id, order_id, id);   -- FK target

CREATE TABLE exchange_units (                     -- a unit swap, or a count swap (goggles M -> L, quantity 2)
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  exchange_id         TEXT    NOT NULL,
  seq                 INTEGER NOT NULL CHECK (seq >= 1),
  order_id            TEXT    NOT NULL,           -- = the exchange's order: its return promise is a promise of THIS order
  base_asset_id       TEXT,                       -- unit swaps of a component: the ski these boots belong to
  old_asset_id        TEXT,
  new_asset_id        TEXT,
  old_variant_id      TEXT,                       -- count swaps
  new_variant_id      TEXT,
  quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  delivery_task_id    TEXT,
  collection_task_id  TEXT,
  return_promise_id   TEXT,
  delivered_at        TEXT,
  collected_at        TEXT,
  received_at         TEXT,
  PRIMARY KEY (shop_id, exchange_id, seq),
  FOREIGN KEY (shop_id, exchange_id) REFERENCES exchanges(shop_id, id),
  FOREIGN KEY (shop_id, base_asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, old_asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, new_asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, old_variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, new_variant_id) REFERENCES item_variants(shop_id, id),
  CHECK ((old_asset_id IS NOT NULL AND old_variant_id IS NULL AND quantity = 1)
         OR (old_asset_id IS NULL AND old_variant_id IS NOT NULL AND base_asset_id IS NULL AND new_asset_id IS NULL)),
  FOREIGN KEY (shop_id, delivery_task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, collection_task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, return_promise_id) REFERENCES line_promises(shop_id, id),
  FOREIGN KEY (shop_id, order_id, exchange_id) REFERENCES exchanges(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, return_promise_id) REFERENCES line_promises(shop_id, order_id, id)
) STRICT;

CREATE TABLE exchange_recoveries (                -- append-only
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  exchange_id           TEXT    NOT NULL,
  reversal_movement_id  TEXT,
  reason                TEXT    NOT NULL,
  occurred_at           TEXT    NOT NULL,
  actor_key             TEXT    NOT NULL,
  actor_name            TEXT    NOT NULL,
  request_id            TEXT    NOT NULL,
  created_rev           INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, exchange_id) REFERENCES exchanges(shop_id, id),
  FOREIGN KEY (shop_id, reversal_movement_id) REFERENCES stock_movements(shop_id, id)
) STRICT;

CREATE TABLE early_returns (                      -- 조기 반납: no money effect by itself
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  order_id          TEXT    NOT NULL,
  reason_code_id    TEXT,
  memo              TEXT,
  method_key        TEXT    NOT NULL REFERENCES sys_fulfillment_methods(key),
  visit_date        TEXT,
  visit_time        TEXT,
  visit_place_id    TEXT,
  visit_place_name  TEXT,
  vehicle_id        TEXT,
  status_key        TEXT    NOT NULL DEFAULT 'waiting',   -- projection: waiting | partial | completed | corrected | rescheduled
  created_at        TEXT    NOT NULL,
  created_by        TEXT    NOT NULL,
  request_id        TEXT,
  updated_rev       INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, visit_place_id) REFERENCES places(shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX early_returns_order_id ON early_returns (shop_id, order_id, id);   -- FK target

CREATE TABLE early_return_assets (                -- one unit, or a quantity of a count variant (2 of 6 goggles back early)
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  early_return_id      TEXT    NOT NULL,
  seq                  INTEGER NOT NULL CHECK (seq >= 1),
  order_id             TEXT    NOT NULL,          -- = the early return's order: its line and promises are of THIS order
  asset_id             TEXT,
  variant_id           TEXT,
  quantity             INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  order_line_id        TEXT,
  previous_task_id     TEXT,
  previous_promise_id  TEXT,
  new_task_id          TEXT,
  PRIMARY KEY (shop_id, early_return_id, seq),
  FOREIGN KEY (shop_id, early_return_id) REFERENCES early_returns(shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, order_line_id) REFERENCES order_lines(shop_id, id),
  FOREIGN KEY (shop_id, previous_task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, previous_promise_id) REFERENCES line_promises(shop_id, id),
  FOREIGN KEY (shop_id, new_task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, order_id, early_return_id) REFERENCES early_returns(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, order_line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, previous_promise_id) REFERENCES line_promises(shop_id, order_id, id),
  CHECK ((asset_id IS NOT NULL AND variant_id IS NULL AND quantity = 1) OR (asset_id IS NULL AND variant_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX early_return_assets_asset ON early_return_assets (shop_id, early_return_id, asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE equipment_loans (                    -- partner borrow (we receive) and lend (we give)
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  direction_key    TEXT    NOT NULL,              -- borrow | lend (code-owned)
  counterparty_id  TEXT    NOT NULL,
  due_date         TEXT,
  reason           TEXT,
  status_key       TEXT    NOT NULL DEFAULT 'open',   -- projection: open | partially_back | closed
  created_at       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  request_id       TEXT,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id)
) STRICT;

CREATE TABLE equipment_loan_items (               -- one unit, or a quantity of a count variant (20 goggles from a partner)
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  loan_id           TEXT    NOT NULL,
  seq               INTEGER NOT NULL CHECK (seq >= 1),
  asset_id          TEXT,
  variant_id        TEXT,
  quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  back_quantity     INTEGER NOT NULL DEFAULT 0 CHECK (back_quantity >= 0),   -- projection
  out_movement_id   TEXT    NOT NULL,
  back_movement_id  TEXT,                         -- unit lines; count lines come back in several movements
  PRIMARY KEY (shop_id, loan_id, seq),
  FOREIGN KEY (shop_id, loan_id) REFERENCES equipment_loans(shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, variant_id) REFERENCES item_variants(shop_id, id),
  FOREIGN KEY (shop_id, out_movement_id) REFERENCES stock_movements(shop_id, id),
  FOREIGN KEY (shop_id, back_movement_id) REFERENCES stock_movements(shop_id, id),
  CHECK ((asset_id IS NOT NULL AND variant_id IS NULL AND quantity = 1) OR (asset_id IS NULL AND variant_id IS NOT NULL)),
  CHECK (back_quantity <= quantity)
) STRICT;
CREATE UNIQUE INDEX equipment_loan_items_asset ON equipment_loan_items (shop_id, loan_id, asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE vendor_refunds (                     -- 발권처 환불: tickets taken back to the ticket office
  shop_id                 TEXT    NOT NULL REFERENCES shops(id),
  id                      TEXT    NOT NULL,
  vendor_counterparty_id  TEXT    NOT NULL,
  vehicle_id              TEXT,
  task_id                 TEXT,
  status_key              TEXT    NOT NULL DEFAULT 'pending',   -- projection: pending | partial | incomplete | completed | cancelled
  created_at              TEXT    NOT NULL,
  created_by              TEXT    NOT NULL,
  request_id              TEXT,
  updated_rev             INTEGER NOT NULL DEFAULT 0,
  version                 INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vendor_counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id)
) STRICT;

CREATE TABLE vendor_refund_items (
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  vendor_refund_id      TEXT    NOT NULL,
  asset_id              TEXT    NOT NULL,
  outcome_key           TEXT    NOT NULL DEFAULT 'pending',   -- pending | completed | cancelled
  completed_attempt_id  TEXT,
  PRIMARY KEY (shop_id, vendor_refund_id, asset_id),
  FOREIGN KEY (shop_id, vendor_refund_id) REFERENCES vendor_refunds(shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, completed_attempt_id) REFERENCES vendor_refund_attempts(shop_id, id)
) STRICT;
-- a ticket can be in only one live vendor refund (the refund money is expected once)
CREATE UNIQUE INDEX vendor_refund_items_live ON vendor_refund_items (shop_id, asset_id) WHERE outcome_key IN ('pending', 'completed');

CREATE TABLE vendor_refund_attempts (             -- each visit to the office (an empty attempt = failed visit); append-only.
                                                  -- NOT a cash source: the money is the linked counterparty settlement
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  id                TEXT    NOT NULL,
  vendor_refund_id  TEXT    NOT NULL,
  amount            INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),   -- = the settlement amount (verifier)
  unit_count        INTEGER NOT NULL DEFAULT 0 CHECK (unit_count >= 0),
  movement_id       TEXT,
  settlement_id     TEXT,                         -- the money reaches the cash closing through the counterparty ledger only
  note              TEXT,
  occurred_at       TEXT    NOT NULL,
  recorded_at       TEXT    NOT NULL,
  closing_scope_id  TEXT    NOT NULL DEFAULT 'main',
  business_date     TEXT    NOT NULL,
  posting_date      TEXT    NOT NULL,
  actor_key         TEXT    NOT NULL,
  actor_name        TEXT    NOT NULL,
  device_id         TEXT,
  request_id        TEXT    NOT NULL,
  created_rev       INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vendor_refund_id) REFERENCES vendor_refunds(shop_id, id),
  FOREIGN KEY (shop_id, movement_id) REFERENCES stock_movements(shop_id, id),
  FOREIGN KEY (shop_id, settlement_id) REFERENCES counterparty_settlements(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE UNIQUE INDEX vendor_refund_attempts_settlement ON vendor_refund_attempts (shop_id, settlement_id) WHERE settlement_id IS NOT NULL;

-- -------------------------------------------------------------------------------------
-- 2.12 Dispatch: van tasks, visit order, 빨리 확인 pins, notifications
-- -------------------------------------------------------------------------------------
CREATE TABLE tasks (                              -- delivery / collection / vendor refund visit of one van
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  kind_key           TEXT    NOT NULL REFERENCES sys_task_kinds(key),
  vehicle_id         TEXT,
  service_date       TEXT    NOT NULL,            -- promised day (visit order never changes it)
  promised_time      TEXT,
  place_id           TEXT,
  area_name          TEXT,                        -- snapshot
  place_name         TEXT,                        -- snapshot or free text
  place_note         TEXT,
  order_id           TEXT,
  customer_label     TEXT,                        -- snapshot '김민수 · 0025' (redactable)
  title              TEXT,
  exchange_id        TEXT,
  early_return_id    TEXT,
  vendor_refund_id   TEXT,
  intake_request_id  TEXT,
  source_key         TEXT    NOT NULL DEFAULT 'promise',   -- promise | manual | exchange | early_return | vendor_refund | legacy
  memo               TEXT,
  status_key         TEXT    NOT NULL DEFAULT 'waiting',   -- waiting | in_progress | completed | cancelled
  completed_at       TEXT,
  cancelled_at       TEXT,
  cancel_reason      TEXT,
  cancelled_by       TEXT,
  created_at         TEXT    NOT NULL,
  created_by         TEXT    NOT NULL,
  request_id         TEXT,
  created_rev        INTEGER NOT NULL,
  updated_at         TEXT    NOT NULL,
  updated_rev        INTEGER NOT NULL DEFAULT 0,
  version            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, place_id) REFERENCES places(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, exchange_id) REFERENCES exchanges(shop_id, id),
  FOREIGN KEY (shop_id, early_return_id) REFERENCES early_returns(shop_id, id),
  FOREIGN KEY (shop_id, vendor_refund_id) REFERENCES vendor_refunds(shop_id, id),
  FOREIGN KEY (shop_id, intake_request_id) REFERENCES intake_requests(shop_id, id)
) STRICT;
CREATE INDEX tasks_vehicle_day ON tasks (shop_id, vehicle_id, service_date, promised_time);
CREATE INDEX tasks_open ON tasks (shop_id, service_date) WHERE status_key IN ('waiting', 'in_progress');
CREATE INDEX tasks_order ON tasks (shop_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX tasks_rev ON tasks (shop_id, updated_rev);

CREATE TABLE task_items (                         -- planned quantity per line; done and elsewhere are projections
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  task_id             TEXT    NOT NULL,
  seq                 INTEGER NOT NULL CHECK (seq >= 1),
  order_id            TEXT,
  order_line_id       TEXT,
  promise_id          TEXT,
  catalog_item_id     TEXT    NOT NULL,
  variant_id          TEXT,
  planned_quantity    INTEGER NOT NULL CHECK (planned_quantity >= 0),
  done_quantity       INTEGER NOT NULL DEFAULT 0 CHECK (done_quantity >= 0),
  elsewhere_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (elsewhere_quantity >= 0),   -- returned directly at the counter
  PRIMARY KEY (shop_id, task_id, seq),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, order_id, order_line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, promise_id) REFERENCES line_promises(shop_id, order_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id, variant_id) REFERENCES item_variants(shop_id, catalog_item_id, id),
  CHECK (order_line_id IS NULL OR order_id IS NOT NULL)
) STRICT;
CREATE INDEX task_items_line ON task_items (shop_id, order_line_id) WHERE order_line_id IS NOT NULL;

CREATE TABLE task_visits (                        -- driver visit results: 고객 부재, 장소 변경, 물품을 받지 못함 (append-only)
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  task_id             TEXT    NOT NULL,
  seq                 INTEGER NOT NULL CHECK (seq >= 1),
  result_reason_id    TEXT    NOT NULL,           -- reason_codes, domain visit_result
  retry_key           TEXT,                       -- today | tomorrow | date (code-owned)
  reason              TEXT,
  before_date         TEXT,
  before_time         TEXT,
  before_place_name   TEXT,
  after_date          TEXT,
  after_time          TEXT,
  after_place_id      TEXT,
  after_place_name    TEXT,
  remaining_quantity  INTEGER CHECK (remaining_quantity IS NULL OR remaining_quantity >= 0),
  occurred_at         TEXT    NOT NULL,
  recorded_at         TEXT    NOT NULL,
  business_date       TEXT    NOT NULL,
  actor_key           TEXT    NOT NULL,
  actor_name          TEXT    NOT NULL,
  device_id           TEXT,
  request_id          TEXT    NOT NULL,
  created_rev         INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, result_reason_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, after_place_id) REFERENCES places(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX task_visits_seq ON task_visits (shop_id, task_id, seq);

CREATE TABLE task_reassignments (                 -- van / date / time changes of a task (append-only)
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  task_id          TEXT    NOT NULL,
  from_vehicle_id  TEXT,
  to_vehicle_id    TEXT,
  from_date        TEXT,
  to_date          TEXT,
  from_time        TEXT,
  to_time          TEXT,
  reason           TEXT,
  occurred_at      TEXT    NOT NULL,
  actor_key        TEXT    NOT NULL,
  actor_name       TEXT    NOT NULL,
  request_id       TEXT    NOT NULL,
  created_rev      INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, from_vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, to_vehicle_id) REFERENCES vehicles(shop_id, id)
) STRICT;

CREATE TABLE route_positions (                    -- visit order: one row per task, fractional rank. The first manual move of a
                                                  -- route writes ranks for the whole route in one command, so every task has one
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  task_id       TEXT    NOT NULL,
  vehicle_id    TEXT    NOT NULL,                 -- reset in the same transaction as task.reassign
  service_date  TEXT    NOT NULL,
  rank_key      TEXT,                             -- base-62 fractional index compared as BINARY (PostgreSQL: COLLATE "C");
                                                  -- NULL = time order. Ties: (rank_key, promised_time, task_id)
  decided_at    TEXT    NOT NULL,                 -- corrected occurred_at of the move: an older move arriving later loses
  updated_at    TEXT    NOT NULL,
  updated_by    TEXT    NOT NULL,                 -- actor key (driver or counter)
  request_id    TEXT,
  updated_rev   INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, task_id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id)
) STRICT;
CREATE INDEX route_positions_route ON route_positions (shop_id, vehicle_id, service_date, rank_key);

CREATE TABLE task_pins (                          -- 빨리 확인: top of the driver list until released
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  task_id             TEXT    NOT NULL,
  message             TEXT,
  pinned_at           TEXT    NOT NULL,
  pinned_by           TEXT    NOT NULL,
  notification_id     TEXT,
  released_at         TEXT,
  released_by         TEXT,
  release_reason_key  TEXT,                       -- manual | task_completed | task_cancelled
  request_id          TEXT,
  updated_rev         INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, notification_id) REFERENCES notifications(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX task_pins_active ON task_pins (shop_id, task_id) WHERE released_at IS NULL;

CREATE TABLE notifications (                      -- staff and driver alerts: requested -> delivered -> acknowledged -> closed/expired
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  recipient_scope_key   TEXT    NOT NULL,         -- shop | vehicle | staff
  recipient_vehicle_id  TEXT,
  recipient_staff_id    TEXT,
  type_key              TEXT    NOT NULL,         -- pin | help | route_changed | review | night_prep | intake_submitted
  source_key            TEXT    NOT NULL,         -- dedupe key (replaces the old linear scan); pins use 'pin:<task_pins.id>'
                                                  -- so a task can be pinned again later
  source_request_id     TEXT,
  order_id              TEXT,
  task_id               TEXT,
  movement_id           TEXT,
  intake_request_id     TEXT,
  title                 TEXT    NOT NULL,         -- never a phone number; rendered in the shop locale
  summary               TEXT,
  template_key          TEXT,                     -- strings-table key the title / summary were rendered from
  params_json           TEXT,                     -- its parameters, so another locale can re-render it
  attention_required    INTEGER NOT NULL DEFAULT 0 CHECK (attention_required IN (0,1)),
  lifecycle_key         TEXT    NOT NULL DEFAULT 'requested',   -- requested | delivered | acknowledged | closed | expired
  delivered_at          TEXT,                     -- reached at least one device
  acknowledged_at       TEXT,                     -- a person pressed 확인
  acknowledged_by       TEXT,
  expires_at            TEXT,
  closed_at             TEXT,
  created_at            TEXT    NOT NULL,
  created_rev           INTEGER NOT NULL,
  updated_rev           INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, recipient_vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, recipient_staff_id) REFERENCES staff_members(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, movement_id) REFERENCES stock_movements(shop_id, id),
  FOREIGN KEY (shop_id, intake_request_id) REFERENCES intake_requests(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX notifications_source ON notifications (shop_id, source_key);
CREATE INDEX notifications_open ON notifications (shop_id, recipient_scope_key, recipient_vehicle_id) WHERE lifecycle_key IN ('requested', 'delivered');

CREATE TABLE notification_receipts (              -- per device: delivered vs acknowledged by a person
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  notification_id  TEXT    NOT NULL,
  device_id        TEXT    NOT NULL,
  delivered_at     TEXT,
  acknowledged_at  TEXT,
  acknowledged_by  TEXT,
  PRIMARY KEY (shop_id, notification_id, device_id),
  FOREIGN KEY (shop_id, notification_id) REFERENCES notifications(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;

CREATE TABLE notification_preferences (
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  scope_key    TEXT    NOT NULL,                  -- store | vehicle | device
  device_id    TEXT,
  vehicle_id   TEXT,
  sound        INTEGER NOT NULL DEFAULT 1 CHECK (sound IN (0,1)),
  interval_s   INTEGER NOT NULL DEFAULT 30 CHECK (interval_s > 0),
  volume       INTEGER NOT NULL DEFAULT 80 CHECK (volume >= 0 AND volume <= 100),
  updated_at   TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  FOREIGN KEY (shop_id, vehicle_id) REFERENCES vehicles(shop_id, id)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.13 Money ledger. One payments row = one real money event (a card approval, a cash
-- handover). payment_allocations spread it over orders and lines. Every table here except
-- payment_intents, order_checkout_locks, deposits, tax_document_identities and
-- cash_movements is append-only (triggers 2.19); a correction is a new row (refund,
-- reallocation, adjustment, cancel record). Ledger rows carry no personal data: payers are
-- references, not names; free-text reasons are redact-only.
-- Each kind of money has exactly one cash-bearing ledger: tender -> payments, float and
-- expenses -> cash_entries, van handover -> cash_transfers + confirmations, counterparty money
-- (partners, lesson teams, ticket-office refunds) -> counterparty_settlements.
-- -------------------------------------------------------------------------------------
CREATE TABLE payment_groups (                     -- one checkout: intake confirm, six families at once, one split round
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  group_no     TEXT    NOT NULL,                  -- human '묶음 1226-03' (shop_counters)
  purpose_key  TEXT    NOT NULL,                  -- intake_confirm | multi_order | split_by_items | driver_field | refund | other
  note         TEXT,
  occurred_at  TEXT    NOT NULL,
  actor_key    TEXT    NOT NULL,
  actor_name   TEXT    NOT NULL,
  device_id    TEXT,
  request_id   TEXT    NOT NULL,
  created_rev  INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX payment_groups_no ON payment_groups (shop_id, group_no);

CREATE TABLE payment_intents (                    -- card terminal / payment gateway round trip
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,         -- deterministic from the originating request (ULID time = occurred_at,
                                                  -- randomness = HMAC(request_id, ordinal)): a resend after a restore
                                                  -- recreates the SAME id, which the terminal agent answers 'already approved'
  payment_group_id      TEXT,
  kind_key              TEXT    NOT NULL REFERENCES sys_payment_kinds(key),
  method_id             TEXT    NOT NULL,
  terminal_id           TEXT,                     -- physical terminal; NULL for a gateway (online booking)
  provider_key          TEXT    NOT NULL,         -- van:<vendor> | pg:<vendor> (adapter key)
  amount                INTEGER NOT NULL CHECK (amount > 0),
  refund_of_payment_id  TEXT,
  status_key            TEXT    NOT NULL DEFAULT 'requested',   -- requested | approved | declined | unknown | cancelled
  approval_no           TEXT,
  card_label            TEXT,                     -- brand + last digits only
  error_code            TEXT,
  vendor_response_json  TEXT,                     -- raw terminal payload
  outbox_id             TEXT,
  payment_id            TEXT,                     -- set when approved and recorded
  resolved_by_request_id TEXT,                    -- payment.intent_resolve (a person read the terminal receipt): the only
                                                  -- way an 'unknown' intent becomes a payment without the agent
  requested_at          TEXT    NOT NULL,
  completed_at          TEXT,
  requested_by          TEXT    NOT NULL,
  device_id             TEXT,
  request_id            TEXT,
  updated_rev           INTEGER NOT NULL DEFAULT 0,
  version               INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, payment_group_id) REFERENCES payment_groups(shop_id, id),
  FOREIGN KEY (shop_id, method_id) REFERENCES payment_methods(shop_id, id),
  FOREIGN KEY (shop_id, terminal_id) REFERENCES card_terminals(shop_id, id),
  FOREIGN KEY (shop_id, refund_of_payment_id) REFERENCES payments(shop_id, id),
  FOREIGN KEY (shop_id, outbox_id) REFERENCES outbox(shop_id, id),
  FOREIGN KEY (shop_id, payment_id) REFERENCES payments(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE INDEX payment_intents_open ON payment_intents (shop_id, status_key) WHERE status_key IN ('requested', 'unknown');
-- open or unknown refund intents count as reserved when 'refund <= what was paid' is checked
CREATE INDEX payment_intents_refund_of ON payment_intents (shop_id, refund_of_payment_id) WHERE refund_of_payment_id IS NOT NULL;

CREATE TABLE payment_intent_allocations (         -- intended allocations, with the same composite FKs as payment_allocations;
                                                  -- copied on approval, so the copy cannot fail after the money is taken
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  intent_id           TEXT    NOT NULL,
  seq                 INTEGER NOT NULL CHECK (seq >= 1),
  order_id            TEXT    NOT NULL,
  line_id             TEXT,
  amount              INTEGER NOT NULL CHECK (amount > 0),
  allocated_quantity  INTEGER CHECK (allocated_quantity IS NULL OR allocated_quantity >= 1),
  PRIMARY KEY (shop_id, intent_id, seq),
  FOREIGN KEY (shop_id, intent_id) REFERENCES payment_intents(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id)
) STRICT;
CREATE INDEX payment_intent_allocations_order ON payment_intent_allocations (shop_id, order_id);

CREATE TABLE order_checkout_locks (               -- one open card checkout per order: the other counter sees
                                                  -- '카운터 1에서 카드 결제 중' and cannot take card or cash for it meanwhile
  shop_id     TEXT    NOT NULL REFERENCES shops(id),
  id          TEXT    NOT NULL,
  order_id    TEXT    NOT NULL,
  intent_id   TEXT    NOT NULL,
  device_id   TEXT,
  started_at  TEXT    NOT NULL,
  ended_at    TEXT,                               -- set when the intent is approved, declined, cancelled or resolved
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, intent_id) REFERENCES payment_intents(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX order_checkout_locks_open ON order_checkout_locks (shop_id, order_id) WHERE ended_at IS NULL;

CREATE TABLE payments (                           -- append-only tender
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  id                       TEXT    NOT NULL,
  payment_group_id         TEXT,
  kind_key                 TEXT    NOT NULL,      -- sys_payment_kinds (FK below, with its rule flags)
  kind_requires_refund_of  INTEGER NOT NULL DEFAULT 0 CHECK (kind_requires_refund_of IN (0,1)),   -- copied from the kind
  kind_requires_deposit    INTEGER NOT NULL DEFAULT 0 CHECK (kind_requires_deposit IN (0,1)),      -- copied from the kind
  kind_cash_sign           INTEGER NOT NULL CHECK (kind_cash_sign IN (-1,0,1)),                    -- copied from the kind
  purpose_key              TEXT    NOT NULL REFERENCES sys_payment_purposes(key),   -- charge | prepayment | deposit
  method_id                TEXT    NOT NULL,
  method_affects_cash      INTEGER NOT NULL CHECK (method_affects_cash IN (0,1)),   -- copied from the method (FK below)
  amount                   INTEGER NOT NULL CHECK (amount > 0),
  cash_drawer_id           TEXT,                  -- counter drawer, or the van's wallet for field cash: required exactly
                                                  -- when the method moves cash and the kind has a cash sign
  terminal_id              TEXT,
  payment_intent_id        TEXT,
  approval_no              TEXT,                  -- card approval number: NOT unique in the real world (8 digits per issuer,
                                                  -- repeated partial cancels); duplicates become a review item, never a rejection
  approved_business_date   TEXT,                  -- the terminal's approval day (duplicate check scope with terminal and amount)
  external_reference       TEXT,                  -- free memo (transfer depositor name ...); never a uniqueness key
  refund_of_payment_id     TEXT,                  -- a refund points at what it refunds
  deposit_id               TEXT,                  -- deposit_in / deposit_out / deposit_apply
  payer_order_id           TEXT,                  -- the team that actually paid
  payer_customer_id        TEXT,
  payer_counterparty_id    TEXT,                  -- partner postpaid: only with a non-cash method ('on_account'); the partner's
                                                  -- real money is a counterparty_settlement, the one cash-bearing ledger for it
  collected_by_vehicle_id  TEXT,                  -- driver field collection
  reason                   TEXT,                  -- required for refund / deposit_out (command layer); redact-only
  occurred_at              TEXT    NOT NULL,
  recorded_at              TEXT    NOT NULL,
  closing_scope_id         TEXT    NOT NULL DEFAULT 'main',   -- the drawer's scope, else the device's, else 'main'
  business_date            TEXT    NOT NULL,      -- the day it happened
  posting_date             TEXT    NOT NULL,      -- the open day whose closing counts it (later than business_date only for late facts)
  actor_key                TEXT    NOT NULL,      -- who took the money (for an offline fact: the device-signed actor, not the
                                                  -- session that flushed the queue)
  actor_name               TEXT    NOT NULL,
  device_id                TEXT,
  request_id               TEXT    NOT NULL,
  created_rev              INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign)
    REFERENCES sys_payment_kinds(key, requires_refund_of, requires_deposit, cash_sign),
  FOREIGN KEY (shop_id, payment_group_id) REFERENCES payment_groups(shop_id, id),
  FOREIGN KEY (shop_id, method_id, method_affects_cash) REFERENCES payment_methods(shop_id, id, affects_cash_drawer),
  FOREIGN KEY (shop_id, cash_drawer_id, closing_scope_id) REFERENCES cash_drawers(shop_id, id, closing_scope_id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, terminal_id) REFERENCES card_terminals(shop_id, id),
  FOREIGN KEY (shop_id, payment_intent_id) REFERENCES payment_intents(shop_id, id),
  FOREIGN KEY (shop_id, refund_of_payment_id) REFERENCES payments(shop_id, id),
  FOREIGN KEY (shop_id, deposit_id) REFERENCES deposits(shop_id, id),
  FOREIGN KEY (shop_id, payer_order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, payer_customer_id) REFERENCES customers(shop_id, id),
  FOREIGN KEY (shop_id, payer_counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, collected_by_vehicle_id) REFERENCES vehicles(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (refund_of_payment_id IS NULL OR refund_of_payment_id <> id),
  CHECK (kind_requires_refund_of = (refund_of_payment_id IS NOT NULL)),
  CHECK (kind_requires_deposit = (deposit_id IS NOT NULL)),
  CHECK ((method_affects_cash = 1 AND kind_cash_sign <> 0) = (cash_drawer_id IS NOT NULL)),
  CHECK (payer_counterparty_id IS NULL OR method_affects_cash = 0),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX payments_posting ON payments (shop_id, closing_scope_id, posting_date);
CREATE INDEX payments_group ON payments (shop_id, payment_group_id) WHERE payment_group_id IS NOT NULL;
CREATE INDEX payments_refund_of ON payments (shop_id, refund_of_payment_id) WHERE refund_of_payment_id IS NOT NULL;
CREATE INDEX payments_drawer_day ON payments (shop_id, cash_drawer_id, posting_date) WHERE cash_drawer_id IS NOT NULL;
CREATE INDEX payments_approval ON payments (shop_id, terminal_id, approval_no) WHERE approval_no IS NOT NULL;   -- lookup only
-- the same approval reported twice for one intent (agent late + a person's resolve) is one payment; a genuinely
-- different second approval of one intent is recorded and raised as 'extra_card_approval'
CREATE UNIQUE INDEX payments_intent_approval ON payments (shop_id, payment_intent_id, approval_no) WHERE payment_intent_id IS NOT NULL AND approval_no IS NOT NULL;
-- FK target of deposit_entries: a deposit unit row names a money row of the right kind and of the same deposit
CREATE UNIQUE INDEX payments_deposit_kind ON payments (shop_id, id, kind_key, deposit_id);

CREATE TABLE tax_documents (                      -- 현금영수증 · 세금계산서 issued for money (append-only; a cancel is a new row)
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  id                   TEXT    NOT NULL,
  kind_key             TEXT    NOT NULL,          -- cash_receipt | tax_invoice (code-owned)
  payment_id           TEXT    NOT NULL,
  amount               INTEGER NOT NULL CHECK (amount > 0),
  supply_amount        INTEGER NOT NULL CHECK (supply_amount >= 0),
  tax_amount           INTEGER NOT NULL CHECK (tax_amount >= 0),
  breakdown_json       TEXT    NOT NULL,          -- per tax category, from the allocated lines' snapshots
  approval_no          TEXT,                      -- NTS approval number
  status_key           TEXT    NOT NULL,          -- issued | cancelled | failed
  cancels_document_id  TEXT,
  occurred_at          TEXT    NOT NULL,
  recorded_at          TEXT    NOT NULL,
  closing_scope_id     TEXT    NOT NULL DEFAULT 'main',
  business_date        TEXT    NOT NULL,
  posting_date         TEXT    NOT NULL,
  actor_key            TEXT    NOT NULL,
  actor_name           TEXT    NOT NULL,
  device_id            TEXT,
  request_id           TEXT    NOT NULL,
  created_rev          INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, payment_id) REFERENCES payments(shop_id, id),
  FOREIGN KEY (shop_id, cancels_document_id) REFERENCES tax_documents(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (supply_amount + tax_amount = amount),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX tax_documents_payment ON tax_documents (shop_id, payment_id);
CREATE UNIQUE INDEX tax_documents_cancel_once ON tax_documents (shop_id, cancels_document_id) WHERE cancels_document_id IS NOT NULL;

CREATE TABLE tax_document_identities (            -- the customer identity a tax document needs (PII, retention-purged)
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  document_id          TEXT    NOT NULL,
  identity_kind_key    TEXT    NOT NULL,          -- phone | business_no | card_no (code-owned)
  identity_value       TEXT,                      -- NULL once purged
  purge_after          TEXT    NOT NULL,
  purged_at            TEXT,
  PRIMARY KEY (shop_id, document_id),
  FOREIGN KEY (shop_id, document_id) REFERENCES tax_documents(shop_id, id)
) STRICT;

CREATE TABLE payment_reallocations (              -- moving money between teams or lines after the fact (append-only)
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  payment_id     TEXT    NOT NULL,
  reason         TEXT    NOT NULL,
  occurred_at    TEXT    NOT NULL,
  recorded_at    TEXT    NOT NULL,
  closing_scope_id TEXT  NOT NULL DEFAULT 'main',
  business_date  TEXT    NOT NULL,
  posting_date   TEXT    NOT NULL,
  actor_key      TEXT    NOT NULL,
  actor_name     TEXT    NOT NULL,
  device_id      TEXT,
  request_id     TEXT    NOT NULL,
  created_rev    INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, payment_id) REFERENCES payments(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;

CREATE TABLE payment_allocations (                -- how a tender is spread over orders and lines (signed, append-only)
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  payment_id          TEXT    NOT NULL,
  seq                 INTEGER NOT NULL CHECK (seq >= 1),
  order_id            TEXT    NOT NULL,
  line_id             TEXT,                       -- NULL = the order as a whole (not allowed once the order is split by
                                                  -- items: earlier order-level money is spread onto lines by a reallocation)
  amount              INTEGER NOT NULL CHECK (amount <> 0),   -- negative only inside a reallocation
  allocated_quantity  INTEGER,                    -- split by items: units paid, signed like the amount (a reversal carries -2)
  reallocation_id     TEXT,
  closing_scope_id    TEXT    NOT NULL DEFAULT 'main',
  business_date       TEXT    NOT NULL,           -- of the payment, or of the reallocation that wrote this row
  posting_date        TEXT    NOT NULL,           -- section / item-kind totals move on the day the allocation posts
  actor_key           TEXT    NOT NULL,
  request_id          TEXT    NOT NULL,
  created_rev         INTEGER NOT NULL,
  PRIMARY KEY (shop_id, payment_id, seq),
  FOREIGN KEY (shop_id, payment_id) REFERENCES payments(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, reallocation_id) REFERENCES payment_reallocations(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  CHECK (amount > 0 OR reallocation_id IS NOT NULL),
  CHECK (allocated_quantity IS NULL OR (allocated_quantity <> 0 AND allocated_quantity * amount > 0)),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX payment_allocations_order ON payment_allocations (shop_id, order_id);
CREATE INDEX payment_allocations_line ON payment_allocations (shop_id, line_id) WHERE line_id IS NOT NULL;
CREATE INDEX payment_allocations_posting ON payment_allocations (shop_id, closing_scope_id, posting_date);

CREATE TABLE deposits (                           -- security deposit holds (보증금); never used against charges automatically.
                                                  -- A rule deposit is ONE hold per team and rule ('이 팀 권 보증금'); its units
                                                  -- live per line in deposit_entries, so a team with adult and child tickets
                                                  -- gets its 10,000 back in one cash handout (one payments row)
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,
  line_id          TEXT,                          -- manual deposits only (a rule deposit spans the team's lines)
  asset_id         TEXT,
  deposit_rule_id  TEXT,                          -- NULL = a manual deposit (ID card, cash guarantee) without a rule
  label            TEXT,                          -- snapshots of the rule when the hold was made: later rule edits never
  unit_amount      INTEGER CHECK (unit_amount IS NULL OR unit_amount > 0),   -- change what this team was told
  refund_default_key     TEXT REFERENCES sys_deposit_refund_methods(key),
  unreturned_key         TEXT REFERENCES sys_deposit_unreturned_actions(key),
  unreturned_after_days  INTEGER CHECK (unreturned_after_days IS NULL OR unreturned_after_days >= 0),
  loss_amount            INTEGER CHECK (loss_amount IS NULL OR loss_amount > 0),
  required_amount  INTEGER CHECK (required_amount IS NULL OR required_amount >= 0),
  note             TEXT,
  held_amount      INTEGER NOT NULL DEFAULT 0 CHECK (held_amount >= 0),   -- projection: sum of deposit_sign x payments
  held_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (held_quantity >= 0), -- projection: take + restore - refund - apply - keep
  kept_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (kept_quantity >= 0), -- projection: keep - restore (units the shop kept)
  status_key       TEXT    NOT NULL DEFAULT 'open',   -- projection: open | held | returned | applied | kept | mixed
  created_at       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  request_id       TEXT,
  updated_rev      INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, deposit_rule_id) REFERENCES deposit_rules(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX deposits_order_id ON deposits (shop_id, order_id, id);   -- FK target: a unit row belongs to THIS team
CREATE UNIQUE INDEX deposits_order_rule ON deposits (shop_id, order_id, deposit_rule_id) WHERE deposit_rule_id IS NOT NULL;
CREATE INDEX deposits_held ON deposits (shop_id, order_id) WHERE held_amount > 0;

CREATE TABLE deposit_entries (                    -- 보증금 장부: the units behind every deposit money row, per line (append-only).
                                                  -- Held units of a deposit = take + restore - refund - apply - keep. Partial
                                                  -- returns refund per unit: 2 of 3 tickets back = one refund of 10,000 with two
                                                  -- unit rows, each naming the return movement line that brought the ticket back
  shop_id           TEXT    NOT NULL REFERENCES shops(id),
  deposit_id        TEXT    NOT NULL,
  seq               INTEGER NOT NULL CHECK (seq >= 1),
  order_id          TEXT    NOT NULL,             -- = the deposit's order (composite FK)
  line_id           TEXT,                         -- the line whose units these are; NULL only for a manual deposit without units
  asset_id          TEXT,                         -- the ticket, when unit-tracked and known
  entry_kind_key    TEXT    NOT NULL,             -- take | refund | apply | keep | restore (sys_deposit_entry_kinds)
  payment_kind_key  TEXT    NOT NULL,             -- copied from the entry kind: the payment below must be of this kind
  quantity          INTEGER NOT NULL CHECK (quantity >= 0),   -- units (0 only for a manual deposit without units)
  amount            INTEGER NOT NULL CHECK (amount > 0),
  payment_id        TEXT    NOT NULL,             -- the money row: deposit_in | deposit_out | deposit_apply | deposit_forfeit |
                                                  -- deposit_restore of the same deposit; one payment may carry several unit rows
  movement_id       TEXT,                         -- refund / apply: the return (direct_return, collect, found) that brought the
  movement_line_no  INTEGER,                      -- units back; keep: the write-off of the unit that never came back
  closing_id        TEXT,                         -- keep applied by a closing (the rule's unreturned_after_days)
  reason_code_id    TEXT,
  reason            TEXT,                         -- keep, restore, a refund without a return (cancelled before issue); redact-only
  occurred_at       TEXT    NOT NULL,
  recorded_at       TEXT    NOT NULL,
  closing_scope_id  TEXT    NOT NULL DEFAULT 'main',
  business_date     TEXT    NOT NULL,
  posting_date      TEXT    NOT NULL,
  actor_key         TEXT    NOT NULL,
  actor_name        TEXT    NOT NULL,
  device_id         TEXT,
  request_id        TEXT    NOT NULL,
  created_rev       INTEGER NOT NULL,
  PRIMARY KEY (shop_id, deposit_id, seq),
  FOREIGN KEY (shop_id, order_id, deposit_id) REFERENCES deposits(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (entry_kind_key, payment_kind_key) REFERENCES sys_deposit_entry_kinds(key, payment_kind_key),
  FOREIGN KEY (shop_id, payment_id, payment_kind_key, deposit_id) REFERENCES payments(shop_id, id, kind_key, deposit_id),
  FOREIGN KEY (shop_id, movement_id, movement_line_no) REFERENCES stock_movement_lines(shop_id, movement_id, line_no),
  -- the movement line that released the units moved THIS line's units
  FOREIGN KEY (shop_id, movement_id, movement_line_no, line_id) REFERENCES stock_movement_lines(shop_id, movement_id, line_no, order_line_id),
  FOREIGN KEY (shop_id, closing_id) REFERENCES closings(shop_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK ((movement_id IS NULL) = (movement_line_no IS NULL)),
  CHECK (quantity >= 1 OR line_id IS NULL),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX deposit_entries_payment ON deposit_entries (shop_id, payment_id);
CREATE INDEX deposit_entries_line ON deposit_entries (shop_id, line_id) WHERE line_id IS NOT NULL;
CREATE INDEX deposit_entries_posting ON deposit_entries (shop_id, closing_scope_id, posting_date);

CREATE TABLE charge_adjustments (                 -- signed changes to what is owed (append-only)
  shop_id                  TEXT    NOT NULL REFERENCES shops(id),
  id                       TEXT    NOT NULL,
  order_id                 TEXT    NOT NULL,
  line_id                  TEXT,
  adjustment_type_id       TEXT    NOT NULL,
  type_sign                INTEGER NOT NULL CHECK (type_sign IN (-1,0,1)),   -- copied from adjustment_types (FK below)
  amount                   INTEGER NOT NULL CHECK (amount <> 0),
  reason                   TEXT    NOT NULL,
  extension_id             TEXT,
  cancellation_id          TEXT,
  service_booking_id       TEXT,
  discount_application_id  TEXT,                  -- discount changed after acceptance
  occurred_at              TEXT    NOT NULL,
  recorded_at              TEXT    NOT NULL,
  closing_scope_id         TEXT    NOT NULL DEFAULT 'main',
  business_date            TEXT    NOT NULL,
  posting_date             TEXT    NOT NULL,
  actor_key                TEXT    NOT NULL,
  actor_name               TEXT    NOT NULL,
  device_id                TEXT,
  request_id               TEXT    NOT NULL,
  created_rev              INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, adjustment_type_id, type_sign) REFERENCES adjustment_types(shop_id, id, sign),
  FOREIGN KEY (shop_id, order_id, extension_id) REFERENCES order_extensions(shop_id, order_id, id),
  FOREIGN KEY (shop_id, order_id, cancellation_id) REFERENCES order_cancellations(shop_id, order_id, id),
  FOREIGN KEY (shop_id, service_booking_id) REFERENCES service_bookings(shop_id, id),
  FOREIGN KEY (shop_id, order_id, discount_application_id) REFERENCES discount_applications(shop_id, order_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (type_sign = 0 OR type_sign * amount > 0),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX charge_adjustments_order ON charge_adjustments (shop_id, order_id);
CREATE INDEX charge_adjustments_posting ON charge_adjustments (shop_id, closing_scope_id, posting_date);

CREATE TABLE adjustment_assets (                  -- which units a loss / damage charge is about (append-only): finding the unit
                                                  -- later raises 'found_after_charge' with a reversing adjustment offered
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  adjustment_id  TEXT    NOT NULL,
  asset_id       TEXT    NOT NULL,
  movement_id    TEXT,                            -- the write_off movement, when there was one
  created_rev    INTEGER NOT NULL,
  PRIMARY KEY (shop_id, adjustment_id, asset_id),
  FOREIGN KEY (shop_id, adjustment_id) REFERENCES charge_adjustments(shop_id, id),
  FOREIGN KEY (shop_id, asset_id) REFERENCES assets(shop_id, id),
  FOREIGN KEY (shop_id, movement_id) REFERENCES stock_movements(shop_id, id)
) STRICT;
CREATE INDEX adjustment_assets_asset ON adjustment_assets (shop_id, asset_id);

CREATE TABLE cash_entries (                       -- cash in or out not tied to an order or a counterparty: float, expenses,
                                                  -- bank deposit (append-only). Counterparty money is never a cash entry.
  shop_id                     TEXT    NOT NULL REFERENCES shops(id),
  id                          TEXT    NOT NULL,
  cash_drawer_id              TEXT    NOT NULL,
  direction_key               TEXT    NOT NULL,   -- in | out
  amount                      INTEGER NOT NULL CHECK (amount > 0),
  reason_code_id              TEXT,
  reason                      TEXT    NOT NULL,
  occurred_at                 TEXT    NOT NULL,
  recorded_at                 TEXT    NOT NULL,
  closing_scope_id            TEXT    NOT NULL DEFAULT 'main',
  business_date               TEXT    NOT NULL,
  posting_date                TEXT    NOT NULL,
  actor_key                   TEXT    NOT NULL,
  actor_name                  TEXT    NOT NULL,
  device_id                   TEXT,
  request_id                  TEXT    NOT NULL,
  created_rev                 INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, cash_drawer_id, closing_scope_id) REFERENCES cash_drawers(shop_id, id, closing_scope_id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX cash_entries_drawer_day ON cash_entries (shop_id, cash_drawer_id, posting_date);

CREATE TABLE cash_transfers (                     -- van wallet -> counter drawer handover (append-only). Declaring it moves
                                                  -- the amount from the wallet to the shop's 'transit' drawer only; the counter
                                                  -- drawer is credited when the cash is counted (confirmation)
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  id              TEXT    NOT NULL,
  from_drawer_id  TEXT    NOT NULL,
  to_drawer_id    TEXT    NOT NULL,               -- the counter drawer that will count it
  transit_drawer_id TEXT  NOT NULL,               -- kind transit
  amount          INTEGER NOT NULL CHECK (amount > 0),
  note            TEXT,
  occurred_at     TEXT    NOT NULL,
  recorded_at     TEXT    NOT NULL,
  closing_scope_id TEXT   NOT NULL DEFAULT 'main',
  business_date   TEXT    NOT NULL,
  posting_date    TEXT    NOT NULL,
  actor_key       TEXT    NOT NULL,
  actor_name      TEXT    NOT NULL,
  device_id       TEXT,
  request_id      TEXT    NOT NULL,
  created_rev     INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, from_drawer_id, closing_scope_id) REFERENCES cash_drawers(shop_id, id, closing_scope_id),
  FOREIGN KEY (shop_id, to_drawer_id) REFERENCES cash_drawers(shop_id, id),
  FOREIGN KEY (shop_id, transit_drawer_id) REFERENCES cash_drawers(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (from_drawer_id <> to_drawer_id AND transit_drawer_id <> from_drawer_id AND transit_drawer_id <> to_drawer_id),
  CHECK (posting_date >= business_date)
) STRICT;

CREATE TABLE cash_transfer_confirmations (        -- the counter counts the handed-over cash (append-only): transit -> drawer
                                                  -- by counted_amount, and any difference transit -> over_short with a reason
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  transfer_id        TEXT    NOT NULL,
  counted_amount     INTEGER NOT NULL CHECK (counted_amount >= 0),
  difference_amount  INTEGER NOT NULL,            -- counted - declared
  over_short_drawer_id TEXT,                      -- required when difference <> 0
  reason_code_id     TEXT,
  note               TEXT,
  confirmed_at       TEXT    NOT NULL,
  recorded_at        TEXT    NOT NULL,
  closing_scope_id   TEXT    NOT NULL DEFAULT 'main',
  business_date      TEXT    NOT NULL,
  posting_date       TEXT    NOT NULL,
  actor_key          TEXT    NOT NULL,
  actor_name         TEXT    NOT NULL,
  device_id          TEXT,
  request_id         TEXT    NOT NULL,
  created_rev        INTEGER NOT NULL,
  PRIMARY KEY (shop_id, transfer_id),
  FOREIGN KEY (shop_id, transfer_id) REFERENCES cash_transfers(shop_id, id),
  FOREIGN KEY (shop_id, over_short_drawer_id) REFERENCES cash_drawers(shop_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (difference_amount = 0 OR over_short_drawer_id IS NOT NULL),
  CHECK (posting_date >= business_date)
) STRICT;

CREATE TABLE cash_movements (                     -- projection: the ONE place a closing reads cash from; rebuildable
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,              -- '<source_kind>:<source_id>:<leg>'
  cash_drawer_id   TEXT    NOT NULL,
  closing_scope_id TEXT    NOT NULL DEFAULT 'main',   -- the drawer's scope (composite FK)
  amount           INTEGER NOT NULL CHECK (amount <> 0),   -- + into the drawer, - out of it
  source_kind_key  TEXT    NOT NULL REFERENCES sys_cash_sources(key),
  source_id        TEXT    NOT NULL,              -- id in the source ledger (verified nightly: must exist, exactly one row per
                                                  -- cash-bearing ledger row and leg)
  leg_no           INTEGER NOT NULL DEFAULT 1 CHECK (leg_no >= 1),   -- a transfer has two legs, a confirmation up to two
  business_date    TEXT    NOT NULL,
  posting_date     TEXT    NOT NULL,
  occurred_at      TEXT    NOT NULL,
  created_rev      INTEGER NOT NULL,              -- a drawer's expected cash is summed by created_rev window between counts
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, cash_drawer_id, closing_scope_id) REFERENCES cash_drawers(shop_id, id, closing_scope_id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE UNIQUE INDEX cash_movements_source ON cash_movements (shop_id, source_kind_key, source_id, leg_no);
CREATE INDEX cash_movements_drawer_day ON cash_movements (shop_id, cash_drawer_id, posting_date);
CREATE INDEX cash_movements_drawer_rev ON cash_movements (shop_id, cash_drawer_id, created_rev);

-- -------------------------------------------------------------------------------------
-- 2.14 Closing (마감). business_days (2.3) is the lock row per closing scope and date;
-- closings are frozen versions and never change. The report JSON holds ids and figures,
-- never names. Posting frontier (data-model 3-3): a late fact posts to its business_date only
-- if that date is open and no later date of the scope is closed, else to the first open date
-- after the scope's latest closed date.
-- -------------------------------------------------------------------------------------
CREATE TABLE closings (                           -- append-only; one version per closing scope and date
  shop_id               TEXT    NOT NULL REFERENCES shops(id),
  id                    TEXT    NOT NULL,
  closing_scope_id      TEXT    NOT NULL DEFAULT 'main',
  business_date         TEXT    NOT NULL,
  version_no            INTEGER NOT NULL CHECK (version_no >= 1),
  opening_cash_amount   INTEGER NOT NULL,
  expected_cash_amount  INTEGER NOT NULL,         -- = sum of closing_drawer_counts.expected_amount (verifier)
  counted_cash_amount   INTEGER NOT NULL,
  difference_amount     INTEGER NOT NULL,
  difference_reason     TEXT,
  as_of_rev             INTEGER NOT NULL,         -- charges and money: rows with created_rev <= as_of_rev and this posting_date;
                                                  -- drawers: the cash_movements rev window since the drawer's previous count
  basis_json            TEXT    NOT NULL DEFAULT '{}',   -- the preview the manager confirmed (expected per drawer, van sync state)
  override_reason       TEXT,                     -- closed although a van device had unsent records or money findings were open
  report_json           TEXT    NOT NULL,         -- frozen report exactly as confirmed (reprint)
  report_schema         INTEGER NOT NULL,
  closed_at             TEXT    NOT NULL,
  actor_key             TEXT    NOT NULL,
  actor_name            TEXT    NOT NULL,
  device_id             TEXT,
  request_id            TEXT    NOT NULL,
  created_rev           INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id, business_date) REFERENCES business_days(shop_id, closing_scope_id, business_date),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (difference_amount = counted_cash_amount - expected_cash_amount)
) STRICT;
CREATE UNIQUE INDEX closings_version ON closings (shop_id, closing_scope_id, business_date, version_no);
CREATE UNIQUE INDEX closings_id_date ON closings (shop_id, id, closing_scope_id, business_date);   -- FK target of business_days

CREATE TABLE closing_reopenings (                 -- only a manager, with a reason; each version reopens once (append-only).
                                                  -- Only the LATEST closed date of a scope can be reopened (or every later closed
                                                  -- date first, as a cascade), so posting dates stay monotonic
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  id           TEXT    NOT NULL,
  closing_id   TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  reopened_at  TEXT    NOT NULL,
  actor_key    TEXT    NOT NULL,
  actor_name   TEXT    NOT NULL,
  request_id   TEXT    NOT NULL,
  created_rev  INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, closing_id) REFERENCES closings(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX closing_reopenings_once ON closing_reopenings (shop_id, closing_id);

CREATE TABLE closing_totals (                     -- queryable figures of a closing (append-only)
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  closing_id     TEXT    NOT NULL,
  metric_key     TEXT    NOT NULL,                -- charged, adjustment, payment, refund, net_received, deposit_in, cancellation ...
  dimension_key  TEXT    NOT NULL DEFAULT '',     -- '' | method:card | section:lift | item_kind:equipment | counterparty:<id> | tax:<key>
  amount         INTEGER NOT NULL,
  row_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, closing_id, metric_key, dimension_key),
  FOREIGN KEY (shop_id, closing_id) REFERENCES closings(shop_id, id)
) STRICT;

CREATE TABLE closing_drawer_counts (              -- one row per drawer and van wallet (append-only)
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  closing_id         TEXT    NOT NULL,
  cash_drawer_id     TEXT    NOT NULL,
  prev_closing_id    TEXT,                        -- the drawer's previous count (NULL = first count)
  prev_as_of_rev     INTEGER,                     -- expected = opening + sum(cash_movements.created_rev in (prev_as_of_rev, as_of_rev])
  count_status_key   TEXT    NOT NULL DEFAULT 'counted',   -- counted | deferred (a van wallet whose device has not synced:
                                                  -- not counted now, carried to the next count)
  opening_amount     INTEGER NOT NULL,            -- = counted_amount of prev_closing_id's row (verifier)
  expected_amount    INTEGER NOT NULL,
  counted_amount     INTEGER NOT NULL,
  difference_amount  INTEGER NOT NULL,
  difference_reason  TEXT,
  PRIMARY KEY (shop_id, closing_id, cash_drawer_id),
  FOREIGN KEY (shop_id, closing_id) REFERENCES closings(shop_id, id),
  FOREIGN KEY (shop_id, cash_drawer_id) REFERENCES cash_drawers(shop_id, id),
  FOREIGN KEY (shop_id, prev_closing_id, cash_drawer_id) REFERENCES closing_drawer_counts(shop_id, closing_id, cash_drawer_id),
  CHECK (difference_amount = counted_amount - expected_amount)
) STRICT;

CREATE TABLE closing_handover_items (             -- 인계: unfinished items carried to the next day (append-only)
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  closing_id           TEXT    NOT NULL,
  seq                  INTEGER NOT NULL CHECK (seq >= 1),
  order_id             TEXT,                      -- NULL for items without an order
  subject_type_key     TEXT,                      -- when not an order: vendor_refund | payment_intent | counterparty_trade |
                                                  -- asset | review_item | cash_transfer (code-owned)
  subject_id           TEXT,
  issue_key            TEXT    NOT NULL,          -- payment | customer_credit | deposit | return | late_entry | review |
                                                  -- promise_open | unconfirmed_transfer | unknown_card | vendor_refund_pending
  line_id              TEXT,
  due_amount           INTEGER NOT NULL DEFAULT 0,
  credit_amount        INTEGER NOT NULL DEFAULT 0,
  deposit_held_amount  INTEGER NOT NULL DEFAULT 0,
  open_quantity        INTEGER NOT NULL DEFAULT 0,
  reason_code_id       TEXT,
  assignee_staff_id    TEXT,
  next_date            TEXT,
  note                 TEXT,
  carried_forward      INTEGER NOT NULL DEFAULT 0 CHECK (carried_forward IN (0,1)),
  PRIMARY KEY (shop_id, closing_id, seq),
  FOREIGN KEY (shop_id, closing_id) REFERENCES closings(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, order_id, line_id) REFERENCES order_lines(shop_id, order_id, id),
  FOREIGN KEY (shop_id, reason_code_id) REFERENCES reason_codes(shop_id, id),
  FOREIGN KEY (shop_id, assignee_staff_id) REFERENCES staff_members(shop_id, id),
  CHECK (order_id IS NOT NULL OR (subject_type_key IS NOT NULL AND subject_id IS NOT NULL)),
  CHECK (line_id IS NULL OR order_id IS NOT NULL)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.15 Counterparty ledger (거래처 장부): trades, settlements, allocations (append-only).
-- Physical loans live in equipment_loans; lesson consignment is a trade kind.
-- -------------------------------------------------------------------------------------
CREATE TABLE counterparty_trades (
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  counterparty_id     TEXT    NOT NULL,
  trade_kind_key      TEXT    NOT NULL REFERENCES sys_trade_kinds(key),
  amount              INTEGER NOT NULL CHECK (amount > 0),    -- direction comes from the kind
  due_date            TEXT,
  reason              TEXT,
  order_id            TEXT,
  service_booking_id  TEXT,                       -- lesson consignment payable
  equipment_loan_id   TEXT,
  vendor_refund_id    TEXT,
  payment_id          TEXT,                       -- partner postpaid: the non-cash 'on_account' tender that cleared the order
  source_key          TEXT,                       -- what issued it, once: 'booking:<id>:<n>' (n = reissue after a cancel)
  cancels_trade_id    TEXT,                       -- a correction is a cancel record
  occurred_at         TEXT    NOT NULL,
  recorded_at         TEXT    NOT NULL,
  closing_scope_id    TEXT    NOT NULL DEFAULT 'main',
  business_date       TEXT    NOT NULL,
  posting_date        TEXT    NOT NULL,
  actor_key           TEXT    NOT NULL,
  actor_name          TEXT    NOT NULL,
  device_id           TEXT,
  request_id          TEXT    NOT NULL,
  created_rev         INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, service_booking_id) REFERENCES service_bookings(shop_id, id),
  FOREIGN KEY (shop_id, equipment_loan_id) REFERENCES equipment_loans(shop_id, id),
  FOREIGN KEY (shop_id, vendor_refund_id) REFERENCES vendor_refunds(shop_id, id),
  FOREIGN KEY (shop_id, payment_id) REFERENCES payments(shop_id, id),
  FOREIGN KEY (shop_id, cancels_trade_id) REFERENCES counterparty_trades(shop_id, id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX counterparty_trades_party ON counterparty_trades (shop_id, counterparty_id, business_date);
CREATE UNIQUE INDEX counterparty_trades_cancel_once ON counterparty_trades (shop_id, cancels_trade_id) WHERE cancels_trade_id IS NOT NULL;
-- one issue per source: closing a lesson booking twice cannot owe the team twice (a reissue after a cancel uses n+1)
CREATE UNIQUE INDEX counterparty_trades_source ON counterparty_trades (shop_id, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE counterparty_trade_lines (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  trade_id         TEXT    NOT NULL,
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  catalog_item_id  TEXT,
  label            TEXT    NOT NULL,              -- snapshot
  quantity         INTEGER NOT NULL CHECK (quantity >= 1),
  units            INTEGER NOT NULL DEFAULT 1 CHECK (units >= 1),   -- days / persons
  unit_amount      INTEGER NOT NULL CHECK (unit_amount >= 0),
  amount           INTEGER NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (shop_id, trade_id, seq),
  FOREIGN KEY (shop_id, trade_id) REFERENCES counterparty_trades(shop_id, id),
  FOREIGN KEY (shop_id, catalog_item_id) REFERENCES catalog_items(shop_id, id)
) STRICT;

CREATE TABLE counterparty_settlements (           -- money paid or received: THE cash-bearing ledger of all counterparty money
                                                  -- (partner shops, lesson teams, ticket-office refunds, postpaid partners)
  shop_id                TEXT    NOT NULL REFERENCES shops(id),
  id                     TEXT    NOT NULL,
  counterparty_id        TEXT    NOT NULL,
  kind_key               TEXT    NOT NULL,        -- payment (we pay) | receipt (we receive) (code-owned)
  offset_group_id        TEXT,                    -- 상계: a receipt and a payment of the same amount, no method, no drawer,
                                                  -- sharing this id; each is allocated to its own trades
  method_id              TEXT,                    -- NULL for an offset half or an imported unconfirmed method
  method_confirmed       INTEGER NOT NULL DEFAULT 1 CHECK (method_confirmed IN (0,1)),
  amount                 INTEGER NOT NULL CHECK (amount > 0),   -- = sum of its allocations (verifier)
  cash_drawer_id         TEXT,                    -- set exactly when the money was cash: the only cash_movements source for it
  cancels_settlement_id  TEXT,                    -- correction = cancel record + new record
  reason                 TEXT,
  occurred_at            TEXT    NOT NULL,
  recorded_at            TEXT    NOT NULL,
  closing_scope_id       TEXT    NOT NULL DEFAULT 'main',
  business_date          TEXT    NOT NULL,
  posting_date           TEXT    NOT NULL,
  actor_key              TEXT    NOT NULL,
  actor_name             TEXT    NOT NULL,
  device_id              TEXT,
  request_id             TEXT    NOT NULL,
  created_rev            INTEGER NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, counterparty_id) REFERENCES counterparties(shop_id, id),
  FOREIGN KEY (shop_id, method_id) REFERENCES payment_methods(shop_id, id),
  FOREIGN KEY (shop_id, cash_drawer_id, closing_scope_id) REFERENCES cash_drawers(shop_id, id, closing_scope_id),
  FOREIGN KEY (shop_id, closing_scope_id) REFERENCES closing_scopes(shop_id, id),
  FOREIGN KEY (shop_id, cancels_settlement_id) REFERENCES counterparty_settlements(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  CHECK (offset_group_id IS NULL OR (method_id IS NULL AND cash_drawer_id IS NULL)),
  CHECK (posting_date >= business_date)
) STRICT;
CREATE INDEX counterparty_settlements_party ON counterparty_settlements (shop_id, counterparty_id, business_date);
CREATE UNIQUE INDEX counterparty_settlements_cancel_once ON counterparty_settlements (shop_id, cancels_settlement_id) WHERE cancels_settlement_id IS NOT NULL;
CREATE INDEX counterparty_settlements_offset ON counterparty_settlements (shop_id, offset_group_id) WHERE offset_group_id IS NOT NULL;

CREATE TABLE counterparty_settlement_allocations (   -- sum per trade <= trade.amount, never onto a cancelled trade (verifier)
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  settlement_id  TEXT    NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  trade_id       TEXT    NOT NULL,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY (shop_id, settlement_id, seq),
  FOREIGN KEY (shop_id, settlement_id) REFERENCES counterparty_settlements(shop_id, id),
  FOREIGN KEY (shop_id, trade_id) REFERENCES counterparty_trades(shop_id, id)
) STRICT;
CREATE INDEX counterparty_settlement_allocations_trade ON counterparty_settlement_allocations (shop_id, trade_id);

-- -------------------------------------------------------------------------------------
-- 2.16 Documents and side effects: print jobs, SMS deliveries, the outbox
-- Side effects are written as outbox rows in the command transaction and executed after
-- commit. Their outcomes come back as system commands with deterministic request ids.
-- -------------------------------------------------------------------------------------
CREATE TABLE print_jobs (                         -- a printout is a record: template version + sources + frozen document
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  id                   TEXT    NOT NULL,
  template_id          TEXT    NOT NULL,
  template_version_no  INTEGER NOT NULL,
  printer_id           TEXT,
  order_id             TEXT,
  reprint_of_job_id    TEXT,
  params_json          TEXT,                      -- {"date":"2026-12-26","return_slot_id":"night"} for the collection list
  source_rev           INTEGER NOT NULL,          -- data revision the document was built from
  document_json        TEXT    NOT NULL,          -- frozen document; a reprint copies it (redactable: may hold names)
  document_hash        TEXT    NOT NULL,          -- detects '출력 후 변경됨' by comparing with a fresh render
  copies               INTEGER NOT NULL DEFAULT 1 CHECK (copies >= 1),
  status_key           TEXT    NOT NULL DEFAULT 'queued',   -- queued | dispatched | confirmed | failed | cancelled | unknown
  outbox_id            TEXT,
  requested_at         TEXT    NOT NULL,
  requested_by         TEXT    NOT NULL,
  device_id            TEXT,
  request_id           TEXT,
  created_rev          INTEGER NOT NULL,
  updated_rev          INTEGER NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, template_id, template_version_no) REFERENCES print_template_versions(shop_id, template_id, version_no),
  FOREIGN KEY (shop_id, printer_id) REFERENCES printers(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, reprint_of_job_id) REFERENCES print_jobs(shop_id, id),
  FOREIGN KEY (shop_id, outbox_id) REFERENCES outbox(shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE INDEX print_jobs_order ON print_jobs (shop_id, order_id) WHERE order_id IS NOT NULL;

CREATE TABLE print_job_sources (                  -- which records and versions a printout was built from
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  print_job_id    TEXT    NOT NULL,
  seq             INTEGER NOT NULL CHECK (seq >= 1),
  source_type     TEXT    NOT NULL,               -- order | intake_review | task | closing | route
  source_id       TEXT    NOT NULL,
  source_version  INTEGER,
  PRIMARY KEY (shop_id, print_job_id, seq),
  FOREIGN KEY (shop_id, print_job_id) REFERENCES print_jobs(shop_id, id)
) STRICT;

CREATE TABLE print_job_attempts (
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  print_job_id  TEXT    NOT NULL,
  seq           INTEGER NOT NULL CHECK (seq >= 1),
  status_key    TEXT    NOT NULL,
  error         TEXT,
  at            TEXT    NOT NULL,
  actor_key     TEXT,
  PRIMARY KEY (shop_id, print_job_id, seq),
  FOREIGN KEY (shop_id, print_job_id) REFERENCES print_jobs(shop_id, id)
) STRICT;

CREATE TABLE message_deliveries (                 -- business record of an SMS (the outbox row is the transport)
  shop_id              TEXT    NOT NULL REFERENCES shops(id),
  id                   TEXT    NOT NULL,
  template_id          TEXT,
  template_version_no  INTEGER,
  channel_key          TEXT    NOT NULL DEFAULT 'sms' REFERENCES sys_outbox_channels(key),
  recipient_kind_key   TEXT    NOT NULL DEFAULT 'phone',   -- phone | email | push | messenger (code-owned)
  recipient_value      TEXT,                      -- PII: address for the channel, blanked by anonymisation
  recipient_phone      TEXT,                      -- PII: phone recipients (kept for search), blanked by anonymisation
  order_id             TEXT,
  intake_request_id    TEXT,
  task_id              TEXT,
  body_snapshot        TEXT    NOT NULL,          -- redactable
  status_key           TEXT    NOT NULL DEFAULT 'prepared',   -- prepared | sending | accepted | delivered | failed | unknown | expired | suppressed
  provider_message_id  TEXT,
  outbox_id            TEXT,
  not_after            TEXT,                      -- a time-sensitive message is never sent after this instant
  anonymized_at        TEXT,
  created_at           TEXT    NOT NULL,
  created_by           TEXT    NOT NULL,
  request_id           TEXT,
  updated_rev          INTEGER NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, template_id, template_version_no) REFERENCES message_template_versions(shop_id, template_id, version_no),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, intake_request_id) REFERENCES intake_requests(shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id),
  FOREIGN KEY (shop_id, outbox_id) REFERENCES outbox(shop_id, id),
  CHECK (recipient_value IS NOT NULL OR recipient_phone IS NOT NULL OR anonymized_at IS NOT NULL)
) STRICT;
-- provider callbacks reach the shop through control.external_refs / inbound_events; this finds the row afterwards
CREATE UNIQUE INDEX message_deliveries_provider ON message_deliveries (shop_id, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE outbox (                             -- side effects to perform after commit
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  id                  TEXT    NOT NULL,
  channel_key         TEXT    NOT NULL REFERENCES sys_outbox_channels(key),
  target_key          TEXT,                       -- printer id | terminal id | provider key
  idempotency_key     TEXT    NOT NULL,           -- sent to the provider; derived from the originating request id, so a resend
                                                  -- after a restore carries the same key
  aggregate_type      TEXT    NOT NULL,
  aggregate_id        TEXT    NOT NULL,
  payload_json        TEXT    NOT NULL,
  status_key          TEXT    NOT NULL DEFAULT 'pending',   -- pending | in_flight | succeeded | failed | unknown | cancelled | expired | suppressed
                                                  -- claiming = its own committed transaction (in_flight, attempts + 1, an attempt row)
                                                  -- BEFORE the external call; an expired lease on an auto_retry = 0 row -> unknown
  auto_retry          INTEGER NOT NULL CHECK (auto_retry IN (0,1)),   -- copied from the channel at insert
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at     TEXT,
  not_after           TEXT,                       -- expire instead of sending late
  locked_by           TEXT,
  locked_until        TEXT,
  last_error          TEXT,
  external_id         TEXT,
  result_json         TEXT,
  source_request_id   TEXT    NOT NULL,           -- the command that created it
  outcome_request_id  TEXT,                       -- deterministic id of the system command that recorded the outcome
  replayed            INTEGER NOT NULL DEFAULT 0 CHECK (replayed IN (0,1)),   -- written by a restore replay or resend: an
                                                  -- auto_retry = 0 row starts as 'unknown' and is never dispatched by itself
  created_at          TEXT    NOT NULL,
  created_rev         INTEGER NOT NULL,
  completed_at        TEXT,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE UNIQUE INDEX outbox_idempotency ON outbox (shop_id, channel_key, idempotency_key);
CREATE INDEX outbox_ready ON outbox (shop_id, status_key, next_attempt_at) WHERE status_key IN ('pending', 'failed');
CREATE INDEX outbox_leases ON outbox (shop_id, locked_until) WHERE status_key = 'in_flight';

CREATE TABLE outbox_attempts (
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  outbox_id      TEXT    NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  started_at     TEXT    NOT NULL,
  finished_at    TEXT,
  outcome_key    TEXT,                            -- succeeded | failed | unknown | timeout
  response_json  TEXT,
  error          TEXT,
  PRIMARY KEY (shop_id, outbox_id, seq),
  FOREIGN KEY (shop_id, outbox_id) REFERENCES outbox(shop_id, id)
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.17 Journal, idempotency and sync. Tables are the truth; the journal is the audit
-- trail, the source of recovery segments and the oracle feed. A restore applies the
-- segments' row after-images; handlers are re-run only as a check (sync doc 10).
-- -------------------------------------------------------------------------------------
CREATE TABLE command_log (                        -- every command ever received: idempotency, device ordering, outcome
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  request_id         TEXT    NOT NULL,            -- THE idempotency key: a client ULID (made when the confirm dialog opens and
                                                  -- reused for every retry) or a deterministic system id ('outbox:<id>:<attempt>:<status>')
  actor_key          TEXT    NOT NULL,            -- 'staff:<id>' | 'system:<worker>' | 'form:<id>' | 'legacy:<role>:<id>' (never NULL);
                                                  -- data, not key: for queued commands the device-signed actor of the moment it happened
  submitted_by_key   TEXT,                        -- the session that delivered it, when different (PIN switch, shared van phone)
  actor_signature    TEXT,                        -- device-key signature over (shop_id, device_id, device_seq, request_id, type,
                                                  -- command_version, payload hash, ageMs, clockAnchor, recordedBy staff); occurred_at
                                                  -- is set by the server and therefore not signed
  device_id          TEXT,
  device_seq         INTEGER CHECK (device_seq IS NULL OR device_seq >= 1),   -- unique per device; gaps are detected, order is not forced
  command_type       TEXT    NOT NULL,
  command_version    INTEGER NOT NULL,
  fingerprint        TEXT    NOT NULL,            -- HMAC(shop secret key, canonical {type, version, payload} with names, phones and
                                                  -- free text replaced by references) — not a bare sha256 that a phone number
                                                  -- could be guessed from; not basis, times or seq
  status_key         TEXT    NOT NULL,            -- applied | partially_applied | superseded | needs_review | rejected | blocked |
                                                  -- conflict | held (arrived from a revoked device, or quarantined after it
                                                  -- crashed the writer; applied only when a person decides, sync doc 1 · 7)
  retryable          INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0,1)),   -- 1: a retry re-evaluates (DAY_CLOSED, SQLITE_BUSY, INTERNAL)
  error_code         TEXT,
  result_json        TEXT,                        -- the reply; nulled after result_expires_at, the row itself is kept
  result_expires_at  TEXT    NOT NULL,            -- retention setting, default 90 days
  applied_rev        INTEGER,
  basis_epoch_id     TEXT,                        -- epoch of the basis; another epoch = refresh conflict
  basis_rev          INTEGER,                     -- as_of_rev of the read model the decision was made on (not the sync cursor)
  depends_on_json    TEXT    NOT NULL DEFAULT '[]',   -- request ids this command needs (offline chains; never blocks money)
  time_source_key    TEXT    NOT NULL DEFAULT 'server',   -- server (online: occurred_at = recorded_at) | monotonic (queued: recorded_at
                                                  -- - age) | wall_clock (anchor lost: flagged, money/custody get a review item)
  occurred_at        TEXT    NOT NULL,
  received_at        TEXT    NOT NULL,
  finished_at        TEXT,
  PRIMARY KEY (shop_id, request_id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE INDEX command_log_actor ON command_log (shop_id, actor_key, received_at);
CREATE UNIQUE INDEX command_log_device_seq ON command_log (shop_id, device_id, device_seq) WHERE device_id IS NOT NULL AND device_seq IS NOT NULL;
CREATE INDEX command_log_result_expiry ON command_log (result_expires_at) WHERE result_json IS NOT NULL;
CREATE INDEX command_log_rev ON command_log (shop_id, applied_rev) WHERE applied_rev IS NOT NULL;

CREATE TABLE events (                             -- journal: one row per accepted command, hash-chained, append-only
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  rev              INTEGER NOT NULL,              -- per-shop revision of the write transaction
  epoch_id         TEXT    NOT NULL,              -- shop_instance.epoch_id when it was written
  request_id       TEXT    NOT NULL,
  actor_key        TEXT    NOT NULL,
  actor_name       TEXT    NOT NULL,
  actor_role_key   TEXT,
  device_id        TEXT,
  device_seq       INTEGER,
  command_type     TEXT    NOT NULL REFERENCES sys_event_types(key),
  command_version  INTEGER NOT NULL,
  engine_key       TEXT    NOT NULL,              -- native | legacy (facade) | import
  handler_version  TEXT    NOT NULL DEFAULT '',   -- app build of the handler; a re-execution check refuses a mismatch
  aggregate_type   TEXT,                          -- primary aggregate (order, task, closing ...)
  aggregate_id     TEXT,
  command_json     TEXT    NOT NULL,              -- canonical command WITH server-assigned ids, times and dates; PII-FREE: names,
                                                  -- phones and every free-text field (note, memo, reason, place_note) are
                                                  -- references into event_pii
  result_json      TEXT,                          -- includes the sha256 digest of every ledger row the command inserted,
                                                  -- so the chain covers the tables (the nightly verifier recomputes them)
  pii_commitment   TEXT,                          -- sha256(salt || event_pii.pii_json): the chain covers the PII by commitment
                                                  -- only, so redacting event_pii keeps the chain verifiable
  occurred_at      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  business_date    TEXT    NOT NULL,
  imported         INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0,1)),
  prev_hash        TEXT    NOT NULL,
  hash             TEXT    NOT NULL,              -- sha256(prev_hash || canonical(rev, request_id, actor_key, command_type,
                                                  -- command_json, result_json, pii_commitment, recorded_at))
  PRIMARY KEY (shop_id, rev),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE UNIQUE INDEX events_request ON events (shop_id, request_id);
CREATE INDEX events_aggregate ON events (shop_id, aggregate_type, aggregate_id, rev);

CREATE TABLE event_pii (                          -- personal data and free text a journal row refers to; purged by retention
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  rev          INTEGER NOT NULL,
  salt         TEXT    NOT NULL,                  -- random; kept with the row, dropped with it on purge
  pii_json     TEXT,                              -- {"customer":{"name":..., "phone":...}, "text":{"note":...}}; NULL once purged
  purge_after  TEXT    NOT NULL,                  -- default 30 days (retention). The PII part of a journal segment is kept 35 days
                                                  -- (backup_policy.journal_pii_keep_days) and daily snapshots 35 days, so a restore to
                                                  -- a point older than that has these values empty, as intended (sync doc 10-2)
  purged_at    TEXT,
  PRIMARY KEY (shop_id, rev),
  FOREIGN KEY (shop_id, rev) REFERENCES events(shop_id, rev)
) STRICT;
CREATE INDEX event_pii_purge ON event_pii (purge_after) WHERE purged_at IS NULL;

CREATE TABLE intent_marks (                       -- which conflict keys each revision touched (intent auto-rebase check)
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  conflict_key  TEXT    NOT NULL,                 -- 'line:<id>:return_promise', 'order:<id>:money', 'drawer:<id>:cash' (server-derived)
  rev           INTEGER NOT NULL,
  created_at    TEXT    NOT NULL,                 -- pruned after 30 days; an older basis gets a refresh conflict
  PRIMARY KEY (shop_id, conflict_key, rev)
) STRICT;
CREATE INDEX intent_marks_prune ON intent_marks (created_at);

CREATE TABLE change_log (                         -- which rows each revision touched, per visibility scope (delta sync)
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  rev             INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  scope_key       TEXT    NOT NULL,               -- 'store' | 'vehicle:<id>' | 'money' | 'public'
  entity_type     TEXT    NOT NULL,
  entity_id       TEXT    NOT NULL,
  op_key          TEXT    NOT NULL,               -- upsert | tombstone (tombstone: the row left this scope, e.g. task moved to another van)
  aggregate_type  TEXT,
  aggregate_id    TEXT,
  PRIMARY KEY (shop_id, rev, seq)
) STRICT;
CREATE INDEX change_log_scope ON change_log (shop_id, scope_key, rev);

CREATE TABLE device_sync_cursors (
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  device_id        TEXT    NOT NULL,
  stream_key       TEXT    NOT NULL,              -- changes | notifications
  epoch_id         TEXT    NOT NULL,
  last_rev         INTEGER NOT NULL DEFAULT 0,
  last_device_seq  INTEGER NOT NULL DEFAULT 0,
  clock_offset_ms  INTEGER,                       -- measured device clock skew
  queue_depth      INTEGER,                       -- reported by the client
  app_version      TEXT,
  schema_seen      INTEGER,
  last_pull_at     TEXT,
  last_push_at     TEXT,
  PRIMARY KEY (shop_id, device_id, stream_key),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;

CREATE TABLE review_items (                       -- '확인 필요' list at the counter: one plain sentence per item
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  id                 TEXT    NOT NULL,
  kind_key           TEXT    NOT NULL REFERENCES sys_review_kinds(key),
  source_key         TEXT    NOT NULL,            -- sync | outbox | closing | import | restore
  request_id         TEXT,
  device_id          TEXT,
  command_type       TEXT,
  order_id           TEXT,
  task_id            TEXT,
  entity_type        TEXT,
  entity_id          TEXT,
  message            TEXT    NOT NULL,            -- rendered from sys_review_kinds.message_template (shop locale)
  message_params_json TEXT   NOT NULL DEFAULT '{}',   -- its parameters: another locale re-renders from kind + params
  target_device_id   TEXT,                        -- routing 'origin_device': shown in context on the device that caused it
  target_actor_key   TEXT,
  detail_json        TEXT    NOT NULL,            -- both records, what was applied, what was not
  applied_part_json  TEXT,
  status_key         TEXT    NOT NULL DEFAULT 'open',   -- open | resolved | dismissed
  resolution_key     TEXT,
  resolution_note    TEXT,
  resolved_by        TEXT,
  resolved_at        TEXT,
  created_at         TEXT    NOT NULL,
  created_rev        INTEGER NOT NULL,
  updated_rev        INTEGER NOT NULL DEFAULT 0,
  version            INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id),
  FOREIGN KEY (shop_id, target_device_id) REFERENCES devices(shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id),
  FOREIGN KEY (shop_id, task_id) REFERENCES tasks(shop_id, id)
) STRICT;
CREATE INDEX review_items_open ON review_items (shop_id, created_at) WHERE status_key = 'open';
CREATE INDEX review_items_device ON review_items (shop_id, target_device_id) WHERE status_key = 'open' AND target_device_id IS NOT NULL;

CREATE TABLE integrity_findings (                 -- verifier output: technical, for the manager / developer, not the counter
  shop_id        TEXT    NOT NULL REFERENCES shops(id),
  id             TEXT    NOT NULL,
  run_id         TEXT    NOT NULL,
  check_key      TEXT    NOT NULL,                -- projection_drift | soft_reference | cash_source | unknown_status | hash_chain |
                                                  -- fk_check | row_digest | money_* (data-model 5: the money checks)
  entity_type    TEXT,
  entity_id      TEXT,
  expected_json  TEXT,
  actual_json    TEXT,
  repaired       INTEGER NOT NULL DEFAULT 0 CHECK (repaired IN (0,1)),
  status_key     TEXT    NOT NULL DEFAULT 'open', -- open | explained | fixed
  found_at       TEXT    NOT NULL,
  PRIMARY KEY (shop_id, id)
) STRICT;
CREATE INDEX integrity_findings_open ON integrity_findings (shop_id, found_at) WHERE status_key = 'open';

CREATE TABLE pii_access_log (                     -- who LOOKED AT personal data (reads; writes are in events): the full phone number
                                                  -- shown, a last-4 search, a printed list, an export, the day's working copy sent to a
                                                  -- device (deployment.md 10-4). A list read is one row. Kept retention.pii_access_days
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  id            TEXT    NOT NULL,                 -- ULID
  actor_key     TEXT    NOT NULL,
  device_id     TEXT,
  action_key    TEXT    NOT NULL,                 -- phone_reveal | last4_search | list_print | export | working_copy | support_view
  subject_type  TEXT,                             -- order | customer | list | copy
  subject_id    TEXT,
  item_count    INTEGER NOT NULL DEFAULT 1 CHECK (item_count >= 1),
  at            TEXT    NOT NULL,
  purge_after   TEXT    NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, device_id) REFERENCES devices(shop_id, id)
) STRICT;
CREATE INDEX pii_access_log_at ON pii_access_log (shop_id, at);
CREATE INDEX pii_access_log_purge ON pii_access_log (purge_after);

CREATE TABLE journal_exports (                    -- journal segments: events + event_pii + command_log rows + the AFTER-IMAGES of
                                                  -- every row written (restore applies after-images; re-execution only checks)
  shop_id          TEXT    NOT NULL REFERENCES shops(id),
  id               TEXT    NOT NULL,
  epoch_id         TEXT    NOT NULL,
  format_version   INTEGER NOT NULL DEFAULT 1,
  from_rev         INTEGER NOT NULL,
  to_rev           INTEGER NOT NULL,
  first_prev_hash  TEXT    NOT NULL,
  last_hash        TEXT    NOT NULL,
  file_name        TEXT    NOT NULL,
  sha256           TEXT    NOT NULL,
  bytes            INTEGER NOT NULL CHECK (bytes >= 0),
  target_key       TEXT    NOT NULL,              -- second_store (another company's store in Korea, every minute) | edge_peer
                                                  -- (a hybrid shop's centre copy, later)
  part_key         TEXT    NOT NULL DEFAULT 'main',   -- main (events without PII, command_log, after-images without PII columns; kept
                                                  -- for the season) | pii (event_pii and the PII columns of after-images; its own
                                                  -- object with a 35-day lifecycle rule) (code-owned, deployment.md 6-1)
  key_id           TEXT,                          -- the data key it was encrypted to (per shop; pii parts per shop and month, so a
                                                  -- destroyed key erases them too)
  expires_at       TEXT,                          -- when the store's lifecycle rule deletes it
  status_key       TEXT    NOT NULL,              -- written | verified | offsite | failed
  created_at       TEXT    NOT NULL,
  offsite_at       TEXT,
  PRIMARY KEY (shop_id, id),
  CHECK (to_rev >= from_rev)
) STRICT;
CREATE INDEX journal_exports_rev ON journal_exports (shop_id, to_rev);

-- -------------------------------------------------------------------------------------
-- 2.18 Legacy import, transition and archive bookkeeping
-- -------------------------------------------------------------------------------------
CREATE TABLE legacy_import_runs (
  id                  TEXT    NOT NULL PRIMARY KEY,
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  source_kind         TEXT    NOT NULL,           -- workflow_state | return_orders | notification_state | access_file
  source_file         TEXT,
  source_fingerprint  TEXT    NOT NULL,           -- sha256 of the source blob / rows
  source_revision     INTEGER,
  status_key          TEXT    NOT NULL,           -- running | verified | failed
  started_at          TEXT    NOT NULL,
  finished_at         TEXT,
  counts_json         TEXT,
  oracle_before_json  TEXT,                       -- legacy engine read models
  oracle_after_json   TEXT,                       -- the same read models from the new tables
  error               TEXT
) STRICT;
CREATE UNIQUE INDEX legacy_import_runs_source ON legacy_import_runs (shop_id, source_kind, source_fingerprint) WHERE status_key = 'verified';

CREATE TABLE legacy_records (                     -- every legacy element -> the row it became, plus fields with no column
  shop_id             TEXT    NOT NULL REFERENCES shops(id),
  source_collection   TEXT    NOT NULL,           -- 'orders', 'orders.lines', 'movements', 'forms' ...
  source_id           TEXT    NOT NULL,           -- the ORIGINAL legacy id (new rows carry it with the shop-code prefix)
  import_run_id       TEXT    REFERENCES legacy_import_runs(id),   -- NULL = written live by the legacy facade
  mapped_entity_type  TEXT,
  mapped_entity_id    TEXT,
  residue_json        TEXT,                       -- fields the codec keeps for an exact round trip (redactable)
  residue_schema      INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT    NOT NULL,
  updated_rev         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, source_collection, source_id)
) STRICT;
CREATE INDEX legacy_records_mapped ON legacy_records (shop_id, mapped_entity_type, mapped_entity_id);

CREATE TABLE legacy_events (                      -- raw copies of workflow_events / return_events / blob events (redactable)
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  source_table    TEXT    NOT NULL,
  source_key      TEXT    NOT NULL,               -- version, or order_id:version
  request_id      TEXT,
  event_json      TEXT    NOT NULL,
  import_run_id   TEXT    NOT NULL REFERENCES legacy_import_runs(id),
  redacted_at     TEXT,
  PRIMARY KEY (shop_id, source_table, source_key)
) STRICT;

CREATE TABLE legacy_value_map (                   -- legacy value -> new row (place strings, vendor ids, staff, actors)
  shop_id            TEXT    NOT NULL REFERENCES shops(id),
  source_collection  TEXT    NOT NULL,            -- 'settings.places', 'ticket.vendorId', 'actor', 'settings.staff'
  source_value       TEXT    NOT NULL,
  target_table       TEXT    NOT NULL,
  target_id          TEXT    NOT NULL,
  import_run_id      TEXT    NOT NULL REFERENCES legacy_import_runs(id),
  PRIMARY KEY (shop_id, source_collection, source_value, target_table)
) STRICT;

CREATE TABLE native_only_aggregates (             -- aggregates the legacy facade must refuse (state it cannot express)
  shop_id         TEXT    NOT NULL REFERENCES shops(id),
  aggregate_type  TEXT    NOT NULL,               -- order | task | payment_group
  aggregate_id    TEXT    NOT NULL,
  reason_key      TEXT    NOT NULL,               -- split_promise | prepayment | multi_order_payment | lesson | route_rank
  since_rev       INTEGER NOT NULL,
  created_at      TEXT    NOT NULL,
  PRIMARY KEY (shop_id, aggregate_type, aggregate_id)
) STRICT;

CREATE TABLE archive_manifests (                  -- journal rows moved to a season archive file (append-only). The archive file
                                                  -- carries its own schema_migrations; attaching it first applies the missing
                                                  -- forward migrations, and archives are read through explicit column lists
  id            TEXT    NOT NULL PRIMARY KEY,
  shop_id       TEXT    NOT NULL REFERENCES shops(id),
  table_name    TEXT    NOT NULL,                 -- events | change_log | command_log | outbox_attempts
  epoch_id      TEXT    NOT NULL,
  schema_version INTEGER NOT NULL,                -- highest schema_migrations.id of the file when it was written
  season_id     TEXT,
  from_rev      INTEGER NOT NULL,
  to_rev        INTEGER NOT NULL,
  from_date     TEXT,
  to_date       TEXT,
  archive_file  TEXT    NOT NULL,
  row_count     INTEGER NOT NULL CHECK (row_count >= 0),
  checksum      TEXT    NOT NULL,
  first_hash    TEXT,                             -- events: chain anchors, so the chain is verifiable across files
  last_hash     TEXT,
  created_at    TEXT    NOT NULL,
  FOREIGN KEY (shop_id, season_id) REFERENCES seasons(shop_id, id),
  CHECK (to_rev >= from_rev)
) STRICT;
CREATE INDEX archive_manifests_table ON archive_manifests (shop_id, table_name, from_rev);

CREATE TABLE archive_verifications (              -- a verified copy (append-only); the journal delete guard requires this row,
                                                  -- not a mutable status on the manifest
  shop_id      TEXT    NOT NULL REFERENCES shops(id),
  manifest_id  TEXT    NOT NULL PRIMARY KEY REFERENCES archive_manifests(id),
  row_count    INTEGER NOT NULL CHECK (row_count >= 0),
  checksum     TEXT    NOT NULL,                  -- recomputed from the archive file; must equal the manifest
  verified_at  TEXT    NOT NULL,
  actor_key    TEXT    NOT NULL
) STRICT;

-- -------------------------------------------------------------------------------------
-- 2.19 Guards (the only triggers in this schema; generated from the column lists, CI keeps
-- them in sync). Ledger rows can never be updated or deleted, whatever the application code
-- does; a correction is a new row. The update guard names the 0001 columns (BEFORE UPDATE OF),
-- so a migration can back-fill a column it adds and then installs that column's own guard:
--   set once:  BEFORE UPDATE OF new_col ON t WHEN OLD.new_col IS NOT NULL -> RAISE
--   required from migration N on: BEFORE INSERT ON t WHEN NEW.new_col IS NULL -> RAISE
-- Free-text columns (reason, memo, note ...) are redact-only: they may become '(지움)', nothing
-- else. REPLACE deletes fire the DELETE guards because recursive_triggers = ON (header).
-- PostgreSQL: one plpgsql function raising an exception, attached BEFORE UPDATE OF ... / DELETE,
-- plus REVOKE UPDATE, DELETE from the app role on the ledger tables.  [SQLite RAISE]
-- -------------------------------------------------------------------------------------
CREATE TRIGGER shop_settings_no_update BEFORE UPDATE OF
  shop_id, setting_key, scope_key, version_no, value_json, value_schema, effective_from, created_at, created_by,
  request_id, created_rev
  ON shop_settings BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY shop_settings'); END;
CREATE TRIGGER shop_settings_no_delete BEFORE DELETE ON shop_settings BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY shop_settings'); END;
CREATE TRIGGER config_changes_no_update BEFORE UPDATE OF
  shop_id, config_rev, seq, entity_type, entity_id, before_json, after_json, actor_key, request_id, at
  ON config_changes BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY config_changes'); END;
CREATE TRIGGER config_changes_no_delete BEFORE DELETE ON config_changes BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY config_changes'); END;
CREATE TRIGGER template_applications_no_update BEFORE UPDATE OF
  shop_id, id, template_id, template_version, added_json, skipped_json, applied_at, applied_by, request_id
  ON template_applications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY template_applications'); END;
CREATE TRIGGER template_applications_no_delete BEFORE DELETE ON template_applications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY template_applications'); END;
CREATE TRIGGER ui_default_applications_no_update BEFORE UPDATE OF
  shop_id, default_rev, applied_at, added_json, updated_json, kept_json, request_id
  ON ui_default_applications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY ui_default_applications'); END;
CREATE TRIGGER ui_default_applications_no_delete BEFORE DELETE ON ui_default_applications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY ui_default_applications'); END;
CREATE TRIGGER device_sign_ins_no_update BEFORE UPDATE OF
  shop_id, device_id, seq, staff_member_id, method_key, signed_in_at, session_id, created_rev
  ON device_sign_ins BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY device_sign_ins'); END;
CREATE TRIGGER device_sign_ins_no_delete BEFORE DELETE ON device_sign_ins BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY device_sign_ins'); END;
CREATE TRIGGER discount_applications_no_update BEFORE UPDATE OF
  shop_id, id, order_id, batch_id, discount_group_id, discount_rule_id, kind_key, label, value_amount,
  value_percent_bp, rounding_unit, total_amount, supersedes_application_id, occurred_at, recorded_at, actor_key,
  actor_name, request_id, created_rev
  ON discount_applications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY discount_applications'); END;
CREATE TRIGGER discount_applications_redact_only BEFORE UPDATE OF reason ON discount_applications
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY discount_applications'); END;
CREATE TRIGGER discount_applications_no_delete BEFORE DELETE ON discount_applications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY discount_applications'); END;
CREATE TRIGGER line_price_components_no_update BEFORE UPDATE OF
  shop_id, order_id, line_id, seq, component_key, price_rule_id, discount_application_id, label, quantity, units,
  unit_amount, percent_bp, service_date, amount, created_at, created_rev
  ON line_price_components BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY line_price_components'); END;
CREATE TRIGGER line_price_components_redact_only BEFORE UPDATE OF reason ON line_price_components
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY line_price_components'); END;
CREATE TRIGGER line_price_components_no_delete BEFORE DELETE ON line_price_components BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY line_price_components'); END;
CREATE TRIGGER order_cancellations_no_update BEFORE UPDATE OF
  shop_id, id, order_id, reason_code_id, refund_decision_key, total_amount, occurred_at, recorded_at,
  closing_scope_id, business_date, posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON order_cancellations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_cancellations'); END;
CREATE TRIGGER order_cancellations_redact_only BEFORE UPDATE OF reason ON order_cancellations
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY order_cancellations'); END;
CREATE TRIGGER order_cancellations_no_delete BEFORE DELETE ON order_cancellations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_cancellations'); END;
CREATE TRIGGER order_cancellation_lines_no_update BEFORE UPDATE OF
  shop_id, cancellation_id, order_id, line_id, quantity, amount, adjustment_id
  ON order_cancellation_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_cancellation_lines'); END;
CREATE TRIGGER order_cancellation_lines_no_delete BEFORE DELETE ON order_cancellation_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_cancellation_lines'); END;
CREATE TRIGGER order_extensions_no_update BEFORE UPDATE OF
  shop_id, id, order_id, total_amount, occurred_at, recorded_at, closing_scope_id, business_date, posting_date,
  actor_key, actor_name, device_id, request_id, created_rev
  ON order_extensions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_extensions'); END;
CREATE TRIGGER order_extensions_redact_only BEFORE UPDATE OF reason ON order_extensions
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY order_extensions'); END;
CREATE TRIGGER order_extensions_no_delete BEFORE DELETE ON order_extensions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_extensions'); END;
CREATE TRIGGER order_extension_lines_no_update BEFORE UPDATE OF
  shop_id, extension_id, order_id, line_id, scope_key, quantity, before_end_date, before_end_time, after_end_date,
  after_end_time, return_slot_id, slot_label, slot_local_time, price_basis_key, added_units, added_minutes, amount,
  adjustment_id, new_promise_id
  ON order_extension_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_extension_lines'); END;
CREATE TRIGGER order_extension_lines_no_delete BEFORE DELETE ON order_extension_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_extension_lines'); END;
CREATE TRIGGER order_extension_assets_no_update BEFORE UPDATE OF
  shop_id, extension_id, line_id, asset_id, before_end_date, before_end_time, after_end_date, after_end_time
  ON order_extension_assets BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_extension_assets'); END;
CREATE TRIGGER order_extension_assets_no_delete BEFORE DELETE ON order_extension_assets BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY order_extension_assets'); END;
CREATE TRIGGER intake_submissions_no_update BEFORE UPDATE OF
  shop_id, id, intake_request_id, version_no, status_key, submitted_at, client_ip_hash, created_rev
  ON intake_submissions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_submissions'); END;
CREATE TRIGGER intake_submissions_no_delete BEFORE DELETE ON intake_submissions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_submissions'); END;
CREATE TRIGGER intake_submission_people_no_update BEFORE UPDATE OF
  shop_id, id, submission_id, seq, client_person_key, order_person_id
  ON intake_submission_people BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_submission_people'); END;
CREATE TRIGGER intake_submission_people_redact_only BEFORE UPDATE OF name ON intake_submission_people
  WHEN (NEW.name IS NOT OLD.name AND NEW.name IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY intake_submission_people'); END;
CREATE TRIGGER intake_submission_people_no_delete BEFORE DELETE ON intake_submission_people BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_submission_people'); END;
CREATE TRIGGER intake_answers_no_update BEFORE UPDATE OF
  shop_id, submission_person_id, attribute_id, value_seq, value_int, value_real, option_id, value_unit, unknown_flag,
  question_label_snapshot
  ON intake_answers BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_answers'); END;
CREATE TRIGGER intake_answers_redact_only BEFORE UPDATE OF value_text ON intake_answers
  WHEN (NEW.value_text IS NOT OLD.value_text AND NEW.value_text IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY intake_answers'); END;
CREATE TRIGGER intake_answers_no_delete BEFORE DELETE ON intake_answers BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_answers'); END;
CREATE TRIGGER intake_reviews_no_update BEFORE UPDATE OF
  shop_id, id, intake_request_id, version_no, source_submission_id, reviewed_at, actor_key, actor_name, request_id,
  created_rev
  ON intake_reviews BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_reviews'); END;
CREATE TRIGGER intake_reviews_no_delete BEFORE DELETE ON intake_reviews BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY intake_reviews'); END;
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE OF
  shop_id, id, kind_key, from_location_id, from_kind_key, to_location_id, to_kind_key, order_id, task_id,
  counterparty_id, exchange_id, early_return_id, vendor_refund_id, equipment_loan_id, intake_request_id,
  reverses_movement_id, transfer_ref, source_reference, late_fact, skipped_hop, reason_code_id, occurred_at,
  recorded_at, closing_scope_id, business_date, posting_date, actor_key, actor_name, device_id, request_id,
  created_rev
  ON stock_movements BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY stock_movements'); END;
CREATE TRIGGER stock_movements_redact_only BEFORE UPDATE OF reason, memo ON stock_movements
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)') OR (NEW.memo IS NOT OLD.memo AND NEW.memo IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY stock_movements'); END;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY stock_movements'); END;
CREATE TRIGGER stock_movement_lines_no_update BEFORE UPDATE OF
  shop_id, movement_id, line_no, catalog_item_id, asset_id, variant_id, quantity, owner_counterparty_id, lot_id,
  order_id, order_line_id, claim_id, before_condition_id, after_condition_id, created_rev
  ON stock_movement_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY stock_movement_lines'); END;
CREATE TRIGGER stock_movement_lines_no_delete BEFORE DELETE ON stock_movement_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY stock_movement_lines'); END;
CREATE TRIGGER stock_movement_reversals_no_update BEFORE UPDATE OF
  shop_id, reversed_movement_id, reversed_line_no, reversal_movement_id, reversal_line_no, created_rev
  ON stock_movement_reversals BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY stock_movement_reversals'); END;
CREATE TRIGGER stock_movement_reversals_no_delete BEFORE DELETE ON stock_movement_reversals BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY stock_movement_reversals'); END;
CREATE TRIGGER asset_reclassifications_no_update BEFORE UPDATE OF
  shop_id, id, asset_id, from_catalog_item_id, to_catalog_item_id, from_variant_id, to_variant_id, reason_code_id,
  occurred_at, recorded_at, business_date, posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON asset_reclassifications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY asset_reclassifications'); END;
CREATE TRIGGER asset_reclassifications_redact_only BEFORE UPDATE OF reason ON asset_reclassifications
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY asset_reclassifications'); END;
CREATE TRIGGER asset_reclassifications_no_delete BEFORE DELETE ON asset_reclassifications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY asset_reclassifications'); END;
CREATE TRIGGER asset_condition_changes_no_update BEFORE UPDATE OF
  shop_id, id, asset_id, from_condition_id, to_condition_id, from_variant_id, to_variant_id, last_known_location_id,
  movement_id, exchange_id, reason_code_id, occurred_at, recorded_at, closing_scope_id, business_date, posting_date,
  actor_key, actor_name, device_id, request_id, created_rev
  ON asset_condition_changes BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY asset_condition_changes'); END;
CREATE TRIGGER asset_condition_changes_redact_only BEFORE UPDATE OF reason ON asset_condition_changes
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY asset_condition_changes'); END;
CREATE TRIGGER asset_condition_changes_no_delete BEFORE DELETE ON asset_condition_changes BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY asset_condition_changes'); END;
CREATE TRIGGER exchange_recoveries_no_update BEFORE UPDATE OF
  shop_id, id, exchange_id, reversal_movement_id, occurred_at, actor_key, actor_name, request_id, created_rev
  ON exchange_recoveries BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY exchange_recoveries'); END;
CREATE TRIGGER exchange_recoveries_redact_only BEFORE UPDATE OF reason ON exchange_recoveries
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY exchange_recoveries'); END;
CREATE TRIGGER exchange_recoveries_no_delete BEFORE DELETE ON exchange_recoveries BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY exchange_recoveries'); END;
CREATE TRIGGER vendor_refund_attempts_no_update BEFORE UPDATE OF
  shop_id, id, vendor_refund_id, amount, unit_count, movement_id, settlement_id, occurred_at, recorded_at,
  closing_scope_id, business_date, posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON vendor_refund_attempts BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY vendor_refund_attempts'); END;
CREATE TRIGGER vendor_refund_attempts_redact_only BEFORE UPDATE OF note ON vendor_refund_attempts
  WHEN (NEW.note IS NOT OLD.note AND NEW.note IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY vendor_refund_attempts'); END;
CREATE TRIGGER vendor_refund_attempts_no_delete BEFORE DELETE ON vendor_refund_attempts BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY vendor_refund_attempts'); END;
CREATE TRIGGER task_visits_no_update BEFORE UPDATE OF
  shop_id, id, task_id, seq, result_reason_id, retry_key, before_date, before_time, before_place_name, after_date,
  after_time, after_place_id, after_place_name, remaining_quantity, occurred_at, recorded_at, business_date,
  actor_key, actor_name, device_id, request_id, created_rev
  ON task_visits BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY task_visits'); END;
CREATE TRIGGER task_visits_redact_only BEFORE UPDATE OF reason ON task_visits
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY task_visits'); END;
CREATE TRIGGER task_visits_no_delete BEFORE DELETE ON task_visits BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY task_visits'); END;
CREATE TRIGGER task_reassignments_no_update BEFORE UPDATE OF
  shop_id, id, task_id, from_vehicle_id, to_vehicle_id, from_date, to_date, from_time, to_time, occurred_at,
  actor_key, actor_name, request_id, created_rev
  ON task_reassignments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY task_reassignments'); END;
CREATE TRIGGER task_reassignments_redact_only BEFORE UPDATE OF reason ON task_reassignments
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY task_reassignments'); END;
CREATE TRIGGER task_reassignments_no_delete BEFORE DELETE ON task_reassignments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY task_reassignments'); END;
CREATE TRIGGER payment_groups_no_update BEFORE UPDATE OF
  shop_id, id, group_no, purpose_key, occurred_at, actor_key, actor_name, device_id, request_id, created_rev
  ON payment_groups BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_groups'); END;
CREATE TRIGGER payment_groups_redact_only BEFORE UPDATE OF note ON payment_groups
  WHEN (NEW.note IS NOT OLD.note AND NEW.note IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY payment_groups'); END;
CREATE TRIGGER payment_groups_no_delete BEFORE DELETE ON payment_groups BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_groups'); END;
CREATE TRIGGER payment_intent_allocations_no_update BEFORE UPDATE OF
  shop_id, intent_id, seq, order_id, line_id, amount, allocated_quantity
  ON payment_intent_allocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_intent_allocations'); END;
CREATE TRIGGER payment_intent_allocations_no_delete BEFORE DELETE ON payment_intent_allocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_intent_allocations'); END;
CREATE TRIGGER payments_no_update BEFORE UPDATE OF
  shop_id, id, payment_group_id, kind_key, kind_requires_refund_of, kind_requires_deposit, kind_cash_sign,
  purpose_key, method_id, method_affects_cash, amount, cash_drawer_id, terminal_id, payment_intent_id, approval_no,
  approved_business_date, external_reference, refund_of_payment_id, deposit_id, payer_order_id, payer_customer_id,
  payer_counterparty_id, collected_by_vehicle_id, occurred_at, recorded_at, closing_scope_id, business_date,
  posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON payments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payments'); END;
CREATE TRIGGER payments_redact_only BEFORE UPDATE OF reason ON payments
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY payments'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payments'); END;
CREATE TRIGGER tax_documents_no_update BEFORE UPDATE OF
  shop_id, id, kind_key, payment_id, amount, supply_amount, tax_amount, breakdown_json, approval_no, status_key,
  cancels_document_id, occurred_at, recorded_at, closing_scope_id, business_date, posting_date, actor_key,
  actor_name, device_id, request_id, created_rev
  ON tax_documents BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY tax_documents'); END;
CREATE TRIGGER tax_documents_no_delete BEFORE DELETE ON tax_documents BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY tax_documents'); END;
CREATE TRIGGER payment_reallocations_no_update BEFORE UPDATE OF
  shop_id, id, payment_id, occurred_at, recorded_at, closing_scope_id, business_date, posting_date, actor_key,
  actor_name, device_id, request_id, created_rev
  ON payment_reallocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_reallocations'); END;
CREATE TRIGGER payment_reallocations_redact_only BEFORE UPDATE OF reason ON payment_reallocations
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY payment_reallocations'); END;
CREATE TRIGGER payment_reallocations_no_delete BEFORE DELETE ON payment_reallocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_reallocations'); END;
CREATE TRIGGER payment_allocations_no_update BEFORE UPDATE OF
  shop_id, payment_id, seq, order_id, line_id, amount, allocated_quantity, reallocation_id, closing_scope_id,
  business_date, posting_date, actor_key, request_id, created_rev
  ON payment_allocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_allocations'); END;
CREATE TRIGGER payment_allocations_no_delete BEFORE DELETE ON payment_allocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY payment_allocations'); END;
CREATE TRIGGER deposit_entries_no_update BEFORE UPDATE OF
  shop_id, deposit_id, seq, order_id, line_id, asset_id, entry_kind_key, payment_kind_key, quantity, amount,
  payment_id, movement_id, movement_line_no, closing_id, reason_code_id, occurred_at, recorded_at, closing_scope_id,
  business_date, posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON deposit_entries BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY deposit_entries'); END;
CREATE TRIGGER deposit_entries_redact_only BEFORE UPDATE OF reason ON deposit_entries
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY deposit_entries'); END;
CREATE TRIGGER deposit_entries_no_delete BEFORE DELETE ON deposit_entries BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY deposit_entries'); END;
CREATE TRIGGER charge_adjustments_no_update BEFORE UPDATE OF
  shop_id, id, order_id, line_id, adjustment_type_id, type_sign, amount, extension_id, cancellation_id,
  service_booking_id, discount_application_id, occurred_at, recorded_at, closing_scope_id, business_date,
  posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON charge_adjustments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY charge_adjustments'); END;
CREATE TRIGGER charge_adjustments_redact_only BEFORE UPDATE OF reason ON charge_adjustments
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY charge_adjustments'); END;
CREATE TRIGGER charge_adjustments_no_delete BEFORE DELETE ON charge_adjustments BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY charge_adjustments'); END;
CREATE TRIGGER adjustment_assets_no_update BEFORE UPDATE OF
  shop_id, adjustment_id, asset_id, movement_id, created_rev
  ON adjustment_assets BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY adjustment_assets'); END;
CREATE TRIGGER adjustment_assets_no_delete BEFORE DELETE ON adjustment_assets BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY adjustment_assets'); END;
CREATE TRIGGER cash_entries_no_update BEFORE UPDATE OF
  shop_id, id, cash_drawer_id, direction_key, amount, reason_code_id, occurred_at, recorded_at, closing_scope_id,
  business_date, posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON cash_entries BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY cash_entries'); END;
CREATE TRIGGER cash_entries_redact_only BEFORE UPDATE OF reason ON cash_entries
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY cash_entries'); END;
CREATE TRIGGER cash_entries_no_delete BEFORE DELETE ON cash_entries BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY cash_entries'); END;
CREATE TRIGGER cash_transfers_no_update BEFORE UPDATE OF
  shop_id, id, from_drawer_id, to_drawer_id, transit_drawer_id, amount, occurred_at, recorded_at, closing_scope_id,
  business_date, posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON cash_transfers BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY cash_transfers'); END;
CREATE TRIGGER cash_transfers_redact_only BEFORE UPDATE OF note ON cash_transfers
  WHEN (NEW.note IS NOT OLD.note AND NEW.note IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY cash_transfers'); END;
CREATE TRIGGER cash_transfers_no_delete BEFORE DELETE ON cash_transfers BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY cash_transfers'); END;
CREATE TRIGGER cash_transfer_confirmations_no_update BEFORE UPDATE OF
  shop_id, transfer_id, counted_amount, difference_amount, over_short_drawer_id, reason_code_id, confirmed_at,
  recorded_at, closing_scope_id, business_date, posting_date, actor_key, actor_name, device_id, request_id,
  created_rev
  ON cash_transfer_confirmations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY cash_transfer_confirmations'); END;
CREATE TRIGGER cash_transfer_confirmations_redact_only BEFORE UPDATE OF note ON cash_transfer_confirmations
  WHEN (NEW.note IS NOT OLD.note AND NEW.note IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY cash_transfer_confirmations'); END;
CREATE TRIGGER cash_transfer_confirmations_no_delete BEFORE DELETE ON cash_transfer_confirmations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY cash_transfer_confirmations'); END;
CREATE TRIGGER closings_no_update BEFORE UPDATE OF
  shop_id, id, closing_scope_id, business_date, version_no, opening_cash_amount, expected_cash_amount,
  counted_cash_amount, difference_amount, as_of_rev, basis_json, report_json, report_schema, closed_at, actor_key,
  actor_name, device_id, request_id, created_rev
  ON closings BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closings'); END;
CREATE TRIGGER closings_redact_only BEFORE UPDATE OF difference_reason, override_reason ON closings
  WHEN (NEW.difference_reason IS NOT OLD.difference_reason AND NEW.difference_reason IS NOT '(지움)') OR (NEW.override_reason IS NOT OLD.override_reason AND NEW.override_reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY closings'); END;
CREATE TRIGGER closings_no_delete BEFORE DELETE ON closings BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closings'); END;
CREATE TRIGGER closing_reopenings_no_update BEFORE UPDATE OF
  shop_id, id, closing_id, reopened_at, actor_key, actor_name, request_id, created_rev
  ON closing_reopenings BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_reopenings'); END;
CREATE TRIGGER closing_reopenings_redact_only BEFORE UPDATE OF reason ON closing_reopenings
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY closing_reopenings'); END;
CREATE TRIGGER closing_reopenings_no_delete BEFORE DELETE ON closing_reopenings BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_reopenings'); END;
CREATE TRIGGER closing_totals_no_update BEFORE UPDATE OF
  shop_id, closing_id, metric_key, dimension_key, amount, row_count
  ON closing_totals BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_totals'); END;
CREATE TRIGGER closing_totals_no_delete BEFORE DELETE ON closing_totals BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_totals'); END;
CREATE TRIGGER closing_drawer_counts_no_update BEFORE UPDATE OF
  shop_id, closing_id, cash_drawer_id, prev_closing_id, prev_as_of_rev, count_status_key, opening_amount,
  expected_amount, counted_amount, difference_amount
  ON closing_drawer_counts BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_drawer_counts'); END;
CREATE TRIGGER closing_drawer_counts_redact_only BEFORE UPDATE OF difference_reason ON closing_drawer_counts
  WHEN (NEW.difference_reason IS NOT OLD.difference_reason AND NEW.difference_reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY closing_drawer_counts'); END;
CREATE TRIGGER closing_drawer_counts_no_delete BEFORE DELETE ON closing_drawer_counts BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_drawer_counts'); END;
CREATE TRIGGER closing_handover_items_no_update BEFORE UPDATE OF
  shop_id, closing_id, seq, order_id, subject_type_key, subject_id, issue_key, line_id, due_amount, credit_amount,
  deposit_held_amount, open_quantity, reason_code_id, assignee_staff_id, next_date, carried_forward
  ON closing_handover_items BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_handover_items'); END;
CREATE TRIGGER closing_handover_items_redact_only BEFORE UPDATE OF note ON closing_handover_items
  WHEN (NEW.note IS NOT OLD.note AND NEW.note IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY closing_handover_items'); END;
CREATE TRIGGER closing_handover_items_no_delete BEFORE DELETE ON closing_handover_items BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY closing_handover_items'); END;
CREATE TRIGGER counterparty_trades_no_update BEFORE UPDATE OF
  shop_id, id, counterparty_id, trade_kind_key, amount, due_date, order_id, service_booking_id, equipment_loan_id,
  vendor_refund_id, payment_id, source_key, cancels_trade_id, occurred_at, recorded_at, closing_scope_id,
  business_date, posting_date, actor_key, actor_name, device_id, request_id, created_rev
  ON counterparty_trades BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_trades'); END;
CREATE TRIGGER counterparty_trades_redact_only BEFORE UPDATE OF reason ON counterparty_trades
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY counterparty_trades'); END;
CREATE TRIGGER counterparty_trades_no_delete BEFORE DELETE ON counterparty_trades BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_trades'); END;
CREATE TRIGGER counterparty_trade_lines_no_update BEFORE UPDATE OF
  shop_id, trade_id, seq, catalog_item_id, label, quantity, units, unit_amount, amount
  ON counterparty_trade_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_trade_lines'); END;
CREATE TRIGGER counterparty_trade_lines_no_delete BEFORE DELETE ON counterparty_trade_lines BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_trade_lines'); END;
CREATE TRIGGER counterparty_settlements_no_update BEFORE UPDATE OF
  shop_id, id, counterparty_id, kind_key, offset_group_id, method_id, method_confirmed, amount, cash_drawer_id,
  cancels_settlement_id, occurred_at, recorded_at, closing_scope_id, business_date, posting_date, actor_key,
  actor_name, device_id, request_id, created_rev
  ON counterparty_settlements BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_settlements'); END;
CREATE TRIGGER counterparty_settlements_redact_only BEFORE UPDATE OF reason ON counterparty_settlements
  WHEN (NEW.reason IS NOT OLD.reason AND NEW.reason IS NOT '(지움)')
  BEGIN SELECT RAISE(ABORT, 'REDACT_ONLY counterparty_settlements'); END;
CREATE TRIGGER counterparty_settlements_no_delete BEFORE DELETE ON counterparty_settlements BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_settlements'); END;
CREATE TRIGGER counterparty_settlement_allocations_no_update BEFORE UPDATE OF
  shop_id, settlement_id, seq, trade_id, amount
  ON counterparty_settlement_allocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_settlement_allocations'); END;
CREATE TRIGGER counterparty_settlement_allocations_no_delete BEFORE DELETE ON counterparty_settlement_allocations BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY counterparty_settlement_allocations'); END;
CREATE TRIGGER print_template_versions_no_update BEFORE UPDATE OF
  shop_id, template_id, version_no, layout_schema, layout_json, created_at, created_by
  ON print_template_versions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY print_template_versions'); END;
CREATE TRIGGER print_template_versions_no_delete BEFORE DELETE ON print_template_versions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY print_template_versions'); END;
CREATE TRIGGER message_template_versions_no_update BEFORE UPDATE OF
  shop_id, template_id, version_no, body, variables_json, created_at, created_by
  ON message_template_versions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY message_template_versions'); END;
CREATE TRIGGER message_template_versions_no_delete BEFORE DELETE ON message_template_versions BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY message_template_versions'); END;
CREATE TRIGGER archive_manifests_no_update BEFORE UPDATE OF
  id, shop_id, table_name, epoch_id, schema_version, season_id, from_rev, to_rev, from_date, to_date, archive_file,
  row_count, checksum, first_hash, last_hash, created_at
  ON archive_manifests BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY archive_manifests'); END;
CREATE TRIGGER archive_manifests_no_delete BEFORE DELETE ON archive_manifests BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY archive_manifests'); END;
CREATE TRIGGER archive_verifications_no_update BEFORE UPDATE OF
  shop_id, manifest_id, row_count, checksum, verified_at, actor_key
  ON archive_verifications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY archive_verifications'); END;
CREATE TRIGGER archive_verifications_no_delete BEFORE DELETE ON archive_verifications BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY archive_verifications'); END;

-- The journal: never updated; a row may be deleted only inside a season archive range that has an
-- append-only archive_verifications row (a manifest alone is not enough).
CREATE TRIGGER events_no_update BEFORE UPDATE OF
  shop_id, rev, epoch_id, request_id, actor_key, actor_name, actor_role_key, device_id, device_seq, command_type,
  command_version, engine_key, handler_version, aggregate_type, aggregate_id, command_json, result_json,
  pii_commitment, occurred_at, recorded_at, business_date, imported, prev_hash, hash
  ON events BEGIN SELECT RAISE(ABORT, 'APPEND_ONLY events'); END;
CREATE TRIGGER events_delete_only_archived BEFORE DELETE ON events
WHEN NOT EXISTS (
  SELECT 1 FROM archive_manifests m JOIN archive_verifications v ON v.manifest_id = m.id
   WHERE m.shop_id = OLD.shop_id AND m.table_name = 'events' AND OLD.rev BETWEEN m.from_rev AND m.to_rev)
BEGIN SELECT RAISE(ABORT, 'ARCHIVE_FIRST events'); END;

-- What is owed is as fixed as what was paid: price, quantity, dates, snapshots and references of a line
-- never change after it is made (a change is a cancellation line, an extension line or an adjustment);
-- the projection columns (qty_*, current_end_*, progress_key) stay writable.
CREATE TRIGGER order_lines_frozen BEFORE UPDATE OF
  shop_id, id, order_id, batch_id, parent_line_id, person_id, catalog_item_id, variant_id, item_kind_id,
  fulfillment_mode_key, tracking_key, return_policy_key, payment_section_id, discount_group_id, label, unit_label,
  quantity, start_date, end_date, window_start_time, window_end_time, issue_planned_date, customer_class_id,
  headcount, price_basis_key, billable_units, unit_price, gross_amount, discount_amount, net_amount,
  price_list_version_id, price_rule_id, price_source_key, price_engine_key, quote_hash, price_note, tax_category_key,
  supply_amount, tax_amount, created_at, created_by, request_id, created_rev
  ON order_lines BEGIN SELECT RAISE(ABORT, 'FROZEN order_lines'); END;

-- Business rows are never deleted (ended, cancelled or anonymised instead).
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'NO_DELETE orders'); END;
CREATE TRIGGER order_batches_no_delete BEFORE DELETE ON order_batches BEGIN SELECT RAISE(ABORT, 'NO_DELETE order_batches'); END;
CREATE TRIGGER order_lines_no_delete BEFORE DELETE ON order_lines BEGIN SELECT RAISE(ABORT, 'NO_DELETE order_lines'); END;
CREATE TRIGGER line_promises_no_delete BEFORE DELETE ON line_promises BEGIN SELECT RAISE(ABORT, 'NO_DELETE line_promises'); END;
CREATE TRIGGER payment_promises_no_delete BEFORE DELETE ON payment_promises BEGIN SELECT RAISE(ABORT, 'NO_DELETE payment_promises'); END;
CREATE TRIGGER service_bookings_no_delete BEFORE DELETE ON service_bookings BEGIN SELECT RAISE(ABORT, 'NO_DELETE service_bookings'); END;
CREATE TRIGGER customers_no_delete BEFORE DELETE ON customers BEGIN SELECT RAISE(ABORT, 'NO_DELETE customers'); END;
CREATE TRIGGER assets_no_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'NO_DELETE assets'); END;
CREATE TRIGGER asset_bindings_no_delete BEFORE DELETE ON asset_bindings BEGIN SELECT RAISE(ABORT, 'NO_DELETE asset_bindings'); END;
CREATE TRIGGER asset_claims_no_delete BEFORE DELETE ON asset_claims BEGIN SELECT RAISE(ABORT, 'NO_DELETE asset_claims'); END;
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'NO_DELETE tasks'); END;
CREATE TRIGGER payment_intents_no_delete BEFORE DELETE ON payment_intents BEGIN SELECT RAISE(ABORT, 'NO_DELETE payment_intents'); END;
CREATE TRIGGER deposits_no_delete BEFORE DELETE ON deposits BEGIN SELECT RAISE(ABORT, 'NO_DELETE deposits'); END;

-- Published prices never change: lines keep price_list_version_id / price_rule_id as provenance.
CREATE TRIGGER price_list_versions_frozen BEFORE UPDATE ON price_list_versions
WHEN OLD.status_key <> 'draft'
 AND (NEW.status_key = 'draft' OR NEW.price_list_id IS NOT OLD.price_list_id OR NEW.version_no IS NOT OLD.version_no
      OR NEW.effective_from IS NOT OLD.effective_from OR NEW.rounding_unit IS NOT OLD.rounding_unit)
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_list_versions'); END;
CREATE TRIGGER price_list_versions_no_delete BEFORE DELETE ON price_list_versions
WHEN OLD.status_key <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_list_versions'); END;

CREATE TRIGGER price_rules_frozen_insert BEFORE INSERT ON price_rules
WHEN (SELECT v.status_key FROM price_list_versions v WHERE v.shop_id = NEW.shop_id AND v.id = NEW.price_list_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_rules'); END;
CREATE TRIGGER price_rules_frozen_update BEFORE UPDATE ON price_rules
WHEN (SELECT v.status_key FROM price_list_versions v WHERE v.shop_id = OLD.shop_id AND v.id = OLD.price_list_version_id) <> 'draft'
  OR (SELECT v.status_key FROM price_list_versions v WHERE v.shop_id = NEW.shop_id AND v.id = NEW.price_list_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_rules'); END;
CREATE TRIGGER price_rules_frozen_delete BEFORE DELETE ON price_rules
WHEN (SELECT v.status_key FROM price_list_versions v WHERE v.shop_id = OLD.shop_id AND v.id = OLD.price_list_version_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_rules'); END;

CREATE TRIGGER price_rule_tiers_frozen_insert BEFORE INSERT ON price_rule_tiers
WHEN (SELECT v.status_key FROM price_rules r JOIN price_list_versions v ON v.shop_id = r.shop_id AND v.id = r.price_list_version_id
       WHERE r.shop_id = NEW.shop_id AND r.id = NEW.price_rule_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_rule_tiers'); END;
CREATE TRIGGER price_rule_tiers_frozen_update BEFORE UPDATE ON price_rule_tiers
WHEN (SELECT v.status_key FROM price_rules r JOIN price_list_versions v ON v.shop_id = r.shop_id AND v.id = r.price_list_version_id
       WHERE r.shop_id = OLD.shop_id AND r.id = OLD.price_rule_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_rule_tiers'); END;
CREATE TRIGGER price_rule_tiers_frozen_delete BEFORE DELETE ON price_rule_tiers
WHEN (SELECT v.status_key FROM price_rules r JOIN price_list_versions v ON v.shop_id = r.shop_id AND v.id = r.price_list_version_id
       WHERE r.shop_id = OLD.shop_id AND r.id = OLD.price_rule_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'PUBLISHED price_rule_tiers'); END;


-- =====================================================================================
-- PART 3 · SEEDS: code vocabularies (sys_*), ASCII keys, added_in = 1.
-- Later migrations only ever INSERT new rows here (or new sys tables). Shop data
-- (item kinds, places, prices, stamps, ledger views for the first shop) is NOT seeded here:
-- it is created by the shop.provision command from a versioned seed file plus the
-- chosen resort template (catalog-and-pricing.md 10, ui-architecture.md 6).
-- JSON Schemas (json_schemas rows) are loaded by the runner from packages/contract/schemas.
-- =====================================================================================

-- @seed control
INSERT INTO sys_features (key, label, description, default_enabled, depends_on_json, added_in) VALUES
 ('vehicles',             '차량 배달·수거',        'vans, driver devices, delivery and collection tasks', 1, '[]', 1),
 ('night_collection',     '야간 수거',             'night return slots, collection list night group, prep reminder', 0, '["vehicles"]', 1),
 ('lift_tickets',         '리프트권 대행',         'ticket products, issue, allocation, recovery, vendor refunds', 0, '[]', 1),
 ('lessons',              '강습',                  'lesson kind, lesson teams (강습팀), lesson list, lesson_done stamp', 0, '[]', 1),
 ('size_preinput',        '사이즈 사전 입력',      'intake links, submissions, reviews, prep sheet', 0, '[]', 1),
 ('partner_ledger',       '거래처 장부',           'counterparty trades, settlements, equipment loans', 0, '[]', 1),
 ('deposits',             '보증금',                'security deposit holds', 0, '[]', 1),
 ('prepayment',           '선입금 방식',           'prepayment purpose and the prepayment_mode setting in the confirm window', 1, '[]', 1),
 ('exchange',             '교환',                  'size / damage exchange for exchangeable kinds', 1, '[]', 1),
 ('driver_field_payment', '배달 현장 수납',        'driver sees due, collects in the field, adds tickets from van stock', 0, '["vehicles"]', 1),
 ('multi_order_payment',  '일괄 수납',  'one tender across several orders, payer team promises', 1, '[]', 1),
 ('split_payment',        '부분 결제',           'one order paid in rounds by items and quantities', 0, '[]', 1),
 ('card_terminal',        '카드 단말 연동',        'payment intents through a terminal agent', 0, '[]', 1),
 ('sms',                  '문자 발송',             'real SMS through a provider (test shops go to a sink)', 0, '[]', 1),
 ('bundles',              '세트 상품',             'bundle items and component lines', 0, '[]', 1),
 ('advanced_pricing',     '요금 조건',             'day types, seasons, classes, multi-day tiers', 0, '[]', 1),
 ('branches',             '지점',                  'locations of one business in one shop file; each closing scope closes its own day', 0, '[]', 1),
 ('label_printer',        '라벨 프린터',           'print agent for team labels', 0, '[]', 1),
 ('customer_profiles',    '고객 기록',             'customers table, tags, visit history', 1, '[]', 1);

-- @seed shop
INSERT INTO sys_features (key, label, description, default_enabled, depends_on_json, config_schema_key, added_in) VALUES
 ('vehicles',             '차량 배달·수거',        'vans, driver devices, delivery and collection tasks', 1, '[]', NULL, 1),
 ('night_collection',     '야간 수거',             'night return slots, collection list night group, prep reminder', 0, '["vehicles"]', NULL, 1),
 ('lift_tickets',         '리프트권 대행',         'ticket products, issue, allocation, recovery, vendor refunds', 0, '[]', NULL, 1),
 ('lessons',              '강습',                  'lesson kind, lesson teams (강습팀), lesson list, lesson_done stamp', 0, '[]', NULL, 1),
 ('size_preinput',        '사이즈 사전 입력',      'intake links, submissions, reviews, prep sheet', 0, '[]', NULL, 1),
 ('partner_ledger',       '거래처 장부',           'counterparty trades, settlements, equipment loans', 0, '[]', NULL, 1),
 ('deposits',             '보증금',                'security deposit holds', 0, '[]', NULL, 1),
 ('prepayment',           '선입금 방식',           'prepayment purpose and the prepayment_mode setting in the confirm window', 1, '[]', NULL, 1),
 ('exchange',             '교환',                  'size / damage exchange for exchangeable kinds', 1, '[]', NULL, 1),
 ('driver_field_payment', '배달 현장 수납',        'driver sees due, collects in the field, adds tickets from van stock', 0, '["vehicles"]', NULL, 1),
 ('multi_order_payment',  '일괄 수납',  'one tender across several orders, payer team promises', 1, '[]', NULL, 1),
 ('split_payment',        '부분 결제',           'one order paid in rounds by items and quantities', 0, '[]', NULL, 1),
 ('card_terminal',        '카드 단말 연동',        'payment intents through a terminal agent', 0, '[]', 'feature.card_terminal', 1),
 ('sms',                  '문자 발송',             'real SMS through a provider (test shops go to a sink)', 0, '[]', 'feature.sms', 1),
 ('bundles',              '세트 상품',             'bundle items and component lines', 0, '[]', NULL, 1),
 ('advanced_pricing',     '요금 조건',             'day types, seasons, classes, multi-day tiers', 0, '[]', NULL, 1),
 ('branches',             '지점',                  'locations of one business in one shop file; each closing scope closes its own day', 0, '[]', NULL, 1),
 ('label_printer',        '라벨 프린터',           'print agent for team labels', 0, '[]', NULL, 1),
 ('customer_profiles',    '고객 기록',             'customers table, tags, visit history', 1, '[]', NULL, 1);

INSERT INTO sys_permissions (key, label, group_key, scopes_json, sensitive, added_in) VALUES
 ('order.create',            '접수',                 'order',    '["shop","own_vehicle"]', 0, 1),
 ('order.add',               '품목 추가',            'order',    '["shop","own_vehicle"]', 0, 1),
 ('order.cancel',            '접수 취소',            'order',    '["shop"]', 1, 1),
 ('order.promise.change',    '일정 변경',          'order',    '["shop"]', 0, 1),
 ('order.extend',            '기간 연장',            'order',    '["shop"]', 0, 1),
 ('price.override',          '가격 직접 입력',       'money',    '["shop"]', 1, 1),
 ('discount.apply',          '할인 적용',            'money',    '["shop"]', 0, 1),
 ('discount.manual',         '할인 직접 입력',       'money',    '["shop"]', 1, 1),
 ('payment.take',            '수납',                 'money',    '["shop"]', 0, 1),
 ('payment.refund',          '환불',                 'money',    '["shop"]', 1, 1),
 ('payment.collect_field',   '현장 수납',            'money',    '["own_vehicle"]', 0, 1),
 ('payment.reallocate',      '수납 이동',          'money',    '["shop"]', 1, 1),
 ('deposit.take',            '보증금 입금',          'money',    '["shop"]', 0, 1),
 ('deposit.return',          '보증금 반환',      'money',    '["shop"]', 1, 1),
 ('deposit.return_field',    '현장 보증금 반환', 'money',    '["own_vehicle"]', 1, 1),
 ('deposit.keep',            '보증금 몰수',      'money',    '["shop"]', 1, 1),
 ('adjustment.create',       '금액 조정',            'money',    '["shop"]', 1, 1),
 ('cash.entry',              '현금 입출금',          'money',    '["shop"]', 1, 1),
 ('cash.transfer',           '차량 현금 인계',     'money',    '["shop","own_vehicle"]', 0, 1),
 ('cash.transfer.confirm',   '차량 현금 확인',       'money',    '["shop"]', 0, 1),
 ('closing.close',           '마감',                 'money',    '["shop"]', 1, 1),
 ('closing.reopen',          '마감 해제',       'money',    '["shop"]', 1, 1),
 ('stock.move',              '지급·반납·적재·수거',  'stock',    '["shop","own_vehicle"]', 0, 1),
 ('stock.receive',           '매장 입고',            'stock',    '["shop","own_vehicle"]', 0, 1),
 ('stock.correct',           '처리 취소',        'stock',    '["shop"]', 1, 1),
 ('stock.intake',            '재고 입고',          'stock',    '["shop"]', 0, 1),
 ('asset.condition',         '정비 상태',            'stock',    '["shop"]', 0, 1),
 ('task.manage',             '차량 업무 관리',       'dispatch', '["shop"]', 0, 1),
 ('route.reorder',           '방문 순서 변경',     'dispatch', '["shop","own_vehicle"]', 0, 1),
 ('task.pin',                '긴급 요청',            'dispatch', '["shop"]', 0, 1),
 ('task.visit',              '방문 결과',            'dispatch', '["own_vehicle","shop"]', 0, 1),
 ('ticket.issue',            '발권',                 'stock',    '["shop"]', 0, 1),
 ('ticket.allocate',         '권 배정',              'stock',    '["shop","own_vehicle"]', 0, 1),
 ('vendor_refund.manage',    '발권처 환불',          'stock',    '["shop","own_vehicle"]', 0, 1),
 ('exchange.manage',         '교환',                 'stock',    '["shop"]', 0, 1),
 ('intake.manage',           '사이즈 요청',          'order',    '["shop"]', 0, 1),
 ('print.request',           '인쇄',                 'order',    '["shop","own_vehicle"]', 0, 1),
 ('catalog.manage',          '품목 관리',            'settings', '["shop"]', 1, 1),
 ('price_list.publish',      '요금표 게시',          'settings', '["shop"]', 1, 1),
 ('settings.manage',         '매장 설정',            'settings', '["shop"]', 1, 1),
 ('features.manage',         '사용 기능',            'settings', '["shop"]', 1, 1),
 ('staff.manage',            '직원 관리',            'settings', '["shop"]', 1, 1),
 ('device.manage',           '기기 등록',            'settings', '["shop"]', 1, 1),
 ('counterparty.manage',     '거래처 관리',          'settings', '["shop"]', 0, 1),
 ('counterparty.settle',     '거래처 정산',          'money',    '["shop"]', 1, 1),
 ('customer.manage',         '고객 관리',            'order',    '["shop"]', 0, 1),
 ('customer.anonymize',      '고객 정보 삭제',     'settings', '["shop"]', 1, 1),
 ('review.resolve',          '확인 필요 처리',       'order',    '["shop"]', 0, 1),
 ('export.data',             '자료 내보내기',        'admin',    '["shop"]', 1, 1),
 ('audit.view',              '사용 내역 조회',       'admin',    '["shop"]', 0, 1);

INSERT INTO sys_setting_definitions (key, label, value_schema_key, default_value, effective_dated, added_in) VALUES
 ('prepayment_mode',                 '선입금 방식',             'setting.prepayment_mode',        '{"mode":"none"}', 1, 1),
 ('same_day_cancel_refund_default',  '발권 후 취소 환불 기본',  'setting.refund_decision',        '{"decision":"refund"}', 0, 1),
 ('payment_timing_default',          '결제 시점 기본',          'setting.payment_timing',         '{"timing":"at_intake"}', 0, 1),
 ('rounding_policy',                 '끝전 처리',               'setting.rounding',               '{"unit":10,"mode":"floor"}', 1, 1),
 ('discount_stacking',               '할인 중복',             'setting.discount_stacking',      '{"policy":"exclusive_per_group"}', 1, 1),
 ('receipt_number_format',           '접수 번호 형식',          'setting.receipt_format',         '{"pattern":"YYMMDD-NNN"}', 0, 1),
 ('weekday_day_types',               '요일별 요금 구분',        'setting.weekday_day_types',      '{"sat":"weekend","sun":"weekend","default":"weekday"}', 1, 1),
 ('walk_in_phone_required',          '현장 접수 연락처 필수',   'setting.flag',                   '{"enabled":true}', 0, 1),
 ('extension_default_return_time',   '연장 기본 반납 시각',     'setting.local_time',             '{"time":"16:30"}', 0, 1),
 ('night_collection_notice_minutes', '야간 수거 준비 알림',     'setting.minutes',                '{"minutes":60}', 0, 1),
 ('driver_sees_due_amount',          '기사 화면 미수 표시',    'setting.flag',                   '{"enabled":true}', 0, 1),
 ('lesson_settlement_timing',        '강습 정산 시점',          'setting.lesson_settlement',      '{"timing":"on_close"}', 0, 1),
 ('max_line_quantity',               '품목 줄 최대 수량',         'setting.max_quantity',           '{"max":500}', 0, 1),
 ('session_idle_minutes',            '자동 로그아웃',           'setting.session_idle',           '{"counter":480,"driver":20160}', 0, 1),
 ('login_lockout',                   '로그인 잠금',             'setting.login_lockout',          '{"max_failures":5,"lock_minutes":10}', 0, 1),
 ('retention',                       '보관 기간',               'setting.retention',              '{"command_result_days":90,"event_pii_days":30,"change_log_days":60,"intent_marks_days":30,"customer_pii_days":1095,"journal_hot_seasons":2,"outbox_payload_days":30,"pii_access_days":365}', 0, 1),
 ('backup_policy',                   '백업',                    'setting.backup_policy',          '{"wal_keep_days":7,"daily_keep_days":35,"journal_pii_keep_days":35,"weekly_scrubbed_keep_weeks":26,"season_scrubbed_keep_years":5,"drill_weekday":"mon","drill_time":"04:30","owner_export_scrubbed":true,"owner_export":false}', 0, 1),
 ('offline_policy',                  '연결 끊김 기록',           'setting.offline_policy',         '{"max_backdate_hours":168,"future_skew_minutes":5,"sent_log_days":7,"sent_pii_hours":24,"clock_warn_minutes":2,"seq_gap_alert_minutes":30,"counter_days_ahead":2,"counter_due_lookback_days":30,"reconnect_window_seconds":120,"fallback_after_failures":2,"fallback_recover_seconds":10,"pii_wipe_hours":{"driver":24,"counter":72},"app_lock_minutes":{"driver_phone":5,"driver_tablet":30}}', 0, 1),
 ('closing_policy',                  '마감 확인',               'setting.closing_policy',         '{"block_on_unsent_van":true,"block_on_unsent_devices":true,"block_on_money_findings":true,"reopen":"latest_only"}', 0, 1);

INSERT INTO sys_device_kinds (key, label, added_in) VALUES
 ('pos','카운터 포스',1), ('driver_tablet','기사 태블릿',1), ('driver_phone','기사 휴대폰',1),
 ('admin_console','관리자 콘솔',1), ('print_agent','인쇄 도우미',1), ('card_agent','카드 단말 도우미',1);

INSERT INTO sys_device_classes (key, label, added_in) VALUES
 ('pos','포스 1024x600~1366x768',1), ('pos_narrow','포스 좁은 화면 907x648·875x600',1),
 ('driver_tablet','기사 태블릿 1024x520~1280x720',1), ('driver_phone','기사 휴대폰 360x640',1),
 ('print','인쇄',1), ('admin','관리자 콘솔 1440x810',1);

INSERT INTO sys_return_policies (key, label, blocks_completion, added_in) VALUES
 ('required','반납 필수',1,1), ('optional','반납 선택(반납 시 기록)',0,1), ('none','반납 없음',0,1);

INSERT INTO sys_fulfillment_modes (key, label, has_custody, needs_issue, default_return_policy_key, completion_rule_key, added_in) VALUES
 ('rental','대여',1,1,'required','custody',1),
 ('ticket','권(리프트권)',1,1,'optional','custody',1),
 ('service','서비스(강습)',0,0,'none','service_closed',1),
 ('sale','판매',1,1,'none','custody',1),
 ('fee','요금만',0,0,'none','immediate',1),
 ('bundle','세트',0,0,'none','children_complete',1),
 ('placeholder','인원 예약',0,0,'none','never',1);

INSERT INTO sys_tracking_modes (key, label, added_in) VALUES
 ('unit','개별(번호)',1), ('count','수량',1), ('none','재고 없음',1);

INSERT INTO sys_price_bases (key, label, multiplies_days, multiplies_headcount, uses_tiers, added_in) VALUES
 ('per_day','1일',1,0,1,1), ('per_unit','1개·1매',0,0,0,1), ('per_session','1회',0,0,0,1),
 ('per_person_session','1인 1회',0,1,0,1), ('per_hour','1시간',0,0,0,1), ('half_day','반일(오전타임 후)',0,0,0,1),
 ('flat','정액',0,0,0,1);

INSERT INTO sys_discount_kinds (key, label, target_scope_key, added_in) VALUES
 ('per_unit_day','개당 1일 금액','line',1), ('percent','비율(%)','group',1), ('amount','금액','group',1),
 ('package','묶음 조건','group',1), ('manual_amount','직접 금액','line',1), ('manual_percent','직접 비율','line',1);

INSERT INTO sys_location_kinds (key, label, added_in) VALUES
 ('external','외부(구입·발권)',1), ('shop','매장',1), ('storage','창고',1), ('vehicle','차량',1),
 ('customer','손님',1), ('counterparty','거래처',1), ('other_shop','다른 매장',1), ('void','폐기·분실',1);

INSERT INTO sys_movement_kinds (key, label, reversible, creates_stock, added_in) VALUES
 ('stock_opening','기초 재고',0,1,1), ('stock_receive','재고 입고',1,1,1), ('ticket_issue','발권',1,1,1),
 ('partner_borrow','거래처 대여 입고',1,1,1), ('load','차량 적재',1,0,1), ('deliver','지급·배달',1,0,1),
 ('collect','차량 수거',1,0,1), ('receive','매장 입고',1,0,1), ('direct_return','매장 반납',1,0,1),
 ('vendor_refund','발권처 환불',1,0,1), ('found','분실 회수',1,0,1), ('partner_lend','거래처 대여 출고',1,0,1),
 ('partner_receive','거래처 회수',1,0,1), ('partner_return','거래처 반납',1,0,1),
 ('vehicle_handover','차량 간 인계',1,0,1), ('relocate','매장·창고 이동',1,0,1), ('shop_transfer','다른 매장 이동',1,0,1),
 ('write_off','폐기·분실',1,0,1), ('reversal','처리 취소',0,0,1);

INSERT INTO sys_movement_routes (movement_kind_key, from_kind_key, to_kind_key, driver_allowed, offline_allowed, added_in) VALUES
 ('stock_opening','external','shop',0,0,1), ('stock_opening','external','storage',0,0,1),
 ('stock_opening','external','vehicle',0,0,1), ('stock_opening','external','customer',0,0,1),
 ('stock_receive','external','shop',0,0,1), ('ticket_issue','external','shop',0,0,1),
 ('partner_borrow','counterparty','shop',0,0,1),
 ('load','shop','vehicle',0,1,1),                                              -- a counter may queue 적재 offline (8-2)
 ('deliver','shop','customer',0,1,1), ('deliver','vehicle','customer',1,1,1),   -- counter 지급 may be queued offline (ADR-19)
 ('collect','customer','vehicle',1,1,1),
 ('receive','vehicle','shop',1,0,1),
 ('direct_return','customer','shop',0,1,1),
 ('vendor_refund','vehicle','counterparty',1,1,1), ('vendor_refund','shop','counterparty',0,0,1),
 ('found','void','shop',0,0,1), ('found','customer','shop',0,0,1), ('found','vehicle','shop',0,0,1),
 ('partner_lend','shop','counterparty',0,0,1), ('partner_receive','counterparty','shop',0,0,1),
 ('partner_return','shop','counterparty',0,0,1),
 ('vehicle_handover','vehicle','vehicle',1,0,1),
 ('relocate','shop','storage',0,0,1), ('relocate','storage','shop',0,0,1),
 ('shop_transfer','shop','other_shop',0,0,1), ('shop_transfer','other_shop','shop',0,0,1),
 ('relocate','shop','shop',0,0,1),
 ('write_off','shop','void',0,0,1), ('write_off','storage','void',0,0,1), ('write_off','vehicle','void',0,0,1),
 ('write_off','customer','void',0,0,1), ('write_off','counterparty','void',0,0,1);
-- a reversal mirrors the route of what it undoes (drivers may not reverse; the counter does)
INSERT INTO sys_movement_routes (movement_kind_key, from_kind_key, to_kind_key, driver_allowed, offline_allowed, added_in)
SELECT 'reversal', r.to_kind_key, r.from_kind_key, 0, 0, 1
  FROM sys_movement_routes r JOIN sys_movement_kinds k ON k.key = r.movement_kind_key
 WHERE k.reversible = 1
ON CONFLICT DO NOTHING;

INSERT INTO sys_claim_lanes (key, label, exclusive, bound, added_in) VALUES
 ('preparation','준비',1,1,1), ('transport','차량 업무',1,1,1), ('disposition','반출(환불·대여·교환)',1,1,1),
 ('composition','구성품',1,0,1), ('ticket_window','권 배정(시간대)',0,1,1);

INSERT INTO sys_claim_types (key, label, lane_key, windowed, added_in) VALUES
 ('preparation','준비','preparation',0,1),
 ('task_delivery','배달 적재','transport',0,1), ('task_collection','수거 예정','transport',0,1),
 ('vendor_refund','발권처 환불','disposition',0,1), ('partner_lending','거래처 대여','disposition',0,1),
 ('exchange_hold','교환용','disposition',0,1),
 ('component_of','구성품','composition',0,1),
 ('line_fulfillment','권 배정','ticket_window',1,1);

INSERT INTO sys_task_kinds (key, label, movement_kind_key, added_in) VALUES
 ('delivery','배달','deliver',1), ('collection','수거','collect',1),
 ('vendor_refund','발권처 환불','vendor_refund',1), ('shop_transfer','매장 간 이동','shop_transfer',1);

INSERT INTO sys_promise_types (key, label, added_in) VALUES ('pickup','수령',1), ('return','반납',1);

INSERT INTO sys_fulfillment_methods (key, promise_type_key, label, requires_vehicle, requires_place, task_kind_key, added_in) VALUES
 ('shop_counter','pickup','매장 수령',0,0,NULL,1), ('vehicle_delivery','pickup','차량 배달',1,1,'delivery',1),
 ('shop_direct','return','매장 직접 반납',0,0,NULL,1), ('vehicle_collection','return','차량 수거',1,1,'collection',1);

INSERT INTO sys_payment_timings (key, label, added_in) VALUES
 ('at_intake','접수 시',1), ('at_issue','지급 시',1), ('at_return','반납 시',1), ('later','후불',1),
 ('by_other_order','다른 팀 결제',1), ('partner_postpaid','거래처 후불',1);

INSERT INTO sys_payment_kinds (key, label, balance_sign, deposit_sign, cash_sign, requires_refund_of, requires_deposit, added_in) VALUES
 ('payment','수납',1,0,1,0,0,1), ('refund','환불',-1,0,-1,1,0,1),
 ('legacy_refund','이전 자료 환불(대상 미확인)',-1,0,-1,0,0,1),   -- import only: old refunds that name no payment
 ('deposit_in','보증금 입금',0,1,1,0,1,1), ('deposit_out','보증금 반환',0,-1,-1,0,1,1),
 ('deposit_apply','보증금 결제',1,-1,0,0,1,1),
 ('deposit_forfeit','보증금 몰수',0,-1,0,0,1,1),   -- a unit never came back: the shop keeps its deposit (no cash moves)
 ('deposit_restore','몰수 취소',0,1,0,0,1,1);  -- the unit came back after all: held again, then refunded as usual

INSERT INTO sys_payment_purposes (key, label, added_in) VALUES
 ('charge','수납',1), ('prepayment','예약금·선입금',1), ('deposit','보증금',1);

INSERT INTO sys_deposit_timings (key, label, added_in) VALUES
 ('at_intake','접수 시',1), ('at_issue','지급 시',1);

INSERT INTO sys_deposit_refund_methods (key, label, added_in) VALUES
 ('cash','현금 반환',1), ('offset_due','미수 차감',1), ('same_method','동일 수단 반환',1);

INSERT INTO sys_deposit_unreturned_actions (key, label, added_in) VALUES
 ('keep','보증금 몰수',1), ('charge_loss','분실금 청구(보증금 공제)',1);

INSERT INTO sys_deposit_entry_kinds (key, label, unit_sign, payment_kind_key, added_in) VALUES
 ('take','보증금 입금',1,'deposit_in',1), ('refund','보증금 반환',-1,'deposit_out',1),
 ('apply','미수 차감',-1,'deposit_apply',1), ('keep','보증금 몰수',-1,'deposit_forfeit',1),
 ('restore','몰수 취소',1,'deposit_restore',1);

INSERT INTO sys_counterparty_roles (key, label, added_in) VALUES
 ('resort_vendor','발권처',1), ('partner_shop','거래처 샵',1), ('lesson_team','강습팀',1),
 ('lodging_affiliate','제휴 숙소',1), ('billing_company','후불 거래처',1);

INSERT INTO sys_trade_kinds (key, label, direction_sign, added_in) VALUES
 ('receivable','미수',1,1), ('payable','미지급',-1,1), ('ticket_purchase','권 구입',-1,1),
 ('ticket_sale','권 판매',1,1), ('ticket_refund','권 환불',1,1), ('equipment_borrow_fee','장비 대여 비용',-1,1),
 ('equipment_lend_fee','장비 대여 수입',1,1), ('lesson_consignment','강습 위탁',-1,1),
 ('commission_payable','수수료 미지급',-1,1), ('commission_receivable','수수료 미수',1,1);

INSERT INTO sys_entity_types (key, label, added_in) VALUES
 ('order','접수',1), ('order_line','품목 줄',1), ('order_person','일행',1), ('customer','고객',1),
 ('catalog_item','상품',1), ('item_variant','규격',1), ('asset','개별 장비',1), ('task','차량 업무',1),
 ('place','장소',1), ('counterparty','거래처',1);

INSERT INTO sys_attribute_data_types (key, value_column, added_in) VALUES
 ('text','value_text',1), ('int','value_int',1), ('decimal','value_real',1), ('bool','value_int',1),
 ('date','value_text',1), ('time','value_text',1), ('option','option_id',1), ('measurement','value_real',1),
 ('money','value_int',1);

INSERT INTO sys_attribute_placements (key, label, added_in) VALUES
 ('intake_form','사이즈 입력폼',1), ('order_form','접수 화면',1), ('prep_sheet','준비표',1),
 ('team_label','팀 스티커',1), ('slip','접수증',1), ('receipt','영수증',1), ('task_sheet','기사 업무 판',1);

INSERT INTO sys_reason_domains (key, label, added_in) VALUES
 ('visit_result','방문 결과',1), ('early_return','조기 반납',1), ('exchange','교환',1), ('handover','인계',1),
 ('asset_condition','정비 상태',1), ('found','분실 회수',1), ('cash_entry','현금 입출금',1), ('refund','환불',1),
 ('cancellation','취소',1), ('adjustment','금액 조정',1), ('closing_difference','마감 차액',1),
 ('reallocation','수납 이동',1), ('price_override','가격 직접 입력',1), ('deposit','보증금',1);

INSERT INTO sys_stamp_rules (key, scope_key, description, added_in) VALUES
 ('qty_prepared','line','qty_prepared of active quantity',1),
 ('qty_loaded','line','units loaded on a van for a delivery promise',1),
 ('qty_issued','line','qty_issued of active quantity',1),
 ('qty_collected','line','units collected by a van (with time)',1),
 ('qty_returned','line','qty_returned + qty_not_returned of issued quantity; na when return policy is none',1),
 ('ticket_secured','line','active ticket_window claims cover the quantity',1),
 ('service_closed','line','service bookings done, cancelled or no_show',1),
 ('order_due_zero','order','due_amount = 0 and collect_for_others_amount = 0; covered only by another team''s promise = scheduled, never done',1),
 ('task_done','task','task completed',1),
 ('task_received','task','collected units received at the shop',1);

INSERT INTO sys_outbox_channels (key, label, auto_retry, added_in) VALUES
 ('sms','문자',0,1), ('print','인쇄',1,1), ('card_terminal','카드 단말',0,1), ('webhook','외부 알림',1,1),
 ('backup_upload','백업 전송',1,1);

INSERT INTO sys_print_renderers (key, label, added_in) VALUES
 ('receipt_slip','대여 접수증',1), ('collection_list_a4','수거 목록 A4',1), ('prep_sheet_a4','준비표 A4',1),
 ('team_label','팀 스티커',1), ('closing_sheet','마감표',1), ('stock_list','재고 목록',1),
 ('unreturned_list','미반납 목록',1), ('ledger_a4','대여 장부 A4',1), ('qr_guide','QR 안내판',1);

INSERT INTO sys_screen_templates (key, label, added_in) VALUES
 ('ledger','장부',1), ('slip','접수증',1), ('checklist','처리 현황',1), ('collection_list','수거 목록',1),
 ('driver_list','기사 목록',1), ('tiles','타일 선택',1), ('form','입력',1), ('split','부분 결제',1);

INSERT INTO sys_column_renderers (key, label, binding_key, added_in) VALUES
 ('time','시각','none',1), ('team','팀','none',1), ('items','품목','none',1), ('promise','일정','none',1), ('place','장소','none',1),
 ('money','금액','none',1), ('stamp','도장','stamp_step',1), ('attribute','속성','attribute',1), ('text','글자','none',1),
 ('vehicle','차량','none',1), ('action','버튼(전화 · 수거 실패)','action',1);

INSERT INTO sys_ledger_filters (key, label, added_in) VALUES
 ('all','전체',1), ('pickup','수령',1), ('return','반납',1), ('unpaid','미수',1), ('vehicle','차량',1),
 ('lessons','강습',1), ('open_tasks','미처리 업무',1), ('collected','수거 완료',1), ('remaining','잔여',1), ('pinned','긴급',1);

INSERT INTO sys_ledger_metrics (key, label, added_in) VALUES
 ('team_count','팀',1), ('issued_count','지급',1), ('returned_count','반납',1), ('due_total','미수',1),
 ('collected_count','수거 완료',1), ('pending_count','전송 대기',1), ('remaining_count','잔여',1), ('vehicle_load','차량 재고',1);

INSERT INTO sys_cash_sources (key, label, added_in) VALUES
 ('payment','수납·환불·보증금',1), ('cash_entry','현금 입출금',1), ('cash_transfer','차량 현금 인계',1),
 ('cash_transfer_confirmation','인계 현금 확인',1), ('counterparty_settlement','거래처 정산(발권처 환불금 포함)',1);

INSERT INTO sys_booking_channels (key, label, added_in) VALUES
 ('walk_in','현장 접수',1), ('phone','전화 예약',1), ('intake_form','사이즈 입력폼',1),
 ('ticket_reservation','리프트권 예약',1), ('driver_field','배달 현장',1), ('legacy','이전 자료',1);

INSERT INTO sys_review_kinds (key, label, message_template, severity_key, routing_key, added_in) VALUES
 ('already_returned',   '수거 기록 제외',       '{team} 팀 {item} {qty}개 매장 반납 완료 · 기사 수거 기록 제외', 'info', 'origin_device', 1),
 ('collect_exceeds',    '수거 수량 확인',    '{team} 팀 수거 {qty}개 · 대여 중 {left}개 · {left}개만 반영', 'action', 'origin_device', 1),
 ('plan_displaced',     '계획 변경',     '{item} 실제 위치 {where} · {plan} 계획 해제 · 계획 다시 지정', 'action', 'manager', 1),
 ('late_money',         '마감 후 수납', '{team} 팀 {amount}원 · 마감일({day}) 수납 · {posting_day} 마감 반영', 'info', 'manager', 1),
 ('overpaid',           '초과 수납',      '{team} 팀 초과 수납 {amount}원 · 환불 또는 다른 팀 이동', 'action', 'order_banner', 1),
 ('allocation_fallback','품목 미지정 수납', '{team} 팀 {amount}원 · 품목 미지정 · 팀 전체 반영 · 품목 선택 필요', 'action', 'manager', 1),
 ('card_unknown',       '카드 결과 미확인',  '카드 {amount}원 결제 결과 미확인 · 단말기 화면 · 영수증 확인', 'blocking', 'dialog_step', 1),
 ('possible_duplicate_card', '승인번호 중복', '승인번호 {approval} · 카드 {amount}원 2건 기록 · 단말기 내역 확인', 'action', 'manager', 1),
 ('extra_card_approval','카드 중복 승인', '카드 {amount}원 중복 승인 · 단말기에서 1건 취소', 'blocking', 'dialog_step', 1),
 ('possible_duplicate_money', '중복 수납 의심', '{team} 팀 {amount}원 · {minutes}분 안 2건 · 중복 여부 확인', 'action', 'origin_device', 1),
 ('sms_unknown',        '문자 결과 미확인',  '{team} 팀 문자 발송 결과 미확인 · 필요 시 전화', 'info', 'origin_device', 1),
 ('task_cancelled',     '취소된 업무',     '{team} 팀 업무 취소 후 기사 기록 수신', 'action', 'manager', 1),
 ('task_moved_meanwhile','업무 차량 변경 확인', '{team} 팀 업무 · {from_vehicle} 처리 완료 · {to_vehicle} 업무 취소', 'info', 'manager', 1),
 ('ticket_unavailable', '차량 권 재고 없음',    '차량 리프트권 재고 없음 · {team} 팀 추가 권 미반영 · 수납 기록 완료', 'action', 'manager', 1),
 ('found_after_charge', '분실금 확인',  '{item} 분실 회수 · {team} 팀 분실금 {amount}원 · 환불 여부 결정', 'action', 'order_banner', 1),
 ('deposit_kept_returned', '몰수 보증금 확인', '{team} 팀 {item} {qty}{unit} 반납 · 몰수 보증금 {amount}원 · 반환 여부 결정', 'action', 'order_banner', 1),
 ('blocked_command',    '처리 중단',       '앞 처리 실패 · 다음 처리 {count}건 중단 · 수납 기록 반영', 'action', 'origin_device', 1),
 ('device_gap',         '미수신 기록',  '{device} 기록 {count}건 미수신 · 해당 기기 전송 필요', 'action', 'manager', 1),
 ('clock_suspect',      '기기 시계 확인',  '{device} 시계 불일치 · {count}건 날짜 확인 필요', 'action', 'manager', 1),
 ('van_unsynced',       '차량 전송 대기',  '{vehicle} 기록 {count}건 전송 대기 · 마감 전 전송 필요', 'blocking', 'dialog_step', 1),
 ('route_superseded',   '순서 변경',     '방문 순서 변경됨({device}, {time})', 'info', 'origin_device', 1),
 ('decision_overridden','결정 변경',  '{time} 결정 {summary} · {other}님 변경', 'info', 'origin_device', 1),
 ('receipt_no_clash',   '접수 번호 중복',  '복구 후 접수 번호 {no} 중복 · 종이 접수증 확인', 'action', 'manager', 1),
 ('restore_replay',     '복구 후 재수신', '복구 후 {device} 기기 {count}건 재수신', 'info', 'manager', 1),
 ('ui_defaults_kept',   '화면 설정 확인',  '새 화면 설정 {count}개 · 매장 변경 항목 유지', 'info', 'manager', 1),
 ('asset_elsewhere',    '장비 위치 불일치', '{item} 기록상 위치 {where} · {team} 팀 {action} 미반영 · 장비 위치 확인', 'action', 'origin_device', 1),
 ('deposit_over_returned', '보증금 초과 반환', '{team} 팀 보증금 {amount}원 초과 반환 · {drawer} 현금 출금 기록 · 청구 여부 결정', 'action', 'order_banner', 1),
 ('revoked_device_record', '사용 중지 기기 기록', '사용 중지 기기({device}) 기록 {count}건 보류 · 확인 후 반영', 'action', 'manager', 1),
 ('offline_order_unapplied', '연결 끊김 중 접수 확인', '연결 끊김 중 접수(임시 {provisional}) · 대표자 · 품목 · 수납만 반영 · 종이 접수증 대조', 'action', 'origin_device', 1),
 ('device_unsynced',    '기기 전송 대기',  '{device} 기록 {count}건 전송 대기 · 마감 전 기기 연결', 'blocking', 'dialog_step', 1),
 ('licence_lapsed_record', '라이선스 만료 후 기록', '라이선스 만료 후 {device} 연결 끊김 중 접수 {count}건 반영 · 공급자 연락', 'info', 'manager', 1),
 ('unverified_sign_in', '미확인 로그인', '{device} · {staff}님 연결 끊김 중 로그인 · {count}건 기록 · 계정 중지 또는 번호 변경 후 기록 · 확인 필요', 'action', 'manager', 1),
 ('command_held',       '공급자 확인 중',  '{device} 기록 {count}건 공급자 확인 중 · 다른 업무 정상', 'info', 'manager', 1),
 ('recomputed_after_restore', '복구 후 재계산', '복구 후 {team} 팀 {what} 재계산 · 이전 {before} · 현재 {after}', 'action', 'manager', 1);

-- engine_key is the season-1 assignment (migration-plan 3-3) and is the ONE field of a sys row a
-- migration may UPDATE (when a bundle moves to native). native = new TypeScript handler;
-- adapter = legacy handler behind the native fact adapter (applies the matching subset, never
-- rejects a fact); legacy = legacy handler through the facade (intents only). CI checks that the
-- engine registered in code matches this seed.
INSERT INTO sys_event_types (key, category_key, class_key, audit_label, is_money, offline_allowed, engine_key, added_in) VALUES
 ('order.create',            'order',    'intent',      '접수',                 0, 1, 'native',  1),
 ('order.add',               'order',    'intent',      '품목 추가',            0, 1, 'native',  1),
 ('order.cancel',            'order',    'intent',      '접수 취소',            1, 0, 'legacy',  1),
 ('order.extend',            'order',    'intent',      '기간 연장',            1, 0, 'legacy',  1),
 ('order.link',              'order',    'intent',      '접수 병합·연결',     0, 0, 'legacy',  1),
 ('reservation.change',      'order',    'intent',      '권 예약 변경',       0, 0, 'legacy',  1),
 ('promise.change',          'order',    'intent',      '일정 변경',          0, 0, 'native',  1),
 ('payment_promise.set',     'money',    'intent',      '결제 팀·시점',       0, 0, 'native',  1),
 ('discount.apply',          'money',    'intent',      '할인',                 1, 0, 'native',  1),
 ('payment.take',            'money',    'fact',        '수납',                 1, 1, 'native',  1),
 ('payment.refund',          'money',    'fact',        '환불',                 1, 0, 'native',  1),
 ('payment.reallocate',      'money',    'intent',      '수납 이동',          1, 0, 'native',  1),
 ('payment.intent_request',  'money',    'intent',      '카드 결제 요청',       1, 0, 'native',  1),
 ('payment.intent_outcome',  'money',    'system',      '카드 결제 결과',       1, 0, 'native',  1),
 ('payment.intent_resolve',  'money',    'intent',      '카드 결과 확인',       1, 0, 'native',  1),
 ('tax_document.issue',      'money',    'fact',        '현금영수증·세금계산서', 1, 0, 'native',  1),
 ('deposit.take',            'money',    'fact',        '보증금 입금',          1, 1, 'native',  1),
 ('deposit.return',          'money',    'fact',        '보증금 반환',      1, 1, 'native',  1),
 ('deposit.keep',            'money',    'intent',      '보증금 몰수',      1, 0, 'native',  1),
 ('adjustment.create',       'money',    'intent',      '금액 조정',            1, 0, 'native',  1),
 ('cash.entry',              'money',    'fact',        '현금 입출금',          1, 0, 'native',  1),
 ('cash.transfer',           'money',    'fact',        '차량 현금 인계',     1, 0, 'native',  1),
 ('cash.transfer_confirm',   'money',    'fact',        '차량 현금 확인',       1, 0, 'native',  1),
 ('closing.close',           'money',    'intent',      '마감',                 1, 0, 'native',  1),
 ('closing.reopen',          'money',    'intent',      '마감 해제',       1, 0, 'native',  1),
 ('field.collect',           'money',    'fact',        '현장 수납',            1, 1, 'native',  1),
 ('field.add_ticket',        'order',    'fact',        '배달 중 리프트권 추가', 1, 1, 'native',  1),
 ('field.deposit_return',    'money',    'fact',        '현장 보증금 반환', 1, 1, 'native',  1),
 ('stock.load',              'stock',    'fact',        '차량 적재',            0, 1, 'adapter', 1),
 ('stock.issue',             'stock',    'fact',        '지급',                 0, 1, 'adapter', 1),
 ('stock.deliver',           'stock',    'fact',        '차량 배달',            0, 1, 'adapter', 1),
 ('stock.collect',           'stock',    'fact',        '차량 수거',            0, 1, 'adapter', 1),
 ('stock.receive',           'stock',    'fact',        '매장 입고',            0, 0, 'adapter', 1),
 ('stock.direct_return',     'stock',    'fact',        '매장 반납',            0, 1, 'adapter', 1),
 ('stock.reverse',           'stock',    'intent',      '처리 취소',        0, 0, 'legacy',  1),
 ('stock.intake',            'stock',    'fact',        '재고 입고',          0, 0, 'adapter', 1),
 ('asset.condition',         'stock',    'fact',        '정비 상태',            0, 0, 'adapter', 1),
 ('asset.found',             'stock',    'fact',        '분실 회수',                 0, 0, 'adapter', 1),
 ('asset.manage',            'stock',    'intent',      '장비 관리',            0, 0, 'legacy',  1),
 ('asset.reclassify',        'stock',    'intent',      '장비 품목 변경',     0, 0, 'native',  1),
 ('preparation.set',         'stock',    'intent',      '준비',                 0, 0, 'legacy',  1),
 ('preparation.cancel',      'stock',    'intent',      '준비 취소',            0, 0, 'legacy',  1),
 ('ticket.issue',            'stock',    'fact',        '발권',                 0, 0, 'adapter', 1),
 ('ticket.allocate',         'stock',    'intent',      '권 배정',              0, 0, 'legacy',  1),
 ('ticket.release',          'stock',    'intent',      '권 배정 해제',         0, 0, 'legacy',  1),
 ('ticket.recover',          'stock',    'fact',        '권 회수',              0, 0, 'adapter', 1),
 ('ticket.hand_out',         'stock',    'fact',        '권 지급(배정 포함)', 0, 1, 'native',  1),
 ('vendor_refund.plan',      'stock',    'intent',      '발권처 환불 준비',     0, 0, 'legacy',  1),
 ('vendor_refund.attempt',   'stock',    'fact',        '발권처 환불',          1, 1, 'adapter', 1),
 ('exchange.request',        'stock',    'intent',      '교환 요청',            0, 0, 'legacy',  1),
 ('exchange.cancel',         'stock',    'intent',      '교환 취소',            0, 0, 'legacy',  1),
 ('exchange.complete',       'stock',    'fact',        '교환 완료',            0, 0, 'adapter', 1),
 ('exchange.recover',        'stock',    'fact',        '교환 회수',            0, 0, 'adapter', 1),
 ('exchange.swap',           'stock',    'fact',        '즉시 교환(카운터)',    0, 1, 'native',  1),
 ('early_return.create',     'stock',    'intent',      '조기 반납',            0, 0, 'legacy',  1),
 ('equipment_loan.move',     'stock',    'fact',        '거래처 장비 대여', 0, 0, 'adapter', 1),
 ('counterparty.trade',      'money',    'fact',        '거래처 거래',          1, 0, 'adapter', 1),
 ('counterparty.settle',     'money',    'fact',        '거래처 정산',          1, 0, 'adapter', 1),
 ('counterparty.agreement',  'money',    'intent',      '거래처 약정',          0, 0, 'legacy',  1),
 ('lesson.close',            'order',    'fact',        '강습 완료 · 불참 · 취소', 0, 0, 'native',  1),
 ('lesson.correct',          'order',    'intent',      '강습 결과 수정',     1, 0, 'native',  1),
 ('placeholder.convert',     'order',    'intent',      '인원 예약 품목 전환', 0, 0, 'native',  1),
 ('task.save',               'dispatch', 'intent',      '차량 업무 생성',     0, 0, 'native',  1),
 ('task.visit',              'dispatch', 'fact',        '방문 결과',            0, 1, 'native',  1),
 ('task.reassign',           'dispatch', 'intent',      '업무 차량 변경',          0, 0, 'native',  1),
 ('route.move',              'dispatch', 'commutative', '방문 순서',            0, 1, 'native',  1),
 ('route.reset',             'dispatch', 'commutative', '시간순 정렬',      0, 1, 'native',  1),
 ('task.pin',                'dispatch', 'commutative', '긴급 요청',            0, 0, 'native',  1),
 ('task.unpin',              'dispatch', 'commutative', '긴급 해제',       0, 0, 'native',  1),
 ('notification.ack',        'dispatch', 'commutative', '알림 확인',            0, 1, 'native',  1),
 ('intake.create',           'order',    'intent',      '사이즈 요청 생성',   0, 0, 'legacy',  1),
 ('intake.revoke',           'order',    'intent',      '사이즈 요청 해지',     0, 0, 'legacy',  1),
 ('intake.submit',           'order',    'fact',        '사이즈 입력',          0, 0, 'adapter', 1),
 ('intake.review',           'order',    'intent',      '사이즈 확인',          0, 0, 'legacy',  1),
 ('intake.apply',            'order',    'intent',      '사이즈 반영',          0, 0, 'legacy',  1),
 ('customer.update',         'order',    'intent',      '고객 정보',            0, 0, 'legacy',  1),
 ('print.request',           'order',    'commutative', '인쇄',                 0, 1, 'native',  1),
 ('print.outcome',           'system',   'system',      '인쇄 결과',            0, 0, 'native',  1),
 ('sms.send',                'order',    'intent',      '문자 발송',          0, 0, 'native',  1),
 ('sms.outcome',             'system',   'system',      '문자 결과',            0, 0, 'native',  1),
 ('inbound.record',          'system',   'system',      '외부 결과 수신',     0, 0, 'native',  1),
 ('registry.update',         'settings', 'intent',      '설정 목록 변경',     0, 0, 'native',  1),
 ('setting.set',             'settings', 'intent',      '매장 설정',            0, 0, 'native',  1),
 ('feature.set',             'settings', 'intent',      '사용 기능',            0, 0, 'native',  1),
 ('ui_defaults.apply',       'settings', 'system',      '화면 기본 설정 반영',  0, 0, 'native',  1),
 ('staff.set',               'settings', 'intent',      '직원',                 0, 0, 'native',  1),
 ('device.register',         'settings', 'intent',      '기기 등록',            0, 0, 'native',  1),
 ('device.sign_in',          'settings', 'system',      '기기 로그인',          0, 1, 'native',  1),
 ('review.resolve',          'sync',     'intent',      '확인 필요 처리',       0, 0, 'native',  1),
 ('customer.anonymize',      'settings', 'intent',      '고객 정보 삭제',     0, 0, 'native',  1),
 ('verifier.repair',         'system',   'system',      '검증 보정',          0, 0, 'native',  1),
 ('legacy.imported',         'import',   'system',      '이전 자료 등록',     0, 0, 'import',  1);

-- What each device kind may queue while it cannot reach the server (sync doc 8-2). Counters record the facts
-- of the counter (지급 · 반납 도장, 적재, 권 주기, 바꿔 드림, money, deposits), new walk-in orders with a provisional
-- receipt number and extra items priced from the cached published price list; decisions about existing orders
-- (promise change, cancel, extend, discounts, reallocation, closing) wait for the connection. Drivers keep the
-- season-1 list. On arrival every queued command is a recorded fact (sync doc 8-12): epoch, basis, conflict keys
-- and expect never send it back; only its decisions (quote, discount, payer, licence) go to a review item.
INSERT INTO sys_offline_limits (key, label, added_in) VALUES
 ('walk_in_cached_quote','현장 접수 · 기기 게시 요금표 · 사전 설정 할인 · 이 팀 결제 또는 후불',1),
 ('own_payer_cached_quote','기기 게시 요금표 · 결제 팀 = 이 팀 · 진행 중 접수',1),
 ('cached_quote','기기 게시 요금표',1),
 ('shop_ticket_stock','기기 사본 매장 권 재고 · 사용 시간 비중복',1),
 ('same_line_swap','같은 품목 줄 번호 · 규격 변경 · 금액 유지',1);

INSERT INTO sys_offline_commands (event_type_key, device_kind_key, limit_key, added_in) VALUES
 ('order.create','pos','walk_in_cached_quote',1), ('order.add','pos','own_payer_cached_quote',1),
 ('stock.issue','pos',NULL,1), ('stock.direct_return','pos',NULL,1), ('stock.load','pos',NULL,1),
 ('ticket.hand_out','pos','shop_ticket_stock',1), ('exchange.swap','pos','same_line_swap',1),
 ('payment.take','pos',NULL,1), ('deposit.take','pos',NULL,1), ('deposit.return','pos',NULL,1),
 ('print.request','pos',NULL,1), ('notification.ack','pos',NULL,1), ('device.sign_in','pos',NULL,1),
 ('stock.deliver','driver_tablet',NULL,1), ('stock.collect','driver_tablet',NULL,1), ('task.visit','driver_tablet',NULL,1),
 ('field.collect','driver_tablet',NULL,1), ('field.add_ticket','driver_tablet','cached_quote',1),
 ('field.deposit_return','driver_tablet',NULL,1), ('vendor_refund.attempt','driver_tablet',NULL,1),
 ('route.move','driver_tablet',NULL,1), ('route.reset','driver_tablet',NULL,1), ('notification.ack','driver_tablet',NULL,1),
 ('device.sign_in','driver_tablet',NULL,1),
 ('stock.deliver','driver_phone',NULL,1), ('stock.collect','driver_phone',NULL,1), ('task.visit','driver_phone',NULL,1),
 ('field.collect','driver_phone',NULL,1), ('field.add_ticket','driver_phone','cached_quote',1),
 ('field.deposit_return','driver_phone',NULL,1), ('vendor_refund.attempt','driver_phone',NULL,1),
 ('route.move','driver_phone',NULL,1), ('route.reset','driver_phone',NULL,1), ('notification.ack','driver_phone',NULL,1),
 ('device.sign_in','driver_phone',NULL,1);

INSERT INTO sys_workspaces (key, label, added_in) VALUES
 ('pos','카운터',1), ('management','관리',1), ('driver','기사',1);

INSERT INTO sys_screens (key, label, route_pattern, template_key, params_schema_key, added_in) VALUES
 ('day_ledger','대여 장부','/ledger/:date','ledger','route.day_ledger',1),
 ('order_slip','접수증','/orders/:orderId','slip','route.order_slip',1),
 ('new_order','새 접수','/orders/new','form',NULL,1),
 ('find_last4','끝 4자리 찾기','/find/:last4',NULL,'route.find',1),
 ('collection_list','수거 목록','/collections/:date','collection_list','route.collection_list',1),
 ('driver_list','기사 목록','/driver/:date','driver_list','route.driver_list',1),
 ('driver_task','업무 판','/driver/tasks/:taskId','slip','route.driver_task',1),
 ('van_stock','차량 재고','/driver/stock',NULL,NULL,1),
 ('review_list','확인 필요','/review','checklist',NULL,1),
 ('closing','마감','/closing/:date','form','route.closing',1),
 ('lift_tickets','리프트권','/tickets',NULL,NULL,1),
 ('lessons','강습','/lessons/:date',NULL,'route.lessons',1),
 ('stock','재고·정비','/stock',NULL,NULL,1),
 ('intake_requests','사이즈 요청','/intake',NULL,NULL,1),
 ('management','관리','/manage','tiles',NULL,1),
 ('more','더 보기','/more','tiles',NULL,1);

INSERT INTO sys_group_keys (key, label, added_in) VALUES
 ('time_bucket','시간대',1), ('return_slot','반납 타임',1), ('place','장소',1), ('area','구역',1), ('vehicle','차량',1);

INSERT INTO sys_sort_keys (key, label, is_time, added_in) VALUES
 ('next_due_at','다음 일정 시각',1,1), ('promised_at','일정 시각',1,1), ('manual_route','방문 순서',0,1), ('receipt_no','접수 번호',0,1);

INSERT INTO sys_fit_modes (key, label, added_in) VALUES
 ('parts','뒷부분부터 생략',1), ('items','외 N종',1), ('words','낱말',1), ('alts','짧은 글',1);

INSERT INTO sys_fold_modes (key, label, added_in) VALUES ('prefix','앞에 표시',1), ('second_line','둘째 줄',1);

INSERT INTO sys_align_keys (key, label, added_in) VALUES ('start','왼쪽',1), ('center','가운데',1), ('end','오른쪽',1);

INSERT INTO sys_overflow_modes (key, label, added_in) VALUES
 ('more_sheet','더 보기',1), ('page','쪽 넘김',1), ('fold','합산',1), ('two_column','두 줄',1);

INSERT INTO sys_tones (key, label, late_only, is_seal, added_in) VALUES
 ('red','빨강(지연만)',1,0,1), ('seal','도장 주홍',0,1,1), ('orange','주황',0,0,1), ('green','초록',0,0,1),
 ('blue','파랑',0,0,1), ('purple','보라',0,0,1), ('grey','회색',0,0,1), ('ink','검정',0,0,1);

INSERT INTO sys_icons (key, label, added_in) VALUES
 ('ski','스키',1), ('board','보드',1), ('clothing','의류',1), ('helmet','헬멧',1), ('ticket','리프트권',1),
 ('lesson','강습',1), ('goggles','고글',1), ('protector','보호대',1), ('boots','부츠',1), ('generic','기타',1);

INSERT INTO sys_picker_placements (key, label, added_in) VALUES
 ('tile','타일',1), ('grouped','타일 묶음',1), ('hidden','선택 목록 제외',1);

INSERT INTO sys_conditions (key, scope_key, label, added_in) VALUES
 ('always','any','항상',1), ('vehicle_pickup','line','차량 배달 일정 있음',1), ('vehicle_return','line','차량 수거 일정 있음',1),
 ('return_required','line','반납 필요',1), ('exchangeable','line','교환 가능',1), ('extendable','line','연장 가능',1),
 ('partial_cancel_allowed','line','부분 취소 가능',1), ('has_open_tasks','order','미처리 차량 업무',1),
 ('has_due','order','미수 있음',1), ('has_items_out','line','미반납 장비 있음',1),
 ('before_last_return_slot','view','마지막 반납 타임 이전',1), ('after_last_return_slot','view','마지막 반납 타임 이후',1);

INSERT INTO sys_status_keys (domain_key, key, default_label, added_in) VALUES
 ('order','booked','예약',1), ('order','cancelled','취소',1), ('order','awaiting_exchange','교환 대기',1),
 ('order','needs_review','확인 필요',1), ('order','partial_return','부분 반납',1), ('order','in_use','이용 중',1),
 ('order','awaiting_shop','입고 대기',1), ('order','awaiting_load','차량 적재 대기',1), ('order','awaiting_issue','지급 대기',1),
 ('order','returned','반납 완료',1), ('order','completed','완료',1),
 ('line','todo','미처리',1), ('line','partial','부분',1), ('line','done','완료',1), ('line','na','해당 없음',1),
 ('task','waiting','대기',1), ('task','in_progress','진행 중',1), ('task','completed','완료',1), ('task','cancelled','취소',1),
 ('pay_state','paid','수납 완료',1), ('pay_state','partial','부분 수납',1), ('pay_state','unpaid','미수',1),
 ('pay_state','promised','다른 팀 결제 예정',1), ('pay_state','none','청구 없음',1),
 ('promise','active','유효',1), ('promise','superseded','변경됨',1), ('promise','fulfilled','완료',1), ('promise','cancelled','취소',1),
 ('booking','unassigned','강습팀 미정',1), ('booking','reserved','예약',1), ('booking','done','완료',1),
 ('booking','cancelled','취소',1), ('booking','no_show','불참',1),
 ('stamp','todo','미처리',1), ('stamp','partial','부분',1), ('stamp','done','완료',1), ('stamp','na','—',1),
 ('stamp','blocked','대기',1), ('stamp','scheduled','예정',1), ('stamp','delegated','차량 담당',1);

INSERT INTO sys_confirm_templates (key, label, added_in) VALUES
 ('issue','지급',1), ('return','반납',1), ('load','적재',1), ('collect','수거',1), ('receive','매장 입고',1),
 ('pay','수납',1), ('ticket_secure','발권',1), ('lesson_close','강습 완료',1), ('prepare','준비',1),
 ('visit_result','방문 결과',1), ('field_payment','현장 수납',1), ('add_ticket','리프트권 추가',1), ('swap','즉시 교환',1);

INSERT INTO sys_actions (key, label, kind_key, command_key, confirm_template_key, undo_command_key, screen_key, rule_scope_key, added_in) VALUES
 ('stamp.issue','지급 처리','stamp','stock.issue','issue','stock.reverse',NULL,'line',1),
 ('stamp.return','반납 처리','stamp','stock.direct_return','return','stock.reverse',NULL,'line',1),
 ('stamp.load','적재 처리','stamp','stock.load','load','stock.reverse',NULL,'line',1),
 ('stamp.collect','수거 처리','stamp','stock.collect','collect','stock.reverse',NULL,'line',1),
 ('stamp.receive','입고 처리','stamp','stock.receive','receive','stock.reverse',NULL,'task',1),
 ('stamp.ticket_secure','발권 처리','stamp','ticket.allocate','ticket_secure','ticket.release',NULL,'line',1),
 ('stamp.lesson_done','강습 처리','stamp','lesson.close','lesson_close','lesson.correct',NULL,'line',1),
 ('stamp.pay','수납 처리','stamp','payment.take','pay',NULL,NULL,'order',1),
 ('stamp.prepare','준비 처리','stamp','preparation.set','prepare','preparation.cancel',NULL,'line',1),
 ('stamp.ticket_hand_out','권 지급 처리','stamp','ticket.hand_out','issue','stock.reverse',NULL,'line',1),
 ('next_step','다음 처리','next',NULL,NULL,NULL,NULL,'order',1),
 ('new_order','새 접수','screen',NULL,NULL,NULL,'new_order',NULL,1),
 ('close_day','마감','screen',NULL,NULL,NULL,'closing',NULL,1),
 ('receive_to_shop','매장 입고','command','stock.receive','receive','stock.reverse',NULL,'task',1),
 ('pay','수납','command','payment.take','pay',NULL,NULL,'order',1),
 ('change_promise','일정 변경','command','promise.change',NULL,NULL,NULL,'line',1),
 ('exchange','교환','command','exchange.request',NULL,'exchange.cancel',NULL,'line',1),
 ('extend','연장','command','order.extend',NULL,NULL,NULL,'line',1),
 ('cancel','접수 취소','command','order.cancel',NULL,NULL,NULL,'line',1),
 ('early_return','조기 반납','command','early_return.create',NULL,NULL,NULL,'line',1),
 ('print','인쇄','command','print.request',NULL,NULL,NULL,'order',1),
 ('call','전화','device',NULL,NULL,NULL,NULL,'order',1),
 ('not_collected','수거 실패','command','task.visit','visit_result',NULL,NULL,'task',1),
 ('not_delivered','배달 실패','command','task.visit','visit_result',NULL,NULL,'task',1),
 ('field_collect','현장 수납','command','field.collect','field_payment',NULL,NULL,'order',1),
 ('leave_unpaid','후불 처리','command','payment_promise.set',NULL,NULL,NULL,'order',1),
 ('add_ticket','리프트권 추가','command','field.add_ticket','add_ticket',NULL,NULL,'order',1),
 ('exchange_swap','즉시 교환','command','exchange.swap','swap',NULL,NULL,'line',1),
 ('move_up','▲','command','route.move',NULL,NULL,NULL,'task',1),
 ('move_down','▼','command','route.move',NULL,NULL,NULL,'task',1),
 ('move_top','맨 위로','command','route.move',NULL,NULL,NULL,'task',1),
 ('route_reset','시간순 정렬','command','route.reset',NULL,NULL,NULL,'task',1),
 ('pin','긴급 요청','command','task.pin',NULL,'task.unpin',NULL,'task',1),
 ('open_slip','접수증','screen',NULL,NULL,NULL,'order_slip',NULL,1);

INSERT INTO sys_input_widgets (key, label, added_in) VALUES
 ('keypad','숫자판',1), ('option_grid','선택 격자(쪽 넘김)',1), ('toggle','사용·미사용',1),
 ('slot_buttons','시각 버튼',1), ('text','글자(화면 키보드)',1), ('date_picker','달력',1);

INSERT INTO sys_display_formats (key, label, added_in) VALUES
 ('plain','그대로',1), ('number_unit','숫자+단위',1), ('money','금액',1), ('local_time','시각',1),
 ('relative_date','오늘·내일·모레',1), ('option_label','선택지 이름',1);

INSERT INTO sys_stamp_states (key, label, tone_key, added_in) VALUES
 ('todo','미처리','ink',1), ('partial','부분','orange',1), ('done','완료(도장)','seal',1), ('na','해당 없음','grey',1),
 ('blocked','대기','grey',1), ('scheduled','예정(다른 팀·후불)','blue',1), ('delegated','차량 담당','purple',1);

INSERT INTO sys_stamp_rollups (key, label, description, added_in) VALUES
 ('worst_of','최저 진행 상태','team cell = the least advanced line state; na lines are ignored; mixed done/todo = partial',1),
 ('first_open','첫 미처리 단계','chain cell = the first step of the chain that is not done (적재 before 지급)',1);

INSERT INTO sys_row_grains (key, label, added_in) VALUES
 ('order','팀 한 줄',1), ('order_line','품목 한 줄',1), ('task','업무 한 줄',1), ('service_booking','강습 한 줄',1), ('asset','장비 한 줄',1);

INSERT INTO sys_row_grain_entities (row_grain_key, entity_type_key, join_path_key, added_in) VALUES
 ('order','order','self',1), ('order','customer','order.customer',1),
 ('order_line','order_line','self',1), ('order_line','order','line.order',1), ('order_line','catalog_item','line.item',1),
 ('order_line','item_variant','line.variant',1), ('order_line','customer','line.order.customer',1),
 ('task','task','self',1), ('task','order','task.order',1), ('task','place','task.place',1), ('task','customer','task.order.customer',1),
 ('service_booking','order','booking.order',1), ('service_booking','order_line','booking.line',1),
 ('service_booking','counterparty','booking.team',1),
 ('asset','asset','self',1), ('asset','catalog_item','asset.item',1), ('asset','item_variant','asset.variant',1);

INSERT INTO sys_tax_categories (key, label, rate_bp, revenue_basis_key, added_in) VALUES
 ('taxable','과세 10%',1000,'gross',1), ('exempt','면세',0,'gross',1), ('zero_rated','영세율',0,'gross',1),
 ('agency','대행(수수료만 매출)',1000,'commission',1);

INSERT INTO sys_place_uses (key, label, added_in) VALUES
 ('pickup','수령',1), ('return','반납',1), ('lodging','숙소',1), ('meeting','집결(강습)',1),
 ('parking','주차장',1), ('locker','보관함',1), ('bus_stop','정류장',1);
