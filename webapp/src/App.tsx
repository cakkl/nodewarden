import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import AppAuthenticatedShell from '@/components/AppAuthenticatedShell';
import DateTimePrefsProvider from '@/components/DateTimePrefsProvider';
import AppGlobalOverlays, { type AppConfirmState } from '@/components/AppGlobalOverlays';
import AuthRequestApprovalDialog from '@/components/AuthRequestApprovalDialog';
import AuthViews from '@/components/AuthViews';
import NotFoundPage from '@/components/NotFoundPage';
import PublicSendPage from '@/components/PublicSendPage';
import JwtWarningPage from '@/components/JwtWarningPage';
import {
  createAuthedFetch,
  getEmailVerificationStatus,
  sendEmailVerificationCode,
  submitEmailVerificationCode,
  deriveLoginHash,
  getAuthorizedDevices,
  clearProfileSnapshot,
  getCurrentDeviceIdentifier,
  getPasswordHint,
  getServerConfig,
  getProfile,
  loadProfileSnapshot,
  resendNewDeviceOtp,
  saveProfileSnapshot,
  revokeCurrentSession,
  getTwoFactorProviderStatus,
  getEmailTwoFactorStatus,
  sendEmailTwoFactorLoginCode,
  getVaultRevisionDate,
  saveSession,
  stripProfileSecrets,
} from '@/lib/api/auth';
import {
  encryptSessionUserKeyForAuthRequest,
  isPendingAuthRequest,
  listPendingAuthRequests,
  respondToAuthRequest,
} from '@/lib/api/auth-requests';
import { clearAuditLogs, getAuditLogSettings, listAdminInvites, listAdminUsers, listAuditLogs, saveAuditLogSettings, type AuditLogFilters } from '@/lib/api/admin';
import { getDomainRules, saveDomainRules } from '@/lib/api/domains';
import { clearSecretsContextCache } from '@/lib/api/secrets';
import { getSendById, getSends } from '@/lib/api/send';
import { getCipherById, getFolderById, repairCipherKeyMismatches, repairCipherUriChecksums } from '@/lib/api/vault-lazy';
import { getCachedVaultCoreSnapshot, invalidateVaultCoreSyncSnapshot, loadVaultCoreSyncSnapshot, saveVaultCoreSyncSnapshot } from '@/lib/api/vault-sync';
import { silentlyRepairBackupSettingsIfNeeded } from '@/lib/backup-settings-repair';
import {
  parseSignalRTextFrames,
  readInviteCodeFromUrl,
} from '@/lib/app-support';
import { preloadAuthenticatedWorkspace, preloadDemoExperience } from '@/lib/app-preload';
import {
  bootstrapAppSession,
  type CompletedLogin,
  readInitialAppBootstrapState,
  completePasskeyPasswordLogin,
  performPasswordLogin,
  performPasskeyLogin,
  performRecoverTwoFactorLogin,
  performNewDeviceOtpLogin,
  performRegistration,
  performTotpLogin,
  hydrateLockedSession,
  performUnlock,
  type JwtUnsafeReason,
  type PendingDeviceVerification,
  type PendingPasskeyPassword,
  type PendingTotp,
} from '@/lib/app-auth';
import { assertTwoFactorPasskey } from '@/lib/account-passkeys';
import useAccountSecurityActions from '@/hooks/useAccountSecurityActions';
import useAdminActions from '@/hooks/useAdminActions';
import useAdminMailActions from '@/hooks/useAdminMailActions';
import useBackupActions from '@/hooks/useBackupActions';
import { RESEND_COOLDOWN_SECONDS, useResendCountdown } from '@/hooks/useResendCountdown';
import useI18nRevision from '@/hooks/useI18nRevision';
import useVaultSendActions from '@/hooks/useVaultSendActions';
import useSecretsManager from '@/hooks/useSecretsManager';
import useMachineAccounts from '@/hooks/useMachineAccounts';
import { useToastManager } from '@/hooks/useToastManager';
import { detectBrowserLocale, getLocale, setLocale, t, type Locale } from '@/lib/i18n';
import { shouldWarnUnverifiedEmail } from '@/lib/email-verification-warning';
import { detectPreferences, savePreferences } from '@/lib/api/preferences';
import { detectBrowserTimeZone } from '@/lib/datetime';
import { APP_NOTIFY_EVENT, type AppNotifyDetail } from '@/lib/app-notify';
import { emitSecretsManagerChange, getSecretsManagerTabId } from '@/lib/secrets-realtime';
import { browserReportsOffline, getCurrentNetworkStatus, subscribeNetworkStatus } from '@/lib/network-status';
import { dispatchBackupProgress, type BackupProgressDetail } from '@/lib/backup-restore-progress';
import { clearOfflineUnlockRecord } from '@/lib/offline-auth';
import { clearPasswordSecurityCache } from '@/lib/password-security-cache';
import { requestPersistentStorage, scheduleOfflineLocalePrefetch } from '@/lib/pwa';
import {
  DIRECT_ALIASES,
  IMPORT_EXPORT_ROUTE_ALIASES,
  PUBLIC_SEND_PATH_PATTERN,
  ROUTES,
  isKnownRoutePath,
  isSecretsProductPath,
  normalizeRoutePath,
} from '@/lib/routes';
import { decryptSends, decryptVaultCore } from '@/lib/vault-decrypt';
import { decryptSendsInWorker, decryptVaultCoreInWorker } from '@/lib/vault-worker';
import {
  DEMO_CIPHERS,
  DEMO_ADMIN_INVITES,
  DEMO_ADMIN_USERS,
  DEMO_AUTHORIZED_DEVICES,
  DEMO_FOLDERS,
  DEMO_SENDS,
  createDemoBackupSettings,
  IS_DEMO_MODE,
  createDemoCompletedLogin,
  createDemoInitialBootstrapState,
  createDemoMainRoutesProps,
} from '@/lib/demo';
import type { AdminBackupSettings } from '@/lib/api/backup';
import type { AdminInvite, AdminUser, AppPhase, AuditLogSettings, AuthRequest, AuthorizedDevice, Cipher, CustomEquivalentDomain, DomainRules, Folder as VaultFolder, MailPreferencesUpdate, MailSettings, Profile, Send, SessionState } from '@/lib/types';
import type { VaultCoreSnapshot } from '@/lib/vault-cache';

function isBackupProgressDetail(value: unknown): value is BackupProgressDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Record<string, unknown>;
  const operation = detail.operation;
  return (
    (operation === 'backup-restore' || operation === 'backup-export' || operation === 'backup-remote-run')
    && typeof detail.step === 'string'
    && typeof detail.fileName === 'string'
  );
}

function isAdminProfile(profile: Profile | null): profile is Profile {
  return String(profile?.role || '').toLowerCase() === 'admin';
}

const THEME_STORAGE_KEY = 'nodewarden.theme.preference.v1';

/**
 * 浏览器 UI 底色（安装成 PWA 后是状态栏 / 任务切换器颜色）。
 * 静态 `theme-color` 只写了暗色一个值 ⇒ 浅色主题下状态栏会发黑，得跟着主题改。
 */
const THEME_COLOR_BY_THEME: Record<'light' | 'dark', string> = {
  light: '#eef4ff',
  dark: '#0f172a',
};
const SIGNALR_RECORD_SEPARATOR = String.fromCharCode(0x1e);
const SIGNALR_UPDATE_TYPE_SYNC_CIPHER_UPDATE = 0;
const SIGNALR_UPDATE_TYPE_SYNC_CIPHER_CREATE = 1;
const SIGNALR_UPDATE_TYPE_SYNC_FOLDER_DELETE = 3;
const SIGNALR_UPDATE_TYPE_SYNC_CIPHERS = 4;
const SIGNALR_UPDATE_TYPE_SYNC_VAULT = 5;
const SIGNALR_UPDATE_TYPE_SYNC_FOLDER_CREATE = 7;
const SIGNALR_UPDATE_TYPE_SYNC_FOLDER_UPDATE = 8;
const SIGNALR_UPDATE_TYPE_SYNC_CIPHER_DELETE = 9;
const SIGNALR_UPDATE_TYPE_LOG_OUT = 11;
const SIGNALR_UPDATE_TYPE_SYNC_SEND_CREATE = 12;
const SIGNALR_UPDATE_TYPE_SYNC_SEND_UPDATE = 13;
const SIGNALR_UPDATE_TYPE_SYNC_SEND_DELETE = 14;
const SIGNALR_UPDATE_TYPE_AUTH_REQUEST = 15;
const SIGNALR_UPDATE_TYPE_AUTH_REQUEST_RESPONSE = 16;
const SIGNALR_UPDATE_TYPE_DEVICE_STATUS = 101;
const SIGNALR_UPDATE_TYPE_BACKUP_RESTORE_PROGRESS = 102;
// 机密管理器（不是官方号段：官方 SM 没有推送，只有拉取式同步）
const SIGNALR_UPDATE_TYPE_SM_SECRETS = 103;
const SIGNALR_UPDATE_TYPE_SM_MACHINE_ACCOUNTS = 104;
const TWO_FACTOR_PROVIDER_EMAIL = 1;
const TWO_FACTOR_PROVIDER_YUBIKEY = 3;
const TWO_FACTOR_PROVIDER_WEBAUTHN = 7;
/**
 * 通知连接稳定存活这么久才清零退避。不能在 `open` 里直接清零 ——「连上即断」时
 * 退避会永远从 1 秒重来，形成永不收敛的循环。
 */
const NOTIFICATION_RECONNECT_STABLE_MS = 30_000;

/**
 * `profile` 查询的 key（`profile.id` 优先、回落邮箱，与 `vaultCacheKey` 同口径）。
 * 抽成函数：解锁回填也要往同一个 key 写缓存，两处各写一遍必然漂。
 */
function profileCacheKey(
  profileId: string | null | undefined,
  email: string | null | undefined
): readonly [string, string] {
  return ['profile', String(profileId || email || '').trim()];
}

/** 已授权设备列表的 staleTime。 */
const AUTHORIZED_DEVICES_STALE_MS = 30_000;

type ThemePreference = 'system' | 'light' | 'dark';
type LockTimeoutMinutes = 0 | 1 | 5 | 15 | 30;
type SessionTimeoutAction = 'lock' | 'logout';

const LOCK_TIMEOUT_STORAGE_KEY = 'nodewarden.lock.timeout-minutes.v1';
const SESSION_TIMEOUT_ACTION_STORAGE_KEY = 'nodewarden.session.timeout-action.v1';
const LOCK_TIMEOUT_VALUES = new Set<LockTimeoutMinutes>([0, 1, 5, 15, 30]);
function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  const stored = String(window.localStorage.getItem(THEME_STORAGE_KEY) || '').trim();
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function resolveSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readLockTimeoutMinutes(): LockTimeoutMinutes {
  if (typeof window === 'undefined') return 15;
  const stored = window.localStorage.getItem(LOCK_TIMEOUT_STORAGE_KEY);
  if (stored === null || stored.trim() === '') return 15;
  const value = Number(stored);
  return LOCK_TIMEOUT_VALUES.has(value as LockTimeoutMinutes) ? (value as LockTimeoutMinutes) : 15;
}

function readSessionTimeoutAction(): SessionTimeoutAction {
  if (typeof window === 'undefined') return 'lock';
  const value = String(window.localStorage.getItem(SESSION_TIMEOUT_ACTION_STORAGE_KEY) || '').trim();
  return value === 'logout' ? 'logout' : 'lock';
}

