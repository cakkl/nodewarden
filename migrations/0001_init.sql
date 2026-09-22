PRAGMA foreign_keys = ON;

-- IMPORTANT:
-- This is the initial D1 schema. Keep it in sync with
-- src/services/storage-schema.ts (SCHEMA_STATEMENTS).
-- Any new table/column/index must be added to both places together.
--
-- WHEN CHANGING THIS:
-- - Also bump STORAGE_SCHEMA_VERSION in src/services/storage.ts.
-- - If the new table stores persistent data, update backup export/import.
-- - Keep src/services/storage-schema.ts idempotent for existing installs.

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  master_password_hint TEXT,
  master_password_hash TEXT NOT NULL,
  key TEXT NOT NULL,
  private_key TEXT,
  public_key TEXT,
  kdf_type INTEGER NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  kdf_memory INTEGER,
  kdf_parallelism INTEGER,
  security_stamp TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  verify_devices INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_recovery_code TEXT,
  -- YubiKey OTP：最多 5 个密钥槽 + NFC 开关。
  -- 与 storage-schema.ts 的运行时定义保持一致（原先仅运行时建表包含这 6 列）。
  yubikey_key1 TEXT,
  yubikey_key2 TEXT,
  yubikey_key3 TEXT,
  yubikey_key4 TEXT,
  yubikey_key5 TEXT,
  yubikey_nfc INTEGER NOT NULL DEFAULT 0,
  api_key TEXT,
  -- 邮箱是否已由用户自己验证。默认 0：未验证的邮箱不接收任何通知邮件。
  email_verified INTEGER NOT NULL DEFAULT 0,
  -- 用户级「语言 / 时区」偏好（见 docs/TODO/MAIL-PREFS.md）。
  -- 值与「来源」分开存：auto_* = 1 表示该值是自动检测来的（登录时可按浏览器刷新）；
  -- 0 表示用户自己选定（或一次性迁移写入），永不被自动改写。
  -- NULL = 未设定：邮件回退到英文 / UTC，并在正文追加一句提示。
  locale TEXT,
  auto_locale INTEGER NOT NULL DEFAULT 0,
  timezone TEXT,
  auto_timezone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 邮箱验证码。user_id 作主键 ⇒ 每个用户同时只有一个待用码（新码覆盖旧码）。
