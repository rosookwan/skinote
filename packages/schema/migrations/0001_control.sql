-- 0001_control · 스키노트 마이그레이션 0001 (control.sqlite)
-- 이 파일은 tools/split.js가 packages/schema/schema.sql에서 만든다. 손으로 고치지 않는다.
-- schema.sql의 "@database control" 부분과 "@seed control" 부분을 그대로 옮긴 것이고, 실행기가 한 트랜잭션으로 적용한다.
-- schema.sql을 고쳤으면 `npm run split -w @skinote/schema`로 다시 만든다(시험이 어긋남을 잡는다).
-- 한 번 배포한 뒤에는 바꾸지 않는다: 적용한 파일의 checksum이 다르면 실행기가 쓰기를 거절한다.

-- @database control
-- =====================================================================================
-- PART 1 · CONTROL DATABASE (control.sqlite)
-- One per deployment. On a shop PC it sits next to the shop file; in SaaS it is the
-- central platform database. Security state (lockouts, revocations) is updated in place;
-- every change made through the admin console also writes platform_audit_log.
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
  deployment_key           TEXT    NOT NULL,      -- shop_pc | saas | demo (code-owned)
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
  data_location  TEXT    NOT NULL,                -- 'sqlite:shop-<id>.sqlite' | 'pg:<schema>'
  status_key     TEXT    NOT NULL DEFAULT 'active',   -- active | suspended | closed (code-owned)
  is_test        INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0,1)),   -- demo shop: nothing reaches customers
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE UNIQUE INDEX tenants_code ON tenants (code);

