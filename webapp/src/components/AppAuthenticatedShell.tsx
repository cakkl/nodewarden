import { ChevronDown, Clock3, Folder as FolderIcon, KeyRound, Lock, LogOut, Send as SendIcon, Settings as SettingsIcon, ShieldUser, Sparkles } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from 'wouter';
import AppMainRoutes from '@/components/AppMainRoutes';
import NetworkStatusBadge from '@/components/NetworkStatusBadge';
import ThemeSwitch from '@/components/ThemeSwitch';
import type { AppMainRoutesProps } from '@/components/AppMainRoutes';
import { t } from '@/lib/i18n';
import { DIRECT_ALIASES, ROUTES, isSecretsProductPath } from '@/lib/routes';
import type { Profile } from '@/lib/types';

interface AppAuthenticatedShellProps {
  profile: Profile | null;
  location: string;
  mobilePrimaryRoute: string;
  currentPageTitle: string;
  isImportRoute: boolean;
  darkMode: boolean;
  themeToggleTitle: string;
  onLock: () => void;
  onLogout: () => void;
  onToggleTheme: () => void;
  mainRoutesProps: AppMainRoutesProps;
}

const NAV_GROUPS_STORAGE_KEY = 'nodewarden.navGroups';

const DEFAULT_EXPANDED_GROUPS = {
  tools: true,
  settings: true,
  management: true,
};

type NavGroup = keyof typeof DEFAULT_EXPANDED_GROUPS;
type ExpandedGroups = Record<NavGroup, boolean>;

function readExpandedGroups(): ExpandedGroups {
  if (typeof window === 'undefined') return DEFAULT_EXPANDED_GROUPS;
  try {
    const saved = window.localStorage.getItem(NAV_GROUPS_STORAGE_KEY);
    if (!saved) return DEFAULT_EXPANDED_GROUPS;
    const parsed = JSON.parse(saved) as Partial<ExpandedGroups>;
    return {
      tools: typeof parsed.tools === 'boolean' ? parsed.tools : DEFAULT_EXPANDED_GROUPS.tools,
      settings: typeof parsed.settings === 'boolean' ? parsed.settings : DEFAULT_EXPANDED_GROUPS.settings,
      management: typeof parsed.management === 'boolean' ? parsed.management : DEFAULT_EXPANDED_GROUPS.management,
    };
  } catch {
    // Ignore local preference read failures.
  }
  return DEFAULT_EXPANDED_GROUPS;
}

function isAdminProfile(profile: Profile | null): boolean {
  return String(profile?.role || '').toLowerCase() === 'admin';
}

