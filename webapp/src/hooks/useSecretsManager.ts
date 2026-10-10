import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  createSecret,
  createSecretProject,
  decryptSecretDetail,
  deleteSecretProjects,
  deleteSecrets,
  ensureOfflineSecretsContext,
  resolveSecretsContext,
  getOfflineSecretDetail,
  getOfflineTrashedSecretDetail,
  getSecretsByIds,
  getTrashedSecret,
  listSecretTags,
  listSecrets,
  listTrashedSecrets,
  loadOfflineSecretDetails,
  loadOfflineSecrets,
  loadOfflineSecretTags,
  saveSecretTag,
  loadOfflineTrash,
  purgeTrashedSecrets,
  refreshSecretsOfflineSnapshot,
  restoreTrashedSecrets,
  updateSecret,
  setSecretsProjects,
  updateSecretProject,
  type RawSecretDetail,
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
import { backendUnreachable as sharedBackendUnreachable, browserReportsOffline, subscribeNetworkStatus } from '@/lib/network-status';
import { SECRETS_DEMO_PROJECTS, SECRETS_DEMO_SECRETS, SECRETS_DEMO_TRASH } from '@/lib/secrets-demo';
import { onSecretsManagerChange } from '@/lib/secrets-realtime';
import type { SessionState } from '@/lib/types';
import { useActionRunner, type AppNotify } from './useActionRunner';

