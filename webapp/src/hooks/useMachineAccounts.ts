import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AuthedFetch } from '@/lib/api/shared';
import {
  ensureSecretsContext,
  listMachineAccountTokens,
  listMachineAccounts,
  listSecretProjects,
  type MachineAccountDetail,
  type MachineAccountToken,
  type SecretProject,
  type SecretsContext,
} from '@/lib/api/secrets';
import { IS_DEMO_MODE } from '@/lib/demo';
import { t } from '@/lib/i18n';
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
  accounts: MachineAccountDetail[];
  projects: SecretProject[];
  /** 账号 id → 令牌列表。 */
  tokens: Record<string, MachineAccountToken[]>;
  /** 静默重取（操作成功后、实时推送）：失败只返回文案，不弹提示。 */
  onReload: () => Promise<string | null>;
  /** 「同步」按钮：手动触发时给成功 / 失败提示。 */
  onRefresh: () => Promise<void>;
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

  // ⚠️ 两个入参都不保证引用稳定（`authedFetch` 每次渲染都会重建）⇒ 存 ref，依赖里只放原始值，
  // 否则 `reload` 每次都换标识 → 挂载 effect 反复触发 → 无限重拉。与 `useSecretsManager` 同一写法。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const fetcherRef = useRef(authedFetch);
  fetcherRef.current = authedFetch;
  const accessToken = session?.accessToken ?? '';
  const keyMaterial = `${session?.symEncKey ?? ''}|${session?.symMacKey ?? ''}`;

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
    setLoading(true);
    setError('');
    try {
      const nextContext = await ensureSecretsContext(fetcher, currentSession);
      const [nextAccounts, nextProjects] = await Promise.all([
        listMachineAccounts(fetcher, nextContext),
        listSecretProjects(fetcher, nextContext),
      ]);
      const withTokens = await Promise.all(
        nextAccounts.map(
          async (account) => [account.id, await listMachineAccountTokens(fetcher, nextContext, account.id)] as const
        )
      );
      setContext(nextContext);
      setAccounts(nextAccounts);
      setProjects(nextProjects);
      setTokens(Object.fromEntries(withTokens));
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return message;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, accessToken, keyMaterial]);

  // 别人（CLI / 其它设备）改了机器账号 / 授权 / 令牌 ⇒ 重新拉一次。
  // 自己那次由 `App.tsx` 按标签页标识挡掉。
  useEffect(() => onSecretsManagerChange((kind) => {
    if (kind !== 'machine-accounts') return;
    void reload();
  }), [reload]);

  const refresh = useCallback(async (): Promise<void> => {
    const failure = await reload();
    if (failure) onNotify('error', failure);
    else onNotify('success', t('txt_secrets_synced'));
  }, [reload, onNotify]);

  return { context, loading, error, accounts, projects, tokens, onReload: reload, onRefresh: refresh };
}
