import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ArrowUpDown,
  Check,
  CheckCheck,
  ChevronDown,
  Eye,
  EyeOff,
  Folder as FolderIcon,
  FolderPlus,
  FolderX,
  LayoutGrid,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-preact';
import ConfirmDialog from '@/components/ConfirmDialog';
import MobileFilterMenu from '@/components/MobileFilterMenu';
import type { MobileFilterOption } from '@/components/MobileFilterMenu';
import type { SecretsManagerProps } from '@/hooks/useSecretsManager';
import type { SecretInput } from '@/lib/api/secrets';
import { t } from '@/lib/i18n';

/**
 * 机密（Secrets）：左侧筛选、中间列表、右侧详情 —— 骨架与交互照密码库。
 *
 * ⚠️ 列表端点**不返回值 / 备注**（官方契约）⇒ 选中某条时要再取一次才有内容。
 * 回收站同理：列表只回标识，值走 `GET /api/secrets/trash/{id}`。
 */
export interface SecretsPageProps {
  /** 是否移动端布局（由 `App.tsx` 的 matchMedia(≤1180px) 提供）。 */
  mobileLayout: boolean;
  manager: SecretsManagerProps;
}

const EMPTY_DRAFT: SecretInput = { key: '', value: '', note: '', projectIds: [] };
const day = (iso: string): string => (iso ? iso.slice(0, 10) : '—');

/**
 * 左栏筛选。**「未分配」是真实存在的状态**：删掉一个 project 时它的关联被级联删除、
 * 机密本体保留 ⇒ 只属于那个项目的机密就失去了归属。
 */
type SecretsFilter = { kind: 'all' } | { kind: 'unassigned' } | { kind: 'project'; projectId: string };
type SortMode = 'edited' | 'created' | 'name';

/** 排序比较器；`name` 用 `localeCompare` 才符合各语言的字符顺序。 */
type Sortable = { name: string; creationDate?: string; revisionDate?: string };
function compareBy(mode: SortMode): (a: Sortable, b: Sortable) => number {
  if (mode === 'name') return (a, b) => a.name.localeCompare(b.name);
  if (mode === 'created') return (a, b) => (b.creationDate ?? '').localeCompare(a.creationDate ?? '');
  return (a, b) => (b.revisionDate ?? '').localeCompare(a.revisionDate ?? '');
}

