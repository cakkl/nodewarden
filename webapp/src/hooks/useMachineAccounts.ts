import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { OfflineRequestError, type AuthedFetch } from '@/lib/api/shared';
import {
  listMachineAccountTokens,
  listMachineAccounts,
  listSecretProjects,
  resolveSecretsContext,
  type MachineAccountDetail,
  type MachineAccountToken,
  type SecretProject,
  type SecretsContext,
} from '@/lib/api/secrets';
import { IS_DEMO_MODE } from '@/lib/demo';
import { t } from '@/lib/i18n';
import { backendUnreachable as sharedBackendUnreachable, subscribeNetworkStatus } from '@/lib/network-status';
import { onSecretsManagerChange } from '@/lib/secrets-realtime';
import { SECRETS_DEMO_MACHINE_ACCOUNTS, SECRETS_DEMO_PROJECTS } from '@/lib/secrets-demo';
import type { SessionState } from '@/lib/types';
import type { AppNotify } from '@/hooks/useActionRunner';

export interface UseMachineAccountsOptions {
  authedFetch: AuthedFetch;
  session: SessionState | null;
  onNotify: AppNotify;
}

export interface MachineAccountsManagerProps {
  /** 组织上下文；未就绪时页面不发请求。 */
  context: SecretsContext | null;
  loading: boolean;
  error: string;
  /** 离线：机器账号 / 令牌 / 授权**不入缓存**（凭据落盘即明文）⇒ 页面只能提示需要联网。 */
  offline: boolean;
  accounts: MachineAccountDetail[];
  projects: SecretProject[];
  /** 账号 id → 令牌列表。 */
  tokens: Record<string, MachineAccountToken[]>;
  /** 「同步」按钮：手动触发时给成功 / 失败提示。 */
  onRefresh: () => Promise<void>;
  /**
   * 写成功后就地打补丁（与机密页同一套做法）：列表立刻反映改动 —— 整页重拉要 4 + N 个请求
   * （每个账号各一次令牌），写完等它回来是明显卡顿。改动都经服务端确认，所以不需回滚。
   */
  onUpsertAccount: (account: MachineAccountDetail) => void;
  onRemoveAccount: (id: string) => void;
  onAddToken: (accountId: string, token: MachineAccountToken) => void;
  /** 只重取**某一个**账号的令牌（撤销后要服务端的 `revokedAt`）—— 失败只返回文案。 */
  onReloadAccountTokens: (accountId: string) => Promise<string | null>;
}

/**
 * 机器账号页的数据（账号 / 项目 / 令牌）。
 * ⚠️ 必须像 `useSecretsManager` 那样挂在 **App** 上：挂在页面里的话，路由一离开就卸载，
 * 回来时先清空再加载（列表闪「加载中」），与机密页不一致。
 */
export default function useMachineAccounts(options: UseMachineAccountsOptions): MachineAccountsManagerProps {
  const { authedFetch, session, onNotify } = options;
  const [context, setContext] = useState<SecretsContext | null>(null);
  const [accounts, setAccounts] = useState<MachineAccountDetail[]>([]);
  const [projects, setProjects] = useState<SecretProject[]>([]);
  const [tokens, setTokens] = useState<Record<string, MachineAccountToken[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);

  // ⚠️ 两个入参都不保证引用稳定（`authedFetch` 每次渲染都会重建）⇒ 存 ref，依赖里只放原始值，
  // 否则 `reload` 每次都换标识 → 挂载 effect 反复触发 → 无限重拉。与 `useSecretsManager` 同一写法。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const fetcherRef = useRef(authedFetch);
  fetcherRef.current = authedFetch;
  const accessToken = session?.accessToken ?? '';
  const keyMaterial = `${session?.symEncKey ?? ''}|${session?.symMacKey ?? ''}`;

  const backendUnreachable = useCallback(
    () => sharedBackendUnreachable({ hasAccessToken: !!sessionRef.current?.accessToken }),
    []
  );

  const reload = useCallback(async (): Promise<string | null> => {
    const currentSession = sessionRef.current;
    const fetcher = fetcherRef.current;
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
      return null;
    }
    if (!currentSession) return null;
    // 离线：机器账号不缓存，页面改显示「需要联网」（不算错误，不弹提示）
    if (backendUnreachable()) {
      setOffline(true);
      setError('');
      return null;
    }
    setLoading(true);
    setError('');
    try {
      const nextContext = await resolveSecretsContext(fetcher, currentSession);
      // 令牌随列表一起回来 ⇒ 不必按账号各发一次
      const [{ accounts: nextAccounts, tokens: nextTokens }, nextProjects] = await Promise.all([
        listMachineAccounts(fetcher, nextContext),
        listSecretProjects(fetcher, nextContext),
      ]);
      setOffline(false);
      setContext(nextContext);
      setAccounts(nextAccounts);
      setProjects(nextProjects);
      setTokens(nextTokens);
      return null;
    } catch (err) {
      // 请求发出后才断网（或冷启动时压根没拿到令牌）⇒ 与真离线同样处理，
      // 而不是把「连不上后端」当成机器账号自己的错误透出去
      if (err instanceof OfflineRequestError) {
        setOffline(true);
        setError('');
        return null;
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return message;
    } finally {
      setLoading(false);
    }
  }, [backendUnreachable]);

  useEffect(() => {
    void reload();
  }, [reload, accessToken, keyMaterial]);

  // 网络恢复 ⇒ 自动补上这一次没能发的请求（离线时页面只是个「需要联网」占位）
  useEffect(
    () =>
      subscribeNetworkStatus((status) => {
        if (status === 'online') void reload();
      }),
    [reload]
  );

  // 别人（CLI / 其它设备）改了机器账号 / 授权 / 令牌 ⇒ 重新拉一次。
  // 自己那次由 `App.tsx` 按标签页标识挡掉。
  useEffect(() => onSecretsManagerChange((kind) => {
    if (kind !== 'machine-accounts') return;
    void reload();
  }), [reload]);

  /** 只重取一个账号的令牌（撤销后要服务端的 `revokedAt`）。 */
  const reloadAccountTokens = useCallback(
    async (accountId: string): Promise<string | null> => {
      if (!context) return null;
      try {
        const nextTokens = await listMachineAccountTokens(fetcherRef.current, context, accountId);
        setTokens((current) => ({ ...current, [accountId]: nextTokens }));
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [context]
  );

  const upsertAccount = useCallback((account: MachineAccountDetail) => {
    setAccounts((current) => {
      const index = current.findIndex((item) => item.id === account.id);
      if (index < 0) return [...current, account];
      const next = current.slice();
      next[index] = account;
      return next;
    });
  }, []);

  const removeAccount = useCallback((id: string) => {
    setAccounts((current) => current.filter((item) => item.id !== id));
    setTokens((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  /** 追加到末尾：服务端按 `created_at` 升序返回，顺序与重拉后一致。 */
  const addToken = useCallback((accountId: string, token: MachineAccountToken) => {
    setTokens((current) => ({ ...current, [accountId]: [...(current[accountId] ?? []), token] }));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const failure = await reload();
    if (failure) onNotify('error', failure);
    else onNotify('success', t('txt_secrets_synced'));
  }, [reload, onNotify]);

  return {
    context,
    loading,
    error,
    offline,
    accounts,
    projects,
    tokens,
    onRefresh: refresh,
    onUpsertAccount: upsertAccount,
    onRemoveAccount: removeAccount,
    onAddToken: addToken,
    onReloadAccountTokens: reloadAccountTokens,
  };
}
