import { useEffect, useMemo, useState } from 'preact/hooks';
import { Clipboard, KeyRound, RefreshCw, Send, ShieldCheck, ShieldOff, Trash2 } from 'lucide-preact';
import { copyTextToClipboard } from '@/lib/clipboard';
import { calcTotpNow } from '@/lib/crypto';
import qrcode from 'qrcode-generator';
import type { AccountPasskeyCredential, MailEncryption, MailSettings, MailSettingsInput, MailTestResult, Profile, TwoFactorPasskeyCredential, TwoFactorPasskeySettings, YubiKeyOtpSettings } from '@/lib/types';
import { describeMailFailure } from '@/hooks/useAdminMailActions';
import { AVAILABLE_LOCALES, getLocale, setLocale, t, type Locale } from '@/lib/i18n';
import ConfirmDialog from '@/components/ConfirmDialog';

interface SettingsPageProps {
  profile: Profile;
  totpEnabled: boolean;
  yubikeyEnabled: boolean;
  passkey2faEnabled: boolean;
  themePreference: ThemePreference;
  lockTimeoutMinutes: 0 | 1 | 5 | 15 | 30;
  sessionTimeoutAction: 'lock' | 'logout';
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onVerifyMasterPassword: (email: string, password: string) => Promise<void>;
  onChangePassword: (currentPassword: string, nextPassword: string, nextPassword2: string) => Promise<void>;
  onSavePasswordHint: (masterPasswordHint: string) => Promise<void>;
  onEnableTotp: (secret: string, token: string, masterPassword: string) => Promise<void>;
  onOpenDisableTotp: () => void;
  onGetTotpAuthenticatorSecret: (masterPassword: string) => Promise<{ enabled: boolean; key: string }>;
  onGetYubiKeySettings: (masterPassword: string) => Promise<YubiKeyOtpSettings>;
  onSaveYubiKeySettings: (keys: string[], nfc: boolean, masterPassword: string) => Promise<YubiKeyOtpSettings>;
  onSaveYubiKeyApiCredentials: (clientId: string, secretKey: string, masterPassword: string) => Promise<YubiKeyOtpSettings>;
  onBootstrapYubiKeyApiCredentials: (otp: string, masterPassword: string) => Promise<YubiKeyOtpSettings>;
  onDisableYubiKey: (masterPassword: string) => Promise<void>;
  onGetTwoFactorPasskeySettings: (masterPassword: string) => Promise<TwoFactorPasskeySettings>;
  onCreateTwoFactorPasskey: (name: string, masterPassword: string) => Promise<TwoFactorPasskeySettings>;
  onDeleteTwoFactorPasskey: (id: number, masterPassword: string) => Promise<TwoFactorPasskeySettings>;
  onDisableTwoFactorPasskeys: (masterPassword: string) => Promise<void>;
  onGetRecoveryCode: (masterPassword: string) => Promise<string>;
  onGetApiKey: (masterPassword: string) => Promise<string>;
  onRotateApiKey: (masterPassword: string) => Promise<string>;
  onLoadMailSettings: () => Promise<MailSettings>;
  onSaveMailSettings: (input: MailSettingsInput, masterPassword: string) => Promise<MailSettings>;
  onSendTestMail: (input: MailSettingsInput) => Promise<MailTestResult>;
  onListAccountPasskeys: () => Promise<AccountPasskeyCredential[]>;
  onCreateAccountPasskey: (name: string, masterPassword: string, directUnlock: boolean) => Promise<AccountPasskeyCredential | null>;
  onEnableAccountPasskeyDirectUnlock: (id: string, masterPassword: string) => Promise<void>;
  onDeleteAccountPasskey: (id: string, masterPassword: string) => Promise<void>;
  onRefreshTwoFactorStatus: () => Promise<void>;
  onLockTimeoutChange: (minutes: 0 | 1 | 5 | 15 | 30) => void;
  onSessionTimeoutActionChange: (action: 'lock' | 'logout') => void;
  onNotify?: (type: 'success' | 'error' | 'warning', text: string) => void;
}

type ThemePreference = 'system' | 'light' | 'dark';
type SettingsSection = 'appearance' | 'session' | 'masterPassword' | 'twoStep' | 'keys' | 'mail';

type MasterPasswordPromptAction =
  | 'enableTotp'
  | 'recovery'
  | 'apiKey'
  | 'rotateApiKey'
  | 'manageTotp'
  | 'manageYubiKey'
  | 'managePasskey2fa'
  | 'createPasskey'
  | 'enablePasskeyDirectUnlock'
  | 'deletePasskey';

const LOCK_TIMEOUT_OPTIONS = [
  { value: 1, labelKey: 'txt_timeout_1_minute' },
  { value: 5, labelKey: 'txt_timeout_5_minutes' },
  { value: 15, labelKey: 'txt_timeout_15_minutes' },
  { value: 30, labelKey: 'txt_timeout_30_minutes' },
  { value: 0, labelKey: 'txt_timeout_never' },
] as const;

const EMPTY_YUBIKEY_KEYS: [string, string, string, string, string] = ['', '', '', '', ''];

/** 浏览器所在时区；拿不到就回退 UTC。 */
function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatStoredYubiKey(value: string): string {
  if (!value) return '';
  if (value.length >= 44) return value;
  return `${value}${'•'.repeat(44 - value.length)}`;
}

