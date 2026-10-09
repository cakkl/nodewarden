import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  createSecret,
  createSecretProject,
  deleteSecretProjects,
  deleteSecrets,
  ensureSecretsContext,
  getSecretsByIds,
  getTrashedSecret,
  listSecrets,
  listTrashedSecrets,
  purgeTrashedSecrets,
  restoreTrashedSecrets,
  updateSecret,
  updateSecretProject,
  type SecretDetail,
  type SecretInput,
  type SecretProject,
  type SecretSummary,
  type SecretsContext,
  type TrashedSecret,
  type TrashedSecretDetail,
} from '@/lib/api/secrets';
import type { AuthedFetch } from '@/lib/api/shared';
import { IS_DEMO_MODE } from '@/lib/demo';
import { t } from '@/lib/i18n';
import { SECRETS_DEMO_PROJECTS, SECRETS_DEMO_SECRETS, SECRETS_DEMO_TRASH } from '@/lib/secrets-demo';
import { onSecretsManagerChange } from '@/lib/secrets-realtime';
import type { SessionState } from '@/lib/types';
import { useActionRunner, type AppNotify } from './useActionRunner';

interface UseSecretsManagerOptions {
  authedFetch: AuthedFetch;
  session: SessionState | null;
  onNotify: AppNotify;
}

/**
 * 机密管理器的数据与操作。
 *
 * 放在 App 层而不是各页面自己取数：项目 / 机密 / 回收站三个页面共用同一份 state，
 * 且 demo 模式要能整体替换数据源（仓库里页面数据一律 props 驱动）。
 *
 * ⚠️ 组织密钥未就绪（会话未解锁）时 `ready` 为 false：此时任何读写都会失败。
 */