export default function SecretsPage(props: SecretsPageProps) {
  const { mobileLayout, manager } = props;
  const {
    onLoadTrash,
    onSelectSecret,
    onClearSelection,
    onCreateSecret,
    onUpdateSecret,
    onDeleteSecret,
    onDeleteSecrets,
    onRestoreTrash,
    onPurgeTrash,
    onSelectTrash,
  } = manager;

  const [projectFilter, setProjectFilter] = useState<SecretsFilter>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'secrets' | 'trash'>('secrets');
  const [sortMode, setSortMode] = useState<SortMode>('edited');
  const [projectSortMode, setProjectSortMode] = useState<SortMode>('name');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [projectSortMenuOpen, setProjectSortMenuOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const projectSortMenuRef = useRef<HTMLDivElement | null>(null);

  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ id: string | null; input: SecretInput } | null>(null);
  const [valueRevealed, setValueRevealed] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'list' | 'detail'>('list');
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [renamingProject, setRenamingProject] = useState<{ id: string; name: string } | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const [trashSelectedId, setTrashSelectedId] = useState<string | null>(null);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmDeleteSecretId, setConfirmDeleteSecretId] = useState<string | null>(null);
  const [confirmPurgeSecretId, setConfirmPurgeSecretId] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<'delete' | 'purge' | null>(null);

  useEffect(() => {
    if (mobileLayout) return;
    setMobilePanel('list');
  }, [mobileLayout]);

  // 进回收站才拉取：正常浏览不该为它付一次请求。
  // ⚠️ 依赖必须是具体函数引用，不能是 `manager` —— 后者每轮 render 都是新对象。
  useEffect(() => {
    if (view !== 'trash') return;
    onClearSelection();
    setDraft(null);
    setCheckedIds(new Set());
    void onLoadTrash();
  }, [view, onLoadTrash, onClearSelection]);

  // 两个下拉与项目下拉都靠点击外部关闭（与密码库的排序菜单同形）
  useEffect(() => {
    if (!sortMenuOpen && !projectSortMenuOpen && !projectMenuOpen) return;
    const onDocumentDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!sortMenuRef.current?.contains(target)) setSortMenuOpen(false);
      if (!projectSortMenuRef.current?.contains(target)) setProjectSortMenuOpen(false);
      if (!projectMenuRef.current?.contains(target)) setProjectMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocumentDown);
    return () => document.removeEventListener('mousedown', onDocumentDown);
  }, [sortMenuOpen, projectSortMenuOpen, projectMenuOpen]);

  const visibleSecrets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return manager.secrets
      .filter((secret) => {
        if (projectFilter.kind === 'unassigned' && secret.projectIds.length > 0) return false;
        if (projectFilter.kind === 'project' && !secret.projectIds.includes(projectFilter.projectId)) return false;
        if (!needle) return true;
        return secret.name.toLowerCase().includes(needle);
      })
      .sort(compareBy(sortMode));
  }, [manager.secrets, projectFilter, query, sortMode]);

  const sortedProjects = useMemo(() => manager.projects.slice().sort(compareBy(projectSortMode)), [manager.projects, projectSortMode]);

  const projectName = useMemo(() => {
    const byId = new Map(manager.projects.map((project) => [project.id, project.name]));
    // 空 = 未分配（包含「挂载的 project 已被删掉」那种），与左栏筛选同一个叫法
    return (ids: string[]): string =>
      ids
        .map((id) => byId.get(id))
        .filter((name): name is string => !!name)
        .join(', ') || t('txt_no_project');
  }, [manager.projects]);

  const selected = manager.selectedSecret;
  // 回收站详情只在「已取回且 id 对得上」时渲染，避免切条时闪出上一条的内容
  const trashSelected =
    view === 'trash' && manager.trashDetail?.id === trashSelectedId ? manager.trashDetail : null;
  const isMobileDetail = mobileLayout && mobilePanel === 'detail';
  const listItems = view === 'trash' ? manager.trash : visibleSecrets;
  const checkedCount = checkedIds.size;
  // 换视图或换左侧筛选就清掉勾选：列表换了，旧勾选既看不见也不该参与批量操作。
  const checkedScopeKey =
    view === 'trash'
      ? 'trash'
      : projectFilter.kind === 'project'
        ? `project:${projectFilter.projectId}`
        : projectFilter.kind;
  useEffect(() => {
    setCheckedIds(new Set());
  }, [checkedScopeKey]);

  /** 确认框里要写出「删的是什么」，否则用户只能看到一句笼统的「删除 / 确认」。 */
  function secretNameOf(id: string | null): string {
    if (!id) return '';
    return (
      manager.secrets.find((secret) => secret.id === id)?.name ??
      manager.trash.find((item) => item.id === id)?.name ??
      ''
    );
  }

  function projectNameById(id: string | null): string {
    if (!id) return '';
    return manager.projects.find((project) => project.id === id)?.name ?? '';
  }

  function showFilter(next: SecretsFilter): void {
    setProjectFilter(next);
    setView('secrets');
  }

  function toggleChecked(id: string, checked: boolean): void {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectAllVisible(): void {
    setCheckedIds(new Set(listItems.map((item) => item.id)));
  }

  function openCreate(): void {
    setDraft({
      id: null,
      input: { ...EMPTY_DRAFT, projectIds: projectFilter.kind === 'project' ? [projectFilter.projectId] : [] },
    });
    setValueRevealed(false);
    if (mobileLayout) setMobilePanel('detail');
  }

  function openEdit(): void {
    if (!selected) return;
    setDraft({
      id: selected.id,
      input: { key: selected.name, value: selected.value, note: selected.note, projectIds: selected.projectIds },
    });
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return;
    const input = draft.input;
    // 允许一个 project 都不选（官方 `project_ids` 也是可选）：这类机密只对 Web 会话可见，
    // 机器账号按 project 授权过滤 ⇒ 看不到它。
    if (!input.key.trim()) return;
    if (draft.id) await onUpdateSecret(draft.id, input);
    else await onCreateSecret(input);
    setDraft(null);
  }

  async function submitNewProject(): Promise<void> {
    const trimmed = newProjectName.trim();
    if (!trimmed) return;
    await manager.onCreateProject(trimmed);
    setNewProjectName('');
    setCreatingProject(false);
  }

  async function submitRenameProject(): Promise<void> {
    if (!renamingProject) return;
    const trimmed = renamingProject.name.trim();
    if (!trimmed) return;
    await manager.onRenameProject(renamingProject.id, trimmed);
    setRenamingProject(null);
  }

  function selectSecret(id: string): void {
    onSelectSecret(id);
    setDraft(null);
    setValueRevealed(false);
    // 移动端：点条目进详情页（与密码库一致），而不是在列表下方堆一块详情。
    if (mobileLayout) setMobilePanel('detail');
  }

  function runBulkDelete(): void {
    const ids = [...checkedIds];
    setConfirmBulk(null);
    setCheckedIds(new Set());
    if (view === 'trash') void onPurgeTrash(ids);
    else void onDeleteSecrets(ids);
  }

  const isProjectActive = (projectId: string): boolean =>
    projectFilter.kind === 'project' && projectFilter.projectId === projectId;

  const projectFilterOptions: MobileFilterOption[] = [
    {
      value: 'all',
      label: t('txt_all_secrets'),
      icon: <LayoutGrid size={14} />,
      active: projectFilter.kind === 'all' && view === 'secrets',
      onSelect: () => showFilter({ kind: 'all' }),
    },
    {
      value: 'unassigned',
      label: t('txt_no_project'),
      icon: <FolderX size={14} />,
      active: projectFilter.kind === 'unassigned' && view === 'secrets',
      onSelect: () => showFilter({ kind: 'unassigned' }),
    },
    ...sortedProjects.map((project) => ({
      value: project.id,
      label: project.name,
      icon: <FolderIcon size={14} />,
      active: isProjectActive(project.id) && view === 'secrets',
      onSelect: () => showFilter({ kind: 'project', projectId: project.id }),
    })),
    {
      value: 'trash',
      label: t('txt_trash'),
      icon: <Trash2 size={14} />,
      active: view === 'trash',
      onSelect: () => setView('trash'),
    },
  ];

  const sortOptions: Array<{ value: SortMode; label: string }> = [
    { value: 'edited', label: t('txt_sort_last_edited') },
    { value: 'created', label: t('txt_sort_created') },
    { value: 'name', label: t('txt_sort_name') },
  ];

  const createMenu = (
    <div className={`create-menu-wrap ${mobileLayout ? 'mobile-fab-wrap' : 'desktop-create-menu-wrap'}`}>
      <button
        type="button"
        className={`btn btn-primary small ${mobileLayout ? 'mobile-fab-trigger' : 'desktop-create-trigger'}`}
        aria-label={t('txt_add')}
        title={t('txt_add')}
        disabled={!manager.ready}
        onClick={openCreate}
      >
        <Plus size={14} className="btn-icon" />
      </button>
    </div>
  );

  return (
    <div className={`vault-grid ${mobileLayout ? `mobile-panel-${mobilePanel}` : ''}`}>
      {/* ≤1180px 时 `.sidebar` 由 responsive.css 直接 `display: none`，筛选改走下面的内联下拉。 */}
      <aside className="sidebar">
        <div className="sidebar-block">
          <button
            type="button"
            className={`tree-btn ${projectFilter.kind === 'all' && view === 'secrets' ? 'active' : ''}`}
            onClick={() => showFilter({ kind: 'all' })}
          >
            <LayoutGrid size={14} className="tree-icon" />
            <span className="tree-label">{t('txt_all_secrets')}</span>
          </button>
        </div>

        {/* 项目的「建 / 改 / 删」入口与密码库的文件夹同形（标题行右侧 + 行内右侧） */}
        <div className="sidebar-block">
          <div className="sidebar-title-row">
            <div className="sidebar-title">{t('nav_secret_projects')}</div>
            <div className="folder-title-actions">
              <div className="sort-menu-wrap" ref={projectSortMenuRef}>
                <button
                  type="button"
                  className={`folder-sort-btn ${projectSortMenuOpen ? 'active' : ''}`}
                  title={t('txt_sort')}
                  aria-label={t('txt_sort')}
                  onClick={() => setProjectSortMenuOpen((open) => !open)}
                >
                  <ArrowUpDown size={13} />
                </button>
                {projectSortMenuOpen && (
                  <div className="sort-menu">
                    {sortOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`sort-menu-item ${projectSortMode === option.value ? 'active' : ''}`}
                        onClick={() => {
                          setProjectSortMode(option.value);
                          setProjectSortMenuOpen(false);
                        }}
                      >
                        <span>{option.label}</span>
                        {projectSortMode === option.value ? <Check size={14} /> : <span className="sort-menu-check-placeholder" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="folder-add-btn"
                title={t('txt_create')}
                aria-label={t('txt_create')}
                disabled={!manager.ready}
                onClick={() => {
                  setNewProjectName('');
                  setCreatingProject(true);
                }}
              >
                <FolderPlus size={14} />
              </button>
            </div>
          </div>

          {/* 「未分配」：删掉项目后遗留的机密（关联被级联删除、本体保留），必须能找到它们 */}
          <button
            type="button"
            className={`tree-btn ${projectFilter.kind === 'unassigned' && view === 'secrets' ? 'active' : ''}`}
            onClick={() => showFilter({ kind: 'unassigned' })}
          >
            <FolderX size={14} className="tree-icon" />
            <span className="tree-label">{t('txt_no_project')}</span>
          </button>

          {creatingProject && (
            <div className="folder-row">
              <input
                className="input"
                autoFocus
                aria-label={t('txt_name')}
                placeholder={t('txt_name')}
                value={newProjectName}
                onInput={(event) => setNewProjectName((event.currentTarget as HTMLInputElement).value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitNewProject();
                  if (event.key === 'Escape') setCreatingProject(false);
                }}
              />
              <button
                type="button"
                className="folder-delete-btn folder-edit-btn"
                title={t('txt_create')}
                aria-label={t('txt_create')}
                disabled={!newProjectName.trim()}
                onClick={() => void submitNewProject()}
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                className="folder-delete-btn"
                title={t('txt_cancel')}
                aria-label={t('txt_cancel')}
                onClick={() => setCreatingProject(false)}
              >
                <X size={12} />
              </button>
            </div>
          )}

          {sortedProjects.map((project) =>
            renamingProject?.id === project.id ? (
              <div key={project.id} className="folder-row">
                <input
                  className="input"
                  autoFocus
                  aria-label={t('txt_name')}
                  value={renamingProject.name}
                  onInput={(event) =>
                    setRenamingProject({ ...renamingProject, name: (event.currentTarget as HTMLInputElement).value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submitRenameProject();
                    if (event.key === 'Escape') setRenamingProject(null);
                  }}
                />
                <button
                  type="button"
                  className="folder-delete-btn folder-edit-btn"
                  title={t('txt_save')}
                  aria-label={t('txt_save')}
                  onClick={() => void submitRenameProject()}
                >
                  <Check size={12} />
                </button>
                <button
                  type="button"
                  className="folder-delete-btn"
                  title={t('txt_cancel')}
                  aria-label={t('txt_cancel')}
                  onClick={() => setRenamingProject(null)}
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <div key={project.id} className="folder-row">
                <button
                  type="button"
                  className={`tree-btn ${isProjectActive(project.id) && view === 'secrets' ? 'active' : ''}`}
                  onClick={() => showFilter({ kind: 'project', projectId: project.id })}
                >
                  <FolderIcon size={14} className="tree-icon" />
                  <span className="tree-label" title={project.name}>
                    {project.name}
                  </span>
                </button>
                <button
                  type="button"
                  className="folder-delete-btn folder-edit-btn"
                  title={t('txt_edit')}
                  aria-label={t('txt_edit')}
                  onClick={() => setRenamingProject({ id: project.id, name: project.name })}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="folder-delete-btn"
                  title={t('txt_delete')}
                  aria-label={t('txt_delete')}
                  onClick={() => setConfirmDeleteProjectId(project.id)}
                >
                  <X size={12} />
                </button>
              </div>
            )
          )}
        </div>

        <div className="sidebar-block">
          <button type="button" className={`tree-btn ${view === 'trash' ? 'active' : ''}`} onClick={() => setView('trash')}>
            <Trash2 size={14} className="tree-icon" />
            <span className="tree-label">{t('txt_trash')}</span>
          </button>
        </div>
      </aside>

      <section className="list-col">
        <div className="list-toolbar-stack">
          <div className={`list-head ${checkedCount > 0 ? 'selection-mode sm-selection-mode' : ''}`}>
            {/* 搜索组常驻（含选择模式）：多选时只替换右侧的「排序 + 操作」一行 */}
            {/* 搜索组：占位文案与密码库一致（「共 N 项中搜索…」） */}
            <div className="head-search-group">
              <div className="search-input-wrap">
                <input
                  type="search"
                  className={`search-input${query ? ' has-clear' : ''}`}
                  placeholder={t('txt_search_items_count', { count: listItems.length })}
                  value={query}
                  onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape' || !query) return;
                    event.preventDefault();
                    setQuery('');
                  }}
                />
                {!!query && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    aria-label={t('txt_clear_search')}
                    onClick={() => setQuery('')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            {checkedCount > 0 ? (
              <div className="head-actions-group">
                <button
                  type="button"
                  className="btn btn-secondary small"
                  disabled={!listItems.length}
                  onClick={selectAllVisible}
                >
                  <CheckCheck size={14} className="btn-icon" /> {t('txt_select_all')}
                </button>
                <button type="button" className="btn btn-secondary small" onClick={() => setCheckedIds(new Set())}>
                  <X size={14} className="btn-icon" /> {t('txt_cancel')}
                </button>
                {view === 'trash' ? (
                  <button
                    type="button"
                    className="btn btn-secondary small"
                    onClick={() => {
                      const ids = [...checkedIds];
                      setCheckedIds(new Set());
                      setTrashSelectedId(null);
                      void onRestoreTrash(ids);
                    }}
                  >
                    <RotateCcw size={14} className="btn-icon" /> {t('txt_restore')}
                  </button>
                ) : null}
                <button type="button" className="btn btn-danger small" onClick={() => setConfirmBulk(view === 'trash' ? 'purge' : 'delete')}>
                  <Trash2 size={14} className="btn-icon" />{' '}
                  {view === 'trash' ? t('txt_delete_permanently') : t('txt_delete_selected')}
                </button>
              </div>
            ) : (
              <div className="head-actions-group">
                <div className="sort-menu-wrap" ref={sortMenuRef}>
                  <button
                    type="button"
                    className={`btn btn-secondary small sort-trigger sort-trigger-labeled ${sortMenuOpen ? 'active' : ''}`}
                    aria-label={t('txt_sort')}
                    title={t('txt_sort')}
                    onClick={() => setSortMenuOpen((open) => !open)}
                  >
                    <ArrowUpDown size={14} className="btn-icon" /> <span>{t('txt_sort')}</span>
                  </button>
                  {sortMenuOpen && (
                    <div className="sort-menu">
                      {sortOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`sort-menu-item ${sortMode === option.value ? 'active' : ''}`}
                          onClick={() => {
                            setSortMode(option.value);
                            setSortMenuOpen(false);
                          }}
                        >
                          <span>{option.label}</span>
                          {sortMode === option.value ? <Check size={14} /> : <span className="sort-menu-check-placeholder" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary small list-icon-btn"
                  disabled={!manager.ready || manager.loading}
                  onClick={() => void manager.onRefresh()}
                >
                  <RefreshCw size={14} className="btn-icon" /> {t('txt_sync_vault')}
                </button>
                {createMenu}
              </div>
            )}
          </div>

          {/* 移动端筛选行与密码库一致：**不随选中态隐藏**（密码库里它就不在 list-head 内部） */}
          {mobileLayout && (
            <div className="mobile-vault-filter-row mobile-secrets-filter-row" aria-label={t('nav_secret_projects')}>
              <MobileFilterMenu
                label={t('nav_secret_projects')}
                selected={projectFilterOptions.find((option) => option.active)}
                fallbackIcon={<FolderIcon size={14} />}
                options={projectFilterOptions}
              />
            </div>
          )}
        </div>

        <div className="list-panel">
          {manager.loading ? (
            <div className="empty">{t('txt_loading')}</div>
          ) : manager.error ? (
            <div className="empty">{manager.error}</div>
          ) : listItems.length === 0 ? (
            <div className="empty">{view === 'trash' ? t('txt_trash') : t('txt_secrets_empty')}</div>
          ) : (
            listItems.map((item) => (
              <div
                key={item.id}
                className={`list-item ${
                  (view === 'trash' ? trashSelectedId === item.id : selected?.id === item.id) ? 'active' : ''
                }`}
                onClick={(event) => {
                  // 点复选框不该顺带切换选中 / 打开详情（与密码库的 row-check 同一处理）
                  if ((event.target as HTMLElement).closest('.row-check')) return;
                  if (view === 'trash') {
                    setTrashSelectedId(item.id);
                    setValueRevealed(false);
                    onSelectTrash(item.id);
                    if (mobileLayout) setMobilePanel('detail');
                  } else selectSecret(item.id);
                }}
              >
                <label className="check-hit" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="row-check"
                    checked={checkedIds.has(item.id)}
                    aria-label={t('txt_select_device_name', { name: item.name })}
                    onInput={(event) => toggleChecked(item.id, (event.currentTarget as HTMLInputElement).checked)}
                  />
                </label>
                <div className="row-main">
                  <div className="list-text">
                    <span className="list-title">{item.name}</span>
                    <span className="list-sub">
                      {projectName(item.projectIds)}
                      <span className="muted-inline">
                        {' · '}
                        {day('deletedAt' in item ? item.deletedAt : item.revisionDate)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className={`detail-col ${mobileLayout ? 'mobile-detail-sheet' : ''} ${isMobileDetail ? 'open' : ''}`}>
        {mobileLayout && isMobileDetail && (
          <div className="mobile-panel-head">
            <button type="button" className="btn btn-secondary small mobile-panel-back" onClick={() => setMobilePanel('list')}>
              <span className="btn-icon" aria-hidden="true">{'<'}</span>
              {t('txt_back')}
            </button>
          </div>
        )}

        {draft ? (
          <div key={`sm-editor-${draft.id ?? 'new'}`} className="detail-switch-stage">
            <div className={`card ${projectMenuOpen ? 'card-menu-open' : ''}`}>
              <label className="field">
                <span>{t('txt_name')}</span>
                <input
                  className="input"
                  value={draft.input.key}
                  onInput={(event) =>
                    setDraft({ ...draft, input: { ...draft.input, key: (event.currentTarget as HTMLInputElement).value } })
                  }
                />
              </label>
              <div className="field">
                <span>{t('nav_secret_projects')}</span>
                <div className="mobile-vault-filter-control" ref={projectMenuRef}>
                  <button
                    type="button"
                    className={`mobile-vault-filter-trigger ${projectMenuOpen ? 'active' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((open) => !open)}
                  >
                    <span className="mobile-vault-filter-trigger-label">
                      {projectName(draft.input.projectIds)}
                    </span>
                    <ChevronDown size={13} className="mobile-vault-filter-chevron" />
                  </button>
                  {projectMenuOpen && (
                    <div className="sort-menu mobile-vault-filter-menu" role="menu">
                      {sortedProjects.length === 0 ? (
                        <div className="sort-menu-item">{t('txt_secret_projects_empty')}</div>
                      ) : (
                        sortedProjects.map((project) => (
                          <label key={project.id} className="sort-menu-item">
                            <input
                              type="checkbox"
                              aria-label={t('txt_select_device_name', { name: project.name })}
                              checked={draft.input.projectIds.includes(project.id)}
                              onChange={(event) => {
                                const checked = (event.currentTarget as HTMLInputElement).checked;
                                setDraft({
                                  ...draft,
                                  input: {
                                    ...draft.input,
                                    projectIds: checked
                                      ? [...draft.input.projectIds, project.id]
                                      : draft.input.projectIds.filter((id) => id !== project.id),
                                  },
                                });
                              }}
                            />
                            <span>{project.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="card">
              <label className="field">
                <span>{t('txt_secret_value')}</span>
                <input
                  className="input"
                  value={draft.input.value}
                  onInput={(event) =>
                    setDraft({
                      ...draft,
                      input: { ...draft.input, value: (event.currentTarget as HTMLInputElement).value },
                    })
                  }
                />
              </label>
              <label className="field">
                <span>{t('txt_notes')}</span>
                <textarea
                  className="input"
                  rows={3}
                  value={draft.input.note}
                  onInput={(event) =>
                    setDraft({
                      ...draft,
                      input: { ...draft.input, note: (event.currentTarget as HTMLTextAreaElement).value },
                    })
                  }
                />
              </label>
            </div>
            <div className="detail-actions">
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!draft.input.key.trim()}
                  onClick={() => void saveDraft()}
                >
                  <Check size={14} className="btn-icon" />
                  {t('txt_confirm')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>
                  <X size={14} className="btn-icon" />
                  {t('txt_cancel')}
                </button>
              </div>
              {draft.id ? (
                <button type="button" className="btn btn-danger" onClick={() => setConfirmDeleteSecretId(draft.id)}>
                  <Trash2 size={14} className="btn-icon" />
                  {t('txt_delete')}
                </button>
              ) : null}
            </div>
          </div>
        ) : selected ? (
          <div key={`sm-detail-${selected.id}`} className="detail-switch-stage">
            <div className="card">
              <h4>{selected.name}</h4>
              <div className="kv-line">
                <span>{t('txt_secret_project')}</span>
                <strong>{projectName(selected.projectIds)}</strong>
              </div>
              <div className="kv-row">
                <span className="kv-label">{t('txt_secret_value')}</span>
                <div className="kv-main">
                  <strong>{manager.selectedSecretLoading ? t('txt_loading') : valueRevealed ? selected.value : '••••••••'}</strong>
                </div>
                <div className="kv-actions">
                  <button
                    type="button"
                    className="btn btn-secondary small"
                    onClick={() => setValueRevealed((current) => !current)}
                  >
                    {valueRevealed ? <EyeOff size={14} className="btn-icon" /> : <Eye size={14} className="btn-icon" />}
                    {valueRevealed ? t('txt_hide') : t('txt_show')}
                  </button>
                </div>
              </div>
            </div>
            {selected.note ? (
              <div className="card">
                <h4>{t('txt_notes')}</h4>
                <div className="notes">{selected.note}</div>
              </div>
            ) : null}
            <div className="card">
              <h4>{t('txt_secret_history')}</h4>
              <div className="detail-sub">{t('txt_last_edited_value', { value: day(selected.revisionDate) })}</div>
              <div className="detail-sub">{t('txt_created_value', { value: day(selected.creationDate) })}</div>
            </div>
            <div className="detail-actions">
              <div className="actions">
                <button type="button" className="btn btn-secondary" onClick={openEdit}>
                  <Pencil size={14} className="btn-icon" />
                  {t('txt_edit')}
                </button>
              </div>
              <button type="button" className="btn btn-danger" onClick={() => setConfirmDeleteSecretId(selected.id)}>
                <Trash2 size={14} className="btn-icon" />
                {t('txt_delete')}
              </button>
            </div>
          </div>
        ) : trashSelected ? (
          <div key={`sm-trash-${trashSelected.id}`} className="detail-switch-stage">
            <div className="card">
              <h4>{trashSelected.name}</h4>
              <div className="kv-line">
                <span>{t('txt_secret_project')}</span>
                <strong>{projectName(trashSelected.projectIds)}</strong>
              </div>
              <div className="kv-row">
                <span className="kv-label">{t('txt_secret_value')}</span>
                <div className="kv-main">
                  <strong>{valueRevealed ? trashSelected.value : '••••••••'}</strong>
                </div>
                <div className="kv-actions">
                  <button
                    type="button"
                    className="btn btn-secondary small"
                    onClick={() => setValueRevealed((current) => !current)}
                  >
                    {valueRevealed ? <EyeOff size={14} className="btn-icon" /> : <Eye size={14} className="btn-icon" />}
                    {valueRevealed ? t('txt_hide') : t('txt_show')}
                  </button>
                </div>
              </div>
            </div>
            {trashSelected.note ? (
              <div className="card">
                <h4>{t('txt_notes')}</h4>
                <div className="notes">{trashSelected.note}</div>
              </div>
            ) : null}
            <div className="detail-actions">
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    // 还原后它就不在回收站了 ⇒ 一并清掉选中项，否则面板会留着它（含已经失效的按钮）
                    setTrashSelectedId(null);
                    void onRestoreTrash([trashSelected.id]);
                  }}
                >
                  <RotateCcw size={14} className="btn-icon" />
                  {t('txt_restore')}
                </button>
              </div>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setConfirmPurgeSecretId(trashSelected.id)}
              >
                <Trash2 size={14} className="btn-icon" />
                {t('txt_delete_permanently')}
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="empty">{t('txt_secrets_empty')}</div>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!confirmDeleteSecretId}
        danger
        title={t('txt_delete_secret')}
        message={t('txt_delete_secret_message', { name: secretNameOf(confirmDeleteSecretId) })}
        confirmText={t('txt_delete')}
        cancelText={t('txt_cancel')}
        onCancel={() => setConfirmDeleteSecretId(null)}
        onConfirm={() => {
          const id = confirmDeleteSecretId;
          setConfirmDeleteSecretId(null);
          if (id) void onDeleteSecret(id);
        }}
      />

      <ConfirmDialog
        open={!!confirmDeleteProjectId}
        danger
        title={t('txt_delete_project')}
        message={t('txt_delete_project_message', { name: projectNameById(confirmDeleteProjectId) })}
        confirmText={t('txt_delete')}
        cancelText={t('txt_cancel')}
        onCancel={() => setConfirmDeleteProjectId(null)}
        onConfirm={() => {
          const id = confirmDeleteProjectId;
          setConfirmDeleteProjectId(null);
          if (id) void manager.onDeleteProject(id);
        }}
      />

      <ConfirmDialog
        open={!!confirmPurgeSecretId}
        danger
        title={t('txt_delete_permanently')}
        message={t('txt_permanent_delete_secret_message', { name: secretNameOf(confirmPurgeSecretId) })}
        confirmText={t('txt_delete_permanently')}
        cancelText={t('txt_cancel')}
        onCancel={() => setConfirmPurgeSecretId(null)}
        onConfirm={() => {
          const id = confirmPurgeSecretId;
          setConfirmPurgeSecretId(null);
          setTrashSelectedId(null);
          if (id) void onPurgeTrash([id]);
        }}
      />

      <ConfirmDialog
        open={!!confirmBulk}
        danger
        title={confirmBulk === 'purge' ? t('txt_delete_permanently') : t('txt_delete_secret')}
        message={
          view === 'trash'
            ? t('txt_are_you_sure_you_want_to_delete_count_selected_items_permanently', { count: checkedCount })
            : t('txt_delete_selected_secrets_message', { count: checkedCount })
        }
        confirmText={confirmBulk === 'purge' ? t('txt_delete_permanently') : t('txt_delete_selected')}
        cancelText={t('txt_cancel')}
        onCancel={() => setConfirmBulk(null)}
        onConfirm={runBulkDelete}
      />
    </div>
  );
}