function normalizeYubiKeyFieldValue(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function randomBase32Secret(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  const maxUnbiasedByte = Math.floor(256 / alphabet.length) * alphabet.length;
  while (out.length < length) {
    const random = crypto.getRandomValues(new Uint8Array(length));
    for (const x of random) {
      if (x >= maxUnbiasedByte) continue;
      out += alphabet[x % alphabet.length];
      if (out.length >= length) break;
    }
  }
  return out;
}

function buildOtpUri(email: string, secret: string): string {
  const issuer = 'NodeWarden';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function clearLegacyTotpSetupSecrets(): void {
  if (typeof window === 'undefined') return;
  const prefix = 'nodewarden.totp.secret.';
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) {
    window.localStorage.removeItem(key);
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return t('txt_dash');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('txt_dash');
  return date.toLocaleString();
}

export default function SettingsPage(props: SettingsPageProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [passwordHint, setPasswordHint] = useState(props.profile.masterPasswordHint || '');
  const [secret, setSecret] = useState(() => randomBase32Secret(32));
  const [token, setToken] = useState('');
  const [totpLocked, setTotpLocked] = useState(props.totpEnabled);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [accountPasskeys, setAccountPasskeys] = useState<AccountPasskeyCredential[]>([]);
  const [accountPasskeysLoading, setAccountPasskeysLoading] = useState(false);
  const [accountPasskeyName, setAccountPasskeyName] = useState(t('txt_account_passkey'));
  const [accountPasskeyDirectUnlock, setAccountPasskeyDirectUnlock] = useState(true);
  const [accountPasskeyPromptId, setAccountPasskeyPromptId] = useState<string | null>(null);
  const [createPasskeyDialogOpen, setCreatePasskeyDialogOpen] = useState(false);
  const [createPasskeyMasterPassword, setCreatePasskeyMasterPassword] = useState('');
  const [rotateApiKeyConfirmOpen, setRotateApiKeyConfirmOpen] = useState(false);
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false);
  const [totpManageDialogOpen, setTotpManageDialogOpen] = useState(false);
  const [yubiKeyDialogOpen, setYubiKeyDialogOpen] = useState(false);
  const [yubiKeyMasterPassword, setYubiKeyMasterPassword] = useState('');
  const [yubiKeyEnabled, setYubiKeyEnabled] = useState(props.yubikeyEnabled || !!props.profile.yubikeyEnabled);
  const [yubiKeyKeys, setYubiKeyKeys] = useState<[string, string, string, string, string]>(EMPTY_YUBIKEY_KEYS);
  const [yubiKeyStoredKeys, setYubiKeyStoredKeys] = useState<[string, string, string, string, string]>(EMPTY_YUBIKEY_KEYS);
  const [yubiKeyNfc, setYubiKeyNfc] = useState(false);
  const [yubiKeyYubicoConfigured, setYubiKeyYubicoConfigured] = useState(false);
  const [yubiKeyYubicoCanManage, setYubiKeyYubicoCanManage] = useState(false);
  const [yubiKeyYubicoClientId, setYubiKeyYubicoClientId] = useState('');
  const [yubiKeyYubicoSecretKey, setYubiKeyYubicoSecretKey] = useState('');
  const [yubiKeyBootstrapOtp, setYubiKeyBootstrapOtp] = useState('');
  const [yubiKeyConfigOpen, setYubiKeyConfigOpen] = useState(false);
  const [yubiKeySubmitting, setYubiKeySubmitting] = useState(false);
  const [twoFactorPasskeyEnabled, setTwoFactorPasskeyEnabled] = useState(props.passkey2faEnabled);
  const [twoFactorPasskeys, setTwoFactorPasskeys] = useState<TwoFactorPasskeyCredential[]>([]);
  const [twoFactorPasskeyDialogOpen, setTwoFactorPasskeyDialogOpen] = useState(false);
  const [twoFactorPasskeyMasterPassword, setTwoFactorPasskeyMasterPassword] = useState('');
  const [twoFactorPasskeyName, setTwoFactorPasskeyName] = useState(t('txt_passkey'));
  const [twoFactorPasskeySubmitting, setTwoFactorPasskeySubmitting] = useState(false);
  const [twoFactorStatusRefreshing, setTwoFactorStatusRefreshing] = useState(false);
  const [recoveryCodeDialogOpen, setRecoveryCodeDialogOpen] = useState(false);
  const [totpManagePassword, setTotpManagePassword] = useState('');
  /** 服务端**实际保存的** TOTP 密钥；null = 尚未取到（此时弹窗里的是本次待启用的新密钥） */
  const [totpRealSecret, setTotpRealSecret] = useState<string | null>(null);
  const [masterPasswordPrompt, setMasterPasswordPrompt] = useState<MasterPasswordPromptAction | null>(null);
  const [masterPasswordPromptValue, setMasterPasswordPromptValue] = useState('');
  const [masterPasswordPromptSubmitting, setMasterPasswordPromptSubmitting] = useState(false);
  const [selectedLocale, setSelectedLocale] = useState<Locale>(() => getLocale());
  const [activeSection, setActiveSection] = useState<SettingsSection>('appearance');
  const [mailSettings, setMailSettings] = useState<MailSettings | null>(null);
  const [mailHost, setMailHost] = useState('');
  const [mailPort, setMailPort] = useState('587');
  const [mailUsername, setMailUsername] = useState('');
  const [mailPassword, setMailPassword] = useState('');
  const [mailFromAddress, setMailFromAddress] = useState('');
  const [mailFromName, setMailFromName] = useState('');
  const [mailLocale, setMailLocale] = useState('en');
  const [mailTimezone, setMailTimezone] = useState('UTC');
  const [mailSubmitting, setMailSubmitting] = useState(false);
  const [mailPromptAction, setMailPromptAction] = useState<'save' | 'disable' | null>(null);
  const [mailMasterPassword, setMailMasterPassword] = useState('');
  /** 当前表单是否已通过测试 —— 只有它为真时「保存」才可用 */
  const [mailTested, setMailTested] = useState(false);
  /** 表单是否与已保存的一致（配置完整时无需重测即可重新启用） */
  const [mailSynced, setMailSynced] = useState(false);

  const isAdmin = props.profile.role === 'admin';
  /** 端口决定加密方式，不单独选择，避免存下必然失败的组合 */
  const mailEncryption: MailEncryption = Number(mailPort) === 465 || Number(mailPort) === 2465 ? 'implicit' : 'starttls';
  /** 服务端当前是否已启用邮件发送 */
  const mailEnabled = !!mailSettings?.enabled;
  /** 已停用等同未配置：只有「参数完整 **且** 已启用」才算配置好了 */
  const mailConfigured = !!mailSettings?.configured && mailEnabled;
  /** 表单没改过且参数完整 ⇒ 可以不经重测直接提交（重新启用 / 停用） */
  const mailUnchanged = mailSynced && !!mailSettings?.configured;
  const mailCanTest = !mailSubmitting && !!mailHost.trim() && !!mailFromAddress.trim();
  /** 保存（= 启用）：测过、或配置未变且当前处于停用状态（重新启用） */
  const mailCanSave = !mailSubmitting && (mailTested || (mailUnchanged && !mailEnabled));
  const mailInput: MailSettingsInput = {
    enabled: true,
    host: mailHost.trim(),
    port: Number(mailPort),
    username: mailUsername.trim(),
    fromAddress: mailFromAddress.trim(),
    fromName: mailFromName.trim(),
    locale: mailLocale,
    timezone: mailTimezone,
    ...(mailPassword ? { password: mailPassword } : {}),
  };

  /** 时区列表由运行环境提供（workerd/浏览器的 ICU 数据），拿不到时保底只给 UTC */
  const timezoneOptions = useMemo<string[]>(() => {
    try {
      const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
        .supportedValuesOf?.('timeZone');
      return supported && supported.length > 0 ? supported : ['UTC'];
    } catch {
      return ['UTC'];
    }
  }, []);

  /**
   * 表单被改动 ⇒ 之前的测试结果作废，保存重新变为不可用。
   * 语言与时区也走这里：它们会影响邮件正文，改了同样要重新测试。
   */
  function touchMailForm(): void {
    setMailTested(false);
    setMailSynced(false);
  }

  function applyMailSettings(settings: MailSettings): void {
    setMailSettings(settings);
    setMailHost(settings.host);
    setMailPort(String(settings.port));
    setMailUsername(settings.username);
    setMailFromAddress(settings.fromAddress);
    setMailFromName(settings.fromName);
    // 从未配置过 ⇒ 用浏览器环境自动填：界面语言 + 本机时区。
    // 已经存过值就尊重它，不覆盖（否则会悄悄改掉管理员的显式选择）。
    if (settings.host) {
      setMailLocale(settings.locale);
      setMailTimezone(settings.timezone);
    } else {
      setMailLocale(getLocale());
      setMailTimezone(detectBrowserTimezone());
    }
    // 口令永不回显：留空表示「保持原口令不变」
    setMailPassword('');
    setMailTested(false);
    setMailSynced(true);
  }

  function closeMailPrompt(): void {
    setMailPromptAction(null);
    setMailMasterPassword('');
  }

  /** 测试不需要主密码：只给操作者自己发一封信，不是敏感写操作。 */
  async function submitMailTest(): Promise<void> {
    if (!mailCanTest) return;
    setMailSubmitting(true);
    try {
      await props.onSendTestMail(mailInput);
      setMailTested(true);
    } catch (error) {
      props.onNotify?.('error', describeMailFailure(error));
    } finally {
      setMailSubmitting(false);
    }
  }

  async function submitMailPrompt(): Promise<void> {
    if (mailSubmitting || !mailMasterPassword) return;
    setMailSubmitting(true);
    try {
      // 禁用再启用走同一个端点：靠 `enabled` 区分（保存 = 启用）
      const payload = mailPromptAction === 'disable' ? { ...mailInput, enabled: false } : mailInput;
      const saved = await props.onSaveMailSettings(payload, mailMasterPassword);
      applyMailSettings(saved);
      closeMailPrompt();
    } catch (error) {
      props.onNotify?.('error', describeMailFailure(error));
      closeMailPrompt();
    } finally {
      setMailSubmitting(false);
    }
  }

  useEffect(() => {
    clearLegacyTotpSetupSecrets();
  }, []);

  useEffect(() => {
    if (activeSection !== 'mail' || !isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await props.onLoadMailSettings();
        if (!cancelled) applyMailSettings(settings);
      } catch (error) {
        if (!cancelled) props.onNotify?.('error', describeMailFailure(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSection, isAdmin]);

  useEffect(() => {
    if (!props.totpEnabled) {
      setTotpLocked(false);
      return;
    }
    setTotpLocked(true);
  }, [props.totpEnabled]);

  useEffect(() => {
    setPasswordHint(props.profile.masterPasswordHint || '');
  }, [props.profile.masterPasswordHint]);

  useEffect(() => {
    setYubiKeyEnabled(props.yubikeyEnabled || !!props.profile.yubikeyEnabled);
  }, [props.yubikeyEnabled, props.profile.yubikeyEnabled]);

  useEffect(() => {
    setTwoFactorPasskeyEnabled(props.passkey2faEnabled);
  }, [props.passkey2faEnabled]);

  useEffect(() => {
    void refreshAccountPasskeys();
  }, [props.profile.id]);

  /** 已启用、但没拿到服务端的真密钥 ⇒ 宁可不显示，也不能把随机值当真值展示 */
  const totpSecretUnavailable = totpLocked && !totpRealSecret;

  const qrDataUrl = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(buildOtpUri(props.profile.email, secret));
    qr.make();
    // Keep a visible quiet zone so authenticator apps can scan reliably in both themes.
    const svg = qr.createSvgTag({ scalable: true, margin: 4 });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [props.profile.email, secret]);

  async function refreshAccountPasskeys(): Promise<void> {
    setAccountPasskeysLoading(true);
    try {
      setAccountPasskeys(await props.onListAccountPasskeys());
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_account_passkeys_load_failed'));
    } finally {
      setAccountPasskeysLoading(false);
    }
  }

  function openMasterPasswordPrompt(action: MasterPasswordPromptAction, credentialId?: string): void {
    setMasterPasswordPrompt(action);
    setAccountPasskeyPromptId(credentialId || null);
    setMasterPasswordPromptValue('');
  }

  function closeMasterPasswordPrompt(): void {
    if (masterPasswordPromptSubmitting) return;
    setMasterPasswordPrompt(null);
    setAccountPasskeyPromptId(null);
    setMasterPasswordPromptValue('');
  }

  async function submitMasterPasswordPrompt(): Promise<void> {
    if (!masterPasswordPrompt || masterPasswordPromptSubmitting) return;
    const masterPassword = masterPasswordPromptValue;
    setMasterPasswordPromptSubmitting(true);
    try {
      if (masterPasswordPrompt === 'enableTotp') {
        await props.onEnableTotp(secret, token, masterPassword);
        setTotpLocked(true);
      } else if (masterPasswordPrompt === 'recovery') {
        const code = await props.onGetRecoveryCode(masterPassword);
        setRecoveryCode(code);
        setRecoveryCodeDialogOpen(true);
        props.onNotify?.('success', t('txt_recovery_code_loaded'));
      } else if (masterPasswordPrompt === 'apiKey') {
        const key = await props.onGetApiKey(masterPassword);
        setApiKey(key);
        setApiKeyDialogOpen(true);
      } else if (masterPasswordPrompt === 'rotateApiKey') {
        const key = await props.onRotateApiKey(masterPassword);
        setApiKey(key);
        setApiKeyDialogOpen(true);
        props.onNotify?.('success', t('txt_api_key_rotated'));
      } else if (masterPasswordPrompt === 'manageTotp') {
        await props.onVerifyMasterPassword(props.profile.email, masterPassword);
        setTotpManagePassword(masterPassword);
        setToken('');
        setTotpRealSecret(null);
        if (props.totpEnabled) {
          // 已启用：必须显示**服务端保存的真值**。
          // 过去这里显示的是前端新生成的随机密钥（与库里那把毫无关系），会让人误以为
          // 「密钥被改成了一个全新的」—— 这是排查恢复/TOTP 问题时的著名陷阱。
          //
          // 但**无论能否取到真值，弹窗都要打开**：「停用 TOTP」是应用内停用两步验证的
          // **唯一**入口，而按钮就在这个弹窗里。早期版本在这里直接 return，于是
          // 「库里存着不可用密钥」的用户被彻底堵在门外 —— 提示让他「在下方先停用」，
          // 可那个按钮他永远看不到，只能去登录页用恢复码自救。
          try {
            const current = await props.onGetTotpAuthenticatorSecret(masterPassword);
            if (current.enabled && current.key) {
              setTotpRealSecret(current.key);
              setSecret(current.key);
            }
            // 否则：库里没有可用密钥（该接口此时会现场随机生成一把返回）。
            // 绝不把它当「当前密钥」显示；也不额外弹通知 —— 弹窗会隐藏密钥与二维码，
            // 并用 txt_totp_secret_unavailable 说清楚。
          } catch (error) {
            // 读取失败（网络/服务端错误）：给出具体原因，但依旧打开弹窗。
            props.onNotify?.('error', error instanceof Error ? error.message : t('txt_totp_secret_unavailable'));
          }
        } else {
          setSecret(randomBase32Secret(32));
        }
        setTotpManageDialogOpen(true);
      } else if (masterPasswordPrompt === 'manageYubiKey') {
        const settings = await props.onGetYubiKeySettings(masterPassword);
        setYubiKeyMasterPassword(masterPassword);
        applyYubiKeySettings(settings);
        setYubiKeyConfigOpen(false);
        setYubiKeyDialogOpen(true);
      } else if (masterPasswordPrompt === 'managePasskey2fa') {
        const settings = await props.onGetTwoFactorPasskeySettings(masterPassword);
        setTwoFactorPasskeyMasterPassword(masterPassword);
        applyTwoFactorPasskeySettings(settings);
        setTwoFactorPasskeyName(t('txt_passkey'));
        setTwoFactorPasskeyDialogOpen(true);
      } else if (masterPasswordPrompt === 'createPasskey') {
        await props.onVerifyMasterPassword(props.profile.email, masterPassword);
        setCreatePasskeyMasterPassword(masterPassword);
        setCreatePasskeyDialogOpen(true);
      } else if (masterPasswordPrompt === 'enablePasskeyDirectUnlock') {
        if (!accountPasskeyPromptId) throw new Error(t('txt_account_passkey_not_found'));
        await props.onEnableAccountPasskeyDirectUnlock(accountPasskeyPromptId, masterPassword);
        await refreshAccountPasskeys();
      } else if (masterPasswordPrompt === 'deletePasskey') {
        if (!accountPasskeyPromptId) throw new Error(t('txt_account_passkey_not_found'));
        await props.onDeleteAccountPasskey(accountPasskeyPromptId, masterPassword);
        await refreshAccountPasskeys();
      }
      setMasterPasswordPrompt(null);
      setAccountPasskeyPromptId(null);
      setMasterPasswordPromptValue('');
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_master_password_is_required_2'));
    } finally {
      setMasterPasswordPromptSubmitting(false);
    }
  }

  const masterPasswordPromptTitle =
    masterPasswordPrompt === 'enableTotp'
      ? t('txt_enable_totp')
      : masterPasswordPrompt === 'recovery'
      ? t('txt_view_recovery_code')
      : masterPasswordPrompt === 'rotateApiKey'
        ? t('txt_rotate_api_key')
        : masterPasswordPrompt === 'manageTotp'
          ? t('txt_totp')
          : masterPasswordPrompt === 'manageYubiKey'
            ? 'YubiKey'
            : masterPasswordPrompt === 'managePasskey2fa'
              ? t('txt_two_step_passkeys')
            : masterPasswordPrompt === 'createPasskey'
            ? t('txt_add_account_passkey')
            : masterPasswordPrompt === 'enablePasskeyDirectUnlock'
              ? t('txt_enable_passkey_direct_unlock')
              : masterPasswordPrompt === 'deletePasskey'
                ? t('txt_delete_account_passkey')
                : t('txt_view_api_key');

  function accountPasskeyStatusText(credential: AccountPasskeyCredential): string {
    if (credential.prfStatus === 0) return t('txt_direct_unlock');
    if (credential.prfStatus === 1) return t('txt_login_only');
    return t('txt_prf_not_supported');
  }

  async function changeLocale(next: Locale): Promise<void> {
    if (next === getLocale()) return;
    setSelectedLocale(next);
    await setLocale(next);
    window.location.reload();
  }

  function closeTotpManageDialog(): void {
    setTotpManageDialogOpen(false);
    setTotpManagePassword('');
  }

  function applyYubiKeySettings(settings: YubiKeyOtpSettings): void {
    setYubiKeyEnabled(settings.enabled);
    setYubiKeyKeys(settings.keys);
    setYubiKeyStoredKeys(settings.keys);
    setYubiKeyNfc(settings.nfc);
    setYubiKeyYubicoConfigured(settings.yubicoConfigured);
    setYubiKeyYubicoCanManage(settings.yubicoCanManage);
    setYubiKeyYubicoClientId(settings.yubicoClientId);
    setYubiKeyYubicoSecretKey(settings.yubicoSecretKey);
  }

  function closeYubiKeyDialog(): void {
    if (yubiKeySubmitting) return;
    setYubiKeyDialogOpen(false);
    setYubiKeyMasterPassword('');
    setYubiKeyKeys(EMPTY_YUBIKEY_KEYS);
    setYubiKeyStoredKeys(EMPTY_YUBIKEY_KEYS);
    setYubiKeyNfc(false);
    setYubiKeyYubicoConfigured(false);
    setYubiKeyYubicoCanManage(false);
    setYubiKeyYubicoClientId('');
    setYubiKeyYubicoSecretKey('');
    setYubiKeyBootstrapOtp('');
    setYubiKeyConfigOpen(false);
  }

  function updateYubiKey(index: number, value: string): void {
    setYubiKeyKeys((current) => {
      const next = [...current] as [string, string, string, string, string];
      next[index] = value;
      return next;
    });
  }

  async function saveYubiKeyDialog(): Promise<void> {
    if (yubiKeySubmitting) return;
    setYubiKeySubmitting(true);
    try {
      const settings = await props.onSaveYubiKeySettings(yubiKeyKeys.map((value) => value.trim()), yubiKeyNfc, yubiKeyMasterPassword);
      applyYubiKeySettings(settings);
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_yubikey_update_failed'));
    } finally {
      setYubiKeySubmitting(false);
    }
  }

  async function bootstrapYubiKeyConfigDialog(): Promise<void> {
    if (yubiKeySubmitting || !yubiKeyBootstrapOtp.trim()) return;
    const bootstrapOtp = yubiKeyBootstrapOtp.trim().toLowerCase();
    setYubiKeySubmitting(true);
    try {
      const settings = await props.onBootstrapYubiKeyApiCredentials(bootstrapOtp, yubiKeyMasterPassword);
      applyYubiKeySettings(settings);
      setYubiKeyKeys(settings.keys);
      setYubiKeyBootstrapOtp('');
      setYubiKeyConfigOpen(false);
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_yubikey_auto_config_failed'));
    } finally {
      setYubiKeySubmitting(false);
    }
  }

  async function saveYubiKeyConfigDialog(): Promise<void> {
    if (yubiKeySubmitting || !yubiKeyYubicoClientId.trim()) return;
    setYubiKeySubmitting(true);
    try {
      const settings = await props.onSaveYubiKeyApiCredentials(yubiKeyYubicoClientId.trim(), yubiKeyYubicoSecretKey.trim(), yubiKeyMasterPassword);
      applyYubiKeySettings(settings);
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_yubikey_config_update_failed'));
    } finally {
      setYubiKeySubmitting(false);
    }
  }

  async function disableYubiKeyDialog(): Promise<void> {
    if (yubiKeySubmitting || !yubiKeyMasterPassword) return;
    setYubiKeySubmitting(true);
    try {
      await props.onDisableYubiKey(yubiKeyMasterPassword);
      setYubiKeyEnabled(false);
      setYubiKeyKeys(EMPTY_YUBIKEY_KEYS);
      setYubiKeyStoredKeys(EMPTY_YUBIKEY_KEYS);
      setYubiKeyNfc(false);
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_disable_yubikey_failed'));
    } finally {
      setYubiKeySubmitting(false);
    }
  }

  function applyTwoFactorPasskeySettings(settings: TwoFactorPasskeySettings): void {
    setTwoFactorPasskeyEnabled(settings.enabled);
    setTwoFactorPasskeys(settings.keys);
  }

  function closeTwoFactorPasskeyDialog(): void {
    if (twoFactorPasskeySubmitting) return;
    setTwoFactorPasskeyDialogOpen(false);
    setTwoFactorPasskeyMasterPassword('');
    setTwoFactorPasskeyName(t('txt_passkey'));
  }

  async function createTwoFactorPasskeyDialog(): Promise<void> {
    if (twoFactorPasskeySubmitting || !twoFactorPasskeyMasterPassword) return;
    setTwoFactorPasskeySubmitting(true);
    try {
      const settings = await props.onCreateTwoFactorPasskey(twoFactorPasskeyName, twoFactorPasskeyMasterPassword);
      applyTwoFactorPasskeySettings(settings);
      setTwoFactorPasskeyName(t('txt_passkey'));
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_passkey_setup_failed'));
    } finally {
      setTwoFactorPasskeySubmitting(false);
    }
  }

  async function deleteTwoFactorPasskeyDialog(id: number): Promise<void> {
    if (twoFactorPasskeySubmitting || !twoFactorPasskeyMasterPassword || twoFactorPasskeys.length < 2) return;
    setTwoFactorPasskeySubmitting(true);
    try {
      applyTwoFactorPasskeySettings(await props.onDeleteTwoFactorPasskey(id, twoFactorPasskeyMasterPassword));
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_delete_item_failed'));
    } finally {
      setTwoFactorPasskeySubmitting(false);
    }
  }

  async function disableTwoFactorPasskeysDialog(): Promise<void> {
    if (twoFactorPasskeySubmitting || !twoFactorPasskeyMasterPassword || !twoFactorPasskeyEnabled) return;
    setTwoFactorPasskeySubmitting(true);
    try {
      await props.onDisableTwoFactorPasskeys(twoFactorPasskeyMasterPassword);
      applyTwoFactorPasskeySettings({ enabled: false, keys: [] });
      setTwoFactorPasskeyDialogOpen(false);
      setTwoFactorPasskeyMasterPassword('');
      setTwoFactorPasskeyName(t('txt_passkey'));
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_disable_passkey_two_step_failed'));
    } finally {
      setTwoFactorPasskeySubmitting(false);
    }
  }

  async function refreshTwoFactorStatus(): Promise<void> {
    if (twoFactorStatusRefreshing) return;
    setTwoFactorStatusRefreshing(true);
    try {
      await props.onRefreshTwoFactorStatus();
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_load_failed'));
    } finally {
      setTwoFactorStatusRefreshing(false);
    }
  }

  async function enableTotpFromManageDialog(): Promise<void> {
    if (totpLocked) return;
    if (!secret.trim() || !token.trim()) {
      props.onNotify?.('error', t('txt_secret_and_code_are_required'));
      return;
    }
    try {
      await props.onEnableTotp(secret, token, totpManagePassword);
      setTotpLocked(true);
      // 刚启用的这一把就是服务端现在的真值，必须同时标记为「已拿到真值」。
      // 否则弹窗（刻意保持打开，方便用户立刻验证）会因为 totpLocked && !totpRealSecret
      // 而误判成「状态不一致」并隐藏密钥 —— 关闭再重开反而正常，就是这个原因。
      setTotpRealSecret(secret);
      // 与「关闭后重开」保持一致：重开时 token 是空的，这里也清掉，
      // 免得把刚刚被服务端消费掉的那个码留在输入框里继续点「验证 TOTP」。
      setToken('');
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_enable_totp_failed'));
    }
  }

  /**
   * 验证输入的验证码是否与**服务端保存的密钥**一致。
   *
   * 刻意在本地计算比对（`calcTotpNow`），而不是打服务端：服务端的校验会**消费防重放计数**
   * （同一个码在一个 30 秒窗口内只能用一次），失败还会计入登录失败次数 —— 连续 10 次会把 IP 锁 2 分钟。
   * 这里只想帮用户确认「手机上的验证器与库里那把是否一致」，不该产生那些副作用。
   */
  async function verifyTotpFromManageDialog(): Promise<void> {
    const entered = token.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(entered)) {
      props.onNotify?.('error', t('txt_totp_verify_failed'));
      return;
    }
    if (!totpRealSecret) {
      props.onNotify?.('error', t('txt_load_failed'));
      return;
    }
    // 与服务端一致：接受当前时间窗 ±1 步（允偏轻微时钟漂移）
    for (const offsetSteps of [-1, 0, 1]) {
      const result = await calcTotpNow(totpRealSecret, Date.now() + offsetSteps * 30_000);
      if (result?.code === entered) {
        props.onNotify?.('success', t('txt_totp_verify_success'));
        return;
      }
    }
    props.onNotify?.('error', t('txt_totp_verify_failed'));
  }

  function closeCreatePasskeyDialog(): void {
    setCreatePasskeyDialogOpen(false);
    setCreatePasskeyMasterPassword('');
    setAccountPasskeyName(t('txt_account_passkey'));
    setAccountPasskeyDirectUnlock(true);
  }

  async function submitCreatePasskeyDialog(): Promise<void> {
    if (!createPasskeyMasterPassword || masterPasswordPromptSubmitting) return;
    setMasterPasswordPromptSubmitting(true);
    try {
      const credential = await props.onCreateAccountPasskey(accountPasskeyName, createPasskeyMasterPassword, accountPasskeyDirectUnlock);
      if (credential) await refreshAccountPasskeys();
      closeCreatePasskeyDialog();
    } catch (error) {
      props.onNotify?.('error', error instanceof Error ? error.message : t('txt_account_passkeys_load_failed'));
    } finally {
      setMasterPasswordPromptSubmitting(false);
    }
  }

  const settingsSections: Array<{ id: SettingsSection; label: string }> = [
    { id: 'appearance', label: t('txt_settings_appearance') },
    { id: 'session', label: t('txt_session_timeout') },
    { id: 'masterPassword', label: t('txt_master_password') },
    { id: 'twoStep', label: t('txt_two_step_login') },
    { id: 'keys', label: t('txt_keys') },
    // 邮件发送是服务器级配置，只有管理员能改，因此仅对管理员显示
    ...(isAdmin ? [{ id: 'mail' as SettingsSection, label: t('txt_mail') }] : []),
  ];

  return (
    <div className="settings-page-categorized">
      <div className="settings-category-layout">
        <nav className="settings-category-tabs" aria-label={t('nav_account_settings')}>
          {settingsSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`settings-category-tab ${activeSection === section.id ? 'active' : ''}`}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <section className="settings-category-panel">
          {activeSection === 'appearance' && (
            <div className="settings-section-stack">
              <section className="settings-submodule">
                <label className="field">
                  <span>{t('txt_theme')}</span>
                  <select
                    className="input"
                    value={props.themePreference}
                    onInput={(e) => props.onThemePreferenceChange((e.currentTarget as HTMLSelectElement).value as ThemePreference)}
                  >
                    <option value="system">{t('txt_use_system_theme')}</option>
                    <option value="light">{t('txt_light_theme')}</option>
                    <option value="dark">{t('txt_dark_theme')}</option>
                  </select>
                  <div className="field-help">{t('txt_theme_saved_locally')}</div>
                </label>
              </section>

              <section className="settings-submodule">
                <label className="field">
                  <span>{t('txt_display_language')}</span>
                  <select
                    className="input"
                    value={selectedLocale}
                    onInput={(e) => void changeLocale((e.currentTarget as HTMLSelectElement).value as Locale)}
                  >
                    {AVAILABLE_LOCALES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="field-help">{t('txt_display_language_help')}</div>
                </label>
              </section>
            </div>
          )}

          {activeSection === 'session' && (
            <div className="settings-section-stack">
              <section className="settings-submodule">
                <div className="session-timeout-fields">
                  <label className="field">
                    <span>{t('txt_timeout_time')}</span>
                    <select
                      className="input"
                      value={String(props.lockTimeoutMinutes)}
                      onInput={(e) => props.onLockTimeoutChange(Number((e.currentTarget as HTMLSelectElement).value) as 0 | 1 | 5 | 15 | 30)}
                    >
                      {LOCK_TIMEOUT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t('txt_timeout_action')}</span>
                    <select
                      className="input"
                      value={props.sessionTimeoutAction}
                      onInput={(e) => props.onSessionTimeoutActionChange((e.currentTarget as HTMLSelectElement).value === 'logout' ? 'logout' : 'lock')}
                    >
                      <option value="logout">{t('txt_timeout_action_logout')}</option>
                      <option value="lock">{t('txt_timeout_action_lock')}</option>
                    </select>
                  </label>
                </div>
              </section>
            </div>
          )}

          {activeSection === 'masterPassword' && (
            <div className="settings-section-stack">
              <section className="settings-submodule">
                <h3>{t('txt_change_master_password')}</h3>
                <label className="field">
                  <span>{t('txt_current_password')}</span>
                  <input
                    className="input"
                    type="password"
                    value={currentPassword}
                    onInput={(e) => setCurrentPassword((e.currentTarget as HTMLInputElement).value)}
                  />
                </label>
                <div className="settings-vertical-fields">
                  <label className="field">
                    <span>{t('txt_new_password')}</span>
                    <input className="input" type="password" value={newPassword} onInput={(e) => setNewPassword((e.currentTarget as HTMLInputElement).value)} />
                  </label>
                  <label className="field">
                    <span>{t('txt_confirm_password')}</span>
                    <input className="input" type="password" value={newPassword2} onInput={(e) => setNewPassword2((e.currentTarget as HTMLInputElement).value)} />
                  </label>
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => void props.onChangePassword(currentPassword, newPassword, newPassword2)}
                >
                  <KeyRound size={14} className="btn-icon" />
                  {t('txt_change_password')}
                </button>
              </section>

              <section className="settings-submodule">
                <label className="field">
                  <span>{t('txt_password_hint_optional')}</span>
                  <input
                    className="input"
                    maxLength={120}
                    value={passwordHint}
                    placeholder={t('txt_password_hint_placeholder')}
                    onInput={(e) => setPasswordHint((e.currentTarget as HTMLInputElement).value)}
                  />
                  <div className="field-help">{t('txt_password_hint_register_help')}</div>
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void props.onSavePasswordHint(passwordHint)}
                >
                  {t('txt_save')}
                </button>
              </section>

              <section className="settings-submodule account-passkeys-module">
                <div className="settings-module-head">
                  <h3>{t('txt_account_passkeys')}</h3>
                  <button
                    type="button"
                    className="btn btn-secondary small"
                    disabled={accountPasskeysLoading}
                    title={t('txt_refresh')}
                    aria-label={t('txt_refresh')}
                    onClick={() => void refreshAccountPasskeys()}
                  >
                    <RefreshCw size={14} className="btn-icon" />
                    {t('txt_refresh')}
                  </button>
                </div>
                <p className="muted-inline settings-field-note">{t('txt_account_passkey_login_only_help')}</p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={masterPasswordPromptSubmitting}
                    onClick={() => openMasterPasswordPrompt('createPasskey')}
                  >
                    <KeyRound size={14} className="btn-icon" />
                    {t('txt_add_account_passkey')}
                  </button>
                </div>
                <div className="account-passkeys-list">
                  {accountPasskeysLoading ? (
                    <div className="settings-module-placeholder">
                      <RefreshCw size={20} />
                      <span>{t('txt_loading')}</span>
                    </div>
                  ) : accountPasskeys.length === 0 ? (
                    <div className="settings-module-placeholder">
                      <KeyRound size={20} />
                      <span>{t('txt_no_account_passkeys')}</span>
                    </div>
                  ) : (
                    accountPasskeys.map((credential) => (
                      <div key={credential.id} className="account-passkey-row">
                        <div className="account-passkey-main">
                          <strong>{credential.name || t('txt_account_passkey')}</strong>
                          <small>{t('txt_created_value', { value: formatDateTime(credential.creationDate) })}</small>
                        </div>
                        <span className={`account-passkey-status account-passkey-status-${credential.prfStatus}`}>
                          {accountPasskeyStatusText(credential)}
                        </span>
                        <div className="actions account-passkey-actions">
                          {credential.prfStatus === 1 && (
                            <button
                              type="button"
                              className="btn btn-secondary small"
                              disabled={masterPasswordPromptSubmitting}
                              onClick={() => openMasterPasswordPrompt('enablePasskeyDirectUnlock', credential.id)}
                            >
                              <ShieldCheck size={14} className="btn-icon" />
                              {t('txt_enable_passkey_direct_unlock')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-danger small"
                            disabled={masterPasswordPromptSubmitting}
                            onClick={() => openMasterPasswordPrompt('deletePasskey', credential.id)}
                          >
                            <Trash2 size={14} className="btn-icon" />
                            {t('txt_delete')}
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}

          {activeSection === 'twoStep' && (
            <div className="settings-section-stack">
              <section className="settings-submodule two-step-recovery-warning">
                <div className="two-step-warning-head">
                  <ShieldOff size={16} aria-hidden="true" />
                  <strong>{t('txt_warning')}</strong>
                </div>
                <p>{t('txt_two_step_recovery_code_warning')}</p>
                <button type="button" className="btn btn-danger" onClick={() => openMasterPasswordPrompt('recovery')}>
                  {t('txt_view_recovery_code')}
                </button>
              </section>

              <section className="settings-submodule two-step-providers-module">
                <div className="settings-module-head">
                  <h3>{t('txt_providers')}</h3>
                  <button
                    type="button"
                    className="btn btn-secondary small"
                    disabled={twoFactorStatusRefreshing}
                    onClick={() => void refreshTwoFactorStatus()}
                  >
                    <RefreshCw size={14} className="btn-icon" />
                    {t('txt_refresh_status')}
                  </button>
                </div>
                <div className="two-step-provider-list">
                  <div className="two-step-provider-row">
                    <div className="two-step-provider-icon">
                      <ShieldCheck size={28} />
                    </div>
                    <div className="two-step-provider-copy">
                      <div className="two-step-provider-title">
                        <strong>{t('txt_authenticator_app')}</strong>
                        {totpLocked && <span className="two-step-enabled-badge">{t('txt_enabled')}</span>}
                      </div>
                      <span>{t('txt_authenticator_app_help')}</span>
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={() => openMasterPasswordPrompt('manageTotp')}>
                      {t('txt_manage')}
                    </button>
                  </div>

                  <div className="two-step-provider-row">
                    <div className="two-step-provider-icon">
                      <KeyRound size={28} />
                    </div>
                    <div className="two-step-provider-copy">
                      <div className="two-step-provider-title">
                        <strong>{t('txt_passkeys')}</strong>
                        {twoFactorPasskeyEnabled && <span className="two-step-enabled-badge">{t('txt_enabled')}</span>}
                      </div>
                      <span>{t('txt_passkey_provider_help')}</span>
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={() => openMasterPasswordPrompt('managePasskey2fa')}>
                      {t('txt_manage')}
                    </button>
                  </div>

                  <div className="two-step-provider-row">
                    <div className="two-step-provider-icon two-step-provider-yubico">yubico</div>
                    <div className="two-step-provider-copy">
                      <div className="two-step-provider-title">
                        <strong>{t('txt_yubico_otp_security_key')}</strong>
                        {yubiKeyEnabled && <span className="two-step-enabled-badge">{t('txt_enabled')}</span>}
                      </div>
                      <span>{t('txt_yubico_otp_security_key_help')}</span>
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={() => openMasterPasswordPrompt('manageYubiKey')}>
                      {t('txt_manage')}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          )}

          {activeSection === 'keys' && (
            <div className="settings-section-stack">
              <section className="settings-submodule sensitive-action">
                <div>
                  <h3>{t('txt_api_key')}</h3>
                  <p className="muted-inline settings-field-note">{t('txt_api_key_dialog_intro')}</p>
                </div>
                <div className="actions">
                  <button type="button" className="btn btn-secondary" onClick={() => openMasterPasswordPrompt('apiKey')}>
                    <KeyRound size={14} className="btn-icon" />
                    {t('txt_view_api_key')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setRotateApiKeyConfirmOpen(true)}
                  >
                    <RefreshCw size={14} className="btn-icon" />
                    {t('txt_rotate_api_key')}
                  </button>
                </div>
              </section>
            </div>
          )}

          {activeSection === 'mail' && (
            <div className="settings-section-stack">
              <section className="settings-submodule">
                <div className="settings-module-head">
                  <h3>{t('txt_mail_config')}</h3>
                  {mailConfigured ? (
                    <span className="two-step-enabled-badge">{t('txt_mail_configured')}</span>
                  ) : (
                    <span className="two-step-enabled-badge is-danger">{t('txt_mail_not_configured')}</span>
                  )}
                </div>
                <p className="muted-inline settings-field-note">{t('txt_mail_sending_intro')}</p>
                <div className="settings-vertical-fields">
                  <label className="field">
                    <span>{t('txt_mail_host')}</span>
                    <input
                      className="input"
                      value={mailHost}
                      placeholder="smtp.example.com"
                      onInput={(event) => {
                        setMailHost((event.currentTarget as HTMLInputElement).value);
                        touchMailForm();
                      }}
                    />
                  </label>

                  <label className="field">
                    <span>{t('txt_mail_port')}</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={65535}
                      value={mailPort}
                      onInput={(event) => {
                        setMailPort((event.currentTarget as HTMLInputElement).value);
                        touchMailForm();
                      }}
                    />
                    <div className="field-help">
                      {t('txt_mail_encryption_inferred', {
                        mode:
                          mailEncryption === 'implicit'
                            ? t('txt_mail_encryption_implicit')
                            : t('txt_mail_encryption_starttls'),
                      })}
                    </div>
                  </label>

                  <label className="field">
                    <span>{t('txt_mail_username')}</span>
                    <input
                      className="input"
                      value={mailUsername}
                      onInput={(event) => {
                        setMailUsername((event.currentTarget as HTMLInputElement).value);
                        touchMailForm();
                      }}
                    />
                  </label>

                  <label className="field">
                    <span>{t('txt_mail_password')}</span>
                    <input
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      value={mailPassword}
                      placeholder={mailSettings?.passwordConfigured ? t('txt_mail_password_keep') : ''}
                      onInput={(event) => {
                        setMailPassword((event.currentTarget as HTMLInputElement).value);
                        touchMailForm();
                      }}
                    />
                  </label>

                  <label className="field">
                    <span>{t('txt_mail_from_address')}</span>
                    <input
                      className="input"
                      value={mailFromAddress}
                      placeholder="noreply@example.com"
                      onInput={(event) => {
                        setMailFromAddress((event.currentTarget as HTMLInputElement).value);
                        touchMailForm();
                      }}
                    />
                  </label>

                  <label className="field">
                    <span>{t('txt_mail_from_name')}</span>
                    <input
                      className="input"
                      value={mailFromName}
                      onInput={(event) => {
                        setMailFromName((event.currentTarget as HTMLInputElement).value);
                        touchMailForm();
                      }}
                    />
                  </label>

                  <label className="field">
                    <span>{t('txt_mail_locale')}</span>
                    <select
                      className="input"
                      value={mailLocale}
                      onInput={(event) => {
                        setMailLocale((event.currentTarget as HTMLSelectElement).value);
                        touchMailForm();
                      }}
                    >
                      {AVAILABLE_LOCALES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="field-help">{t('txt_mail_locale_help')}</div>
                  </label>

                  <label className="field">
                    <span>{t('txt_mail_timezone')}</span>
                    <select
                      className="input"
                      value={mailTimezone}
                      onInput={(event) => {
                        setMailTimezone((event.currentTarget as HTMLSelectElement).value);
                        touchMailForm();
                      }}
                    >
                      {timezoneOptions.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone}
                        </option>
                      ))}
                    </select>
                    <div className="field-help">{t('txt_mail_timezone_help')}</div>
                  </label>

                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!mailCanSave}
                      onClick={() => setMailPromptAction('save')}
                    >
                      {t('txt_save')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!mailCanTest}
                      onClick={() => void submitMailTest()}
                    >
                      <Send size={14} className="btn-icon" />
                      {t('txt_mail_send_test')}
                    </button>
                    {mailEnabled && (
                      <button
                        type="button"
                        className="btn btn-danger push-right"
                        disabled={mailSubmitting}
                        onClick={() => setMailPromptAction('disable')}
                      >
                        {t('txt_mail_disable')}
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={mailPromptAction !== null}
        title={mailPromptAction === 'disable' ? t('txt_mail_disable') : t('txt_mail_save_title')}
        message={t('txt_enter_master_password_to_continue')}
        hideConfirm
        hideCancel
        closeButton
        onConfirm={() => undefined}
        onCancel={closeMailPrompt}
        afterActions={
          <div className="settings-vertical-fields">
            <label className="field">
              <span>{t('txt_master_password')}</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={mailMasterPassword}
                onInput={(event) =>
                  setMailMasterPassword((event.currentTarget as HTMLInputElement).value)
                }
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className={mailPromptAction === 'disable' ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={mailSubmitting || !mailMasterPassword}
                onClick={() => void submitMailPrompt()}
              >
                {mailPromptAction === 'disable' ? t('txt_mail_disable') : t('txt_save')}
              </button>
            </div>
          </div>
        }
      />
      <ConfirmDialog
        open={masterPasswordPrompt !== null}
        title={masterPasswordPromptTitle}
        message={t('txt_enter_master_password_to_continue')}
        confirmText={t('txt_continue')}
        cancelText={t('txt_cancel')}
        confirmDisabled={masterPasswordPromptSubmitting || !masterPasswordPromptValue.trim()}
        cancelDisabled={masterPasswordPromptSubmitting}
        onConfirm={() => void submitMasterPasswordPrompt()}
        onCancel={closeMasterPasswordPrompt}
      >
        <label className="field">
          <span>{t('txt_master_password')}</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={masterPasswordPromptValue}
            onInput={(e) => setMasterPasswordPromptValue((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={totpManageDialogOpen}
        title={t('txt_totp')}
        message={totpLocked ? t('txt_totp_enabled') : t('txt_totp_manage_intro')}
        hideCancel
        hideConfirm
        closeButton
        onConfirm={() => {}}
        onCancel={closeTotpManageDialog}
      >
        <div className="totp-manage-dialog-body">
          <div className="totp-grid">
            {totpSecretUnavailable ? (
              <p className="muted-inline settings-field-note">{t('txt_totp_secret_unavailable')}</p>
            ) : (
              <div className="totp-qr">
                <img src={qrDataUrl} alt="TOTP QR" />
              </div>
            )}
            <div>
              <label className="field">
                <span>{t('txt_authenticator_key')}</span>
                <div className="totp-secret-input-wrap">
                  <input className="input totp-secret-input" aria-label={t('txt_authenticator_key')} value={totpSecretUnavailable ? '' : secret} disabled={totpLocked} onInput={(e) => setSecret((e.currentTarget as HTMLInputElement).value.toUpperCase())} />
                  <div className="totp-secret-actions">
                    <button
                      type="button"
                      className="btn btn-secondary small totp-secret-icon-btn"
                      disabled={totpLocked}
                      title={t('txt_regenerate')}
                      aria-label={t('txt_regenerate')}
                      onClick={() => setSecret(randomBase32Secret(32))}
                    >
                      <RefreshCw size={14} className="btn-icon" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary small totp-secret-icon-btn"
                      disabled={totpLocked && !totpRealSecret}
                      title={t('txt_copy_secret')}
                      aria-label={t('txt_copy_secret')}
                      onClick={() => {
                        void copyTextToClipboard(secret, { successMessage: t('txt_secret_copied') });
                      }}
                    >
                      <Clipboard size={14} className="btn-icon" />
                    </button>
                  </div>
                </div>
              </label>
              <label className="field">
                <span>{t('txt_verification_code')}</span>
                <input
                  className="input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={token}
                  onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <div className="actions">
                {totpLocked ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        closeTotpManageDialog();
                        props.onOpenDisableTotp();
                      }}
                    >
                      <ShieldOff size={14} className="btn-icon" />
                      {t('txt_disable_totp')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!token.trim() || !totpRealSecret}
                      onClick={() => void verifyTotpFromManageDialog()}
                    >
                      <ShieldCheck size={14} className="btn-icon" />
                      {t('txt_verify_totp')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary" disabled={!totpManagePassword} onClick={() => void enableTotpFromManageDialog()}>
                    <ShieldCheck size={14} className="btn-icon" />
                    {t('txt_enable_totp')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={yubiKeyDialogOpen}
        title={`${t('txt_two_step_login')} YubiKey`}
        message={!yubiKeyYubicoConfigured ? '' : yubiKeyEnabled ? t('txt_yubikey_enabled') : t('txt_disabled')}
        hideConfirm
        hideCancel
        closeButton
        onConfirm={() => {
          if (yubiKeySubmitting) return;
          if (yubiKeyYubicoConfigured) {
            void saveYubiKeyDialog();
          } else {
            void bootstrapYubiKeyConfigDialog();
          }
        }}
        onCancel={closeYubiKeyDialog}
        afterActions={(
          <>
            {yubiKeyYubicoConfigured && (
              <button type="button" className="btn btn-primary dialog-btn" disabled={yubiKeySubmitting} onClick={() => void saveYubiKeyDialog()}>
                {t('txt_save')}
              </button>
            )}
            {yubiKeyEnabled && (
              <button type="button" className="btn btn-secondary dialog-btn" disabled={yubiKeySubmitting} onClick={() => void disableYubiKeyDialog()}>
                {t('txt_disable_all_keys')}
              </button>
            )}
          </>
        )}
      >
        <div className="yubikey-manage-dialog-body">
          {!yubiKeyYubicoConfigured && (
            <section className="settings-submodule yubikey-config-panel">
              <h3>{t('txt_yubikey_config_required')}</h3>
              <p className="muted-inline settings-field-note">{t('txt_yubikey_config_required_help')}</p>
              <label className="field">
                <span>{t('txt_otp_from_yubikey')}</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  inputMode="verbatim"
                  spellcheck={false}
                  value={yubiKeyBootstrapOtp}
                  onInput={(e) => setYubiKeyBootstrapOtp(normalizeYubiKeyFieldValue((e.currentTarget as HTMLInputElement).value))}
                />
              </label>
              <button type="button" className="btn btn-primary" disabled={yubiKeySubmitting || !yubiKeyBootstrapOtp.trim()} onClick={() => void bootstrapYubiKeyConfigDialog()}>
                {t('txt_yubikey_auto_configure')}
              </button>
            </section>
          )}

          {yubiKeyYubicoConfigured && yubiKeyYubicoCanManage && (
              <section className="settings-submodule yubikey-config-panel">
                <div className="settings-module-head">
                  <h3>{t('txt_yubikey_validation_credentials')}</h3>
                  <button type="button" className="btn btn-secondary small" onClick={() => setYubiKeyConfigOpen((open) => !open)}>
                    {yubiKeyConfigOpen ? t('txt_hide') : t('txt_view')}
                  </button>
                </div>
                {yubiKeyConfigOpen && (
                  <div className="settings-vertical-fields">
                    <label className="field">
                      <span>Client ID</span>
                      <input className="input" value={yubiKeyYubicoClientId} onInput={(e) => setYubiKeyYubicoClientId((e.currentTarget as HTMLInputElement).value)} />
                    </label>
                    <label className="field">
                      <span>Secret key</span>
                      <input className="input" value={yubiKeyYubicoSecretKey} onInput={(e) => setYubiKeyYubicoSecretKey((e.currentTarget as HTMLInputElement).value)} />
                    </label>
                    <label className="field">
                      <span>{t('txt_otp_from_yubikey')}</span>
                      <input
                        className="input"
                        type="password"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        inputMode="verbatim"
                        spellcheck={false}
                        value={yubiKeyBootstrapOtp}
                        onInput={(e) => setYubiKeyBootstrapOtp(normalizeYubiKeyFieldValue((e.currentTarget as HTMLInputElement).value))}
                      />
                      <div className="field-help">{t('txt_yubikey_reconfigure_help')}</div>
                    </label>
                    <div className="actions">
                      <button type="button" className="btn btn-secondary" disabled={yubiKeySubmitting || !yubiKeyYubicoClientId.trim()} onClick={() => void saveYubiKeyConfigDialog()}>
                        {t('txt_save')}
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={yubiKeySubmitting || !yubiKeyBootstrapOtp.trim()} onClick={() => void bootstrapYubiKeyConfigDialog()}>
                        {t('txt_yubikey_auto_configure_again')}
                      </button>
                    </div>
                  </div>
                )}
              </section>
          )}

          {yubiKeyYubicoConfigured && (
            <>
              <ol className="settings-plain-steps">
                <li>{t('txt_yubikey_plug_in')}</li>
                <li>{t('txt_yubikey_select_empty_field')}</li>
                <li>{t('txt_yubikey_touch_button')}</li>
              </ol>
              <div className="settings-vertical-fields">
                {yubiKeyKeys.map((keyValue, index) => (
                  <label className="field" key={index}>
                    <span>{t('txt_yubikey_x').replace('{index}', String(index + 1))}</span>
                    <div className="yubikey-input-row">
                      {yubiKeyStoredKeys[index] && keyValue === yubiKeyStoredKeys[index] ? (
                        <span className="yubikey-stored-key">{formatStoredYubiKey(keyValue)}</span>
                      ) : (
                        <input
                          className="input"
                          type="password"
                          autoComplete="off"
                          autoCapitalize="none"
                          autoCorrect="off"
                          inputMode="verbatim"
                          spellcheck={false}
                          value={keyValue}
                          onInput={(e) => updateYubiKey(index, normalizeYubiKeyFieldValue((e.currentTarget as HTMLInputElement).value))}
                        />
                      )}
                      {keyValue && (
                        <button
                          type="button"
                          className="btn btn-danger small yubikey-remove-btn"
                          title={t('txt_remove')}
                          aria-label={t('txt_remove')}
                          onClick={() => updateYubiKey(index, '')}
                        >
                          <Trash2 size={14} className="btn-icon" />
                        </button>
                      )}
                    </div>
                  </label>
                ))}
              </div>
              <div className="settings-checkbox-block">
                <strong>{t('txt_nfc_support')}</strong>
                <label className="checkbox-inline">
                  <input type="checkbox" checked={yubiKeyNfc} onInput={(e) => setYubiKeyNfc((e.currentTarget as HTMLInputElement).checked)} />
                  <span>{t('txt_yubikey_supports_nfc')}</span>
                </label>
                {t('txt_yubikey_supports_nfc_desc') && <div className="field-help">{t('txt_yubikey_supports_nfc_desc')}</div>}
              </div>
            </>
          )}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={twoFactorPasskeyDialogOpen}
        title={t('txt_two_step_passkeys')}
        message={t('txt_two_step_passkeys_help')}
        hideConfirm
        hideCancel
        closeButton
        cancelDisabled={twoFactorPasskeySubmitting}
        onConfirm={() => {}}
        onCancel={closeTwoFactorPasskeyDialog}
      >
        <div className="settings-vertical-fields">
          <div className="field">
            <label htmlFor="two-factor-passkey-name">{t('txt_passkey_name')}</label>
            <div className="two-factor-passkey-register-row">
              <input
                id="two-factor-passkey-name"
                className="input"
                maxLength={128}
                value={twoFactorPasskeyName}
                placeholder={t('txt_two_step_passkey_name_placeholder')}
                onInput={(e) => setTwoFactorPasskeyName((e.currentTarget as HTMLInputElement).value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={twoFactorPasskeySubmitting}
                onClick={() => void createTwoFactorPasskeyDialog()}
              >
                <KeyRound size={14} className="btn-icon" />
                {t('txt_register')}
              </button>
            </div>
          </div>

          <div className="two-factor-passkey-list-block">
            <div className="settings-list-label">{t('txt_key_list')}</div>
            {twoFactorPasskeys.length > 0 ? (
              <div className="account-passkey-list">
                {twoFactorPasskeys.map((credential, index) => (
                  <div key={credential.id} className="account-passkey-row two-factor-passkey-row">
                    <span className="account-passkey-index">{index + 1}</span>
                    <div className="account-passkey-main">
                      <strong>{credential.name || t('txt_dash')}</strong>
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger small"
                      disabled={twoFactorPasskeySubmitting || twoFactorPasskeys.length < 2}
                      title={twoFactorPasskeys.length < 2 ? t('txt_remove_last_passkey_hint') : t('txt_delete')}
                      onClick={() => void deleteTwoFactorPasskeyDialog(credential.id)}
                    >
                      <Trash2 size={14} className="btn-icon" />
                      {t('txt_delete')}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted-inline settings-field-note">{t('txt_no_two_step_passkeys')}</p>
            )}
          </div>

          <div className="actions two-factor-passkey-danger-actions">
            {twoFactorPasskeyEnabled && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={twoFactorPasskeySubmitting}
                onClick={() => void disableTwoFactorPasskeysDialog()}
              >
                {t('txt_disable_all_keys')}
              </button>
            )}
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={recoveryCodeDialogOpen}
        title={`${t('txt_two_step_login')} ${t('txt_recovery_code')}`}
        message={t('txt_your_two_step_recovery_code')}
        hideConfirm
        hideCancel
        closeButton
        onConfirm={() => {}}
        onCancel={() => setRecoveryCodeDialogOpen(false)}
        afterActions={(
          <button
            type="button"
            className="btn btn-primary dialog-btn"
            disabled={!recoveryCode}
            onClick={() => {
              void copyTextToClipboard(recoveryCode, { successMessage: t('txt_recovery_code_copied') });
            }}
          >
            <Clipboard size={14} className="btn-icon" />
            {t('txt_copy_code')}
          </button>
        )}
      >
        <div className="two-step-recovery-code-dialog-value">{recoveryCode}</div>
      </ConfirmDialog>
      <ConfirmDialog
        open={createPasskeyDialogOpen}
        title={t('txt_add_account_passkey')}
        message={t('txt_name_account_passkey_after_verification')}
        confirmText={t('txt_save')}
        cancelText={t('txt_cancel')}
        confirmDisabled={masterPasswordPromptSubmitting}
        cancelDisabled={masterPasswordPromptSubmitting}
        onConfirm={() => void submitCreatePasskeyDialog()}
        onCancel={closeCreatePasskeyDialog}
      >
        <label className="field">
          <span>{t('txt_passkey_name')}</span>
          <input
            className="input"
            maxLength={128}
            value={accountPasskeyName}
            placeholder={t('txt_account_passkey_name_placeholder')}
            onInput={(e) => setAccountPasskeyName((e.currentTarget as HTMLInputElement).value)}
          />
          <div className="field-help">{t('txt_account_passkey_name_help')}</div>
        </label>
        <div className="field account-passkey-mode-field">
          <span>{t('txt_account_passkey_mode')}</span>
          <label className="account-passkey-toggle">
            <input
              type="checkbox"
              checked={accountPasskeyDirectUnlock}
              onInput={(e) => setAccountPasskeyDirectUnlock((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>{t('txt_account_passkey_direct_unlock_mode')}</span>
          </label>
          <div className="field-help">
            {accountPasskeyDirectUnlock ? t('txt_account_passkey_direct_unlock_help') : t('txt_account_passkey_login_only_help')}
          </div>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={apiKeyDialogOpen}
        title={t('txt_api_key')}
        message={t('txt_api_key_dialog_intro')}
        hideCancel
        confirmText={t('txt_close')}
        onConfirm={() => setApiKeyDialogOpen(false)}
        onCancel={() => setApiKeyDialogOpen(false)}
      >
        <div className="api-key-warning-panel">
          <div className="api-key-warning-title">{t('txt_warning')}</div>
          <div className="api-key-warning-body">{t('txt_api_key_warning_body')}</div>
        </div>

        <div className="api-key-credentials-panel">
          <div className="api-key-credentials-title">
            <KeyRound size={15} />
            <span>{t('txt_oauth_client_credentials')}</span>
          </div>
          {([
            [t('txt_client_id'), `user.${props.profile.id}`],
            [t('txt_client_secret'), apiKey],
            [t('txt_scope'), 'api'],
            [t('txt_grant_type'), 'client_credentials'],
          ] as [string, string][]).map(([label, value]) => (
            <label key={label} className="field">
              <span>{label}</span>
              <div className="api-key-credential-row">
                <input className="input" readOnly value={value} onFocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
                <button
                  type="button"
                  className="btn btn-secondary small"
                  onClick={() => void copyTextToClipboard(value, { successMessage: t('txt_copied') })}
                >
                  <Clipboard size={14} className="btn-icon" />
                  {t('txt_copy')}
                </button>
              </div>
            </label>
          ))}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={rotateApiKeyConfirmOpen}
        title={t('txt_rotate_api_key')}
        message={t('txt_rotate_api_key_confirm')}
        danger
        onConfirm={() => {
          setRotateApiKeyConfirmOpen(false);
          openMasterPasswordPrompt('rotateApiKey');
        }}
        onCancel={() => setRotateApiKeyConfirmOpen(false)}
      />
    </div>
  );
}
