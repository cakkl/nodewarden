import type { User } from '../types';

type SafeBind = (stmt: D1PreparedStatement, ...values: any[]) => D1PreparedStatement;
const USER_SELECT_COLUMNS =
  'id, email, name, master_password_hint, master_password_hash, key, private_key, public_key, ' +
  'kdf_type, kdf_iterations, kdf_memory, kdf_parallelism, security_stamp, role, status, verify_devices, ' +
  'totp_secret, totp_recovery_code, yubikey_key1, yubikey_key2, yubikey_key3, yubikey_key4, yubikey_key5, yubikey_nfc, api_key, email_verified, locale, auto_locale, timezone, auto_timezone, mail_opt_in, created_at, updated_at';

function mapUserRow(row: any): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    masterPasswordHint: row.master_password_hint ?? null,
    masterPasswordHash: row.master_password_hash,
    key: row.key,
    privateKey: row.private_key,
    publicKey: row.public_key,
    kdfType: row.kdf_type,
    kdfIterations: row.kdf_iterations,
    kdfMemory: row.kdf_memory ?? undefined,
    kdfParallelism: row.kdf_parallelism ?? undefined,
    securityStamp: row.security_stamp,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'banned' ? 'banned' : 'active',
    verifyDevices: row.verify_devices == null ? false : !!row.verify_devices,
    totpSecret: row.totp_secret ?? null,
    totpRecoveryCode: row.totp_recovery_code ?? null,
    yubikeyKey1: row.yubikey_key1 ?? null,
    yubikeyKey2: row.yubikey_key2 ?? null,
    yubikeyKey3: row.yubikey_key3 ?? null,
    yubikeyKey4: row.yubikey_key4 ?? null,
    yubikeyKey5: row.yubikey_key5 ?? null,
    yubikeyNfc: !!row.yubikey_nfc,
    apiKey: row.api_key ?? null,
    emailVerified: row.email_verified == null ? false : !!row.email_verified,
    locale: row.locale ?? null,
    autoLocale: row.auto_locale == null ? false : !!row.auto_locale,
    timezone: row.timezone ?? null,
    autoTimezone: row.auto_timezone == null ? false : !!row.auto_timezone,
    mailOptIn: row.mail_opt_in == null ? false : !!row.mail_opt_in,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getUser(db: D1Database, email: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${USER_SELECT_COLUMNS} FROM users WHERE email = ?`)
    .bind(email.toLowerCase())
    .first<any>();
  if (!row) return null;
  return mapUserRow(row);
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${USER_SELECT_COLUMNS} FROM users WHERE id = ?`)
    .bind(id)
    .first<any>();
  if (!row) return null;
  return mapUserRow(row);
}

export async function getUserCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>();
  return Number(row?.count || 0);
}

/**
 * 「还能用的管理员」数量。
 *
 * 口径必须与 `handlers/admin.ts` 的 `isAdmin()` 一致：`role = 'admin'` **且** `status = 'active'`。只数
 * `role` 会把**被 ban 的管理员**也算进去 —— 那种行占着“有管理员”的名额，却登不进管理端，于是“最后
 * 一个可用管理员已被移除”成了一个隐形状态（`ensureAdminUserExists` 历史上就踩过：它只看 role，于是
 * 直接返回、不再兜底）。
 */
export async function countActiveAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'")
    .first<{ count: number }>();
  return Number(row?.count || 0);
}

export async function getAllUsers(db: D1Database): Promise<User[]> {
  const res = await db
    .prepare(`SELECT ${USER_SELECT_COLUMNS} FROM users ORDER BY created_at ASC`)
    .all<any>();
  return (res.results || []).map((row) => mapUserRow(row));
}