interface UseSecretsManagerOptions {
  authedFetch: AuthedFetch;
  session: SessionState | null;
  onNotify: AppNotify;
  /** 离线缓存的键（`profile.id` 优先、回落邮箱）—— 与密码库同一口径，由 App 计算后传入。 */
  offlineCacheKey: string;
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
  /** 数据来自本地缓存（离线只读）：写操作会被挡下并提示，不改变界面形态。 */
  offline: boolean;
  projects: SecretProject[];
  secrets: SecretSummary[];
  /** 机密 id → 标签明文（列表分组与详情显示用）。 */
  tags: Record<string, string>;
  /** 已用过的标签（编辑器候选；与当前筛选无关）。 */
  tagOptions: string[];
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
  /** 批量调整所属项目（逐条给各自的集合）。 */
  onSetSecretsProjects: (assignments: ReadonlyArray<{ id: string; projectIds: string[] }>) => Promise<void>;
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (id: string, name: string) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  /**
   * 新建 / 更新机密。
   * 标签**不进 `SecretInput`**（那是官方线格式的形状），作为独立参数传：空串 = 清除标签。
   * `contentChanged` = 名称 / 值 / 备注 / 项目是否有变：**只改了标签时不发官方 PUT**，
   * 否则那条 PUT 会无谓推进 `revision_date`（CLI 会以为机密变了、离线快照也会整份重拉）。
   */
  onCreateSecret: (input: SecretInput, tag: string) => Promise<void>;
  onUpdateSecret: (id: string, input: SecretInput, tag: string, contentChanged: boolean) => Promise<void>;
  onDeleteSecret: (id: string) => Promise<void>;
  onDeleteSecrets: (ids: string[]) => Promise<void>;
  onLoadTrash: () => Promise<void>;
  onRestoreTrash: (ids: string[]) => Promise<void>;
  onPurgeTrash: (ids: string[]) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 写结果缓存的键：同一条机密换了 `revisionDate` 就是另一份内容（两份不能混用）。 */
function writtenDetailKey(id: string, revisionDate: string): string {
  return `${id}:${revisionDate}`;
}

export default function useSecretsManager(options: UseSecretsManagerOptions): SecretsManagerProps {
  const { authedFetch, session, onNotify, offlineCacheKey } = options;
  const demoMode = IS_DEMO_MODE;

  const [context, setContext] = useState<SecretsContext | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [liveProjects, setLiveProjects] = useState<SecretProject[]>([]);
  const [liveSecrets, setLiveSecrets] = useState<SecretSummary[]>([]);
  /** 机密 id → 标签明文（仅 Web 扩展字段）。 */
  const [tagsBySecretId, setTagsBySecretId] = useState<Record<string, string>>({});
  /** 已用过的标签（可复用给编辑器候选），去重排序。 */
  const [allTags, setAllTags] = useState<string[]>([]);
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
  // 离线只读状态：用 ref 同步一份，免得写进回调依赖后反复换标识（见下方无限重拉的教训）
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const offlineCacheKeyRef = useRef(offlineCacheKey);
  offlineCacheKeyRef.current = offlineCacheKey;
  /** 「已保存的标签」得在异步动作里读到最新值（比较后才决定要不要发请求）。 */
  const tagsRef = useRef<Record<string, string>>({});
  /**
   * 列表里每条机密的最新 `revisionDate`：判「内存索引 / 本地快照里那份是否落后」。
   * `liveSecrets` 是 state，同一轮异步里 set 完还没重渲染就得读到 ⇒ 与 `offlineRef` 一样同步写一份。
   */
  const revisionsRef = useRef<Record<string, string>>({});
  const rememberRevisions = useCallback((next: SecretSummary[]) => {
    const map: Record<string, string> = {};
    for (const secret of next) map[secret.id] = secret.revisionDate;
    revisionsRef.current = map;
  }, []);
  /** 内存索引：最近一次快照的**含值密文**。点条目时先查它，命中就只剩解密（同帧完成）。 */
  const rawDetailsRef = useRef<Map<string, RawSecretDetail>>(new Map());
  /** 索引来自哪个组织 —— 换过组织就不能再留（那批密文是另一把密钥加密的，解出来是乱码）。 */
  const rawDetailsOrgRef = useRef('');
  const rememberRawDetails = useCallback((ctx: SecretsContext, rows: RawSecretDetail[]) => {
    const index = new Map<string, RawSecretDetail>();
    for (const row of rows) if (row?.id) index.set(row.id, row);
    rawDetailsRef.current = index;
    rawDetailsOrgRef.current = ctx.organizationId;
  }, []);
  /**
   * 从缓存读含值密文建索引。⚠️「没读到」（`null`）时**保留旧索引**（那份密文还能用，判定靠
   * `revisionDate`）—— 清掉等于把点击全部退回网络；只有换过组织才允许丢。
   */
  const warmRawDetails = useCallback(
    async (ctx: SecretsContext): Promise<void> => {
      const cacheKey = offlineCacheKeyRef.current;
      if (!cacheKey) return;
      const rows = await loadOfflineSecretDetails(ctx, cacheKey);
      if (!rows) {
        if (rawDetailsOrgRef.current !== ctx.organizationId) rememberRawDetails(ctx, []);
        return;
      }
      rememberRawDetails(ctx, rows);
    },
    [rememberRawDetails]
  );
  /** 刚写过的那一条（`id:revisionDate` → 详情）：刚写完点开要立刻看到，而内存索引里那份密文要下次刷新才回吐。 */
  const writtenDetailsRef = useRef<Map<string, SecretDetail>>(new Map());
  /** 标签就地更新（写成功后的补丁；候选清单只加不减 —— 用过的标签留着）。 */
  const applyTagLocally = useCallback((id: string, tag: string) => {
    const next = tag.trim();
    const map = { ...tagsRef.current };
    if (next) map[id] = next;
    else delete map[id];
    tagsRef.current = map;
    setTagsBySecretId(map);
    if (!next) return;
    setAllTags((current) =>
      current.includes(next) ? current : [...current, next].sort((a, b) => a.localeCompare(b))
    );
  }, []);
  /**
   * 写成功后**就地打补丁**：列表立刻反映这次改动（服务端已确认，不必等随后的整页刷新）。
   * 那次刷新降级为**校准** —— 标签候选、`revisionDate`、离线快照仍由它照旧维护。
   */
  const applySecretWrite = useCallback((detail: SecretDetail) => {
    setLiveSecrets((current) => {
      const summary: SecretSummary = {
        id: detail.id,
        name: detail.name,
        projectIds: detail.projectIds,
        creationDate: detail.creationDate,
        revisionDate: detail.revisionDate,
      };
      const index = current.findIndex((item) => item.id === summary.id);
      if (index < 0) return [...current, summary];
      const next = current.slice();
      next[index] = summary;
      return next;
    });
    revisionsRef.current = { ...revisionsRef.current, [detail.id]: detail.revisionDate };
    const written = writtenDetailsRef.current;
    if (written.size > 20) written.clear();
    written.set(writtenDetailKey(detail.id, detail.revisionDate), detail);
  }, []);
  /** 软删成功后就地从列表里拿掉，并把 revision 表 / 标签映射 / 内存索引里的对应项一并清掉。 */
  const removeSecretsLocally = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids);
    setLiveSecrets((current) => current.filter((item) => !gone.has(item.id)));
    const revisions = { ...revisionsRef.current };
    const tags = { ...tagsRef.current };
    for (const id of gone) {
      delete revisions[id];
      delete tags[id];
      rawDetailsRef.current.delete(id);
    }
    revisionsRef.current = revisions;
    tagsRef.current = tags;
    setTagsBySecretId(tags);
  }, []);
  /** 批量调整项目后就地改列表里的 `projectIds`（改动是我们发出去的，不必等回应）。 */
  const applySecretProjectsLocally = useCallback(
    (assignments: ReadonlyArray<{ id: string; projectIds: string[] }>) => {
      const byId = new Map(assignments.map((item) => [item.id, item.projectIds]));
      setLiveSecrets((current) =>
        current.map((item) => (byId.has(item.id) ? { ...item, projectIds: byId.get(item.id) ?? [] } : item))
      );
    },
    []
  );
  const accessToken = session?.accessToken ?? '';
  const keyMaterial = `${session?.symEncKey ?? ''}|${session?.symMacKey ?? ''}`;

  const backendUnreachable = useCallback(
    () => sharedBackendUnreachable({ hasAccessToken: !!sessionRef.current?.accessToken }),
    []
  );

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

  /** 离线状态要同步写 ref：同一轮里后面的回调（如 `loadDetail`）也得立刻看到新值。 */
  const setOfflineState = useCallback((value: boolean) => {
    offlineRef.current = value;
    setOffline(value);
  }, []);

  /**
   * 取某条机密的详情（列表里根本没有 value / note，所以详情得单独取）。
   *
   * 三级，**顺序不能改** —— 取数落在同一帧内是「点开 / 切换没有中间帧」的唯一条件：
   * ① 内存索引里的含值密文（只解密）；② 本地快照（读一次 IndexedDB）；③ 网络 `get-by-ids`。
   * 三级都要求 `revisionDate` 与列表一致：编辑会推进它，而 `refresh` 先刷列表再取详情 ⇒
   * 刚改过的条目不会命中旧密文。
   * ⚠️ 加载态只能放在 ③：提到函数开头会给 ①② 也画出一帧「加载中」。
   */
  const loadDetail = useCallback(
    async (ctx: SecretsContext, id: string, showSpinner = true): Promise<void> => {
      try {
        const revision = revisionsRef.current[id];
        // ⓪ 刚写过的那一条：同步命中 ⇒ 连一帧中间态都不会有
        const written = revision ? writtenDetailsRef.current.get(writtenDetailKey(id, revision)) : undefined;
        if (written) {
          setLiveDetail(written);
          return;
        }
        const raw = revision ? rawDetailsRef.current.get(id) : undefined;
        if (raw && raw.revisionDate === revision) {
          setLiveDetail(await decryptSecretDetail(raw, ctx));
          return;
        }
        const cacheKey = offlineCacheKeyRef.current;
        const local = cacheKey ? await getOfflineSecretDetail(ctx, cacheKey, id) : null;
        // 离线时快照就是全部内容；在线时要求它与列表同一版
        if (local && (offlineRef.current || local.revisionDate === revision)) {
          setLiveDetail(local);
          return;
        }
        if (offlineRef.current) {
          setLiveDetail(null);
          onNotify('error', t('txt_sm_offline_content_unavailable'));
          return;
        }
        if (showSpinner) setSelectedSecretLoading(true);
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

  /**
   * 用本地快照重建整套数据（离线只读）。
   * ⚠️ 组织密钥从缓存里的**包裹**解出（用户密钥加密）；拿不到（没缓存 / 换过账号或主密码）
   * 就返回 `false`，让调用方把真实的联网错误透给用户。
   */
  const applyOfflineSnapshot = useCallback(
    async (currentSession: SessionState): Promise<boolean> => {
      const cacheKey = offlineCacheKeyRef.current;
      if (!cacheKey) return false;
      try {
        const nextContext = await ensureOfflineSecretsContext(currentSession, cacheKey);
        if (!nextContext) return false;
        const listed = await loadOfflineSecrets(nextContext, cacheKey);
        if (!listed) return false;
        // 先翻状态再取详情：`loadDetail` 据此走离线分支
        setOfflineState(true);
        setContext(nextContext);
        setLiveSecrets(listed.secrets);
        rememberRevisions(listed.secrets);
        void warmRawDetails(nextContext);
        setLiveProjects(listed.projects);
        // 标签与列表分开缓存（官方载荷里没有它），离线时同样要能分组
        const tags = await loadOfflineSecretTags(nextContext, cacheKey);
        setTagsBySecretId(tags.tagsBySecretId);
        setAllTags(tags.allTags);
        const selected = selectedIdRef.current;
        if (selected) await loadDetail(nextContext, selected, false);
        return true;
      } catch {
        return false;
      }
    },
    [loadDetail, setOfflineState, rememberRevisions, warmRawDetails]
  );

  /**
   * 重新取数。`null` = 成功；返回文案表示失败 —— 是否给反馈由调用点决定
   * （自动加载 / 实时推送不弹，手动「同步」才弹）。
   *
   * `skipTags` / `skipTrash` = 写操作之后的**轻量校准**：标签已由就地补丁维护、回收站的离线副本
   * 晚一步更新（在线打开回收站页时有自己的请求）⇒ 一次写完之后只剩「列表 + 续写快照」。
   */
  const refresh = useCallback(async (options?: { skipTags?: boolean; skipTrash?: boolean }): Promise<string | null> => {
    const current = sessionRef.current;
    if (demoMode || !current) return null;
    setLoading(true);
    setError('');
    try {
      // 后端不可达（含浏览器自报离线）⇒ 不白等两个必然失败的请求
      if (backendUnreachable()) {
        if (await applyOfflineSnapshot(current)) return null;
        const offlineMessage = t('txt_offline_unavailable');
        setError(offlineMessage);
        return offlineMessage;
      }
      const nextContext = await resolveSecretsContext(fetcherRef.current, current);
      // 标签与列表并行取（多一次请求，换来分组与候选；失败不影响主流程）。
      // 写后校准（`skipTags`）不取：标签已由就地补丁维护。
      const [listed, tags] = await Promise.all([
        listSecrets(fetcherRef.current, nextContext),
        options?.skipTags ? Promise.resolve(null) : listSecretTags(fetcherRef.current, nextContext).catch(() => null),
      ]);
      setOfflineState(false);
      setContext(nextContext);
      setLiveSecrets(listed.secrets);
      // 同步记下新版 `revisionDate`：本轮稍后的 `loadDetail` 要据此判断快照能不能用
      rememberRevisions(listed.secrets);
      setLiveProjects(listed.projects);
      // 取失败时**保留上一次的**标签：宁可分组稍旧，也不要凭空把分组抹掉（类似快照的「宁旧勿空」）。
      if (tags) {
        setTagsBySecretId(tags.tagsBySecretId);
        setAllTags(tags.allTags);
      }
      // 后台补快照：签名没变时它一次请求都不发；变了也只取变更的那几条密文
      // （见 `refreshSecretsOfflineSnapshot`）。`null` = 这次没取到标签 ⇒ 保留缓存里的旧标签，别抹掉
      void refreshSecretsOfflineSnapshot(
        fetcherRef.current,
        nextContext,
        offlineCacheKeyRef.current,
        listed.raw,
        tags?.raw ?? null,
        { skipTrash: options?.skipTrash }
      ).then((secrets) => {
        // 快照交回的那批密文直接建索引（省掉再读一遍 IndexedDB）；没交回时回退读盘
        if (secrets) rememberRawDetails(nextContext, secrets);
        else void warmRawDetails(nextContext);
      });
      // ⚠️ 选中的那条也得重取：列表里没有 value / note，而且项目 / 备注改完不重取的话，
      // 详情会一直停在旧值（要再点一次条目才更新）。静默刷新，别把面板闪成「加载中」。
      const selected = selectedIdRef.current;
      if (selected && listed.secrets.some((secret) => secret.id === selected)) {
        await loadDetail(nextContext, selected, false);
      }
      return null;
    } catch (err) {
      // 请求发出后才断网 ⇒ 回落缓存；真的没有快照才把错误透给用户
      // （连不上时 `authedFetch` 已经换成本地化的离线文案，不用在这儿再判一次）
      if (await applyOfflineSnapshot(current)) return null;
      const message = messageOf(err);
      setError(message);
      return message;
    } finally {
      setLoading(false);
    }
  }, [demoMode, loadDetail, applyOfflineSnapshot, setOfflineState, backendUnreachable, rememberRevisions, warmRawDetails, rememberRawDetails]);

  useEffect(() => {
    void refresh();
  }, [refresh, accessToken, keyMaterial]);

  // 网络恢复 ⇒ 自动切回在线数据（离线时页面上挂的是旧快照）
  useEffect(
    () =>
      subscribeNetworkStatus((status) => {
        if (status === 'online') void refresh();
      }),
    [refresh]
  );

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

  /** 「同步」按钮：只在手动点击时给反馈（挂载加载与实时推送的刷新不弹）。 */
  const syncNow = useCallback(async (): Promise<void> => {
    if (offlineRef.current) {
      onNotify('error', t('txt_sm_offline_readonly'));
      return;
    }
    const failure = await refresh();
    if (failure) onNotify('error', failure);
    else onNotify('success', t('txt_secrets_synced'));
  }, [refresh, onNotify]);

  const projects = demoMode ? demoSources.projects : liveProjects;
  const secrets = demoMode ? demoSources.secrets : liveSecrets;
  const trash = demoMode ? demoSources.trash : liveTrash;
  // 演示集里没有标签概念 ⇒ 演示下两组都空（分组退化成扁平列表）
  const tags = demoMode ? {} : tagsBySecretId;
  const tagOptions = demoMode ? [] : allTags;
  tagsRef.current = tags;

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
   * 校准分两条：默认**轻量**（就地补丁已维护标签与回收站）；会改变「按标签分组」的动作
   * （恢复回收站条目）用完整的。
   */
  const calibrate = useCallback(() => refresh({ skipTags: true, skipTrash: true }), [refresh]);
  const run = useActionRunner({ onNotify, demoMode, reload: calibrate });
  const runWithTags = useActionRunner({ onNotify, demoMode, reload: refresh });

  /**
   * 标签只在**真的变了**时才发请求（避免每次编辑都白写一次），空串 = 清除。
   * 两端 trim：服务端不归一化，但手滑多一个空格会凭空多出一个分组。
   */
  const saveTagIfChanged = useCallback(
    async (ctx: SecretsContext, id: string, tag: string): Promise<void> => {
      const next = tag.trim();
      const current = tagsRef.current[id] ?? '';
      if (next === current) return;
      await saveSecretTag(fetcherRef.current, ctx, id, next === '' ? null : next);
    },
    []
  );
  const runAction = useCallback(
    async (
      action: (ctx: SecretsContext) => Promise<unknown>,
      successText: string,
      /** 恢复回收站条目会连标签一起变（条目回到带标签的分组）⇒ 校准要完整跑一次 */
      options?: { withTags?: boolean }
    ): Promise<void> => {
      // 离线只读：写操作在本地拦下（按钮保留，反馈走既有 toast 机制，与密码库同一口径）
      if (offlineRef.current) {
        onNotify('error', t('txt_sm_offline_readonly'));
        return;
      }
      const current = context;
      // 还没有组织上下文 ⇒ 静默返回（不是失败，不该弹错误）
      if (!current) return;
      await (options?.withTags ? runWithTags : run)(() => action(current), successText);
    },
    [context, run, onNotify]
  );

  return {
    ready,
    loading: demoMode ? false : loading,
    error: demoMode ? '' : error,
    offline: demoMode ? false : offline,
    /** 机密 id → 标签明文（列表分组与详情显示）。 */
    tags,
    /** 已用过的标签（编辑器候选；不随当前筛选变化）。 */
    tagOptions,
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
    onRefresh: syncNow,
    onSetSecretsProjects: (assignments) =>
      runAction(async (ctx) => {
        await setSecretsProjects(fetcherRef.current, ctx, assignments);
        applySecretProjectsLocally(assignments);
      }, t('txt_saved')),
    onCreateProject: (name) =>
      runAction((ctx) => createSecretProject(fetcherRef.current, ctx, name), t('txt_saved')),
    onRenameProject: (id, name) =>
      runAction((ctx) => updateSecretProject(fetcherRef.current, ctx, id, name), t('txt_saved')),
    onDeleteProject: (id) =>
      runAction((ctx) => deleteSecretProjects(fetcherRef.current, ctx, [id]), t('txt_deleted')),
    onCreateSecret: (input, tag) =>
      runAction(async (ctx) => {
        const created = await createSecret(fetcherRef.current, ctx, input);
        await saveTagIfChanged(ctx, created.id, tag);
        // 服务端已确认 ⇒ 就地补上列表与标签，不等随后那次校准刷新
        applySecretWrite(created);
        applyTagLocally(created.id, tag);
      }, t('txt_saved')),
    onUpdateSecret: (id, input, tag, contentChanged) =>
      runAction(async (ctx) => {
        // 只有内容真的变了才发官方 PUT（见 props 上的说明）
        if (contentChanged) applySecretWrite(await updateSecret(fetcherRef.current, ctx, id, input));
        await saveTagIfChanged(ctx, id, tag);
        applyTagLocally(id, tag);
      }, t('txt_saved')),
    onDeleteSecret: (id) =>
      runAction(async (ctx) => {
        await deleteSecrets(fetcherRef.current, ctx, [id]);
        removeSecretsLocally([id]);
        setSelectedId(null);
        setLiveDetail(null);
      }, t('txt_deleted')),
    onDeleteSecrets: (ids) =>
      runAction(async (ctx) => {
        await deleteSecrets(fetcherRef.current, ctx, ids);
        removeSecretsLocally(ids);
        setSelectedId(null);
        setLiveDetail(null);
      }, t('txt_deleted')),
    onLoadTrash: useCallback(async () => {
      if (demoMode) return;
      const current = context;
      if (!current) return;
      setTrashLoading(true);
      try {
        if (offlineRef.current || browserReportsOffline()) {
          const cached = await loadOfflineTrash(current, offlineCacheKeyRef.current);
          if (cached) setLiveTrash(cached);
          return;
        }
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
        if (offlineRef.current) {
          // 回收站没有批量详情接口 ⇒ 只有「在线看过内容」的那几条在本地有密文
          void getOfflineTrashedSecretDetail(current, offlineCacheKeyRef.current, id)
            .then((detail) => {
              setLiveTrashDetail(detail);
              if (!detail) onNotify('error', t('txt_sm_offline_content_unavailable'));
            })
            .catch(() => setLiveTrashDetail(null));
          return;
        }
        void getTrashedSecret(fetcherRef.current, current, id, offlineCacheKeyRef.current)
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
      }, t('txt_restored'), { withTags: true }),
    onPurgeTrash: (ids) =>
      runAction(async (ctx) => {
        await purgeTrashedSecrets(fetcherRef.current, ctx, ids);
        setLiveTrash(await listTrashedSecrets(fetcherRef.current, ctx));
      }, t('txt_deleted')),
  };
}
