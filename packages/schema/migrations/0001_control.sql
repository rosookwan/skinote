-- 0001_control · 스키노트 마이그레이션 0001 (control.sqlite)
-- 이 파일은 tools/split.js가 packages/schema/schema.sql에서 만든다. 손으로 고치지 않는다.
-- schema.sql의 "@database control" 부분과 "@seed control" 부분을 그대로 옮긴 것이고, 실행기가 한 트랜잭션으로 적용한다.
-- schema.sql을 고쳤으면 `npm run split -w @skinote/schema`로 다시 만든다(시험이 어긋남을 잡는다).
-- 한 번 배포한 뒤에는 바꾸지 않는다: 적용한 파일의 checksum이 다르면 실행기가 쓰기를 거절한다.

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