export interface SecretsManagerProps {
  ready: boolean;
  loading: boolean;
  error: string;
  projects: SecretProject[];
  secrets: SecretSummary[];
  /** 选中机密的完整内容（含值 / 备注）；列表端点是拿不到的。 */
  selectedSecret: SecretDetail | null;
  selectedSecretLoading: boolean;
  trash: TrashedSecret[];
  /** 选中条目后才拉的完整内容（含值 / 备注）。 */
  trashDetail: TrashedSecretDetail | null;
  trashLoading: boolean;
  onSelectTrash: (id: string) => void;
  onSelectSecret: (id: string) => void;
  onClearSelection: () => void;
  onRefresh: () => Promise<void>;
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (id: string, name: string) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  onCreateSecret: (input: SecretInput) => Promise<void>;
  onUpdateSecret: (id: string, input: SecretInput) => Promise<void>;
  onDeleteSecret: (id: string) => Promise<void>;
  onDeleteSecrets: (ids: string[]) => Promise<void>;
  onLoadTrash: () => Promise<void>;
  onRestoreTrash: (ids: string[]) => Promise<void>;
  onPurgeTrash: (ids: string[]) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function useSecretsManager(options: UseSecretsManagerOptions): SecretsManagerProps {
  const { authedFetch, session, onNotify } = options;
  const demoMode = IS_DEMO_MODE;

  const [context, setContext] = useState<SecretsContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [liveProjects, setLiveProjects] = useState<SecretProject[]>([]);
  const [liveSecrets, setLiveSecrets] = useState<SecretSummary[]>([]);
  const [liveTrash, setLiveTrash] = useState<TrashedSecret[]>([]);
  const [trashDetailId, setTrashDetailId] = useState<string | null>(null);
  const [liveTrashDetail, setLiveTrashDetail] = useState<TrashedSecretDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveDetail, setLiveDetail] = useState<SecretDetail | null>(null);
  const [selectedSecretLoading, setSelectedSecretLoading] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);

  // `session` / `authedFetch` 每次 render 都是新对象，直接进依赖会让取数反复触发
  // ⇒ 只看真正影响结果的字段，其余用 ref 取最新值。
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const fetcherRef = useRef(authedFetch);
  fetcherRef.current = authedFetch;
  // `refresh` 要能读到「当前选中哪条」但又不因选中变化而换标识（否则每次点条目都会重拉列表）
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const accessToken = session?.accessToken ?? '';
  const keyMaterial = `${session?.symEncKey ?? ''}|${session?.symMacKey ?? ''}`;

  // demo 模式：数据来自静态演示集，写操作一律只读提示（不发请求、不落库）
  const demoSources = useMemo(
    () => ({
      projects: SECRETS_DEMO_PROJECTS.map(({ id, name, createdAt, revisionDate }): SecretProject => ({
        id,
        name,
        creationDate: createdAt,
        revisionDate,
      })),
      secrets: SECRETS_DEMO_SECRETS.map(({ id, name, projectIds, createdAt, revisionDate }): SecretSummary => ({
        id,
        name,
        projectIds,
        creationDate: createdAt,
        revisionDate,
      })),
      trash: SECRETS_DEMO_TRASH.map(({ id, name, projectIds, revisionDate }): TrashedSecret => ({
        id,
        name,
        projectIds,
        deletedAt: revisionDate,
      })),
    }),
    []
  );

  // demo 的回收站详情同样按选中项从演示集里取
  const demoTrashDetail = useMemo((): TrashedSecretDetail | null => {
    const found = SECRETS_DEMO_TRASH.find((item) => item.id === trashDetailId);
    if (!found) return null;
    return {
      id: found.id,
      name: found.name,
      value: found.value,
      note: found.note,
      projectIds: found.projectIds,
      deletedAt: found.revisionDate,
    };
  }, [trashDetailId]);

  /** 取某条机密的详情（列表里根本没有 value / note，所以详情得单独取）。 */
  const loadDetail = useCallback(
    async (ctx: SecretsContext, id: string, showSpinner = true): Promise<void> => {
      if (showSpinner) setSelectedSecretLoading(true);
      try {
        const details = await getSecretsByIds(fetcherRef.current, ctx, [id]);
        setLiveDetail(details[0] ?? null);
      } catch (err) {
        setLiveDetail(null);
        onNotify('error', messageOf(err));
      } finally {
        if (showSpinner) setSelectedSecretLoading(false);
      }
    },
    [onNotify]
  );

  const refresh = useCallback(async () => {
    const current = sessionRef.current;
    if (demoMode || !current) return;
    setLoading(true);
    setError('');
    try {
      const nextContext = await ensureSecretsContext(fetcherRef.current, current);
      const listed = await listSecrets(fetcherRef.current, nextContext);
      setContext(nextContext);
      setLiveSecrets(listed.secrets);
      setLiveProjects(listed.projects);
      // ⚠️ 选中的那条也得重取：列表里没有 value / note，而且项目 / 备注改完不重取的话，
      // 详情会一直停在旧值（要再点一次条目才更新）。静默刷新，别把面板闪成「加载中」。
      const selected = selectedIdRef.current;
      if (selected && listed.secrets.some((secret) => secret.id === selected)) {
        await loadDetail(nextContext, selected, false);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [demoMode, loadDetail]);

  useEffect(() => {
    void refresh();
  }, [refresh, accessToken, keyMaterial]);

  // 别人（CLI / 其它设备）改了机密与项目 ⇒ 整页刷新（列表、项目与选中项详情）。
  // 自己那次由 `App.tsx` 按标签页标识挡掉。
  useEffect(
    () =>
      onSecretsManagerChange((kind) => {
        if (kind !== 'secrets') return;
        void refresh();
      }),
    [refresh]
  );

  const projects = demoMode ? demoSources.projects : liveProjects;
  const secrets = demoMode ? demoSources.secrets : liveSecrets;
  const trash = demoMode ? demoSources.trash : liveTrash;

  // 选中的机密可能已经不在列表里（被删 / 换了筛选），清掉避免显示幽灵详情
  useEffect(() => {
    if (selectedId && !secrets.some((secret) => secret.id === selectedId)) {
      setSelectedId(null);
      setLiveDetail(null);
    }
  }, [secrets, selectedId]);

  // demo 的详情直接取自演示集（那里本来就存着明文值）
  const demoDetail = useMemo((): SecretDetail | null => {
    const found = SECRETS_DEMO_SECRETS.find((secret) => secret.id === selectedId);
    if (!found) return null;
    return {
      id: found.id,
      name: found.name,
      projectIds: found.projectIds,
      creationDate: found.createdAt,
      revisionDate: found.revisionDate,
      value: found.value,
      note: found.note,
    };
  }, [selectedId]);

  const selectedSecret = demoMode ? demoDetail : liveDetail;
  const ready = demoMode || !!context;

  const selectSecret = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (demoMode) return;
      const current = context;
      if (!current) return;
      void loadDetail(current, id);
    },
    [context, demoMode, loadDetail]
  );

  /**
   * 统一的操作包装（成功提示 / 刷新 / 失败透出文案见 `useActionRunner`）。
   * 这里只多一层：把已就绪的组织上下文交给调用方。
   */
  const run = useActionRunner({ onNotify, demoMode, reload: refresh });
  const runAction = useCallback(
    async (action: (ctx: SecretsContext) => Promise<unknown>, successText: string): Promise<void> => {
      const current = context;
      // 还没有组织上下文 ⇒ 静默返回（不是失败，不该弹错误）
      if (!current) return;
      await run(() => action(current), successText);
    },
    [context, run]
  );

  return {
    ready,
    loading: demoMode ? false : loading,
    error: demoMode ? '' : error,
    projects,
    secrets,
    selectedSecret,
    selectedSecretLoading: demoMode ? false : selectedSecretLoading,
    trash,
    trashDetail: demoMode ? demoTrashDetail : liveTrashDetail,
    trashLoading: demoMode ? false : trashLoading,
    onSelectSecret: selectSecret,
    onClearSelection: useCallback(() => {
      setSelectedId(null);
      setLiveDetail(null);
    }, []),
    onRefresh: refresh,
    onCreateProject: (name) =>
      runAction((ctx) => createSecretProject(fetcherRef.current, ctx, name), t('txt_saved')),
    onRenameProject: (id, name) =>
      runAction((ctx) => updateSecretProject(fetcherRef.current, ctx, id, name), t('txt_saved')),
    onDeleteProject: (id) =>
      runAction((ctx) => deleteSecretProjects(fetcherRef.current, ctx, [id]), t('txt_deleted')),
    onCreateSecret: (input) =>
      runAction((ctx) => createSecret(fetcherRef.current, ctx, input), t('txt_saved')),
    onUpdateSecret: (id, input) =>
      runAction((ctx) => updateSecret(fetcherRef.current, ctx, id, input), t('txt_saved')),
    onDeleteSecret: (id) =>
      runAction(async (ctx) => {
        await deleteSecrets(fetcherRef.current, ctx, [id]);
        setSelectedId(null);
        setLiveDetail(null);
      }, t('txt_deleted')),
    onDeleteSecrets: (ids) =>
      runAction(async (ctx) => {
        await deleteSecrets(fetcherRef.current, ctx, ids);
        setSelectedId(null);
        setLiveDetail(null);
      }, t('txt_deleted')),
    onLoadTrash: useCallback(async () => {
      if (demoMode) return;
      const current = context;
      if (!current) return;
      setTrashLoading(true);
      try {
        setLiveTrash(await listTrashedSecrets(fetcherRef.current, current));
      } catch (err) {
        onNotify('error', messageOf(err));
      } finally {
        setTrashLoading(false);
      }
    }, [context, demoMode, onNotify]),
    onSelectTrash: useCallback(
      (id: string) => {
        setTrashDetailId(id);
        setLiveTrashDetail(null);
        if (demoMode) return;
        const current = context;
        if (!current) return;
        void getTrashedSecret(fetcherRef.current, current, id)
          .then((detail) => setLiveTrashDetail(detail))
          .catch((err) => {
            setLiveTrashDetail(null);
            onNotify('error', messageOf(err));
          });
      },
      [context, demoMode, onNotify]
    ),
    onRestoreTrash: (ids) =>
      runAction(async (ctx) => {
        await restoreTrashedSecrets(fetcherRef.current, ctx, ids);
        setLiveTrash(await listTrashedSecrets(fetcherRef.current, ctx));
      }, t('txt_restored')),
    onPurgeTrash: (ids) =>
      runAction(async (ctx) => {
        await purgeTrashedSecrets(fetcherRef.current, ctx, ids);
        setLiveTrash(await listTrashedSecrets(fetcherRef.current, ctx));
      }, t('txt_deleted')),
  };
}