export default function AppAuthenticatedShell(props: AppAuthenticatedShellProps) {
  const routeAnimationKey = props.isImportRoute ? ROUTES.importExport : props.location;
  const isDomainRulesRoute = props.location === ROUTES.settingsDomainRules;
  const isLogRoute = props.location === ROUTES.logs;
  const isAdmin = isAdminProfile(props.profile);
  const deviceManagementActive = props.location === ROUTES.deviceManagement
    || props.location === DIRECT_ALIASES.deviceManagementLegacy;
  // 产品归属由路径派生（不存开关状态）—— 见 `isSecretsProductPath` 的说明。
  const isSecretsProduct = isSecretsProductPath(props.location);
  const [expandedGroups, setExpandedGroups] = useState<ExpandedGroups>(readExpandedGroups);

  function toggleGroup(group: NavGroup): void {
    setExpandedGroups((current) => {
      const next = { ...current, [group]: !current[group] };
      try {
        window.localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore local preference write failures.
      }
      return next;
    });
  }

  function renderSideLink(href: string, active: boolean, icon: ComponentChildren, label: string) {
    return (
      <Link href={href} className={`side-link ${active ? 'active' : ''}`}>
        {icon}
        <span>{label}</span>
      </Link>
    );
  }

  function renderSubLink(href: string, active: boolean, label: string) {
    return (
      <Link href={href} className={`side-sub-link ${active ? 'active' : ''}`}>
        <span>{label}</span>
      </Link>
    );
  }

  function renderNavGroup(
    group: NavGroup,
    title: string,
    icon: ComponentChildren,
    children: ComponentChildren
  ) {
    const open = expandedGroups[group];
    return (
      <div className={`side-nav-group ${open ? 'open' : ''}`}>
        <button
          type="button"
          className="side-group-trigger"
          aria-expanded={open}
          onClick={() => toggleGroup(group)}
        >
          {icon}
          <span>{title}</span>
          <ChevronDown size={15} className="side-group-chevron" />
        </button>
        <div className={`side-subnav ${open ? 'open' : ''}`}>
          <div className="side-subnav-inner">
            {children}
          </div>
        </div>
      </div>
    );
  }

  const groupedNav = (
    <>
      {renderSideLink(ROUTES.vault, props.location === ROUTES.vault, <KeyRound size={16} />, t('nav_vault_items'))}
      {renderSideLink(ROUTES.sends, props.location === ROUTES.sends, <SendIcon size={16} />, t('nav_sends'))}
      {renderNavGroup(
        'tools',
        t('nav_group_tools'),
        <Sparkles size={16} />,
        <>
          {renderSubLink(ROUTES.vaultTotp, props.location === ROUTES.vaultTotp, t('txt_verification_code'))}
          {renderSubLink(ROUTES.generator, props.location === ROUTES.generator, t('nav_generator'))}
          {renderSubLink(ROUTES.passwordHealth, props.location === ROUTES.passwordHealth, t('nav_password_security'))}
          {renderSubLink(ROUTES.importExport, props.isImportRoute, t('nav_import_export'))}
        </>
      )}
      {renderNavGroup(
        'settings',
        t('txt_settings'),
        <SettingsIcon size={16} />,
        <>
          {renderSubLink(ROUTES.settingsAccount, props.location === ROUTES.settingsAccount, t('nav_account_settings'))}
          {renderSubLink(ROUTES.deviceManagement, deviceManagementActive, t('nav_device_management'))}
          {renderSubLink(ROUTES.settingsDomainRules, props.location === ROUTES.settingsDomainRules, t('nav_domain_rules'))}
        </>
      )}
      {isAdmin &&
        renderNavGroup(
          'management',
          t('nav_group_system_management'),
          <ShieldUser size={16} />,
          <>
            {renderSubLink(ROUTES.backup, props.location === ROUTES.backup, t('nav_backup_strategy'))}
            {renderSubLink(ROUTES.admin, props.location === ROUTES.admin, t('nav_admin_panel'))}
            {renderSubLink(ROUTES.logs, props.location === ROUTES.logs, t('nav_log_center'))}
          </>
        )}
    </>
  );

  // 机密管理器产品的导航（与密码管理器的那套互斥渲染）
  const secretsNav = (
    <>
      {renderSideLink(ROUTES.secrets, props.location === ROUTES.secrets, <KeyRound size={16} />, t('nav_secrets'))}
      {renderSideLink(ROUTES.secretsProjects, props.location === ROUTES.secretsProjects, <FolderIcon size={16} />, t('nav_secret_projects'))}
      {renderSideLink(ROUTES.secretsMachineAccounts, props.location === ROUTES.secretsMachineAccounts, <ShieldUser size={16} />, t('nav_machine_accounts'))}
    </>
  );

  return (
    <div className="app-page">
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <img src="/nodewarden-logo.svg" alt="NodeWarden logo" className="brand-logo" />
            <span className="brand-wordmark" role="img" aria-label="NodeWarden" />
            <span className="mobile-page-title">{props.currentPageTitle}</span>
          </div>
          <div className="topbar-actions">
            {/* ≤1180px 时应用侧栏整体隐藏，顶栏这份紧凑切换器是手机上唯一的入口。 */}
            <nav className="product-switch product-switch-mobile" aria-label={t('txt_switch_product')}>
              <Link href={ROUTES.vault} className={`product-switch-option ${isSecretsProduct ? '' : 'active'}`}>
                {t('nav_password_manager_short')}
              </Link>
              <Link href={ROUTES.secrets} className={`product-switch-option ${isSecretsProduct ? 'active' : ''}`}>
                {t('nav_secrets_manager_short')}
              </Link>
            </nav>
            <NetworkStatusBadge />
            <div className="user-chip">
              <ShieldUser size={16} />
              <span>{props.profile?.email}</span>
            </div>
            <ThemeSwitch checked={props.darkMode} title={props.themeToggleTitle} onToggle={props.onToggleTheme} />
            <button type="button" className="btn btn-secondary small" onClick={props.onLock}>
              <Lock size={14} className="btn-icon" /> {t('txt_lock')}
            </button>
            <div className="mobile-theme-btn">
              <ThemeSwitch checked={props.darkMode} title={props.themeToggleTitle} onToggle={props.onToggleTheme} />
            </div>
            <button type="button" className="btn btn-secondary small mobile-lock-btn" aria-label={t('txt_lock')} title={t('txt_lock')} onClick={props.onLock}>
              <Lock size={14} className="btn-icon" />
            </button>
            <button type="button" className="btn btn-secondary small" onClick={props.onLogout}>
              <LogOut size={14} className="btn-icon" /> {t('txt_sign_out')}
            </button>
          </div>
        </header>

        <div className="app-main">
          <aside className="app-side">
            <nav className="product-switch" aria-label={t('txt_switch_product')}>
              <Link href={ROUTES.vault} className={`product-switch-option ${isSecretsProduct ? '' : 'active'}`}>
                {t('nav_password_manager')}
              </Link>
              <Link href={ROUTES.secrets} className={`product-switch-option ${isSecretsProduct ? 'active' : ''}`}>
                {t('nav_secrets_manager')}
              </Link>
            </nav>
            <div className="side-nav-main">
              {isSecretsProduct ? secretsNav : groupedNav}
            </div>
          </aside>
          <main className="content">
            <div key={routeAnimationKey} className={`route-stage ${isDomainRulesRoute ? 'route-stage-fixed' : ''} ${isLogRoute ? 'route-stage-log-fixed' : ''}`}>
              <AppMainRoutes {...props.mainRoutesProps} />
            </div>
          </main>
        </div>

        {/* 底部 tab 按产品分两套：机密管理器有自己的四个（不是在第 5 个后面再加一个） */}
        {isSecretsProduct ? (
          <nav className="mobile-tabbar" aria-label={t('txt_menu')}>
            <Link href={ROUTES.secrets} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.secrets ? 'active' : ''}`}>
              <KeyRound size={18} />
              <span>{t('nav_secrets')}</span>
            </Link>
            <Link href={ROUTES.secretsProjects} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.secretsProjects ? 'active' : ''}`}>
              <FolderIcon size={18} />
              <span>{t('nav_secret_projects')}</span>
            </Link>
            <Link href={ROUTES.secretsMachineAccounts} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.secretsMachineAccounts ? 'active' : ''}`}>
              <ShieldUser size={18} />
              <span>{t('nav_machine_accounts')}</span>
            </Link>
          </nav>
        ) : (
          <nav className="mobile-tabbar" aria-label={t('txt_menu')}>
            <Link href={ROUTES.vault} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.vault ? 'active' : ''}`}>
              <KeyRound size={18} />
              <span>{t('nav_my_vault')}</span>
            </Link>
            <Link href={ROUTES.vaultTotp} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.vaultTotp ? 'active' : ''}`}>
              <Clock3 size={18} />
              <span>{t('txt_verification_code')}</span>
            </Link>
            <Link href={ROUTES.generator} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.generator ? 'active' : ''}`}>
              <Sparkles size={18} />
              <span>{t('nav_generator')}</span>
            </Link>
            <Link href={ROUTES.sends} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.sends ? 'active' : ''}`}>
              <SendIcon size={18} />
              <span>{t('nav_sends')}</span>
            </Link>
            <Link href={ROUTES.settings} className={`mobile-tab ${props.mobilePrimaryRoute === ROUTES.settings ? 'active' : ''}`}>
              <SettingsIcon size={18} />
              <span>{t('txt_settings')}</span>
            </Link>
          </nav>
        )}
      </div>
    </div>
  );
}