export default function App() {
  // 语言热切换：`t()` 读的是模块级文案表，根组件订阅一次即可带动整棵树重渲染
  // （`memo` 组件不跟着更新，用到 `t()` 的要自己订阅）。
  useI18nRevision();
  const initialBootstrap = useMemo(
    () => (IS_DEMO_MODE ? createDemoInitialBootstrapState() : readInitialAppBootstrapState()),
    []
  );
  const initialInviteCode = useMemo(() => readInviteCodeFromUrl(), []);
  const initialProfileSnapshot = useMemo(
    () => (IS_DEMO_MODE ? null : loadProfileSnapshot(initialBootstrap.session?.email)),
    [initialBootstrap]
  );
  const queryClient = useQueryClient();
  const [pendingAuthAction, setPendingAuthAction] = useState<'login' | 'passkey' | 'register' | 'unlock' | null>(null);
  const [location, navigate] = useLocation();
  const [phase, setPhase] = useState<AppPhase>(initialBootstrap.phase);
  const [session, setSessionState] = useState<SessionState | null>(initialBootstrap.session);
  const [profile, setProfile] = useState<Profile | null>(initialProfileSnapshot);
  /**
   * 解锁回填（`login.profilePromise`）是否还在路上。落地前**不发** `profileQuery`，
   * 否则两边请求同时飞出、同一份 profile 拉两次（实测相隔 6 ms、各 2,697 B）。
   */
  const [profileHydrationPending, setProfileHydrationPending] = useState(false);
  const [defaultKdfIterations, setDefaultKdfIterations] = useState(initialBootstrap.defaultKdfIterations);
  const [registrationInviteRequired, setRegistrationInviteRequired] = useState(initialBootstrap.registrationInviteRequired);
  const [jwtWarning, setJwtWarning] = useState<{ reason: JwtUnsafeReason; minLength: number } | null>(initialBootstrap.jwtWarning);

  const [loginValues, setLoginValues] = useState({ email: '', password: '' });
  const [registerValues, setRegisterValues] = useState({
    name: '',
    email: '',
    password: '',
    password2: '',
    passwordHint: '',
    inviteCode: initialInviteCode,
  });
  const [loginHintState, setLoginHintState] = useState<{
    email: string;
    loading: boolean;
    hint: string | null;
  }>({
    email: '',
    loading: false,
    hint: null,
  });
  const [inviteCodeFromUrl, setInviteCodeFromUrl] = useState(initialInviteCode);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [pendingTotp, setPendingTotp] = useState<PendingTotp | null>(null);
  const [emailCodeResending, setEmailCodeResending] = useState(false);
  // 防重入必须用 ref：`setEmailCodeResending(true)` 是异步的，同一 tick 内连续调用两次时
  // 第二次读到的仍是旧值 ⇒ 会真的发出两封信（进入挑战与切换 provider 可能同时触发）。
  const emailCodeSendingRef = useRef(false);
  // 本轮挑战是否已为邮件方式发过码：默认不是邮件时切过来要补发一枚；已发过则不重发
  // （重发会让用户刚收到的那枚立刻失效，还会撞 60 秒冷却）。
  const emailCodeSentRef = useRef(false);
  // 「重新发送」按钮上的倒计时。邮件 2FA 的剩余秒数优先取自 429 的 `Retry-After`；
  // NDV 的响应刻意与「已发送」逐字一致（防探测）⇒ 拿不到剩余秒数，用本地固定冷却。
  const [emailCodeResendIn, startEmailCodeCountdown] = useResendCountdown();
  // 只保留 setter：这里写入的值当前没有任何读取点（CodeQL js/unused-local-variable）。
  // 7 处 setPendingTotpMode 调用保持原样、行为不变；将来真要用这个状态时把首项命名回来即可。
  const [, setPendingTotpMode] = useState<'login' | 'unlock' | null>(null);
  const [pendingPasskeyPassword, setPendingPasskeyPassword] = useState<PendingPasskeyPassword | null>(null);
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);
  const [totpSubmitting, setTotpSubmitting] = useState(false);
  // 新设备验证（NDV）输码：状态照 `pendingTotp`，区别是验证码由服务端**在挑战响应里**就已发出。
  const [pendingDeviceVerification, setPendingDeviceVerification] = useState<PendingDeviceVerification | null>(null);
  const [deviceOtpCode, setDeviceOtpCode] = useState('');
  const [deviceOtpSubmitting, setDeviceOtpSubmitting] = useState(false);
  const [deviceOtpResending, setDeviceOtpResending] = useState(false);
  // 同 `emailCodeSendingRef`：state 写入是异步的，防重入只能用 ref。
  const deviceOtpSendingRef = useRef(false);
  const [deviceOtpResendIn, startDeviceOtpCountdown] = useResendCountdown();

  const [disableTotpOpen, setDisableTotpOpen] = useState(false);
  const [disableTotpPassword, setDisableTotpPassword] = useState('');
  const [disableTotpSubmitting, setDisableTotpSubmitting] = useState(false);
  const [authRequestDialogDismissedId, setAuthRequestDialogDismissedId] = useState<string | null>(null);
  const [authRequestDialogSelectedId, setAuthRequestDialogSelectedId] = useState<string | null>(null);
  const [authRequestSubmittingId, setAuthRequestSubmittingId] = useState<string | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() => resolveSystemTheme());
  const [lockTimeoutMinutes, setLockTimeoutMinutesState] = useState<LockTimeoutMinutes>(() => readLockTimeoutMinutes());
  const [sessionTimeoutAction, setSessionTimeoutActionState] = useState<SessionTimeoutAction>(() => readSessionTimeoutAction());
  const [unlockPreparing, setUnlockPreparing] = useState(() => initialBootstrap.phase === 'locked' && !initialBootstrap.session?.email);
  const [lockedSessionRefreshError, setLockedSessionRefreshError] = useState('');
  const [lockedSessionRetryKey, setLockedSessionRetryKey] = useState(0);

  const [confirm, setConfirm] = useState<AppConfirmState | null>(null);
  const [mobileLayout, setMobileLayout] = useState(false);
  const [decryptedFolders, setDecryptedFolders] = useState<VaultFolder[]>([]);
  const [decryptedCiphers, setDecryptedCiphers] = useState<Cipher[]>([]);
  const [decryptedSends, setDecryptedSends] = useState<Send[]>([]);
  const [demoUsers, setDemoUsers] = useState<AdminUser[]>(() => DEMO_ADMIN_USERS.map((user) => ({ ...user })));
  const [demoInvites, setDemoInvites] = useState<AdminInvite[]>(() => DEMO_ADMIN_INVITES.map((invite) => ({ ...invite })));
  const [demoAuthorizedDevices, setDemoAuthorizedDevices] = useState<AuthorizedDevice[]>(() => DEMO_AUTHORIZED_DEVICES.map((device) => ({ ...device })));
  const [demoBackupSettings, setDemoBackupSettings] = useState<AdminBackupSettings>(() => createDemoBackupSettings());
  const [cachedVaultCore, setCachedVaultCore] = useState<VaultCoreSnapshot | null>(null);
  const [vaultInitialDecryptDone, setVaultInitialDecryptDone] = useState(false);
  const [vaultDecryptError, setVaultDecryptError] = useState('');
  const [sendsDecryptDone, setSendsDecryptDone] = useState(false);
  const sessionRef = useRef<SessionState | null>(initialBootstrap.session);
  const lockedSessionRetryAttemptRef = useRef(0);
  const silentRefreshVaultRef = useRef<() => Promise<void>>(async () => {});
  const refreshAuthorizedDevicesRef = useRef<() => Promise<void>>(async () => {});
  const refreshPendingAuthRequestsRef = useRef<() => Promise<void>>(async () => {});
  const repairAttemptRef = useRef<string>('');
  const loginScopedBackupRepairAuthRef = useRef<{
    accessToken: string;
    masterPasswordHash?: string | null;
    userVerificationToken?: string | null;
  } | null>(null);
  const uriChecksumRepairAttemptRef = useRef<string>('');
  const pendingVaultCoreQueryRefreshRef = useRef<Promise<{ data?: VaultCoreSnapshot } | unknown> | null>(null);
  const pendingVaultCoreRefreshRef = useRef<Promise<unknown> | null>(null);
  const notificationRefreshTimerRef = useRef<number | null>(null);
  const secretsManagerRefreshTimerRef = useRef<number | null>(null);
  const domainRulesSaveSeqRef = useRef(0);
  const loginEmailRef = useRef(loginValues.email);
  const loginHintRequestSeqRef = useRef(0);
  const { toasts, pushToast, removeToast, pauseToasts, resumeToasts } = useToastManager();

  useEffect(() => {
    const handleAppNotify = (event: Event) => {
      const detail = (event as CustomEvent<AppNotifyDetail>).detail;
      if (!detail?.text) return;
      pushToast(detail.type, detail.text);
    };

    window.addEventListener(APP_NOTIFY_EVENT, handleAppNotify as EventListener);
    return () => window.removeEventListener(APP_NOTIFY_EVENT, handleAppNotify as EventListener);
  }, [pushToast]);

  // 已提醒过「邮箱未验证」的用户 id：profile 会反复刷新，同一次登录只提醒一次。
  const warnedUnverifiedEmailRef = useRef<string | null>(null);

  // 提醒「邮箱未验证」：服务端只对已验证邮箱发信 ⇒ 忘记主密码时收不到提示邮件。
  useEffect(() => {
    if (!shouldWarnUnverifiedEmail(profile, warnedUnverifiedEmailRef.current)) return;
    warnedUnverifiedEmailRef.current = String(profile?.id || '');
    pushToast(
      'warning',
      t('txt_email_verification_unverified_warning', { where: t('nav_account_settings') })
    );
  }, [profile, pushToast]);

  useEffect(() => {
    const syncUrlState = () => {
      setInviteCodeFromUrl(readInviteCodeFromUrl());
    };
    syncUrlState();
    window.addEventListener('hashchange', syncUrlState);
    window.addEventListener('popstate', syncUrlState);
    return () => {
      window.removeEventListener('hashchange', syncUrlState);
      window.removeEventListener('popstate', syncUrlState);
    };
  }, []);

  useEffect(() => {
    if (!inviteCodeFromUrl) return;
    setRegisterValues((prev) => (prev.inviteCode === inviteCodeFromUrl ? prev : { ...prev, inviteCode: inviteCodeFromUrl }));
  }, [inviteCodeFromUrl]);

  useEffect(() => {
    loginEmailRef.current = loginValues.email;
    const normalizedEmail = loginValues.email.trim().toLowerCase();
    setLoginHintState((prev) => (
      prev.email && prev.email !== normalizedEmail
        ? { email: '', loading: false, hint: null }
        : prev
    ));
  }, [loginValues.email]);

  useEffect(() => {
    if (!inviteCodeFromUrl) return;
    if (phase === 'locked' || phase === 'app') return;
    setPhase('register');
    if (location !== ROUTES.register) navigate(ROUTES.register);
    if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
      window.history.replaceState(null, '', ROUTES.register);
    }
    setInviteCodeFromUrl('');
  }, [inviteCodeFromUrl, phase, location, navigate]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1180px)');
    const sync = () => setMobileLayout(media.matches);
    sync();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemTheme(media.matches ? 'dark' : 'light');
    sync();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }
    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  const resolvedTheme = themePreference === 'system' ? systemTheme : themePreference;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', THEME_COLOR_BY_THEME[resolvedTheme]);
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  }, [themePreference]);

  useEffect(() => {
    if (IS_DEMO_MODE) return;
    saveProfileSnapshot(profile);
  }, [profile]);

  useEffect(() => {
    if (phase === 'locked' && session?.email) {
      setUnlockPreparing(false);
    }
  }, [phase, profile, session]);

  useEffect(() => {
    if (phase !== 'app') {
      clearPasswordSecurityCache();
      // 组织密钥在模块作用域里 ⇒ 非解锁态一并清掉
      clearSecretsContextCache();
    }
  }, [phase]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LOCK_TIMEOUT_STORAGE_KEY, String(lockTimeoutMinutes));
  }, [lockTimeoutMinutes]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SESSION_TIMEOUT_ACTION_STORAGE_KEY, sessionTimeoutAction);
  }, [sessionTimeoutAction]);

  function handleToggleTheme() {
    setThemePreference((prev) => {
      const current = prev === 'system' ? systemTheme : prev;
      return current === 'dark' ? 'light' : 'dark';
    });
  }

  function setSession(next: SessionState | null) {
    sessionRef.current = next;
    setSessionState(next);
    saveSession(next);
  }

  function setLockTimeoutMinutes(next: LockTimeoutMinutes) {
    setLockTimeoutMinutesState(next);
    pushToast('success', t('txt_session_timeout_updated'));
  }

  function setSessionTimeoutAction(next: SessionTimeoutAction) {
    setSessionTimeoutActionState(next);
    pushToast('success', t('txt_session_timeout_updated'));
  }

  const authedFetch = useMemo(
    () =>
      createAuthedFetch(
        () => session,
        (next) => {
          setSession(next);
          if (!next) {
            setProfile(null);
            setPhase('login');
          }
        }
      ),
    [session]
  );
  const importAuthedFetch = useMemo(
    () => async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      headers.set('X-NodeWarden-Import', '1');
      return authedFetch(input, { ...init, headers });
    },
    [authedFetch]
  );
  const vaultCacheKey = String(profile?.id || session?.email || '').trim();
  const backupActions = useBackupActions({
    authedFetch,
    onImported: () => {
      window.setTimeout(() => {
        logoutNow();
      }, 200);
    },
    onRestored: () => {
      window.setTimeout(() => {
        logoutNow();
      }, 200);
    },
  });

  useEffect(() => {
    if (IS_DEMO_MODE) {
      const currentHashPath = typeof window !== 'undefined'
        ? (window.location.hash || '').replace(/^#/, '').split('?')[0].split('#')[0]
        : '';
      const normalizedCurrentHashPath = currentHashPath.replace(/^\/+/, '').replace(/\/+$/, '');
      // demo 站点也要能直接打开公开链接：既认路径形态，也认已发出去的旧 hash 形态
      const isDemoPublicSendRoute = typeof window !== 'undefined' && (
        PUBLIC_SEND_PATH_PATTERN.test(normalizeRoutePath(window.location.pathname)) ||
        /^send\/[^/]+(?:\/[^/]+)?$/i.test(normalizedCurrentHashPath)
      );
      setDefaultKdfIterations(initialBootstrap.defaultKdfIterations);
      setRegistrationInviteRequired(initialBootstrap.registrationInviteRequired);
      setJwtWarning(null);
      setSession(null);
      setProfile(null);
      setPhase('login');
      setUnlockPreparing(false);
      if (!isDemoPublicSendRoute && location !== ROUTES.login) navigate(ROUTES.login);
      return;
    }

    let mounted = true;
    (async () => {
      const boot = await bootstrapAppSession(initialBootstrap);
      if (!mounted) return;
      if (sessionRef.current?.symEncKey || sessionRef.current?.symMacKey) return;
      setDefaultKdfIterations(boot.defaultKdfIterations);
      setRegistrationInviteRequired(boot.registrationInviteRequired);
      setJwtWarning(boot.jwtWarning);
      setSession(boot.session);
      setProfile(boot.profile);
      setPhase(boot.phase);
      setUnlockPreparing(boot.phase === 'locked' && !boot.session?.email);
    })();

    return () => {
      mounted = false;
    };
  }, [initialBootstrap]);

  useEffect(() => {
    if (phase !== 'locked' || !session) return;
    if (IS_DEMO_MODE) return;
    let cancelled = false;
    let retryTimerId: number | null = null;
    void (async () => {
      const result = await hydrateLockedSession(session, profile);
      if (cancelled) return;
      if (result.kind === 'expired') {
        setSession(null);
        setProfile(null);
        setUnlockPreparing(false);
        setLockedSessionRefreshError('');
        setPhase('login');
        if (location !== ROUTES.login) navigate(ROUTES.login);
        return;
      }
      setSession(result.session);
      if (result.profile) {
        setProfile(stripProfileSecrets(result.profile));
      }
      if (result.kind === 'transient') {
        setUnlockPreparing(false);
        setLockedSessionRefreshError(result.message || t('txt_session_refresh_temporarily_unavailable'));
        const retrySchedule = [2_000, 5_000, 15_000, 30_000, 60_000];
        const scheduledDelay = retrySchedule[Math.min(lockedSessionRetryAttemptRef.current, retrySchedule.length - 1)];
        lockedSessionRetryAttemptRef.current += 1;
        const retryAfterMs = Math.min(60_000, Math.max(scheduledDelay, result.retryAfterMs || 0));
        retryTimerId = window.setTimeout(() => {
          setLockedSessionRetryKey((value) => value + 1);
        }, retryAfterMs);
        return;
      }
      lockedSessionRetryAttemptRef.current = 0;
      setLockedSessionRefreshError('');
    })();
    return () => {
      cancelled = true;
      if (retryTimerId !== null) window.clearTimeout(retryTimerId);
    };
  }, [phase, session?.email, location, navigate, lockedSessionRetryKey]);

  useEffect(() => {
    if (!lockedSessionRefreshError || phase !== 'locked') return;
    const retryNow = () => {
      lockedSessionRetryAttemptRef.current = 0;
      setLockedSessionRetryKey((value) => value + 1);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') retryNow();
    };
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [lockedSessionRefreshError, phase]);

  async function finalizeLogin(login: CompletedLogin) {
    loginScopedBackupRepairAuthRef.current =
      login.session.accessToken && (login.freshMasterPasswordHash || login.freshUserVerificationToken)
        ? {
            accessToken: login.session.accessToken,
            masterPasswordHash: login.freshMasterPasswordHash || null,
            userVerificationToken: login.freshUserVerificationToken || null,
          }
        : null;
    setSession(login.session);
    setProfile(login.profile);
    setUnlockPreparing(false);
    setLockedSessionRefreshError('');
    setProfileHydrationPending(true);
    setPendingTotp(null);
    setPendingTotpMode(null);
    setPendingPasskeyPassword(null);
    setPendingDeviceVerification(null);
    setDeviceOtpCode('');
    setTotpCode('');
    setPasskeyPassword('');
    setUnlockPassword('');
    setPhase('app');
    if (location === ROUTES.home || location === ROUTES.login || location === ROUTES.register || location === ROUTES.lock) {
      navigate(ROUTES.vault);
    }
    void (async () => {
      try {
        const hydratedProfile = await login.profilePromise;
        if (sessionRef.current?.accessToken !== login.session.accessToken) return;
        setProfile(hydratedProfile);
        // 顺手写进缓存：不然 profileQuery 会把同一份 ~5 KB 再拉一遍。
        queryClient.setQueryData(profileCacheKey(hydratedProfile.id, login.session.email), hydratedProfile);
      } catch {
        // 回填失败也放行，让 profileQuery 走常规路径（自带重试与错误提示）。
      } finally {
        // 必须放行：否则一次失败就把 profileQuery 永久关在门外了。
        setProfileHydrationPending(false);
      }
    })();
  }

  async function handleLogin() {
    if (pendingAuthAction) return;
    if (IS_DEMO_MODE) {
      setPendingAuthAction('login');
      try {
        await finalizeLogin(createDemoCompletedLogin(loginValues.email));
      } finally {
        setPendingAuthAction(null);
      }
      return;
    }
    if (!loginValues.email || !loginValues.password) {
      pushToast('error', t('txt_please_input_email_and_password'));
      return;
    }
    setPendingAuthAction('login');
    try {
      const result = await performPasswordLogin(loginValues.email, loginValues.password, defaultKdfIterations);
      if (result.kind === 'success') {
        await finalizeLogin(result.login);
        return;
      }
      if (result.kind === 'totp') {
        setPendingTotp(result.pendingTotp);
        setPendingTotpMode('login');
        setTotpCode('');
        setRememberDevice(true);
        beginTotpChallenge(result.pendingTotp);
        return;
      }
      // 新设备验证：码已由服务端发出（与挑战同一个响应），这里只需切到输码界面。
      if (result.kind === 'device-verification') {
        setPendingDeviceVerification(result.pendingDeviceVerification);
        setDeviceOtpCode('');
        // 服务端刚发过一封信 ⇒ 重发按钮先冷却 60 秒，否则首次点击会被静默限流、却提示「已发送」。
        startDeviceOtpCountdown(RESEND_COOLDOWN_SECONDS);
        return;
      }
      pushToast('error', result.message || t('txt_login_failed'));
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('txt_login_failed'));
    } finally {
      setPendingAuthAction(null);
    }
  }

  async function handlePasskeyLogin() {
    if (pendingAuthAction) return;
    if (IS_DEMO_MODE) {
      pushToast('warning', t('txt_demo_readonly_message'));
      return;
    }
    setPendingAuthAction('passkey');
    try {
      const result = await performPasskeyLogin(defaultKdfIterations);
      if (result.kind === 'success') {
        await finalizeLogin(result.login);
        return;
      }
      if (result.kind === 'password') {
        setPendingPasskeyPassword(result.pendingPasskeyPassword);
        setLoginValues({ email: result.pendingPasskeyPassword.email, password: '' });
        setPasskeyPassword('');
        pushToast('warning', t('txt_passkey_requires_master_password'));
        return;
      }
      pushToast('error', result.message || t('txt_login_failed'));
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('txt_login_failed'));
    } finally {
      setPendingAuthAction(null);
    }
  }

  async function handlePasskeyUnlock() {
    if (pendingAuthAction) return;
    const expectedEmail = (profile?.email || session?.email || '').trim().toLowerCase();
    if (!expectedEmail) return;
    if (IS_DEMO_MODE) {
      pushToast('warning', t('txt_demo_readonly_message'));
      return;
    }
    setPendingAuthAction('passkey');
    try {
      const result = await performPasskeyLogin(defaultKdfIterations, expectedEmail);
      if (result.kind === 'success') {
        await finalizeLogin(result.login);
        return;
      }
      if (result.kind === 'password') {
        pushToast('error', t('txt_account_passkey_direct_unlock_unavailable_error'));
        return;
      }
      pushToast('error', result.message || t('txt_unlock_failed_master_password_is_incorrect'));
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('txt_unlock_failed_master_password_is_incorrect'));
    } finally {
      setPendingAuthAction(null);
    }
  }

  async function handlePasskeyPasswordLogin() {
    if (pendingAuthAction || !pendingPasskeyPassword) return;
    if (!passkeyPassword) {
      pushToast('error', t('txt_please_input_master_password'));
      return;
    }
    setPendingAuthAction('login');
    try {
      const login = await completePasskeyPasswordLogin(pendingPasskeyPassword, passkeyPassword);
      await finalizeLogin(login);
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('txt_unlock_failed_master_password_is_incorrect'));
    } finally {
      setPendingAuthAction(null);
    }
  }

  function handleSelectTotpProvider(providerType: number) {
    if (totpSubmitting) return;
    setPendingTotp((current) => {
      if (!current || current.providerType === providerType) return current;
      const canUseProvider = current.availableProviders.includes(providerType);
      if (!canUseProvider) return current;
      return {
        ...current,
        providerType,
        providerData: current.providerDataByType[providerType],
      };
    });
    setTotpCode('');
    // 切到邮件：本轮还没发过码才补发一枚（默认不是邮件时用户手里没码）；已发过则不重发、不提示。
    if (providerType === TWO_FACTOR_PROVIDER_EMAIL && pendingTotp && !emailCodeSentRef.current) {
      void sendEmailTwoFactorCode(pendingTotp.email);
    }
  }

  /** 进入两步验证挑战：重置「本轮是否已发过码」，默认方式是邮件时立刻发一枚。 */
  function beginTotpChallenge(pending: PendingTotp): void {
    emailCodeSentRef.current = false;
    if (pending.providerType === TWO_FACTOR_PROVIDER_EMAIL) {
      void sendEmailTwoFactorCode(pending.email);
    }
  }

  /**
   * 发送邮件 2FA 的登录验证码。
   *
   * 失败时**只提示、不中断登录流程** —— 邮件服务的问题不该表现为「登录失败」，
   * 用户看到「验证码发送失败」才知道该重试，而不是以为密码错了。
   */
  async function sendEmailTwoFactorCode(email: string): Promise<void> {
    if (emailCodeSendingRef.current) return;
    emailCodeSendingRef.current = true;
    setEmailCodeResending(true);
    try {
      await sendEmailTwoFactorLoginCode(email);
      // 发码成功即进入冷却：不依赖服务端返回的剩余秒数（成功响应不带它）。
      startEmailCodeCountdown(RESEND_COOLDOWN_SECONDS);
      pushToast('success', t('txt_email_code_sent_to_your_address'));
    } catch (error) {
      // 限流：用服务端的 `Retry-After` 把倒计时对齐到真实剩余时间，而不是固定 60 秒。
      const retryAfter = error instanceof Error ? (error as Error & { retryAfterSeconds?: number }).retryAfterSeconds : undefined;
      if (retryAfter) startEmailCodeCountdown(retryAfter);
      pushToast('error', error instanceof Error ? error.message : t('txt_email_code_send_failed'));
    } finally {
      // 无论成与不成，本轮挑战都算「已经为邮件方式尝试过了」⇒ 后续切换不再自动重试，
      // 免得每次切到邮件都弹一条报错（用户想要的补发可以自己点按钮）。
      emailCodeSentRef.current = true;
      emailCodeSendingRef.current = false;
      setEmailCodeResending(false);
    }
  }

  async function handleTotpVerify() {
    if (totpSubmitting) return;
    if (!pendingTotp) return;
    const isPasskeyTwoFactor = pendingTotp.providerType === TWO_FACTOR_PROVIDER_WEBAUTHN;
    if (!isPasskeyTwoFactor && !totpCode.trim()) {
      pushToast('error', pendingTotp.providerType === TWO_FACTOR_PROVIDER_YUBIKEY ? t('txt_please_input_yubikey_otp') : t('txt_please_input_totp_code'));
      return;
    }
    setTotpSubmitting(true);
    try {
      const token = isPasskeyTwoFactor
        ? await assertTwoFactorPasskey(pendingTotp.providerData)
        : totpCode;
      const login = await performTotpLogin(pendingTotp, token, rememberDevice);
      await finalizeLogin(login);
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : pendingTotp.providerType === 3 ? t('txt_yubikey_verify_failed') : isPasskeyTwoFactor ? t('txt_passkey_verification_failed') : t('txt_totp_verify_failed'));
    } finally {
      setTotpSubmitting(false);
    }
  }

  /**
   * 新设备验证（NDV）：提交邮件验证码。
   *
   * 码与设备标识绑定，`performNewDeviceOtpLogin` 会带上本机标识重发**同一个** password grant。
   */
  async function handleDeviceVerificationSubmit() {
    if (deviceOtpSubmitting || !pendingDeviceVerification) return;
    const code = deviceOtpCode.trim();
    if (!code) return;
    setDeviceOtpSubmitting(true);
    try {
      const login = await performNewDeviceOtpLogin(pendingDeviceVerification, code);
      await finalizeLogin(login);
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('txt_new_device_verification_invalid_code'));
    } finally {
      setDeviceOtpSubmitting(false);
    }
  }

  /**
   * 新设备验证（NDV）：重新发送验证码（失败只提示、不中断 —— 发信问题不该表现为「验证失败」）。
   * 服务端对「发了」与「未发」返回同一响应 ⇒ 提示成功不代表一定有新邮件。
   */
  async function handleResendDeviceOtpCode() {
    if (!pendingDeviceVerification || deviceOtpSendingRef.current) return;
    deviceOtpSendingRef.current = true;
    setDeviceOtpResending(true);
    try {
      await resendNewDeviceOtp(pendingDeviceVerification.email, pendingDeviceVerification.passwordHash);
      startDeviceOtpCountdown(RESEND_COOLDOWN_SECONDS);
      pushToast('success', t('txt_email_code_sent_to_your_address'));
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('txt_email_code_send_failed'));
    } finally {
      deviceOtpSendingRef.current = false;
      setDeviceOtpResending(false);
    }
  }

  /**
   * 登录弹窗里用一次性恢复码恢复（就地，不跳页；主密码材料取自 `pendingTotp`）。
   * 服务端收到恢复码后会**停用全部两步登录**并轮换恢复码 ⇒ 成功提示要把新码带出来。
   */
  /** 恢复码流程的收尾提示：服务端会把恢复码换成新的一份，但不在这里显示（避免被人瞄屏），只提示去哪儿看。 */
  function pushTwoFactorRecoveredToast(): void {
    pushToast('success', t('txt_text_2fa_recovered_check_recovery_code'));
  }
  async function handleSubmitTotpRecoveryCode(recoveryCode: string): Promise<void> {
    if (totpSubmitting || !pendingTotp) return;
    const code = recoveryCode.trim();
    if (!code) return;
    setTotpSubmitting(true);
    try {
      const recovered = await performRecoverTwoFactorLogin(
        pendingTotp.email,
        {
          passwordHash: pendingTotp.passwordHash,
          masterKey: pendingTotp.masterKey,
          kdfIterations: pendingTotp.kdfIterations,
        },
        code
      );
      if (recovered.kind === 'success') {
        setPendingTotp(null);
        setPendingTotpMode(null);
        await finalizeLogin(recovered.login);
        pushTwoFactorRecoveredToast();
        return;
      }
      if (recovered.kind === 'device-verification') {
        // 恢复码已经用掉（服务端也把它换成了新的一份）⇒ 先把「已恢复、去哪儿看新码」说清楚，
        // 再转交新设备验证弹窗（那里还要一个邮箱验证码）。
        pushTwoFactorRecoveredToast();
        setPendingTotp(null);
        setPendingTotpMode(null);
        setPendingDeviceVerification(recovered.pendingDeviceVerification);
        setDeviceOtpCode('');
        startDeviceOtpCountdown(RESEND_COOLDOWN_SECONDS);
        return;
      }
      pushToast('error', recovered.message);
    } catch (error) {
      pushToast('error', error instanceof Error ? error.message : t('txt_recover_2fa_failed'));
    } finally {
      setTotpSubmitting(false);
    }
  }

  async function handleRegister() {
    if (pendingAuthAction) return;
    if (IS_DEMO_MODE) {
      pushToast('warning', t('txt_demo_readonly_message'));
      setPhase('login');
      navigate(ROUTES.login);
      return;
    }
    if (!registerValues.email || !registerValues.password) {
      pushToast('error', t('txt_please_input_email_and_password'));
      return;
    }
    if (registerValues.password.length < 12) {
      pushToast('error', t('txt_master_password_must_be_at_least_12_chars'));
      return;
    }
    if (registerValues.password !== registerValues.password2) {
      pushToast('error', t('txt_passwords_do_not_match'));
      return;
    }
    setPendingAuthAction('register');
    try {
      const resp = await performRegistration({
        email: registerValues.email,
        name: registerValues.name,
        password: registerValues.password,
        masterPasswordHint: registerValues.passwordHint,
        inviteCode: registerValues.inviteCode,
        fallbackIterations: defaultKdfIterations,
      });
      if (!resp.ok) {
        pushToast('error', resp.message);
        return;
      }
      setLoginValues({ email: registerValues.email.toLowerCase(), password: '' });
      setPhase('login');
      navigate(ROUTES.login);
      pushToast('success', t('txt_registration_succeeded_please_sign_in'));
    } finally {
      setPendingAuthAction(null);
    }
  }

  function openPasswordHintDialog(hint: string | null) {
    setConfirm({
      title: t('txt_password_hint'),
      message: hint || t('txt_password_hint_not_set'),
      showIcon: false,
      confirmText: t('txt_close'),
      hideCancel: true,
      onConfirm: () => setConfirm(null),
    });
  }

  async function handleTogglePasswordHint() {
    if (pendingAuthAction) return;
    if (IS_DEMO_MODE) {
      openPasswordHintDialog(t('txt_demo_master_password_hint'));
      return;
    }
    const email = loginValues.email.trim().toLowerCase();
    if (!email) return;

    if (loginHintState.email === email && !loginHintState.loading) {
      openPasswordHintDialog(loginHintState.hint);
      return;
    }

    const requestSeq = ++loginHintRequestSeqRef.current;
    setLoginHintState({
      email,
      loading: true,
      hint: null,
    });

    try {
      const result = await getPasswordHint(email);
      if (loginHintRequestSeqRef.current !== requestSeq || loginEmailRef.current.trim().toLowerCase() !== email) return;
      // 配了 SMTP：提示走邮箱，页面上只告知「已发送」（不显示内容）。
      if (result.sent) {
        pushToast('success', t('txt_password_hint_sent_to_email'));
        setLoginHintState({ email: '', loading: false, hint: null });
        return;
      }
      openPasswordHintDialog(result.masterPasswordHint);
      setLoginHintState({
        email,
        loading: false,
        hint: result.masterPasswordHint,
      });
    } catch (error) {
      if (loginHintRequestSeqRef.current !== requestSeq || loginEmailRef.current.trim().toLowerCase() !== email) return;
      setLoginHintState({
        email: '',
        loading: false,
        hint: null,
      });
      pushToast('error', error instanceof Error ? error.message : t('txt_password_hint_load_failed'));
    }
  }

  function handleShowLockedPasswordHint() {
    if (pendingAuthAction) return;
    openPasswordHintDialog((IS_DEMO_MODE ? t('txt_demo_master_password_hint') : profile?.masterPasswordHint) ?? null);
  }

  async function handleUnlock() {
    if (pendingAuthAction) return;
    if (!session?.email) return;
    if (IS_DEMO_MODE) {
      setPendingAuthAction('unlock');
      try {
        await finalizeLogin(createDemoCompletedLogin(session.email));
      } finally {
        setPendingAuthAction(null);
      }
      return;
    }
    if (!unlockPassword) {
      pushToast('error', t('txt_please_input_master_password'));
      return;
    }
    setPendingAuthAction('unlock');
    try {
      const result = await performUnlock(session, profile, unlockPassword, defaultKdfIterations);
      if (result.kind === 'success') {
        await finalizeLogin(result.login);
        return;
      }
      if (result.kind === 'totp') {
        setPendingTotp(result.pendingTotp);
        setPendingTotpMode('unlock');
        setTotpCode('');
        setRememberDevice(true);
        // 与登录路径一致：邮件 2FA 要自动发一次码，否则用户面对空输入框、不知道去哪拿码。
        beginTotpChallenge(result.pendingTotp);
        return;
      }
      // 解锁也走 password grant（设备行被清掉时会碰到），因此与登录分支同样处理。
      if (result.kind === 'device-verification') {
        setPendingDeviceVerification(result.pendingDeviceVerification);
        setDeviceOtpCode('');
        startDeviceOtpCountdown(RESEND_COOLDOWN_SECONDS);
        return;
      }
      pushToast('error', result.message || t('txt_unlock_failed_master_password_is_incorrect'));
    } catch {
      pushToast('error', t('txt_unlock_failed_master_password_is_incorrect'));
    } finally {
      setPendingAuthAction(null);
    }
  }

  function lockCurrentSession() {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    const nextSession = { ...currentSession };
    delete nextSession.symEncKey;
    delete nextSession.symMacKey;
    setSession(nextSession);
    setProfile((prev) => stripProfileSecrets(prev));
    setDecryptedFolders([]);
    setDecryptedCiphers([]);
    setDecryptedSends([]);
    clearPasswordSecurityCache();
    setUnlockPassword('');
    setPendingTotp(null);
    setPendingTotpMode(null);
    setPendingDeviceVerification(null);
    setDeviceOtpCode('');
    setTotpCode('');
    setUnlockPreparing(false);
    setLockedSessionRefreshError('');
    setPhase('locked');
    navigate(ROUTES.lock);
  }

  function handleLock() {
    lockCurrentSession();
  }

  function logoutNow() {
    if (!IS_DEMO_MODE) {
      void revokeCurrentSession(sessionRef.current);
    }
    setConfirm(null);
    setSession(null);
    clearProfileSnapshot();
    clearOfflineUnlockRecord();
    clearPasswordSecurityCache();
    setProfile(null);
    // 清空「已提醒」标记 ⇒ 下次登录重新提醒一次。
    warnedUnverifiedEmailRef.current = null;
    setUnlockPreparing(false);
    setPendingTotp(null);
    setPendingTotpMode(null);
    setPendingDeviceVerification(null);
    setDeviceOtpCode('');
    setPhase('login');
    navigate(ROUTES.login);
  }

  function handleLogout() {
    setConfirm({
      title: t('txt_log_out'),
      message: t('txt_are_you_sure_you_want_to_log_out'),
      showIcon: false,
      onConfirm: () => {
        logoutNow();
      },
    });
  }

  useEffect(() => {
    if (phase !== 'app' || lockTimeoutMinutes === 0) return;
    if (typeof window === 'undefined') return;

    let timerId: number | null = null;
    let lastActivityAt = 0;
    const timeoutMs = lockTimeoutMinutes * 60 * 1000;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };
    const runTimeoutAction = () => {
      if (sessionTimeoutAction === 'logout') {
        logoutNow();
        return;
      }
      if (sessionRef.current?.symEncKey || sessionRef.current?.symMacKey) {
        lockCurrentSession();
      }
    };
    const scheduleTimeout = () => {
      clearTimer();
      timerId = window.setTimeout(() => {
        runTimeoutAction();
      }, timeoutMs);
    };
    const markActivity = () => {
      const now = Date.now();
      if (now - lastActivityAt < 1000) return;
      lastActivityAt = now;
      scheduleTimeout();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') markActivity();
    };

    scheduleTimeout();
    window.addEventListener('pointerdown', markActivity, { passive: true });
    window.addEventListener('keydown', markActivity);
    window.addEventListener('scroll', markActivity, { passive: true });
    window.addEventListener('touchstart', markActivity, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimer();
      window.removeEventListener('pointerdown', markActivity);
      window.removeEventListener('keydown', markActivity);
      window.removeEventListener('scroll', markActivity);
      window.removeEventListener('touchstart', markActivity);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [phase, lockTimeoutMinutes, sessionTimeoutAction]);

  function renderPassiveOverlays() {
    return (
      <AppGlobalOverlays
        toasts={toasts}
        onCloseToast={removeToast}
        onPauseToasts={pauseToasts}
        onResumeToasts={resumeToasts}
        confirm={null}
        onCancelConfirm={() => {}}
        pendingTotpOpen={false}
        pendingTotpProviderType={0}
        pendingTotpAvailableProviders={[]}
        totpCode=""
        rememberDevice={false}
        onTotpCodeChange={() => {}}
        onRememberDeviceChange={() => {}}
        onConfirmTotp={() => {}}
        onSelectTotpProvider={() => {}}
        onSubmitRecoveryCode={() => {}}
        onCancelTotp={() => {}}
        totpSubmitting={false}
        disableTotpOpen={false}
        disableTotpPassword=""
        onDisableTotpPasswordChange={() => {}}
        onConfirmDisableTotp={() => {}}
        onCancelDisableTotp={() => {}}
        disableTotpSubmitting={false}
      />
    );
  }

  useEffect(() => {
    if (!IS_DEMO_MODE) return;
    if (phase !== 'app') {
      setDecryptedFolders([]);
      setDecryptedCiphers([]);
      setDecryptedSends([]);
      setDemoUsers(DEMO_ADMIN_USERS.map((user) => ({ ...user })));
      setDemoInvites(DEMO_ADMIN_INVITES.map((invite) => ({ ...invite })));
      setDemoAuthorizedDevices(DEMO_AUTHORIZED_DEVICES.map((device) => ({ ...device })));
      setDemoBackupSettings(createDemoBackupSettings());
      setVaultInitialDecryptDone(false);
      setSendsDecryptDone(false);
      return;
    }
    setDecryptedFolders(DEMO_FOLDERS.map((folder) => ({ ...folder })));
    setDecryptedCiphers(DEMO_CIPHERS.map((cipher) => ({ ...cipher })));
    setDecryptedSends(DEMO_SENDS.map((send) => ({ ...send })));
    setDemoUsers(DEMO_ADMIN_USERS.map((user) => ({ ...user })));
    setDemoInvites(DEMO_ADMIN_INVITES.map((invite) => ({ ...invite })));
    setDemoAuthorizedDevices(DEMO_AUTHORIZED_DEVICES.map((device) => ({ ...device })));
    setDemoBackupSettings(createDemoBackupSettings());
    setVaultDecryptError('');
    setVaultInitialDecryptDone(true);
    setSendsDecryptDone(true);
  }, [phase]);

  useEffect(() => {
    if (IS_DEMO_MODE) {
      setCachedVaultCore(null);
      return;
    }
    let cancelled = false;
    if (phase !== 'app' || !session?.symEncKey || !session?.symMacKey || !vaultCacheKey) {
      setCachedVaultCore(null);
      return;
    }
    void (async () => {
      const snapshot = await getCachedVaultCoreSnapshot(vaultCacheKey);
      if (!cancelled) {
        setCachedVaultCore(snapshot);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, session?.symEncKey, session?.symMacKey, vaultCacheKey]);

  async function refetchVaultCoreData() {
    if (pendingVaultCoreQueryRefreshRef.current) {
      return pendingVaultCoreQueryRefreshRef.current;
    }
    const request = vaultCoreQuery.refetch().finally(() => {
      if (pendingVaultCoreQueryRefreshRef.current === request) {
        pendingVaultCoreQueryRefreshRef.current = null;
      }
    });
    pendingVaultCoreQueryRefreshRef.current = request;
    return request;
  }

  const vaultCoreQuery = useQuery({
    queryKey: ['vault-core', vaultCacheKey],
    queryFn: () => loadVaultCoreSyncSnapshot(authedFetch, vaultCacheKey),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && !!session?.symEncKey && !!session?.symMacKey && !!vaultCacheKey,
    staleTime: 30_000,
  });
  const encryptedVaultCore = vaultCoreQuery.data || cachedVaultCore;
  const encryptedFolders = encryptedVaultCore?.folders;
  const encryptedCiphers = encryptedVaultCore?.ciphers;
  const encryptedSendsFromSync = encryptedVaultCore?.sends;
  const sendsQueryKey = useMemo(() => ['sends', vaultCacheKey || session?.email] as const, [vaultCacheKey, session?.email]);
  const sendsQuery = useQuery({
    queryKey: sendsQueryKey,
    queryFn: () => getSends(authedFetch),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && !!session?.symEncKey && !!session?.symMacKey && location === ROUTES.sends && !encryptedSendsFromSync,
    staleTime: 30_000,
  });
  const encryptedSends = sendsQuery.data || encryptedSendsFromSync;
  async function refetchSendsFromVaultCore() {
    const result = await refetchVaultCoreData() as { data?: VaultCoreSnapshot };
    const sends = Array.isArray(result.data?.sends) ? result.data.sends : [];
    queryClient.setQueryData(sendsQueryKey, sends);
    return { data: sends };
  }
  useEffect(() => {
    if (!Array.isArray(encryptedSendsFromSync)) return;
    queryClient.setQueryData(sendsQueryKey, encryptedSendsFromSync);
  }, [queryClient, sendsQueryKey, encryptedSendsFromSync]);
  const profileQuery = useQuery({
    queryKey: profileCacheKey(profile?.id, session?.email),
    queryFn: () => getProfile(authedFetch),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && !profileHydrationPending,
    staleTime: 30_000,
  });

  // 服务端配置：目前只用于「主密码提示」的说明文案（能发信 ⇒ 说会发到邮箱）。
  // 登录前就要用（注册页），所以不依赖会话。
  const serverConfigQuery = useQuery({
    queryKey: ['server-config'],
    queryFn: getServerConfig,
    enabled: !IS_DEMO_MODE,
    staleTime: 5 * 60_000,
  });
  const mailDeliveryAvailable = serverConfigQuery.data?.mailDeliveryAvailable === true;
  // Send 页的「未配发信」提示：只在服务端**确定**说了「没配」时才显示（未知 ⇒ 不显示，避免误报）
  const mailDeliveryUnavailable = serverConfigQuery.data?.mailDeliveryAvailable === false;
  useEffect(() => {
    if (!profileQuery.data) return;
    setProfile(profileQuery.data);
  }, [profileQuery.data]);

  /**
   * 用户级「语言 / 时区」偏好。
   *
   * queryFn 顺带调 `detect`：每次登录都上报浏览器检测值，由服务端条件写
   *（只在未设定或自动档时才写），因此重复调用安全；返回值即最新偏好。
   */
  const preferencesQuery = useQuery({
    queryKey: ['preferences', vaultCacheKey || session?.email],
    queryFn: () =>
      detectPreferences(authedFetch, {
        locale: detectBrowserLocale(),
        timezone: detectBrowserTimeZone(),
      }),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken,
    staleTime: 30_000,
  });
  const mailPreferences = preferencesQuery.data ?? null;

  /** 时间格式化偏好（语言 + 时区）；用 useMemo 稳定引用，避免每次渲染都让消费方重渲。 */
  const dateTimePrefs = useMemo(
    () => ({
      locale: mailPreferences?.locale ?? null,
      timezone: mailPreferences?.timezone ?? null,
    }),
    [mailPreferences?.locale, mailPreferences?.timezone]
  );

  // 服务端偏好是语言的**权威来源**（换设备登录后界面语言也跟着走）。
  // 只在确实不同时才切换：切完 localStorage 就与它一致，不会来回刷新。
  useEffect(() => {
    const serverLocale = mailPreferences?.locale;
    if (!serverLocale || serverLocale === getLocale()) return;
    // 热切换即可（`setLocale` 会通知订阅者重渲染）；整页重载会要求重新解锁密码库。
    void setLocale(serverLocale as Locale);
  }, [mailPreferences?.locale]);

  const isAdmin = isAdminProfile(profile);
  /**
   * 管理员数据只在对应页面才拉：消费方都是懒加载的页面组件，启动时（用户还在密码库）
   * 提前拉只是白跑请求 + D1 查询。切到该页时查询自动启用，页面内的 staleTime 兼顾来回切不重拉。
   */
  const onAdminRoute = location === ROUTES.admin;
  const usersQuery = useQuery({
    queryKey: ['admin-users', vaultCacheKey],
    queryFn: () => listAdminUsers(authedFetch),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && isAdmin && vaultInitialDecryptDone && onAdminRoute,
    staleTime: 30_000,
  });
  const invitesQuery = useQuery({
    queryKey: ['admin-invites', vaultCacheKey],
    queryFn: () => listAdminInvites(authedFetch),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && isAdmin && vaultInitialDecryptDone && onAdminRoute,
    staleTime: 30_000,
  });
  const twoFactorStatusQuery = useQuery({
    queryKey: ['two-factor-status', vaultCacheKey || session?.email],
    queryFn: () => getTwoFactorProviderStatus(authedFetch),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && vaultInitialDecryptDone,
    staleTime: 30_000,
  });
  const authorizedDevicesQuery = useQuery({
    queryKey: ['authorized-devices', vaultCacheKey || session?.email],
    queryFn: () => getAuthorizedDevices(authedFetch),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && vaultInitialDecryptDone,
    staleTime: AUTHORIZED_DEVICES_STALE_MS,
  });  const domainRulesQueryKey = useMemo(() => ['domain-rules', vaultCacheKey || session?.email] as const, [vaultCacheKey, session?.email]);
  const domainRulesQuery = useQuery({
    queryKey: domainRulesQueryKey,
    queryFn: () => getDomainRules(authedFetch),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && vaultInitialDecryptDone,
    staleTime: 30_000,
  });

  async function deriveCurrentMasterPasswordHash(masterPassword: string): Promise<string> {
    const email = String(profile?.email || session?.email || '').trim().toLowerCase();
    if (!email) throw new Error(t('txt_profile_unavailable'));
    const normalizedPassword = String(masterPassword || '');
    if (!normalizedPassword) throw new Error(t('txt_master_password_is_required'));
    const derived = await deriveLoginHash(email, normalizedPassword, defaultKdfIterations);
    return derived.hash;
  }
  const pendingAuthRequestsQueryKey = useMemo(() => ['auth-requests-pending', vaultCacheKey || session?.email] as const, [vaultCacheKey, session?.email]);
  const pendingAuthRequestsQuery = useQuery({
    queryKey: pendingAuthRequestsQueryKey,
    queryFn: () => listPendingAuthRequests(authedFetch, profile?.email || session?.email || ''),
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && !!session?.symEncKey && !!session?.symMacKey && !!(profile?.email || session?.email),
    staleTime: 5_000,
  });
  const pendingAuthRequests = (pendingAuthRequestsQuery.data || []).filter(isPendingAuthRequest);
  const latestPendingAuthRequest = pendingAuthRequests[0] || null;
  const selectedPendingAuthRequest = authRequestDialogSelectedId
    ? pendingAuthRequests.find((request) => request.id === authRequestDialogSelectedId) || null
    : null;
  const authRequestDialogRequest = selectedPendingAuthRequest || (
    latestPendingAuthRequest && latestPendingAuthRequest.id !== authRequestDialogDismissedId
      ? latestPendingAuthRequest
      : null
  );
  const authRequestDialogOpen = !!authRequestDialogRequest;

  async function beginApproveAuthRequest(authRequest: AuthRequest): Promise<void> {
    setAuthRequestDialogSelectedId(authRequest.id);
    setAuthRequestDialogDismissedId(null);
  }

  async function approveAuthRequest(authRequest: AuthRequest): Promise<void> {
    if (!session) throw new Error(t('txt_vault_key_unavailable'));
    setAuthRequestSubmittingId(authRequest.id);
    try {
      const key = await encryptSessionUserKeyForAuthRequest(session, authRequest);
      await respondToAuthRequest(authedFetch, authRequest.id, {
        key,
        deviceIdentifier: getCurrentDeviceIdentifier(),
        requestApproved: true,
      });
      setAuthRequestDialogDismissedId(null);
      setAuthRequestDialogSelectedId(null);
      pushToast('success', t('txt_auth_request_approved'));
      await pendingAuthRequestsQuery.refetch();
    } finally {
      setAuthRequestSubmittingId(null);
    }
  }

  async function denyAuthRequest(authRequest: AuthRequest): Promise<void> {
    setAuthRequestSubmittingId(authRequest.id);
    try {
      await respondToAuthRequest(authedFetch, authRequest.id, {
        deviceIdentifier: getCurrentDeviceIdentifier(),
        requestApproved: false,
      });
      setAuthRequestDialogDismissedId(null);
      setAuthRequestDialogSelectedId(null);
      pushToast('success', t('txt_auth_request_denied'));
      await pendingAuthRequestsQuery.refetch();
    } finally {
      setAuthRequestSubmittingId(null);
    }
  }

  function handleSaveDomainRules(customEquivalentDomains: CustomEquivalentDomain[], excludedGlobalEquivalentDomains: number[]): Promise<void> {
    const equivalentDomains = customEquivalentDomains.filter((rule) => !rule.excluded).map((rule) => rule.domains);
    const excludedGlobalTypes = new Set(excludedGlobalEquivalentDomains);
    const currentRules = queryClient.getQueryData<DomainRules>(domainRulesQueryKey) || domainRulesQuery.data;
    const optimisticRules: DomainRules = {
      object: 'domains',
      equivalentDomains,
      customEquivalentDomains,
      globalEquivalentDomains: (currentRules?.globalEquivalentDomains || []).map((rule) => ({
        ...rule,
        excluded: excludedGlobalTypes.has(rule.type),
      })),
    };
    const saveSeq = ++domainRulesSaveSeqRef.current;
    queryClient.setQueryData(domainRulesQueryKey, optimisticRules);

    void saveDomainRules(authedFetch, {
      customEquivalentDomains,
      equivalentDomains,
      excludedGlobalEquivalentDomains,
    }).then((updated) => {
      if (domainRulesSaveSeqRef.current !== saveSeq) return;
      queryClient.setQueryData(domainRulesQueryKey, updated);
      void queryClient.invalidateQueries({ queryKey: ['vault-core', vaultCacheKey] });
    }).catch((error) => {
      if (domainRulesSaveSeqRef.current !== saveSeq) return;
      pushToast('error', error instanceof Error ? error.message : t('txt_domain_rules_save_failed'));
      void domainRulesQuery.refetch();
    });

    return Promise.resolve();
  }
  useQuery({
    queryKey: ['admin-backup-settings', vaultCacheKey],
    queryFn: () => backupActions.loadSettings(),
    // 只是给备份页预热缓存（消费方是 `onLoadBackupSettings` 的 `ensureQueryData`）⇒ 进备份页再拉。
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && isAdmin && vaultInitialDecryptDone && location.startsWith(ROUTES.backup),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!IS_DEMO_MODE) return;
    return preloadDemoExperience();
  }, []);

  useEffect(() => {
    if (IS_DEMO_MODE) return;
    if (phase !== 'app' || !vaultInitialDecryptDone) return;
    void preloadAuthenticatedWorkspace(isAdmin);
  }, [phase, vaultInitialDecryptDone, isAdmin]);

  // 登录就绪后（用户已经能用应用）再空闲补取语言包，见 lib/pwa.ts 的说明。
  useEffect(() => {
    if (IS_DEMO_MODE) return;
    if (phase !== 'app' || !vaultInitialDecryptDone) return;
    scheduleOfflineLocalePrefetch();
    // 同时申请持久化存储：不申请的话浏览器可静默回收离线快照（见 lib/pwa.ts）。
    requestPersistentStorage();
  }, [phase, vaultInitialDecryptDone]);

  useEffect(() => {
    if (IS_DEMO_MODE) return;
    if (phase !== 'app' || !session?.accessToken || !session?.symEncKey || !session?.symMacKey) return;
    if (!vaultInitialDecryptDone) return;
    if (!isAdminProfile(profile)) return;
    if (repairAttemptRef.current === session.accessToken) return;

    const loginScopedRepairAuth = loginScopedBackupRepairAuthRef.current?.accessToken === session.accessToken
      ? loginScopedBackupRepairAuthRef.current
      : null;
    repairAttemptRef.current = session.accessToken;
    void (async () => {
      try {
        await silentlyRepairBackupSettingsIfNeeded(session, profile, loginScopedRepairAuth);
      } finally {
        if (loginScopedBackupRepairAuthRef.current?.accessToken === session.accessToken) {
          loginScopedBackupRepairAuthRef.current = null;
        }
      }
    })();
  }, [phase, session?.accessToken, session?.symEncKey, session?.symMacKey, profile, vaultInitialDecryptDone]);

  useEffect(() => {
    if (session?.accessToken) return;
    repairAttemptRef.current = '';
    loginScopedBackupRepairAuthRef.current = null;
    uriChecksumRepairAttemptRef.current = '';
  }, [session?.accessToken]);

  useEffect(() => {
    if (IS_DEMO_MODE) return;
    if (!session?.symEncKey || !session?.symMacKey) {
      setDecryptedFolders([]);
      setDecryptedCiphers([]);
      setDecryptedSends([]);
      setVaultInitialDecryptDone(false);
      setVaultDecryptError('');
      setSendsDecryptDone(false);
      return;
    }
    if (!encryptedFolders || !encryptedCiphers) return;

    let active = true;
    (async () => {
      try {
        setVaultDecryptError('');
        let result;
        try {
          result = await decryptVaultCoreInWorker({
            folders: encryptedFolders,
            ciphers: encryptedCiphers,
            symEncKeyB64: session.symEncKey!,
            symMacKeyB64: session.symMacKey!,
          });
        } catch {
          result = await decryptVaultCore({
            folders: encryptedFolders,
            ciphers: encryptedCiphers,
            symEncKeyB64: session.symEncKey!,
            symMacKeyB64: session.symMacKey!,
          });
        }

        if (!active) return;
        setDecryptedFolders(result.folders);
        setDecryptedCiphers(result.ciphers);
        setVaultInitialDecryptDone(true);
        if (!session.accessToken) return;
        const repairKey = `${session.accessToken}:${encryptedCiphers.map((cipher) => `${cipher.id}:${cipher.revisionDate || ''}`).join(',')}`;
        if (uriChecksumRepairAttemptRef.current !== repairKey) {
          uriChecksumRepairAttemptRef.current = repairKey;
          void repairCipherKeyMismatches(authedFetch, session, result.ciphers)
            .then(async (keyMismatchCount) => {
              if (keyMismatchCount > 0) {
                await invalidateVaultCoreSyncSnapshot(vaultCacheKey);
                void refetchVaultCoreData();
                return;
              }
              const uriChecksumCount = await repairCipherUriChecksums(authedFetch, session, result.ciphers);
              if (uriChecksumCount > 0) {
                await invalidateVaultCoreSyncSnapshot(vaultCacheKey);
                void refetchVaultCoreData();
              }
            })
            .catch(() => {
              // Best-effort compatibility repair must not interrupt normal vault loading.
            });
        }
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : t('txt_decrypt_failed_2');
        setVaultDecryptError(message);
        setVaultInitialDecryptDone(true);
        pushToast('error', message);
      }
    })();

    return () => {
      active = false;
    };
  }, [session?.symEncKey, session?.symMacKey, vaultCacheKey, encryptedFolders, encryptedCiphers]);

  useEffect(() => {
    if (IS_DEMO_MODE) return;
    if (!session?.symEncKey || !session?.symMacKey) {
      setDecryptedSends([]);
      setSendsDecryptDone(false);
      return;
    }
    if (!encryptedSends) {
      setSendsDecryptDone(false);
      return;
    }
    if (!encryptedSends.length) {
      setDecryptedSends([]);
      setSendsDecryptDone(true);
      return;
    }

    let active = true;
    setSendsDecryptDone(false);
    (async () => {
      try {
        let sends;
        try {
          sends = await decryptSendsInWorker({
            sends: encryptedSends,
            symEncKeyB64: session.symEncKey!,
            symMacKeyB64: session.symMacKey!,
            origin: window.location.origin,
          });
        } catch {
          sends = await decryptSends({
            sends: encryptedSends,
            symEncKeyB64: session.symEncKey!,
            symMacKeyB64: session.symMacKey!,
            origin: window.location.origin,
          });
        }

        if (!active) return;
        setDecryptedSends(sends);
        setSendsDecryptDone(true);
      } catch (error) {
        if (!active) return;
        setSendsDecryptDone(true);
        pushToast('error', error instanceof Error ? error.message : t('txt_decrypt_failed_2'));
      }
    })();

    return () => {
      active = false;
    };
  }, [session?.symEncKey, session?.symMacKey, encryptedSends]);

  async function refreshVaultSilently() {
    if (pendingVaultCoreRefreshRef.current) {
      await pendingVaultCoreRefreshRef.current;
      return;
    }
    const request = refetchVaultCoreData().finally(() => {
      if (pendingVaultCoreRefreshRef.current === request) {
        pendingVaultCoreRefreshRef.current = null;
      }
    });
    pendingVaultCoreRefreshRef.current = request;
    await request;
  }

  silentRefreshVaultRef.current = refreshVaultSilently;

  function normalizeVaultCoreSnapshot(snapshot?: Partial<VaultCoreSnapshot> | null): VaultCoreSnapshot {
    return {
      ciphers: Array.isArray(snapshot?.ciphers) ? snapshot.ciphers : [],
      folders: Array.isArray(snapshot?.folders) ? snapshot.folders : [],
      sends: Array.isArray(snapshot?.sends) ? snapshot.sends : [],
    };
  }

  function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
    const nextId = String(nextItem.id || '').trim();
    if (!nextId) return items;
    const index = items.findIndex((item) => String(item.id || '').trim() === nextId);
    if (index < 0) return [...items, nextItem];
    const next = items.slice();
    next[index] = nextItem;
    return next;
  }

  function removeById<T extends { id: string }>(items: T[], id: string): T[] {
    const normalizedId = String(id || '').trim();
    if (!normalizedId) return items;
    return items.filter((item) => String(item.id || '').trim() !== normalizedId);
  }

  function revisionStampFromIso(value: unknown): number | null {
    const stamp = new Date(String(value || '').trim()).getTime();
    return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
  }

  function patchVaultCoreSnapshot(
    updater: (snapshot: VaultCoreSnapshot) => VaultCoreSnapshot,
    options?: { revisionStamp?: number | null }
  ): void {
    if (!vaultCacheKey) return;
    let nextSnapshot: VaultCoreSnapshot | null = null;
    queryClient.setQueryData(['vault-core', vaultCacheKey], (previous?: VaultCoreSnapshot) => {
      const base = normalizeVaultCoreSnapshot(previous || cachedVaultCore);
      nextSnapshot = updater(base);
      return nextSnapshot;
    });
    if (nextSnapshot) {
      setCachedVaultCore(nextSnapshot);
      void saveVaultCoreSyncSnapshot(vaultCacheKey, nextSnapshot, options?.revisionStamp ?? null);
    }
  }

  async function refreshVaultCoreRevisionStamp(): Promise<void> {
    if (!vaultCacheKey || !session?.accessToken) return;
    try {
      const revisionStamp = await getVaultRevisionDate(authedFetch);
      const currentSnapshot = normalizeVaultCoreSnapshot(
        queryClient.getQueryData<VaultCoreSnapshot>(['vault-core', vaultCacheKey]) || cachedVaultCore
      );
      await saveVaultCoreSyncSnapshot(vaultCacheKey, currentSnapshot, revisionStamp);
    } catch {
      // A stale revision stamp only affects the next cache validation; the local resource patch remains valid.
    }
  }

  function upsertEncryptedCipher(cipher: Cipher, revisionStamp?: number | null): void {
    patchVaultCoreSnapshot((snapshot) => ({
      ...snapshot,
      ciphers: upsertById(snapshot.ciphers, cipher),
    }), { revisionStamp: revisionStamp ?? revisionStampFromIso(cipher.revisionDate) });
  }

  function deleteCipherLocally(cipherId: string, revisionStamp?: number | null): void {
    const id = String(cipherId || '').trim();
    if (!id) return;
    patchVaultCoreSnapshot((snapshot) => ({
      ...snapshot,
      ciphers: removeById(snapshot.ciphers, id),
    }), { revisionStamp });
    setDecryptedCiphers((current) => removeById(current, id));
  }

  function upsertEncryptedFolder(folder: VaultFolder, revisionStamp?: number | null): void {
    patchVaultCoreSnapshot((snapshot) => ({
      ...snapshot,
      folders: upsertById(snapshot.folders, folder),
    }), { revisionStamp: revisionStamp ?? revisionStampFromIso(folder.revisionDate) });
  }

  function deleteFolderLocally(folderId: string, revisionStamp?: number | null): void {
    const id = String(folderId || '').trim();
    if (!id) return;
    patchVaultCoreSnapshot((snapshot) => ({
      ...snapshot,
      folders: removeById(snapshot.folders, id),
      ciphers: snapshot.ciphers.map((cipher) => (
        String(cipher.folderId || '').trim() === id ? { ...cipher, folderId: null } : cipher
      )),
    }), { revisionStamp });
    setDecryptedFolders((current) => removeById(current, id));
    setDecryptedCiphers((current) => current.map((cipher) => (
      String(cipher.folderId || '').trim() === id ? { ...cipher, folderId: null } : cipher
    )));
  }

  function upsertEncryptedSend(send: Send, revisionStamp?: number | null): void {
    patchVaultCoreSnapshot((snapshot) => ({
      ...snapshot,
      sends: upsertById(snapshot.sends, send),
    }), { revisionStamp: revisionStamp ?? revisionStampFromIso(send.revisionDate) });
    queryClient.setQueryData(sendsQueryKey, (previous?: Send[]) => upsertById(Array.isArray(previous) ? previous : [], send));
  }

  function deleteSendLocally(sendId: string, revisionStamp?: number | null): void {
    const id = String(sendId || '').trim();
    if (!id) return;
    patchVaultCoreSnapshot((snapshot) => ({
      ...snapshot,
      sends: removeById(snapshot.sends, id),
    }), { revisionStamp });
    queryClient.setQueryData(sendsQueryKey, (previous?: Send[]) => removeById(Array.isArray(previous) ? previous : [], id));
    setDecryptedSends((current) => removeById(current, id));
  }

  async function upsertCipherFromNotification(cipherId: string, revisionStamp?: number | null): Promise<void> {
    const id = String(cipherId || '').trim();
    if (!id || !session?.symEncKey || !session?.symMacKey) return;
    try {
      const encrypted = await getCipherById(authedFetch, id);
      upsertEncryptedCipher(encrypted, revisionStamp);
      const result = await decryptVaultCore({
        folders: [],
        ciphers: [encrypted],
        symEncKeyB64: session.symEncKey,
        symMacKeyB64: session.symMacKey,
      });
      const decrypted = result.ciphers[0];
      if (decrypted) setDecryptedCiphers((current) => upsertById(current, decrypted));
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        deleteCipherLocally(id);
        return;
      }
      console.warn('Failed to upsert cipher from notification:', error);
    }
  }

  async function upsertFolderFromNotification(folderId: string, revisionStamp?: number | null): Promise<void> {
    const id = String(folderId || '').trim();
    if (!id || !session?.symEncKey || !session?.symMacKey) return;
    try {
      const encrypted = await getFolderById(authedFetch, id);
      upsertEncryptedFolder(encrypted, revisionStamp);
      const result = await decryptVaultCore({
        folders: [encrypted],
        ciphers: [],
        symEncKeyB64: session.symEncKey,
        symMacKeyB64: session.symMacKey,
      });
      const decrypted = result.folders[0];
      if (decrypted) setDecryptedFolders((current) => upsertById(current, decrypted));
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        deleteFolderLocally(id);
        return;
      }
      console.warn('Failed to upsert folder from notification:', error);
    }
  }

  async function upsertSendFromNotification(sendId: string, revisionStamp?: number | null): Promise<void> {
    const id = String(sendId || '').trim();
    if (!id || !session?.symEncKey || !session?.symMacKey) return;
    try {
      const encrypted = await getSendById(authedFetch, id);
      upsertEncryptedSend(encrypted, revisionStamp);
      const sends = await decryptSends({
        sends: [encrypted],
        symEncKeyB64: session.symEncKey,
        symMacKeyB64: session.symMacKey,
        origin: window.location.origin,
      });
      const decrypted = sends[0];
      if (decrypted) setDecryptedSends((current) => upsertById(current, decrypted));
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        deleteSendLocally(id);
        return;
      }
      console.warn('Failed to upsert send from notification:', error);
    }
  }

  useEffect(() => {
    if (IS_DEMO_MODE) return;
    if (phase !== 'app' || !session?.accessToken || !session?.symEncKey || !session?.symMacKey || !vaultInitialDecryptDone) return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;
    /** 连接「够久」的计时器：到点才清零退避（见 NOTIFICATION_RECONNECT_STABLE_MS）。 */
    let stableTimer: number | null = null;

    const notificationsOfflineNow = () => browserReportsOffline() || getCurrentNetworkStatus() === 'offline';

    const clearStableTimer = () => {
      if (stableTimer !== null) {
        window.clearTimeout(stableTimer);
        stableTimer = null;
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      clearReconnectTimer();
      // 离线时不排重连：每 ≤10s 白试一次纯属浪费。网络恢复由下面的 `subscribeNetworkStatus` 补。
      if (notificationsOfflineNow()) return;
      const delay = Math.min(10000, 1000 * Math.max(1, reconnectAttempts + 1));
      reconnectAttempts += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      const accessToken = session.accessToken;
      if (!accessToken) return;
      try {
        const negotiateResponse = await fetch('/notifications/hub/negotiate?negotiateVersion=1', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!negotiateResponse.ok) throw new Error('Notification negotiation failed');
        const negotiation = (await negotiateResponse.json()) as { connectionToken?: string };
        if (!negotiation.connectionToken || disposed) throw new Error('Notification connection token missing');

        const hubUrl = new URL('/notifications/hub', window.location.origin);
        hubUrl.searchParams.set('id', negotiation.connectionToken);
        hubUrl.protocol = hubUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(hubUrl.toString());
      } catch {
        scheduleReconnect();
        return;
      }

      let pingTimer: number | null = null;

      const clearPingTimer = () => {
        if (pingTimer !== null) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
      };

      // 只有**重连**才需要重新对齐设备列表：首次连接紧跟在启动查询之后（实测相隔 262 ms），
      // 那时查询还在飞行中，无条件刷就是白跑一次（600 B + 3 次 D1 往返）。
      let connectedOnce = false;

      socket.addEventListener('open', () => {
        // 只「连上」不算成功：稳定存活够久之后才清零退避。
        clearStableTimer();
        stableTimer = window.setTimeout(() => {
          stableTimer = null;
          reconnectAttempts = 0;
        }, NOTIFICATION_RECONNECT_STABLE_MS);
        if (connectedOnce) {
          void refreshAuthorizedDevicesRef.current();
        }
        connectedOnce = true;
        try {
          socket?.send(`{"protocol":"json","version":1}${SIGNALR_RECORD_SEPARATOR}`);
        } catch {
          socket?.close();
          return;
        }
        clearPingTimer();
        pingTimer = window.setInterval(() => {
          try {
            socket?.send(`{"type":6}${SIGNALR_RECORD_SEPARATOR}`);
          } catch {
            // send failure will trigger close event
          }
        }, 15_000);
      });

      socket.addEventListener('message', (event) => {
        if (disposed) return;
        if (typeof event.data !== 'string') return;

        const frames = parseSignalRTextFrames(event.data);
        for (const frame of frames) {
          if (frame.type !== 1 || frame.target !== 'ReceiveMessage') continue;
          const message = frame.arguments?.[0] as Record<string, unknown> | undefined;
          const updateType = Number(message?.Type || 0);
          const contextId = String(message?.ContextId || '').trim();
          const payload = message?.Payload;
          const payloadRecord = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
          const resourceId = String(payloadRecord?.Id || payloadRecord?.id || '').trim();
          const revisionStamp = revisionStampFromIso(
            payloadRecord?.RevisionDate
            || payloadRecord?.revisionDate
            || message?.Date
            || message?.date
          );
          if (updateType === SIGNALR_UPDATE_TYPE_LOG_OUT) {
            logoutNow();
            return;
          }
          if (updateType === SIGNALR_UPDATE_TYPE_DEVICE_STATUS) {
            void refreshAuthorizedDevicesRef.current();
            continue;
          }
          if (updateType === SIGNALR_UPDATE_TYPE_AUTH_REQUEST || updateType === SIGNALR_UPDATE_TYPE_AUTH_REQUEST_RESPONSE) {
            void refreshPendingAuthRequestsRef.current();
            continue;
          }
          if (updateType === SIGNALR_UPDATE_TYPE_BACKUP_RESTORE_PROGRESS) {
            if (isBackupProgressDetail(payload)) dispatchBackupProgress(payload);
            continue;
          }
          if (contextId && contextId === getCurrentDeviceIdentifier()) continue;
          if (
            updateType === SIGNALR_UPDATE_TYPE_SM_SECRETS ||
            updateType === SIGNALR_UPDATE_TYPE_SM_MACHINE_ACCOUNTS
          ) {
            // 自己这个**标签页**刚改的不用刷（CLI 那路没有这个字段 ⇒ 照常刷）。
            // ⚠️ 不能拿设备标识比 —— 同设备的另一个标签页正是我们要刷新的对象。
            if (contextId && contextId === getSecretsManagerTabId()) continue;
            // CLI 一条命令往往连写好几条（建项目 → 建机密 → 改 → 读 → 删）⇒ 去抖成一次刷新。
            if (secretsManagerRefreshTimerRef.current !== null) {
              window.clearTimeout(secretsManagerRefreshTimerRef.current);
            }
            const kind =
              updateType === SIGNALR_UPDATE_TYPE_SM_SECRETS ? 'secrets' : 'machine-accounts';
            secretsManagerRefreshTimerRef.current = window.setTimeout(() => {
              secretsManagerRefreshTimerRef.current = null;
              emitSecretsManagerChange(kind);
            }, 250);
            continue;
          }
          if (updateType === SIGNALR_UPDATE_TYPE_SYNC_CIPHERS || updateType === SIGNALR_UPDATE_TYPE_SYNC_VAULT) {
            if (notificationRefreshTimerRef.current !== null) {
              window.clearTimeout(notificationRefreshTimerRef.current);
            }
            notificationRefreshTimerRef.current = window.setTimeout(() => {
              notificationRefreshTimerRef.current = null;
              void silentRefreshVaultRef.current();
            }, 250);
            continue;
          }
          if ((updateType === SIGNALR_UPDATE_TYPE_SYNC_CIPHER_CREATE || updateType === SIGNALR_UPDATE_TYPE_SYNC_CIPHER_UPDATE) && resourceId) {
            void upsertCipherFromNotification(resourceId, revisionStamp);
            continue;
          }
          if (updateType === SIGNALR_UPDATE_TYPE_SYNC_CIPHER_DELETE && resourceId) {
            deleteCipherLocally(resourceId, revisionStamp);
            continue;
          }
          if ((updateType === SIGNALR_UPDATE_TYPE_SYNC_FOLDER_CREATE || updateType === SIGNALR_UPDATE_TYPE_SYNC_FOLDER_UPDATE) && resourceId) {
            void upsertFolderFromNotification(resourceId, revisionStamp);
            continue;
          }
          if (updateType === SIGNALR_UPDATE_TYPE_SYNC_FOLDER_DELETE && resourceId) {
            deleteFolderLocally(resourceId, revisionStamp);
            continue;
          }
          if ((updateType === SIGNALR_UPDATE_TYPE_SYNC_SEND_CREATE || updateType === SIGNALR_UPDATE_TYPE_SYNC_SEND_UPDATE) && resourceId) {
            void upsertSendFromNotification(resourceId, revisionStamp);
            continue;
          }
          if (updateType === SIGNALR_UPDATE_TYPE_SYNC_SEND_DELETE && resourceId) {
            deleteSendLocally(resourceId, revisionStamp);
            continue;
          }
        }
      });

      socket.addEventListener('close', () => {
        socket = null;
        clearPingTimer();
        clearStableTimer();
        // 离线断开时别再拉设备列表：那次请求必然失败。
        if (!notificationsOfflineNow()) void refreshAuthorizedDevicesRef.current();
        scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        try {
          socket?.close();
        } catch {
          // ignore close races
        }
      });
    };

    void connect();

    // 网络恢复 ⇒ 立刻补一次连接（离线期间 `scheduleReconnect` 是空转的），并清零退避。
    const unsubscribeNetwork = subscribeNetworkStatus((status) => {
      if (disposed || status !== 'online' || socket) return;
      reconnectAttempts = 0;
      clearReconnectTimer();
      void connect();
    });

    return () => {
      disposed = true;
      unsubscribeNetwork();
      if (notificationRefreshTimerRef.current !== null) {
        window.clearTimeout(notificationRefreshTimerRef.current);
        notificationRefreshTimerRef.current = null;
      }
      if (secretsManagerRefreshTimerRef.current !== null) {
        window.clearTimeout(secretsManagerRefreshTimerRef.current);
        secretsManagerRefreshTimerRef.current = null;
      }
      clearReconnectTimer();
      clearStableTimer();
      if (socket) {
        const s = socket;
        socket = null;
        try {
          s.close();
        } catch {
          // ignore close races
        }
      }
    };
  }, [phase, session?.accessToken, session?.symEncKey, session?.symMacKey, vaultInitialDecryptDone]);

  const vaultSendActions = useVaultSendActions({
    authedFetch,
    importAuthedFetch,
    session,
    profile,
    defaultKdfIterations,
    encryptedCiphers,
    encryptedFolders,
    refetchCiphers: async () => {
      const result = await refetchVaultCoreData() as { data?: VaultCoreSnapshot };
      return { data: result.data?.ciphers };
    },
    refetchFolders: async () => {
      const result = await refetchVaultCoreData() as { data?: VaultCoreSnapshot };
      return { data: result.data?.folders };
    },
    refetchSends: refetchSendsFromVaultCore,
    onNotify: pushToast,
    patchEncryptedCiphers: (updater) => {
      patchVaultCoreSnapshot((snapshot) => ({
        ...snapshot,
        ciphers: updater(snapshot.ciphers),
      }));
    },
    patchEncryptedFolders: (updater) => {
      patchVaultCoreSnapshot((snapshot) => ({
        ...snapshot,
        folders: updater(snapshot.folders),
      }));
    },
    patchEncryptedSends: (updater) => {
      let nextSends: Send[] = [];
      patchVaultCoreSnapshot((snapshot) => {
        nextSends = updater(snapshot.sends);
        return {
          ...snapshot,
          sends: nextSends,
        };
      });
      queryClient.setQueryData(sendsQueryKey, nextSends);
    },
    patchDecryptedCiphers: setDecryptedCiphers,
    patchDecryptedFolders: setDecryptedFolders,
    patchDecryptedSends: setDecryptedSends,
    refreshVaultRevisionStamp: refreshVaultCoreRevisionStamp,
  });
  const accountSecurityActions = useAccountSecurityActions({
    authedFetch,
    profile,
    session,
    defaultKdfIterations,
    disableTotpPassword,
    clearDisableTotpDialog: () => {
      setDisableTotpOpen(false);
      setDisableTotpPassword('');
    },
    onLogoutNow: logoutNow,
    onNotify: pushToast,
    onProfileUpdated: setProfile,
    onSetConfirm: setConfirm,
    refetchTwoFactorStatus: twoFactorStatusQuery.refetch,
    refetchAuthorizedDevices: authorizedDevicesQuery.refetch,
  });
  const adminActions = useAdminActions({
    authedFetch,
    email: String(profile?.email || session?.email || ''),
    defaultKdfIterations,
    onNotify: pushToast,
    onSetConfirm: setConfirm,
    refetchUsers: usersQuery.refetch,
    refetchInvites: invitesQuery.refetch,
  });
  const adminMailActions = useAdminMailActions({
    authedFetch,
    profile,
    defaultKdfIterations,
    onNotify: pushToast,
    queryClient,
  });

  // 设置页首帧要用到的状态：与其它启动查询同一门控，**应用就绪时就拉**。
  // 否则要等进到那个分区才请求 ⇒ 首帧缺元素 / 显示成「未配置」，并带布局跳动。
  // （邮箱验证状态已并进 profile ⇒ 不再是独立请求。）
  const mailSettingsQuery = useQuery({
    queryKey: ['admin-mail-settings', vaultCacheKey || session?.email],
    queryFn: () => adminMailActions.loadMailSettings(),
    // 邮件设置是管理员端点（非管理员看不到那分区也不该请求），且只被设置页消费 ⇒ 进 `/settings*` 再拉。
    enabled: !IS_DEMO_MODE && phase === 'app' && !!session?.accessToken && isAdmin && vaultInitialDecryptDone && location.startsWith(ROUTES.settings),
    staleTime: 30_000,
  });

  refreshAuthorizedDevicesRef.current = async () => {
    if (!vaultInitialDecryptDone) return;
    await authorizedDevicesQuery.refetch();
  };
  refreshPendingAuthRequestsRef.current = async () => {
    if (!vaultInitialDecryptDone || !(profile?.email || session?.email)) return;
    setAuthRequestDialogDismissedId(null);
    await pendingAuthRequestsQuery.refetch();
  };

  // 单页应用：路径一律以 wouter 的 location 为准，不解析 hash（旧 `#/xxx` 深链接已不支持）。
  const routeLocation = normalizeRoutePath(location);
  const effectiveLocation = routeLocation;
  const publicSendMatch = effectiveLocation.match(/^\/send\/([^/]+)(?:\/([^/]+))?\/?$/i);
  const isPublicSendRoute = !!publicSendMatch;
  const isMalformedSendRoute = PUBLIC_SEND_PATH_PATTERN.test(effectiveLocation) && !publicSendMatch;
  const isKnownRoute = isKnownRoutePath(routeLocation);
  const isUnknownRoute = isMalformedSendRoute || !isKnownRoute;
  const isImportRoute = routeLocation === ROUTES.importExport || IMPORT_EXPORT_ROUTE_ALIASES.has(routeLocation);
  const demoDomainRules = useMemo<DomainRules>(() => ({
    equivalentDomains: [
      ['nodewarden.example', 'nw.example'],
      ['staging.nodewarden.example', 'preview.nodewarden.example'],
    ],
    customEquivalentDomains: [
      { id: 'demo-custom-1', domains: ['nodewarden.example', 'nw.example'], excluded: false },
      { id: 'demo-custom-2', domains: ['staging.nodewarden.example', 'preview.nodewarden.example'], excluded: false },
    ],
    globalEquivalentDomains: [
      { type: 0, domains: ['youtube.com', 'google.com', 'gmail.com'], excluded: false },
      { type: 1, domains: ['apple.com', 'icloud.com'], excluded: false },
      { type: 10, domains: ['microsoft.com', 'office.com', 'xbox.com'], excluded: true },
      { type: -10001, domains: ['nodewarden.example', 'nw.example'], excluded: false },
    ],
    object: 'domains',
  }), []);
  // 未知路径不高亮任何 tab（否则底部会错误地亮着「设置」）。
  // 机密管理器有自己那套 tab，直接回落到当前路径。
  const mobilePrimaryRoute = isUnknownRoute
    ? ''
    : isSecretsProductPath(location)
      ? location
      : location === ROUTES.sends
        ? ROUTES.sends
        : location === ROUTES.generator
          ? ROUTES.generator
          : location === ROUTES.vaultTotp
            ? ROUTES.vaultTotp
            : location === ROUTES.vault
              ? ROUTES.vault
              : ROUTES.settings;
  const currentPageTitle = (() => {
    if (isUnknownRoute) return t('txt_page_not_found');
    if (location === ROUTES.secrets) return t('nav_secrets');
    if (location === ROUTES.secretsMachineAccounts) return t('nav_machine_accounts');
    if (location === ROUTES.passwordHealth) return t('txt_password_security');
    if (location === ROUTES.vaultTotp) return t('txt_verification_code');
    if (location === ROUTES.generator) return t('txt_password_generator');
    if (location === ROUTES.sends) return t('nav_sends');
    if (location === ROUTES.admin) return t('nav_admin_panel');
    if (location === ROUTES.logs) return t('nav_log_center');
    if (location === ROUTES.deviceManagement || location === DIRECT_ALIASES.deviceManagementLegacy) return t('nav_device_management');
    if (location === ROUTES.settingsDomainRules) return t('nav_domain_rules');
    if (location === ROUTES.backup) return t('nav_backup_strategy');
    if (isImportRoute) return t('nav_import_export');
    if (location === ROUTES.settingsAccount) return t('nav_account_settings');
    if (location === ROUTES.settings) return t('txt_settings');
    return t('nav_my_vault');
  })();

  useEffect(() => {
    if (phase === 'register' && (location === ROUTES.home || location === ROUTES.login) && !isPublicSendRoute) {
      navigate(ROUTES.register);
    }
  }, [phase, location, isPublicSendRoute, navigate]);

  useEffect(() => {
    if (phase === 'app' && !isAdminProfile(profile) && (location === ROUTES.backup || location === ROUTES.logs) && !profileQuery.isFetching) {
      navigate(ROUTES.vault);
    }
  }, [phase, profile?.role, profileQuery.isFetching, location, navigate]);

  useEffect(() => {
    if (phase === 'app' && !mobileLayout && location === ROUTES.settings) {
      navigate(ROUTES.settingsAccount);
    }
  }, [phase, mobileLayout, location, navigate]);

  const secretsManager = useSecretsManager({ authedFetch, session, onNotify: pushToast, offlineCacheKey: vaultCacheKey });
  // 与 secretsManager 一样挂在 App：否则每次进机器账号页都会先清空再加载
  const machineAccounts = useMachineAccounts({ authedFetch, session, onNotify: pushToast });

  const mainRoutesProps = {
    profile,
    profileLoading: profileQuery.isFetching && !profile,
    session,
    mobileLayout,
    secretsManager,
    machineAccounts,
    authedFetch,
    themePreference,
    decryptedCiphers,
    decryptedFolders,
    decryptedSends,
    vaultError: vaultCoreQuery.isError && !encryptedVaultCore ? t('txt_load_vault_failed') : vaultDecryptError,
    ciphersLoading: !(vaultCoreQuery.isError && !encryptedVaultCore) && !vaultDecryptError && !vaultInitialDecryptDone,
    foldersLoading: !(vaultCoreQuery.isError && !encryptedVaultCore) && !vaultDecryptError && !vaultInitialDecryptDone,
    sendsLoading: (sendsQuery.isFetching && !encryptedSends) || (!!encryptedSends && !sendsDecryptDone),
    users: usersQuery.data || [],
    invites: invitesQuery.data || [],
    adminLoading: (usersQuery.isFetching && !usersQuery.data) || (invitesQuery.isFetching && !invitesQuery.data),
    adminError: usersQuery.isError || invitesQuery.isError ? t('txt_load_admin_data_failed') : '',
    totpEnabled: !!twoFactorStatusQuery.data?.totpEnabled,
    yubikeyEnabled: !!twoFactorStatusQuery.data?.yubikeyEnabled,
    passkey2faEnabled: !!twoFactorStatusQuery.data?.passkeyEnabled,
    defaultProvider: twoFactorStatusQuery.data?.defaultProvider ?? null,
    lockTimeoutMinutes,
    sessionTimeoutAction,
    authorizedDevices: authorizedDevicesQuery.data || [],
    currentDeviceIdentifier: getCurrentDeviceIdentifier(),
    authorizedDevicesLoading: authorizedDevicesQuery.isFetching,
    authorizedDevicesError: authorizedDevicesQuery.isError && !authorizedDevicesQuery.data ? t('txt_load_devices_failed') : '',
    domainRules: IS_DEMO_MODE ? demoDomainRules : domainRulesQuery.data || null,
    domainRulesLoading: domainRulesQuery.isFetching && !domainRulesQuery.data,
    domainRulesError: domainRulesQuery.isError && !domainRulesQuery.data ? t('txt_domain_rules_load_failed') : '',
    onNavigate: navigate,
    onLogout: handleLogout,
    onNotify: pushToast,
    onThemePreferenceChange: setThemePreference,
    onImport: vaultSendActions.importVault,
    onImportEncryptedRaw: vaultSendActions.importEncryptedRaw,
    onExport: vaultSendActions.exportVault,
    onCreateVaultItem: vaultSendActions.createVaultItem,
    onUpdateVaultItem: vaultSendActions.updateVaultItem,
    onDeleteVaultItem: vaultSendActions.deleteVaultItem,
    onArchiveVaultItem: vaultSendActions.archiveVaultItem,
    onUnarchiveVaultItem: vaultSendActions.unarchiveVaultItem,
    onRestoreVaultItems: vaultSendActions.bulkRestoreVaultItems,
    onBulkDeleteVaultItems: vaultSendActions.bulkDeleteVaultItems,
    onBulkPermanentDeleteVaultItems: vaultSendActions.bulkPermanentDeleteVaultItems,
    onBulkRestoreVaultItems: vaultSendActions.bulkRestoreVaultItems,
    onBulkArchiveVaultItems: vaultSendActions.bulkArchiveVaultItems,
    onBulkUnarchiveVaultItems: vaultSendActions.bulkUnarchiveVaultItems,
    onBulkMoveVaultItems: vaultSendActions.bulkMoveVaultItems,
    onVerifyMasterPassword: vaultSendActions.verifyMasterPassword,
    onCreateFolder: vaultSendActions.createFolder,
    onRenameFolder: vaultSendActions.renameFolder,
    onDeleteFolder: vaultSendActions.deleteFolder,
    onDownloadVaultAttachment: vaultSendActions.downloadVaultAttachment,
    downloadingAttachmentKey: vaultSendActions.downloadingAttachmentKey,
    attachmentDownloadPercent: vaultSendActions.attachmentDownloadPercent,
    uploadingAttachmentName: vaultSendActions.uploadingAttachmentName,
    attachmentUploadPercent: vaultSendActions.attachmentUploadPercent,
    onRefreshVault: vaultSendActions.refreshVault,
    onCreateSend: vaultSendActions.createSend,
    onUpdateSend: vaultSendActions.updateSend,
    onDeleteSend: vaultSendActions.deleteSend,
    onBulkDeleteSends: vaultSendActions.bulkDeleteSends,
    uploadingSendFileName: vaultSendActions.uploadingSendFileName,
    sendUploadPercent: vaultSendActions.sendUploadPercent,
    onChangePassword: accountSecurityActions.changePassword,
    onSavePasswordHint: accountSecurityActions.savePasswordHint,
    onEnableTotp: async (secret: string, token: string, masterPassword: string) => {
      await accountSecurityActions.enableTotp(secret, token, masterPassword);
      await twoFactorStatusQuery.refetch();
    },
    onOpenDisableTotp: () => setDisableTotpOpen(true),
    onGetTotpAuthenticatorSecret: accountSecurityActions.getTotpAuthenticatorSecret,
    onGetYubiKeySettings: accountSecurityActions.getYubiKeySettings,
    onSaveYubiKeySettings: accountSecurityActions.saveYubiKeySettings,
    onSaveYubiKeyApiCredentials: accountSecurityActions.saveYubiKeyApiCredentials,
    onBootstrapYubiKeyApiCredentials: accountSecurityActions.bootstrapYubiKeyApiCredentials,
    onDisableYubiKey: accountSecurityActions.disableYubiKey,
    onSetDefaultTwoFactorProvider: accountSecurityActions.setDefaultTwoFactorProvider,
    onGetTwoFactorPasskeySettings: accountSecurityActions.getTwoFactorPasskeySettings,
    onGetEmailTwoFactor: () => getEmailTwoFactorStatus(authedFetch),
    onSetEmailTwoFactor: accountSecurityActions.setEmailTwoFactor,
    onCreateTwoFactorPasskey: accountSecurityActions.createTwoFactorPasskey,
    onDeleteTwoFactorPasskey: accountSecurityActions.deleteTwoFactorPasskey,
    onDisableTwoFactorPasskeys: accountSecurityActions.disableTwoFactorPasskeys,
    onGetRecoveryCode: accountSecurityActions.getRecoveryCode,
    onGetApiKey: accountSecurityActions.getApiKey,
    onRotateApiKey: accountSecurityActions.rotateApiKey,
    // 设置页的邮箱验证状态 / 邮件配置由启动查询提供：首帧即正确，进分区不再拉取
    emailVerification: profileQuery.data?.emailVerification ?? null,
    mailSettings: mailSettingsQuery.data ?? null,
    onRefreshEmailVerification: async () => {
      // 重拉 profile（它的响应里带着邮箱验证状态），不再为它单开一个请求。
      await profileQuery.refetch();
    },
    onMailSettingsSaved: (settings: MailSettings) => {
      queryClient.setQueryData(['admin-mail-settings', vaultCacheKey || session?.email], settings);
      // 邮件可用性变了，两个启动查询都得跟上 —— 否则要刷新整页才生效：
      // profile 里的 `emailVerification`（账户页的徽标 / 验证按钮）与 `/api/config`
      // 的 `mailDeliveryAvailable`（两步登录邮件那一行、提示文案）。
      void profileQuery.refetch();
      void serverConfigQuery.refetch();
    },
    onSaveMailSettings: adminMailActions.saveMailSettings,
    onSendTestMail: adminMailActions.sendTestMail,
    mailDeliveryAvailable,
    mailDeliveryUnavailable,
    mailPreferences,
    onSaveMailPreferences: async (update: MailPreferencesUpdate) => {
      const next = await savePreferences(authedFetch, update);
      await preferencesQuery.refetch();
      return next;
    },
    onLoadEmailVerification: () => getEmailVerificationStatus(authedFetch),
    onSendEmailVerificationCode: () => sendEmailVerificationCode(authedFetch),
    onSubmitEmailVerificationCode: (code: string) => submitEmailVerificationCode(authedFetch, code),
    onListAccountPasskeys: accountSecurityActions.listAccountPasskeys,
    onCreateAccountPasskey: accountSecurityActions.createAccountPasskey,
    onEnableAccountPasskeyDirectUnlock: accountSecurityActions.enableAccountPasskeyDirectUnlock,
    onDeleteAccountPasskey: accountSecurityActions.deleteAccountPasskey,
    onRefreshTwoFactorStatus: async () => {
      await twoFactorStatusQuery.refetch();
    },
    onRefreshServerConfig: async () => {
      await serverConfigQuery.refetch();
    },
    pendingAuthRequests,
    pendingAuthRequestsLoading: pendingAuthRequestsQuery.isLoading,
    pendingAuthRequestsRefreshing: pendingAuthRequestsQuery.isFetching && !pendingAuthRequestsQuery.isLoading,
    onRefreshPendingAuthRequests: async () => {
      await pendingAuthRequestsQuery.refetch();
    },
    onApproveAuthRequest: beginApproveAuthRequest,
    onDenyAuthRequest: denyAuthRequest,
    onLockTimeoutChange: setLockTimeoutMinutes,
    onSessionTimeoutActionChange: setSessionTimeoutAction,
    onRefreshAuthorizedDevices: accountSecurityActions.refreshAuthorizedDevices,
    onRefreshDomainRules: () => {
      void domainRulesQuery.refetch();
    },
    onSaveDomainRules: handleSaveDomainRules,
    onRenameAuthorizedDevice: accountSecurityActions.renameAuthorizedDevice,
    onRevokeDeviceTrust: accountSecurityActions.openRevokeDeviceTrust,
    onTrustDevicePermanently: accountSecurityActions.openTrustDevicePermanently,
    onRemoveDevice: accountSecurityActions.openRemoveDevice,
    onRemoveSelectedDevices: accountSecurityActions.openRemoveSelectedDevices,
    onRevokeAllDeviceTrust: accountSecurityActions.openRevokeAllDeviceTrust,
    onRemoveAllDevices: accountSecurityActions.openRemoveAllDevices,
    onRefreshAdmin: adminActions.refreshAdmin,
    onCreateInvite: adminActions.createInvite,
    onDeleteInvalidInvites: adminActions.deleteInvalidInvites,
    onDeleteAllInvites: adminActions.deleteAllInvites,
    onToggleUserStatus: adminActions.toggleUserStatus,
    onDeleteUser: adminActions.deleteUser,
    onDeleteInvite: adminActions.deleteInvite,
    onLoadAuditLogs: (filters: AuditLogFilters) => listAuditLogs(authedFetch, filters),
    onLoadAuditLogSettings: () => getAuditLogSettings(authedFetch),
    onSaveAuditLogSettings: (settings: AuditLogSettings) => saveAuditLogSettings(authedFetch, settings),
    onClearAuditLogs: () => clearAuditLogs(authedFetch),
    onExportBackup: async (masterPassword: string, includeAttachments?: boolean) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.exportBackup(hash, includeAttachments);
    },
    onImportBackup: async (masterPassword: string, file: File, replaceExisting?: boolean) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.importBackup(hash, file, replaceExisting);
    },
    onImportBackupAllowingChecksumMismatch: async (masterPassword: string, file: File, replaceExisting?: boolean) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.importBackupAllowingChecksumMismatch(hash, file, replaceExisting);
    },
    onLoadBackupSettings: () => queryClient.ensureQueryData({
      queryKey: ['admin-backup-settings', vaultCacheKey],
      queryFn: () => backupActions.loadSettings(),
      staleTime: 30_000,
    }),
    onSaveBackupSettings: async (masterPassword: string, settings: AdminBackupSettings) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      const saved = await backupActions.saveSettings(hash, settings);
      queryClient.setQueryData(['admin-backup-settings', vaultCacheKey], saved);
      return saved;
    },
    onRunRemoteBackup: async (masterPassword: string, destinationId?: string | null) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      const result = await backupActions.runRemoteBackup(hash, destinationId);
      queryClient.setQueryData(['admin-backup-settings', vaultCacheKey], result.settings);
      return result;
    },
    onListRemoteBackups: backupActions.listRemoteBackups,
    onDownloadRemoteBackup: async (masterPassword: string, destinationId: string, path: string, onProgress?: (percent: number | null) => void) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.downloadRemoteBackup(hash, destinationId, path, onProgress);
    },
    onInspectRemoteBackup: async (masterPassword: string, destinationId: string, path: string) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.inspectRemoteBackup(hash, destinationId, path);
    },
    onDeleteRemoteBackup: async (masterPassword: string, destinationId: string, path: string) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.deleteRemoteBackup(hash, destinationId, path);
    },
    onRestoreRemoteBackup: async (masterPassword: string, destinationId: string, path: string, replaceExisting?: boolean) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.restoreRemoteBackup(hash, destinationId, path, replaceExisting);
    },
    onRestoreRemoteBackupAllowingChecksumMismatch: async (masterPassword: string, destinationId: string, path: string, replaceExisting?: boolean) => {
      const hash = await deriveCurrentMasterPasswordHash(masterPassword);
      return backupActions.restoreRemoteBackupAllowingChecksumMismatch(hash, destinationId, path, replaceExisting);
    },
  };
  const effectiveMainRoutesProps = IS_DEMO_MODE
    ? createDemoMainRoutesProps(mainRoutesProps, pushToast, {
        ciphers: decryptedCiphers,
        folders: decryptedFolders,
        sends: decryptedSends,
        users: demoUsers,
        invites: demoInvites,
        authorizedDevices: demoAuthorizedDevices,
        backupSettings: demoBackupSettings,
        setCiphers: setDecryptedCiphers,
        setFolders: setDecryptedFolders,
        setSends: setDecryptedSends,
        setUsers: setDemoUsers,
        setInvites: setDemoInvites,
        setAuthorizedDevices: setDemoAuthorizedDevices,
        setBackupSettings: setDemoBackupSettings,
      })
    : mainRoutesProps;

  if (jwtWarning) {
    return <JwtWarningPage reason={jwtWarning.reason} minLength={jwtWarning.minLength} />;
  }

  if (publicSendMatch) {
    return (
      <>
        <PublicSendPage
          accessId={decodeURIComponent(publicSendMatch[1])}
          keyPart={publicSendMatch[2] ? decodeURIComponent(publicSendMatch[2]) : null}
          onNotify={pushToast}
        />
        {renderPassiveOverlays()}
      </>
    );
  }

  // 未登录没有 shell 可回退，只能整页 404；已登录交给兜底渲染到内容区，保留导航栏。
  if (isUnknownRoute && phase !== 'app') {
    return (
      <>
        <NotFoundPage />
        {renderPassiveOverlays()}
      </>
    );
  }

  if (phase === 'register' || phase === 'login' || phase === 'locked') {
    return (
      <>
        <AuthViews
          mode={phase}
          pendingAction={pendingAuthAction}
          relaxedLoginInput={IS_DEMO_MODE}
          authPlaceholder={IS_DEMO_MODE ? t('txt_demo_auth_placeholder') : undefined}
          unlockPlaceholder={IS_DEMO_MODE ? t('txt_demo_unlock_placeholder') : undefined}
          unlockReady={!!session?.email}
          unlockPreparing={unlockPreparing}
          sessionRefreshError={lockedSessionRefreshError}
          loginValues={loginValues}
          pendingPasskeyPasswordEmail={pendingPasskeyPassword?.email || null}
          passkeyPassword={passkeyPassword}
          registerValues={registerValues}
          registrationInviteRequired={registrationInviteRequired}
          mailDeliveryAvailable={mailDeliveryAvailable}
          unlockPassword={unlockPassword}
          emailForLock={profile?.email || session?.email || ''}
          loginHintLoading={loginHintState.loading}
          onChangeLogin={setLoginValues}
          onChangePasskeyPassword={setPasskeyPassword}
          onChangeRegister={setRegisterValues}
          onChangeUnlock={setUnlockPassword}
          onSubmitLogin={() => void handleLogin()}
          onSubmitPasskey={() => void handlePasskeyLogin()}
          onSubmitPasskeyUnlock={() => void handlePasskeyUnlock()}
          onSubmitPasskeyPassword={() => void handlePasskeyPasswordLogin()}
          onSubmitRegister={() => void handleRegister()}
          onSubmitUnlock={() => void handleUnlock()}
          onGotoLogin={() => {
            setPendingPasskeyPassword(null);
            setPasskeyPassword('');
            setPhase('login');
            navigate(ROUTES.login);
          }}
          onGotoRegister={() => {
            if (IS_DEMO_MODE) {
              pushToast('warning', t('txt_demo_readonly_message'));
              return;
            }
            if (inviteCodeFromUrl) {
              setRegisterValues((prev) => ({ ...prev, inviteCode: inviteCodeFromUrl }));
            }
            setPendingPasskeyPassword(null);
            setPasskeyPassword('');
            setPhase('register');
            navigate(ROUTES.register);
          }}
          onLogout={logoutNow}
          onTogglePasswordHint={() => void handleTogglePasswordHint()}
          onShowLockedPasswordHint={handleShowLockedPasswordHint}
          onRetrySessionRefresh={() => {
            lockedSessionRetryAttemptRef.current = 0;
            setLockedSessionRefreshError('');
            setLockedSessionRetryKey((value) => value + 1);
          }}
        />
        <AppGlobalOverlays
          toasts={toasts}
          onCloseToast={removeToast}
          onPauseToasts={pauseToasts}
          onResumeToasts={resumeToasts}
          confirm={confirm}
          onCancelConfirm={() => setConfirm(null)}
          pendingTotpOpen={!!pendingTotp}
          pendingTotpProviderType={pendingTotp?.providerType ?? 0}
          pendingTotpAvailableProviders={pendingTotp?.availableProviders ?? []}
          totpCode={totpCode}
          rememberDevice={rememberDevice}
          onTotpCodeChange={setTotpCode}
          onRememberDeviceChange={setRememberDevice}
          onConfirmTotp={() => void handleTotpVerify()}
          onSelectTotpProvider={handleSelectTotpProvider}
          onSubmitRecoveryCode={(recoveryCode) => void handleSubmitTotpRecoveryCode(recoveryCode)}
          onCancelTotp={() => {
            if (totpSubmitting) return;
            setPendingTotp(null);
            setPendingTotpMode(null);
            setTotpCode('');
            setRememberDevice(true);
          }}
          totpSubmitting={totpSubmitting}
          onResendEmailCode={() => {
            if (pendingTotp) void sendEmailTwoFactorCode(pendingTotp.email);
          }}
          emailCodeResending={emailCodeResending}
          emailCodeResendIn={emailCodeResendIn}
          deviceVerification={pendingDeviceVerification ? {
            email: pendingDeviceVerification.email,
            code: deviceOtpCode,
            submitting: deviceOtpSubmitting,
            resending: deviceOtpResending,
            resendIn: deviceOtpResendIn,
            onCodeChange: setDeviceOtpCode,
            onConfirm: () => void handleDeviceVerificationSubmit(),
            onResend: () => void handleResendDeviceOtpCode(),
            onCancel: () => {
              if (deviceOtpSubmitting) return;
              setPendingDeviceVerification(null);
              setDeviceOtpCode('');
            },
          } : null}
          disableTotpOpen={false}
          disableTotpPassword=""
          onDisableTotpPasswordChange={() => {}}
          onConfirmDisableTotp={() => {}}
          onCancelDisableTotp={() => {}}
          disableTotpSubmitting={false}
        />
      </>
    );
  }

  return (
    <DateTimePrefsProvider prefs={dateTimePrefs}>
      <AppAuthenticatedShell
        profile={profile}
        location={location}
        mobilePrimaryRoute={mobilePrimaryRoute}
        currentPageTitle={currentPageTitle}
        isImportRoute={isImportRoute}
        darkMode={resolvedTheme === 'dark'}
        themeToggleTitle={resolvedTheme === 'dark' ? t('txt_switch_to_light_mode') : t('txt_switch_to_dark_mode')}
        onLock={handleLock}
        onLogout={handleLogout}
        onToggleTheme={handleToggleTheme}
        mainRoutesProps={effectiveMainRoutesProps}
      />

      <AppGlobalOverlays
        toasts={toasts}
        onCloseToast={removeToast}
        onPauseToasts={pauseToasts}
        onResumeToasts={resumeToasts}
        confirm={confirm}
        onCancelConfirm={() => setConfirm(null)}
        pendingTotpOpen={false}
        pendingTotpProviderType={0}
        pendingTotpAvailableProviders={[]}
        totpCode=""
        rememberDevice={false}
        onTotpCodeChange={() => {}}
        onRememberDeviceChange={() => {}}
        onConfirmTotp={() => {}}
        onSelectTotpProvider={() => {}}
        onSubmitRecoveryCode={() => {}}
        onCancelTotp={() => {}}
        totpSubmitting={false}
        disableTotpOpen={disableTotpOpen}
        disableTotpPassword={disableTotpPassword}
        onDisableTotpPasswordChange={setDisableTotpPassword}
        onConfirmDisableTotp={() => {
          if (disableTotpSubmitting) return;
          void (async () => {
            setDisableTotpSubmitting(true);
            try {
              await accountSecurityActions.disableTotp();
            } finally {
              setDisableTotpSubmitting(false);
            }
          })();
        }}
        onCancelDisableTotp={() => {
          if (disableTotpSubmitting) return;
          setDisableTotpOpen(false);
          setDisableTotpPassword('');
        }}
        disableTotpSubmitting={disableTotpSubmitting}
      />
      <AuthRequestApprovalDialog
        open={authRequestDialogOpen}
        authRequest={authRequestDialogRequest}
        submitting={!!authRequestSubmittingId}
        onApprove={() => {
          if (!authRequestDialogRequest) return;
          void approveAuthRequest(authRequestDialogRequest).catch((error) => {
            pushToast('error', error instanceof Error ? error.message : t('txt_auth_request_update_failed'));
          });
        }}
        onDeny={() => {
          if (!authRequestDialogRequest) return;
          void denyAuthRequest(authRequestDialogRequest).catch((error) => {
            pushToast('error', error instanceof Error ? error.message : t('txt_auth_request_update_failed'));
          });
        }}
        onClose={() => {
          setAuthRequestDialogSelectedId(null);
          setAuthRequestDialogDismissedId(authRequestDialogRequest?.id || null);
        }}
      />
    </DateTimePrefsProvider>
  );
}