-- 存 email 是为了让「发码后用户改了邮箱」的旧码立即失效。
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS domain_settings (
  user_id TEXT PRIMARY KEY,
  equivalent_domains TEXT NOT NULL DEFAULT '[]',
  custom_equivalent_domains TEXT NOT NULL DEFAULT '[]',
  excluded_global_equivalent_domains TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Per-user sync revision date
CREATE TABLE IF NOT EXISTS user_revisions (
  user_id TEXT PRIMARY KEY,
  revision_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ciphers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type INTEGER NOT NULL,
  folder_id TEXT,
  name TEXT,
  notes TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  reprompt INTEGER,
  key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ciphers_user_updated ON ciphers(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_ciphers_user_archived ON ciphers(user_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_ciphers_user_deleted ON ciphers(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_ciphers_user_deleted_updated ON ciphers(user_id, deleted_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_ciphers_user_folder ON ciphers(user_id, folder_id);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_folders_user_updated ON folders(user_id, updated_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  cipher_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  size_name TEXT NOT NULL,
  key TEXT,
  FOREIGN KEY (cipher_id) REFERENCES ciphers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_attachments_cipher ON attachments(cipher_id);

CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type INTEGER NOT NULL,
  name TEXT NOT NULL,
  notes TEXT,
  data TEXT NOT NULL,
  key TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER,
  auth_type INTEGER NOT NULL DEFAULT 2,
  emails TEXT,
  max_access_count INTEGER,
  access_count INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  hide_email INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expiration_date TEXT,
  deletion_date TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sends_user_updated ON sends(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_sends_user_deletion ON sends(user_id, deletion_date);
CREATE INDEX IF NOT EXISTS idx_sends_user_updated_id ON sends(user_id, updated_at, id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  device_identifier TEXT,
  device_session_stamp TEXT,
  security_stamp TEXT,
  created_at INTEGER,
  last_used_at INTEGER,
  absolute_expires_at INTEGER,
  client_type TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
-- 清理用：DELETE FROM refresh_tokens WHERE expires_at < ?
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  used_by TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_status_expires ON invites(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'system',
  level TEXT NOT NULL DEFAULT 'info',
  target_type TEXT,
  target_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  -- 操作者邮箱的**行内快照**（写入时抄一份）。
  -- actor_user_id 上的外键是 ON DELETE SET NULL，而 DELETE FROM users 在
  -- 「恢复备份」与「管理端删除用户」两条路径上都会跑 —— 那一刻该用户所有历史
  -- 日志的 actor_user_id 被置空且不会自愈。有了这份快照，被抹掉的只剩编号，
  -- 邮箱仍留在同一行里。详见 storage-schema.ts 中同一列的说明。
  actor_email TEXT,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_category_created ON audit_logs(category, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_level_created ON audit_logs(level, created_at);

CREATE TABLE IF NOT EXISTS devices (
  user_id TEXT NOT NULL,
  device_identifier TEXT NOT NULL,
  name TEXT NOT NULL,
  type INTEGER NOT NULL,
  session_stamp TEXT,
  encrypted_user_key TEXT,
  encrypted_public_key TEXT,
  encrypted_private_key TEXT,
  push_uuid TEXT,
  push_token TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  banned_at TEXT,
  device_note TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_identifier),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_devices_user_updated ON devices(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_devices_user_last_seen ON devices(user_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_devices_user_push ON devices(user_id, push_token);

CREATE TABLE IF NOT EXISTS auth_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  organization_id TEXT,
  type INTEGER NOT NULL,
  request_device_identifier TEXT NOT NULL,
  request_device_type INTEGER NOT NULL,
  request_ip_address TEXT,
  request_country_name TEXT,
  response_device_identifier TEXT,
  access_code TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key TEXT,
  master_password_hash TEXT,
  approved INTEGER,
  creation_date TEXT NOT NULL,
  response_date TEXT,
  authentication_date TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_auth_requests_user_created
  ON auth_requests(user_id, creation_date);
CREATE INDEX IF NOT EXISTS idx_auth_requests_user_pending
  ON auth_requests(user_id, approved, response_date, authentication_date, creation_date);
CREATE INDEX IF NOT EXISTS idx_auth_requests_device_pending
  ON auth_requests(user_id, request_device_identifier, creation_date);
-- 清理用：DELETE FROM auth_requests WHERE creation_date < ?（不带 user_id）
CREATE INDEX IF NOT EXISTS idx_auth_requests_creation_date
  ON auth_requests(creation_date);

CREATE TABLE IF NOT EXISTS trusted_two_factor_device_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_identifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trusted_two_factor_device_tokens_user_device
  ON trusted_two_factor_device_tokens(user_id, device_identifier);
-- 清理用：DELETE FROM trusted_two_factor_device_tokens WHERE expires_at < ?
CREATE INDEX IF NOT EXISTS idx_trusted_two_factor_device_tokens_expires
  ON trusted_two_factor_device_tokens(expires_at);

CREATE TABLE IF NOT EXISTS totp_login_replays (
  user_id TEXT NOT NULL,
  time_counter INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, time_counter),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_totp_login_replays_consumed_at
  ON totp_login_replays(consumed_at);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  type TEXT,
  aa_guid TEXT,
  transports TEXT,
  encrypted_user_key TEXT,
  encrypted_public_key TEXT,
  encrypted_private_key TEXT,
  supports_prf INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_credentials_credential_id
  ON webauthn_credentials(credential_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
  ON webauthn_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_updated
  ON webauthn_credentials(user_id, updated_at);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
  ON webauthn_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user_scope
  ON webauthn_challenges(user_id, scope);
-- 清理用的语句已拆成两条（见 storage-account-passkey-repo.ts）：
-- `WHERE expires_at < ? OR used_at IS NOT NULL` 里的 OR 会让索引全部失效。
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_used_at
  ON webauthn_challenges(used_at);

-- Rate limiting
CREATE TABLE IF NOT EXISTS login_attempts_ip (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);
-- 清理用（storage-schema.ts 的 maybeCleanupLoginAttempts）：
-- DELETE FROM login_attempts_ip WHERE updated_at < ? AND (locked_until IS NULL OR locked_until < ?)
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_updated_at
  ON login_attempts_ip(updated_at);

CREATE TABLE IF NOT EXISTS used_attachment_download_tokens (
  jti TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
-- 清理用：DELETE FROM used_attachment_download_tokens WHERE expires_at < ?
CREATE INDEX IF NOT EXISTS idx_used_attachment_download_tokens_expires
  ON used_attachment_download_tokens(expires_at);

-- 严格限流预算（storage-schema.ts 的 RateLimitService 使用）。
-- 与 storage-schema.ts 的运行时定义保持一致（原先仅运行时建表包含此表）。
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires
  ON rate_limit_buckets(expires_at);
