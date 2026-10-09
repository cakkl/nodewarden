import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Check, ChevronDown, Copy, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-preact';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { AuthedFetch } from '@/lib/api/shared';
import {
  createMachineAccount,
  createMachineAccountToken,
  deleteMachineAccount,
  ensureSecretsContext,
  listMachineAccountEvents,
  listMachineAccountTokens,
  listMachineAccounts,
  listSecretProjects,
  removeMachineAccountGrant,
  renameMachineAccount,
  revokeMachineAccountToken,
  setMachineAccountGrant,
  type MachineAccountDetail,
  type MachineAccountEvent,
  type MachineAccountGrant,
  type MachineAccountToken,
  type SecretProject,
  type SecretsContext,
} from '@/lib/api/secrets';
import { IS_DEMO_MODE } from '@/lib/demo';
import { t } from '@/lib/i18n';
import { SECRETS_DEMO_MACHINE_ACCOUNTS, SECRETS_DEMO_MACHINE_ACCOUNT_EVENTS, SECRETS_DEMO_PROJECTS } from '@/lib/secrets-demo';
import { onSecretsManagerChange } from '@/lib/secrets-realtime';
import type { SessionState } from '@/lib/types';
import { useActionRunner, type AppNotify } from '@/hooks/useActionRunner';

/**
 * 机器账号（Machine accounts）：左侧账号列表、右侧详情。
 *
 * ⚠️ 详情**只读**：名称、项目权限、访问令牌的改动（连同新建账号）一律在「编辑」视图里完成。
 * 编辑视图里项目只列**已授予**的 —— 铺开全部项目会让真正关心的两三行淹没在里面。令牌同理。
 *
 * ⚠️ 访问令牌的**明文只在创建那一刻返回一次**（服务端只存 `sha256(密钥)`），创建后必须立刻
 * 复制。因此令牌的增删**即时生效**（不像名称 / 项目那样等「保存」），否则明文无法跟随一次提交回吐。
 */
export interface MachineAccountsPageProps {
  authedFetch: AuthedFetch;
  session: SessionState | null;
  onNotify: AppNotify;
  mobileLayout: boolean;
}

const day = (iso: string): string => (iso ? iso.slice(0, 10) : '—');
/** 事件日志要精确到分钟（与 `day` 一样取 ISO 串自身的 UTC 部分）。 */
const stamp = (iso: string): string => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '—');
/** 令牌有效期的候选天数（发给程序用，太长不便于轮换）。 */
const TOKEN_TTL_DAYS = [30, 90, 365];
/** 事件日志每页条数（服务端上限 100）。 */
const EVENT_PAGE_SIZE = 20;

/** 事件类型码 → 文案键。数字码与 `src/services/secrets-events.ts` 保持一致。 */
const EVENT_LABEL_KEYS: Record<number, string> = {
  2100: 'txt_sm_event_secret_retrieved',
  2101: 'txt_sm_event_secret_created',
  2102: 'txt_sm_event_secret_edited',
  2103: 'txt_sm_event_secret_deleted',
  2104: 'txt_sm_event_secret_purged',
  2105: 'txt_sm_event_secret_restored',
  2201: 'txt_sm_event_project_created',
  2202: 'txt_sm_event_project_edited',
  2203: 'txt_sm_event_project_deleted',
  2304: 'txt_sm_event_account_created',
  2305: 'txt_sm_event_account_deleted',
};

/** 事件一行的人话。目标已不存在时用破折号占位 —— 事件本身仍要看得见。 */
function eventLabel(event: MachineAccountEvent): string {
  const key = EVENT_LABEL_KEYS[event.typeCode];
  return key ? t(key, { name: event.name ?? '—' }) : `#${event.typeCode}`;
}

/**
 * 编辑视图的草稿。名称与项目授权**一次性保存**（取消即全部丢弃）；
 * 令牌因为明文只出现一次，单独即时生效，所以不在这份草稿里。
 */
interface AccountDraft {
  /** `null` = 新建（此时还没有令牌可管理）。 */
  id: string | null;
  name: string;
  grants: MachineAccountGrant[];
}