export async function saveUser(db: D1Database, safeBind: SafeBind, user: User): Promise<void> {
  const email = user.email.toLowerCase();
  const stmt = db.prepare(
    'INSERT INTO users(id, email, name, master_password_hint, master_password_hash, key, private_key, public_key, kdf_type, kdf_iterations, kdf_memory, kdf_parallelism, security_stamp, role, status, verify_devices, totp_secret, totp_recovery_code, yubikey_key1, yubikey_key2, yubikey_key3, yubikey_key4, yubikey_key5, yubikey_nfc, api_key, created_at, updated_at) ' +
    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET ' +
    'email=excluded.email, name=excluded.name, master_password_hint=excluded.master_password_hint, master_password_hash=excluded.master_password_hash, key=excluded.key, private_key=excluded.private_key, public_key=excluded.public_key, ' +
    'kdf_type=excluded.kdf_type, kdf_iterations=excluded.kdf_iterations, kdf_memory=excluded.kdf_memory, kdf_parallelism=excluded.kdf_parallelism, security_stamp=excluded.security_stamp, role=excluded.role, status=excluded.status, verify_devices=excluded.verify_devices, totp_secret=excluded.totp_secret, totp_recovery_code=excluded.totp_recovery_code, yubikey_key1=excluded.yubikey_key1, yubikey_key2=excluded.yubikey_key2, yubikey_key3=excluded.yubikey_key3, yubikey_key4=excluded.yubikey_key4, yubikey_key5=excluded.yubikey_key5, yubikey_nfc=excluded.yubikey_nfc, api_key=excluded.api_key, updated_at=excluded.updated_at'
  );
  await safeBind(
    stmt,
    user.id,
    email,
    user.name,
    user.masterPasswordHint,
    user.masterPasswordHash,
    user.key,
    user.privateKey,
    user.publicKey,
    user.kdfType,
    user.kdfIterations,
    user.kdfMemory,
    user.kdfParallelism,
    user.securityStamp,
    user.role,
    user.status,
    user.verifyDevices ? 1 : 0,
    user.totpSecret,
    user.totpRecoveryCode,
    user.yubikeyKey1,
    user.yubikeyKey2,
    user.yubikeyKey3,
    user.yubikeyKey4,
    user.yubikeyKey5,
    user.yubikeyNfc ? 1 : 0,
    user.apiKey,
    user.createdAt,
    user.updatedAt
  ).run();
}

export async function createUser(db: D1Database, safeBind: SafeBind, user: User): Promise<void> {
  await saveUser(db, safeBind, user);
}

// 邮箱验证状态单独写：saveUser 是全字段覆盖，让它携带该列容易被无关改动误重置。
// 改邮箱时必须显式调用本函数传 false。
export async function setEmailVerified(db: D1Database, userId: string, verified: boolean): Promise<void> {
  await db
    .prepare('UPDATE users SET email_verified = ?, updated_at = ? WHERE id = ?')
    .bind(verified ? 1 : 0, new Date().toISOString(), userId)
    .run();
}

// 用户级「语言 / 时区」偏好（见 docs/TODO/MAIL-PREFS.md）同样走**专用 UPDATE**，不进 `saveUser`。
// `auto_* = 1` = 值来自自动检测（登录时可按浏览器刷新）；`0` = 用户自己选定，永不被自动改写。

/**
 * 用户自己选定：写值（可选）并设置来源标记。
 *
 * `locale` / `timezone` 传 `null` = 清空回「未设定」；省略 = 不动该字段。
 * `*Auto: true` = 标为「自动档」（界面选「自动（按浏览器）」时传），此后登录可按浏览器刷新。
 */