CREATE TABLE accounts (                           -- a person who can sign in (docs/45)
  id                    TEXT    NOT NULL PRIMARY KEY,   -- global ULID minted once; a shop PC's control file copies it, never re-mints
  login_realm           TEXT    NOT NULL DEFAULT 'platform',   -- tenant code ('shop1') for shop staff, 'platform' for admins;
                                                  -- logins such as 'counter1' may repeat across shops, so the realm is part of the key
  login_id              TEXT,                     -- lower-cased; NULL for imported legacy actors that cannot sign in
  display_name          TEXT    NOT NULL,         -- shown as '삭제된 계정' once deleted_at is set
  password_hash         TEXT,                     -- PHC string (scrypt / argon2id); never leaves the server
  pin_hash              TEXT,                     -- short PIN for quick staff switch on a registered shop device
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
  kind_key        TEXT    NOT NULL,               -- staff | admin | agent | legacy_token (code-owned)
  account_id      TEXT    REFERENCES accounts(id),-- NULL only for legacy_token sessions until cutover
  tenant_id       TEXT    REFERENCES tenants(id), -- chosen shop; NULL for the admin console
  device_id       TEXT,                           -- devices.id in the shop file (no cross-file FK)
  staff_member_id TEXT,                           -- staff_members.id in the shop file, set after shop choice or PIN switch
  legacy_actor_json TEXT,                         -- imported {id, role, vehicleId, permissions} of the old access file
  created_at      TEXT    NOT NULL,
  last_used_at    TEXT    NOT NULL,
  idle_timeout_s  INTEGER NOT NULL CHECK (idle_timeout_s > 0),   -- driver devices: long (14 days); counter: shift length
  expires_at      TEXT    NOT NULL,
  revoked_at      TEXT,
  revoke_reason   TEXT,
  ip_hash         TEXT,
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
  method_key  TEXT    NOT NULL,                   -- password | pin | token (code-owned)
  succeeded   INTEGER NOT NULL CHECK (succeeded IN (0,1)),
  reason_key  TEXT,                               -- bad_password | locked | suspended | ok
  ip_hash     TEXT,
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

CREATE TABLE licence_signing_keys (               -- PUBLIC keys only; the private key never enters any database
  key_id       TEXT NOT NULL PRIMARY KEY,
  algorithm    TEXT NOT NULL,                     -- 'Ed25519'
  public_key   TEXT NOT NULL,                     -- base64
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
  status_key             TEXT    NOT NULL DEFAULT 'active', -- active | suspended | deleted
  token                  TEXT    NOT NULL,        -- vendor-signed claims (Ed25519); the shop server verifies it with the
                                                  -- public key built into the app, so editing this row does not unlock anything
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
  id                   TEXT    NOT NULL PRIMARY KEY,   -- vendor-fixed ULID shipped with the template package, so a shop PC's
                                                       -- copy and the central database agree (template_applications.template_id)
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
  chain_id     TEXT    NOT NULL,                  -- db_instance.instance_id of the file that wrote it: chains of several
                                                  -- shop PCs merge into a central database without renumbering
  seq          INTEGER NOT NULL CHECK (seq >= 1), -- gapless order inside the chain (PostgreSQL: appends serialised per chain)
  id           TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  tenant_id    TEXT,                              -- NULL = platform scope
  account_id   TEXT,
  actor_label  TEXT    NOT NULL,
  device_id    TEXT,
  session_id   TEXT,
  ip_hash      TEXT,
  category_key TEXT    NOT NULL,                  -- login | account | licence | template | settings | export | backup | restore | error
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

CREATE TABLE usage_daily (                        -- admin dashboard counters, pushed by each shop server
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
  kind_key      TEXT    NOT NULL,                 -- hourly | nightly | pre_migration | pre_import | manual | season_archive
  file_name     TEXT    NOT NULL,
  bytes         INTEGER NOT NULL CHECK (bytes >= 0),
  sha256        TEXT    NOT NULL,
  epoch_id      TEXT    NOT NULL,
  max_rev       INTEGER,                          -- shop files: highest rev inside the copy
  last_hash     TEXT,                             -- shop files: journal hash at max_rev (chain continuity on restore)
  encrypted     INTEGER NOT NULL DEFAULT 1 CHECK (encrypted IN (0,1)),
  status_key    TEXT    NOT NULL,                 -- written | verified | offsite | failed | expired
  created_at    TEXT    NOT NULL,
  verified_at   TEXT,
  offsite_at    TEXT,
  expires_at    TEXT,
  note          TEXT
) STRICT;
CREATE INDEX backups_tenant ON backups (tenant_id, created_at);

CREATE TABLE restore_drills (                     -- weekly automated restore test: restore, integrity_check, verifier, counts
  id           TEXT    NOT NULL PRIMARY KEY,
  backup_id    TEXT    NOT NULL REFERENCES backups(id),
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
-- Shop files are per tenant and shop PCs sit behind NAT, so the platform keeps the directory and
-- a relay inbox that each shop server pulls from; under PostgreSQL row security these rows are
-- read before skinote.shop_id is set.
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

CREATE TABLE inbound_events (                     -- relay inbox: callbacks received centrally, pulled by the shop server
  id            TEXT    NOT NULL PRIMARY KEY,     -- ULID; also the request id of the system command the shop records
  tenant_id     TEXT,                             -- NULL until routed through public_links / external_refs
  provider_key  TEXT    NOT NULL,
  external_id   TEXT,
  payload_json  TEXT    NOT NULL,
  received_at   TEXT    NOT NULL,
  routed_at     TEXT,
  pulled_at     TEXT,                             -- the shop server acknowledged it (idempotent by id)
  status_key    TEXT    NOT NULL DEFAULT 'received'   -- received | routed | pulled | unroutable
) STRICT;
CREATE INDEX inbound_events_pending ON inbound_events (tenant_id, received_at) WHERE pulled_at IS NULL;

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
  target_key  TEXT    NOT NULL,                   -- lan_peer | usb | offsite
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

-- @seed control
INSERT INTO sys_features (key, label, description, default_enabled, depends_on_json, added_in) VALUES
 ('vehicles',             '차량 배달·수거',        'vans, driver devices, delivery and collection tasks', 1, '[]', 1),
 ('night_collection',     '야간 수거',             'night return slots, collection list night group, prep reminder', 0, '["vehicles"]', 1),
 ('lift_tickets',         '리프트권 대행',         'ticket products, issue, allocation, recovery, vendor refunds', 0, '[]', 1),
 ('lessons',              '강습',                  'lesson kind, lesson teams (강습팀), lesson list, lesson_done stamp', 0, '[]', 1),
 ('size_preinput',        '사이즈 미리 받기',      'intake links, submissions, reviews, prep sheet', 0, '[]', 1),
 ('partner_ledger',       '거래처 장부',           'counterparty trades, settlements, equipment loans', 0, '[]', 1),
 ('deposits',             '보증금',                'security deposit holds', 0, '[]', 1),
 ('prepayment',           '선입금 방식',           'prepayment purpose and the prepayment_mode setting in the confirm window', 1, '[]', 1),
 ('exchange',             '교환',                  'size / damage exchange for exchangeable kinds', 1, '[]', 1),
 ('driver_field_payment', '배달 현장 수납',        'driver sees due, collects in the field, adds tickets from van stock', 0, '["vehicles"]', 1),
 ('multi_order_payment',  '여러 팀 한 번에 수납',  'one tender across several orders, payer team promises', 1, '[]', 1),
 ('split_payment',        '나눠서 결제',           'one order paid in rounds by items and quantities', 0, '[]', 1),
 ('card_terminal',        '카드 단말 연동',        'payment intents through a terminal agent', 0, '[]', 1),
 ('sms',                  '문자 발송',             'real SMS through a provider (test shops go to a sink)', 0, '[]', 1),
 ('bundles',              '세트 상품',             'bundle items and component lines', 0, '[]', 1),
 ('advanced_pricing',     '요금 조건',             'day types, seasons, classes, multi-day tiers', 0, '[]', 1),
 ('branches',             '지점',                  'locations of one business in one shop file; each closing scope closes its own day', 0, '[]', 1),
 ('label_printer',        '라벨 프린터',           'print agent for team labels', 0, '[]', 1),
 ('customer_profiles',    '고객 기록',             'customers table, tags, visit history', 1, '[]', 1);