/** 「添加项目」菜单里的一项：从项目选到权限，一步到位。 */
function GrantPicker(props: {
  projects: SecretProject[];
  disabled: boolean;
  onPick: (projectId: string, permission: 'read' | 'write') => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocumentDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentDown);
    return () => document.removeEventListener('mousedown', onDocumentDown);
  }, [open]);

  if (props.projects.length === 0) return null;

  return (
    <div className="sort-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn btn-secondary ${open ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={14} className="btn-icon" /> {t('txt_add')}
        <ChevronDown size={13} className="mobile-vault-filter-chevron" />
      </button>
      {open && (
        <div className="sort-menu" role="menu">
          {props.projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className="sort-menu-item"
              role="menuitem"
              onClick={() => {
                // 先给最保守的「只读」，要写权限再在行内改
                props.onPick(project.id, 'read');
                setOpen(false);
              }}
            >
              <span>{project.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MachineAccountsPage(props: MachineAccountsPageProps) {
  const { authedFetch, session, onNotify, mobileLayout } = props;
  const [context, setContext] = useState<SecretsContext | null>(null);
  const [accounts, setAccounts] = useState<MachineAccountDetail[]>([]);
  const [projects, setProjects] = useState<SecretProject[]>([]);
  const [tokens, setTokens] = useState<Record<string, MachineAccountToken[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'list' | 'detail'>('list');
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [tokenDraft, setTokenDraft] = useState<{ name: string; days: number } | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);
  const [events, setEvents] = useState<MachineAccountEvent[]>([]);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    if (mobileLayout) return;
    setMobilePanel('list');
  }, [mobileLayout]);

  const load = useCallback(async () => {
    if (IS_DEMO_MODE) {
      setAccounts(
        SECRETS_DEMO_MACHINE_ACCOUNTS.map((account) => ({
          id: account.id,
          name: account.name,
          creationDate: account.createdAt,
          revisionDate: account.revisionDate,
          grants: account.grants,
        }))
      );
      setProjects(
        SECRETS_DEMO_PROJECTS.map((project) => ({
          id: project.id,
          name: project.name,
          creationDate: project.createdAt,
          revisionDate: project.revisionDate,
        }))
      );
      setTokens(
        Object.fromEntries(
          SECRETS_DEMO_MACHINE_ACCOUNTS.map((account) => [
            account.id,
            // 演示数据用 `createdAt`，API 用 `creationDate` ⇒ 这里显式对齐
            account.tokens.map(
              (token): MachineAccountToken => ({
                id: token.id,
                name: token.name,
                expiresAt: token.expiresAt,
                revokedAt: token.revokedAt,
                lastUsedAt: token.lastUsedAt,
                creationDate: token.createdAt,
              })
            ),
          ])
        )
      );
      return;
    }
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const nextContext = await ensureSecretsContext(authedFetch, session);
      const [nextAccounts, nextProjects] = await Promise.all([
        listMachineAccounts(authedFetch, nextContext),
        listSecretProjects(authedFetch, nextContext),
      ]);
      const withTokens = await Promise.all(
        nextAccounts.map(
          async (account) => [account.id, await listMachineAccountTokens(authedFetch, nextContext, account.id)] as const
        )
      );
      setContext(nextContext);
      setAccounts(nextAccounts);
      setProjects(nextProjects);
      setTokens(Object.fromEntries(withTokens));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [authedFetch, session]);

  useEffect(() => {
    void load();
  }, [load]);

  // 别人（CLI / 其它设备）改了机器账号 / 授权 / 令牌 ⇒ 重新拉一次。
  // 自己那次由 `App.tsx` 按标签页标识挡掉。
  useEffect(
    () =>
      onSecretsManagerChange((kind) => {
        if (kind !== 'machine-accounts') return;
        void load();
      }),
    [load]
  );

  /** 事件日志：首屏取第一页，「加载更多」传上一页最后一条的 (时间, id) 复合游标。 */
  async function loadEvents(accountId: string, cursor?: { creationDate: string; id: string }): Promise<void> {
    if (IS_DEMO_MODE) {
      setEvents(
        SECRETS_DEMO_MACHINE_ACCOUNT_EVENTS.map((event) => ({
          id: event.id,
          actorType: event.actorType,
          typeCode: event.typeCode,
          secretId: event.secretId,
          projectId: event.projectId,
          name: event.name,
          creationDate: event.createdAt,
        }))
      );
      setEventsHasMore(false);
      return;
    }
    if (!context) return;
    setEventsLoading(true);
    try {
      const page = await listMachineAccountEvents(authedFetch, context, accountId, {
        limit: EVENT_PAGE_SIZE,
        before: cursor?.creationDate,
        beforeId: cursor?.id,
      });
      setEvents((current) => (cursor ? [...current, ...page.events] : page.events));
      setEventsHasMore(page.hasMore);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setEventsLoading(false);
    }
  }

  const selected = accounts.find((account) => account.id === selectedId) ?? null;
  const activeId = draft?.id ?? null;

  /** 已授权之外的候选项目（编辑视图里「添加」菜单的数据源）。 */
  const grantCandidates = useMemo(() => {
    if (!draft) return [];
    const granted = new Set(draft.grants.map((grant) => grant.projectId));
    return projects.filter((project) => !granted.has(project.id));
  }, [projects, draft]);

  const projectNameOf = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project.name]));
    return (id: string): string => byId.get(id) ?? id;
  }, [projects]);

  const permissionLabel = (permission: MachineAccountGrant['permission']): string =>
    permission === 'write' ? t('txt_permission_write') : t('txt_permission_read');

  /** 统一包装（成功提示 / 刷新 / 失败透出文案见 `useActionRunner`）。 */
  const run = useActionRunner({ onNotify, demoMode: IS_DEMO_MODE, reload: load, onBusyChange: setBusy });

  function openCreate(): void {
    setCreatedToken(null);
    setTokenDraft(null);
    setDraft({ id: null, name: '', grants: [] });
    if (mobileLayout) setMobilePanel('detail');
  }

  function openEdit(): void {
    if (!selected) return;
    setCreatedToken(null);
    setTokenDraft(null);
    setDraft({ id: selected.id, name: selected.name, grants: selected.grants.map((grant) => ({ ...grant })) });
    if (mobileLayout) setMobilePanel('detail');
  }

  /** 丢弃草稿 —— 名称与项目授权都还没落库，令牌不受影响。 */
  function cancelEdit(): void {
    setDraft(null);
    setTokenDraft(null);
    setCreatedToken(null);
  }

  /** 保存名称 + 项目授权：一处提交，取消即全部丢弃。令牌另走即时接口。 */
  async function saveDraft(): Promise<void> {
    const current = draft;
    if (!current || !context) return;
    const name = current.name.trim();
    if (!name) return;
    if (IS_DEMO_MODE) {
      onNotify('warning', t('txt_demo_readonly_message'));
      return;
    }
    setBusy(true);
    try {
      const before = current.id ? accounts.find((account) => account.id === current.id) : undefined;
      let accountId = current.id;
      if (!accountId) {
        accountId = (await createMachineAccount(authedFetch, context, name)).id;
      } else if (name !== before?.name) {
        await renameMachineAccount(authedFetch, context, accountId, name);
      }

      // 授权的差异落库：新增/改权限用 upsert，被移出草稿的删掉
      const original = new Map((before?.grants ?? []).map((grant) => [grant.projectId, grant.permission]));
      const wanted = new Map(current.grants.map((grant) => [grant.projectId, grant.permission]));
      for (const [projectId, permission] of wanted) {
        if (original.get(projectId) !== permission) {
          await setMachineAccountGrant(authedFetch, context, accountId, projectId, permission);
        }
      }
      for (const projectId of original.keys()) {
        if (!wanted.has(projectId)) {
          await removeMachineAccountGrant(authedFetch, context, accountId, projectId);
        }
      }

      onNotify('success', t('txt_saved'));
      setDraft(null);
      setTokenDraft(null);
      setSelectedId(accountId);
      await load();
      await loadEvents(accountId);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** 创建访问令牌：明文只出现一次，故即时生效而非等「保存」。 */
  async function submitToken(): Promise<void> {
    if (!tokenDraft || !activeId || !context) return;
    const name = tokenDraft.name.trim();
    if (!name) return;
    if (IS_DEMO_MODE) {
      onNotify('warning', t('txt_demo_readonly_message'));
      return;
    }
    setBusy(true);
    try {
      const expiresAt = new Date(Date.now() + tokenDraft.days * 24 * 60 * 60 * 1000).toISOString();
      const created = await createMachineAccountToken(authedFetch, context, activeId, name, expiresAt);
      // ⚠️ 明文只在这一刻拿到，先把界面切到「把它复制走」，再刷新列表
      setCreatedToken(created.plaintext);
      setTokenDraft(null);
      await load();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(tokenId: string): Promise<void> {
    if (!context) return;
    await run(() => revokeMachineAccountToken(authedFetch, context, tokenId), t('txt_revoked'));
  }

  async function copyPlaintext(): Promise<void> {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      onNotify('success', t('txt_copied'));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : String(err));
    }
  }

  function selectAccount(id: string): void {
    setSelectedId(id);
    cancelEdit();
    setEvents([]);
    void loadEvents(id);
    if (mobileLayout) setMobilePanel('detail');
  }

  const list = (
    <section className="list-col">
      <div className="list-toolbar-stack">
        <div className="list-head machine-accounts-list-head">
          <div className="head-search-group">
            <h3 className="flush-title">{t('nav_machine_accounts')}</h3>
          </div>
          <div className="head-actions-group">
            <button
              type="button"
              className="btn btn-secondary small list-icon-btn"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              <RefreshCw size={14} className="btn-icon" /> {t('txt_sync_vault')}
            </button>
            <div
              className={`create-menu-wrap ${mobileLayout ? 'mobile-fab-wrap' : 'desktop-create-menu-wrap'}`}
            >
              <button
                type="button"
                className={`btn btn-primary small ${mobileLayout ? 'mobile-fab-trigger' : 'desktop-create-trigger'}`}
                aria-label={t('txt_add')}
                title={t('txt_add')}
                onClick={openCreate}
              >
                <Plus size={14} className="btn-icon" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="list-panel">
        {loading ? (
          <div className="empty">{t('txt_loading')}</div>
        ) : error ? (
          <div className="empty">{error}</div>
        ) : accounts.length === 0 ? (
          <div className="empty">{t('txt_machine_accounts_empty')}</div>
        ) : (
          accounts.map((account) => (
            <div
              key={account.id}
              className={`list-item ${selectedId === account.id ? 'active' : ''}`}
              onClick={() => selectAccount(account.id)}
            >
              <div className="row-main">
                <div className="list-text">
                  <span className="list-title">{account.name}</span>
                  <span className="list-sub">
                    {t('nav_secret_projects')} {account.grants.length}
                    <span className="muted-inline">
                      {' · '}
                      {t('txt_access_tokens')} {(tokens[account.id] ?? []).length}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );

  const accountTokens = activeId ? tokens[activeId] ?? [] : [];

  const editor = draft ? (
    <div key={`machine-editor-${draft.id ?? 'new'}`} className="detail-switch-stage">
      <div className="card">
        <label className="field">
          <span>{t('txt_name')}</span>
          <input
            className="input"
            autoFocus
            aria-label={t('txt_name')}
            placeholder={t('txt_name')}
            value={draft.name}
            onInput={(event) => setDraft({ ...draft, name: (event.currentTarget as HTMLInputElement).value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveDraft();
              if (event.key === 'Escape') cancelEdit();
            }}
          />
        </label>
      </div>

      {/* 只列已授权的项目；没涉及的项目收在「添加」菜单里 */}
      <div className={`card ${grantCandidates.length > 0 ? 'card-menu-open' : ''}`}>
        <h4>{t('nav_secret_projects')}</h4>
        {draft.grants.map((grant) => (
          <div key={grant.projectId} className="kv-row">
            <span className="kv-label" title={projectNameOf(grant.projectId)}>
              {projectNameOf(grant.projectId)}
            </span>
            <div className="kv-main" />
            <div className="kv-actions">
              <select
                className="input small"
                aria-label={projectNameOf(grant.projectId)}
                value={grant.permission}
                disabled={busy}
                onInput={(event) => {
                  const next = (event.currentTarget as HTMLSelectElement).value as 'read' | 'write';
                  setDraft({
                    ...draft,
                    grants: draft.grants.map((item) =>
                      item.projectId === grant.projectId ? { ...item, permission: next } : item
                    ),
                  });
                }}
              >
                <option value="read">{t('txt_permission_read')}</option>
                <option value="write">{t('txt_permission_write')}</option>
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                aria-label={t('txt_delete')}
                disabled={busy}
                onClick={() =>
                  setDraft({ ...draft, grants: draft.grants.filter((item) => item.projectId !== grant.projectId) })
                }
              >
                <X size={14} className="btn-icon" />
              </button>
            </div>
          </div>
        ))}
        <div className="detail-actions">
          <div className="actions">
            <GrantPicker
              projects={grantCandidates}
              disabled={busy}
              onPick={(projectId, permission) =>
                setDraft({ ...draft, grants: [...draft.grants, { projectId, permission }] })
              }
            />
          </div>
        </div>
      </div>

      {/* 令牌：明文只在创建时出现一次，故即时生效；新建账号要先保存才有 id */}
      {draft.id ? (
        <div className="card">
          <h4>{t('txt_access_tokens')}</h4>
          {accountTokens.map((token) => (
            <div key={token.id} className="kv-row">
              <span className="kv-label" title={token.name}>
                {token.name}
              </span>
              <div className="kv-main machine-meta">
                <span>{t('txt_created_value', { value: day(token.creationDate) })}</span>
                <span>{t('txt_expires_at_value', { value: day(token.expiresAt) })}</span>
              </div>
              <div className="kv-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={t('txt_revoke')}
                  title={t('txt_revoke')}
                  disabled={busy || !!token.revokedAt}
                  onClick={() => setConfirmRevoke({ id: token.id, name: token.name })}
                >
                  <Trash2 size={14} className="btn-icon" />
                </button>
              </div>
            </div>
          ))}

          {createdToken ? (
            <div className="kv-row">
              <span className="kv-label">{t('txt_access_token_once')}</span>
              <div className="kv-main">
                <strong>{createdToken}</strong>
              </div>
              <div className="kv-actions">
                <button type="button" className="btn btn-secondary" onClick={() => void copyPlaintext()}>
                  <Copy size={14} className="btn-icon" /> {t('txt_copy')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setCreatedToken(null)}>
                  {t('txt_close')}
                </button>
              </div>
            </div>
          ) : tokenDraft ? (
            <div className="machine-inline-row">
              <input
                className="input"
                autoFocus
                aria-label={t('txt_name')}
                placeholder={t('txt_name')}
                value={tokenDraft.name}
                onInput={(event) =>
                  setTokenDraft({ ...tokenDraft, name: (event.currentTarget as HTMLInputElement).value })
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitToken();
                  if (event.key === 'Escape') setTokenDraft(null);
                }}
              />
              <select
                className="input small"
                aria-label={t('txt_expiry')}
                value={tokenDraft.days}
                onInput={(event) =>
                  setTokenDraft({ ...tokenDraft, days: Number((event.currentTarget as HTMLSelectElement).value) })
                }
              >
                {TOKEN_TTL_DAYS.map((days) => (
                  <option key={days} value={days}>
                    {t('txt_expires_in_days', { count: days })}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !tokenDraft.name.trim()}
                onClick={() => void submitToken()}
              >
                {t('txt_confirm')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setTokenDraft(null)}>
                {t('txt_cancel')}
              </button>
            </div>
          ) : null}

          <div className="detail-actions">
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!!createdToken || !!tokenDraft}
                onClick={() => setTokenDraft({ name: '', days: 90 })}
              >
                <Plus size={14} className="btn-icon" /> {t('txt_access_tokens')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="detail-actions">
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !draft.name.trim()}
            onClick={() => void saveDraft()}
          >
            <Check size={14} className="btn-icon" />
            {t('txt_save')}
          </button>
          <button type="button" className="btn btn-secondary" onClick={cancelEdit}>
            <X size={14} className="btn-icon" />
            {t('txt_cancel')}
          </button>
        </div>
        {draft.id ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() =>
              setConfirmDelete({
                id: draft.id as string,
                name: accounts.find((account) => account.id === draft.id)?.name ?? draft.name,
              })
            }
          >
            <Trash2 size={14} className="btn-icon" /> {t('txt_delete')}
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  const detail = (
    <section className={`detail-col ${mobileLayout ? 'mobile-detail-sheet' : ''} ${mobileLayout && mobilePanel === 'detail' ? 'open' : ''}`}>
      {mobileLayout && mobilePanel === 'detail' && (
        <div className="mobile-panel-head">
          <button type="button" className="btn btn-secondary small mobile-panel-back" onClick={() => setMobilePanel('list')}>
            <span className="btn-icon" aria-hidden="true">{'<'}</span>
            {t('txt_back')}
          </button>
        </div>
      )}

      {editor ? (
        editor
      ) : !selected ? (
        <div className="card">
          <div className="empty">{t('txt_machine_accounts_empty')}</div>
        </div>
      ) : (
        <div key={`machine-${selected.id}`} className="detail-switch-stage">
          <div className="card">
            <h4>{selected.name}</h4>
          </div>

          <div className="card">
            <h4>{t('nav_secret_projects')}</h4>
            {selected.grants.length === 0 ? (
              <div className="detail-sub">—</div>
            ) : (
              selected.grants.map((grant) => (
                <div key={grant.projectId} className="kv-line">
                  <span title={projectNameOf(grant.projectId)}>{projectNameOf(grant.projectId)}</span>
                  <strong>{permissionLabel(grant.permission)}</strong>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h4>{t('txt_access_tokens')}</h4>
            {(tokens[selected.id] ?? []).length === 0 ? (
              <div className="detail-sub">—</div>
            ) : (
              (tokens[selected.id] ?? []).map((token) => (
                <div key={token.id} className="kv-row">
                  <span className="kv-label" title={token.name}>
                    {token.name}
                  </span>
                  <div className="kv-main machine-meta">
                    <span>{t('txt_created_value', { value: day(token.creationDate) })}</span>
                    <span>{t('txt_expires_at_value', { value: day(token.expiresAt) })}</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="card">
            <h4>{t('txt_machine_account_history')}</h4>
            <div className="detail-sub">{t('txt_last_edited_value', { value: day(selected.revisionDate) })}</div>
            <div className="detail-sub">{t('txt_created_value', { value: day(selected.creationDate) })}</div>
          </div>

          <div className="card">
            <h4>{t('txt_sm_event_logs')}</h4>
            {events.length === 0 ? (
              <div className="detail-sub">{eventsLoading ? t('txt_loading') : '—'}</div>
            ) : (
              events.map((event) => (
                <div key={event.id} className="kv-line">
                  <span>{stamp(event.creationDate)}</span>
                  <strong>{eventLabel(event)}</strong>
                </div>
              ))
            )}
            {eventsHasMore ? (
              <div className="detail-actions">
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={eventsLoading}
                    onClick={() => {
                      const last = events[events.length - 1];
                      if (last) void loadEvents(selected.id, { creationDate: last.creationDate, id: last.id });
                    }}
                  >
                    {t('txt_load_more')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="detail-actions">
            <div className="actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={openEdit}>
                <Pencil size={14} className="btn-icon" />
                {t('txt_edit')}
              </button>
            </div>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => setConfirmDelete({ id: selected.id, name: selected.name })}
            >
              <Trash2 size={14} className="btn-icon" /> {t('txt_delete')}
            </button>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div className={`vault-grid machine-accounts-grid ${mobileLayout ? `mobile-panel-${mobilePanel}` : ''}`}>
      {list}
      {detail}

      <ConfirmDialog
        open={!!confirmDelete}
        danger
        title={t('txt_delete')}
        message={confirmDelete ? t('txt_delete_machine_account_message', { name: confirmDelete.name }) : ''}
        confirmText={t('txt_delete')}
        cancelText={t('txt_cancel')}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (!target || !context) return;
          setDraft(null);
          setSelectedId(null);
          setMobilePanel('list');
          void run(() => deleteMachineAccount(authedFetch, context, target.id), t('txt_deleted'));
        }}
      />

      <ConfirmDialog
        open={!!confirmRevoke}
        danger
        title={t('txt_revoke')}
        message={confirmRevoke ? t('txt_revoke_token_message', { name: confirmRevoke.name }) : ''}
        confirmText={t('txt_revoke')}
        cancelText={t('txt_cancel')}
        onCancel={() => setConfirmRevoke(null)}
        onConfirm={() => {
          const target = confirmRevoke;
          setConfirmRevoke(null);
          if (!target) return;
          void revokeToken(target.id);
        }}
      />
    </div>
  );
}