export async function saveUserPreferences(
  db: D1Database,
  userId: string,
  update: {
    locale?: string | null;
    localeAuto?: boolean;
    timezone?: string | null;
    timezoneAuto?: boolean;
    mailOptIn?: boolean;
  }
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (update.locale !== undefined) {
    sets.push('locale = ?');
    values.push(update.locale);
  }
  if (update.localeAuto !== undefined) {
    sets.push('auto_locale = ?');
    values.push(update.localeAuto ? 1 : 0);
  }
  if (update.timezone !== undefined) {
    sets.push('timezone = ?');
    values.push(update.timezone);
  }
  if (update.timezoneAuto !== undefined) {
    sets.push('auto_timezone = ?');
    values.push(update.timezoneAuto ? 1 : 0);
  }
  if (update.mailOptIn !== undefined) {
    sets.push('mail_opt_in = ?');
    values.push(update.mailOptIn ? 1 : 0);
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  values.push(new Date().toISOString(), userId);
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

/**
 * 自动填充 / 刷新：**只在「未设定」或「当前是自动档且值真的变了」时才写**。
 *
 * 两个条件都必须写在 SQL 里（先写后判）：前端读到状态后、写入到达前，用户可能已在另一个
 * 标签页选定了具体值，无条件的写会把它静默覆盖（同款先例：`claimConfigValue()`）。
 * `raw <> ?` 不能省 —— SQLite 把「赋成同一个值」也算改动，否则每次登录都白刷 `updated_at`
 *（D1 按写入行数计费），返回的 `*Written` 也不再等价于「值变了」。
 */
export async function detectUserPreferences(
  db: D1Database,
  userId: string,
  detected: { locale?: string | null; timezone?: string | null }
): Promise<{ localeWritten: boolean; timezoneWritten: boolean }> {
  const now = new Date().toISOString();

  let localeWritten = false;
  if (detected.locale) {
    const result = await db
      .prepare(
        'UPDATE users SET locale = ?, auto_locale = 1, updated_at = ? ' +
          'WHERE id = ? AND (locale IS NULL OR (auto_locale = 1 AND locale <> ?))'
      )
      .bind(detected.locale, now, userId, detected.locale)
      .run();
    localeWritten = Number(result.meta.changes ?? 0) > 0;
  }

  let timezoneWritten = false;
  if (detected.timezone) {
    const result = await db
      .prepare(
        'UPDATE users SET timezone = ?, auto_timezone = 1, updated_at = ? ' +
          'WHERE id = ? AND (timezone IS NULL OR (auto_timezone = 1 AND timezone <> ?))'
      )
      .bind(detected.timezone, now, userId, detected.timezone)
      .run();
    timezoneWritten = Number(result.meta.changes ?? 0) > 0;
  }

  return { localeWritten, timezoneWritten };
}

export async function createFirstUser(db: D1Database, safeBind: SafeBind, user: User): Promise<boolean> {
  const email = user.email.toLowerCase();
  const stmt = db.prepare(
    'INSERT INTO users(id, email, name, master_password_hint, master_password_hash, key, private_key, public_key, kdf_type, kdf_iterations, kdf_memory, kdf_parallelism, security_stamp, role, status, verify_devices, totp_secret, totp_recovery_code, yubikey_key1, yubikey_key2, yubikey_key3, yubikey_key4, yubikey_key5, yubikey_nfc, api_key, created_at, updated_at) ' +
    'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ' +
    'WHERE NOT EXISTS (SELECT 1 FROM users LIMIT 1)'
  );
  const result = await safeBind(
    stmt,
    user.id,
    email,
    user.name,
    user.masterPasswordHint,
    user.masterPasswordHash,
    user.key,
    user.privateKey,
    user.publicKey,
    user.kdfType,
    user.kdfIterations,
    user.kdfMemory,
    user.kdfParallelism,
    user.securityStamp,
    user.role,
    user.status,
    user.verifyDevices ? 1 : 0,
    user.totpSecret,
    user.totpRecoveryCode,
    user.yubikeyKey1,
    user.yubikeyKey2,
    user.yubikeyKey3,
    user.yubikeyKey4,
    user.yubikeyKey5,
    user.yubikeyNfc ? 1 : 0,
    user.apiKey,
    user.createdAt,
    user.updatedAt
  ).run();

  return (result.meta.changes ?? 0) > 0;
}

export async function deleteUserById(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
