import { useEffect, useMemo, useState } from 'preact/hooks';
import { Eye, EyeOff, Folder as FolderIcon, LayoutGrid, X } from 'lucide-preact';
import MobileFilterMenu from '@/components/MobileFilterMenu';
import type { MobileFilterOption } from '@/components/MobileFilterMenu';
import { t } from '@/lib/i18n';
import {
  SECRETS_DEMO_PROJECTS,
  SECRETS_DEMO_SECRETS,
  findDemoProjectName,
  formatDemoTimestamp,
} from '@/lib/secrets-demo';

/**
 * 机密（Secrets）：左侧 project 筛选、中间列表、右侧详情。
 *
 * 骨架阶段用 `@/lib/secrets-demo` 渲染；接入真实数据时改为
 * 「`list` 取标识 → `get-by-ids` 取密文 → 客户端解密」两步（列表接口不返回值）。
 * 移动端与密码库同构：列表与详情切成两页，筛选走内联下拉。
 */
export interface SecretsPageProps {
  /** 是否移动端布局（由 `App.tsx` 的 matchMedia(≤1180px) 提供）。 */
  mobileLayout: boolean;
}

export default function SecretsPage(props: SecretsPageProps) {
  const { mobileLayout } = props;
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(SECRETS_DEMO_SECRETS[0]?.id ?? null);
  const [valueRevealed, setValueRevealed] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'list' | 'detail'>('list');

  useEffect(() => {
    if (mobileLayout) return;
    setMobilePanel('list');
  }, [mobileLayout]);

  const visibleSecrets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return SECRETS_DEMO_SECRETS.filter((secret) => {
      if (projectFilter && secret.projectId !== projectFilter) return false;
      if (!needle) return true;
      return secret.name.toLowerCase().includes(needle);
    });
  }, [projectFilter, query]);

  const selected = visibleSecrets.find((secret) => secret.id === selectedId) ?? null;

  function selectSecret(id: string): void {
    setSelectedId(id);
    setValueRevealed(false);
    // 移动端：点条目进详情页（与密码库一致），而不是在列表下方堆一块详情。
    if (mobileLayout) setMobilePanel('detail');
  }

  // 移动端的 project 筛选与 Send / 密码库一致，走内联下拉（`.mobile-vault-filter-row`）。
  const projectFilterOptions: MobileFilterOption[] = [
    {
      value: 'all',
      label: t('txt_all_secrets'),
      icon: <LayoutGrid size={14} />,
      active: projectFilter === null,
      onSelect: () => setProjectFilter(null),
    },
    ...SECRETS_DEMO_PROJECTS.map((project) => ({
      value: project.id,
      label: project.name,
      icon: <FolderIcon size={14} />,
      active: projectFilter === project.id,
      onSelect: () => setProjectFilter(project.id),
    })),
  ];

  return (
    <div className={`vault-grid ${mobileLayout ? `mobile-panel-${mobilePanel}` : ''}`}>
      {/* ≤1180px 时 `.sidebar` 由 responsive.css 直接 `display: none`，筛选改走下面的内联下拉。 */}
      <aside className="sidebar">
        <div className="sidebar-block">
          <button
            type="button"
            className={`tree-btn ${projectFilter === null ? 'active' : ''}`}
            onClick={() => setProjectFilter(null)}
          >
            <LayoutGrid size={14} className="tree-icon" />
            <span className="tree-label">{t('txt_all_secrets')}</span>
          </button>
        </div>
        <div className="sidebar-block">
          <div className="sidebar-title">{t('nav_secret_projects')}</div>
          {SECRETS_DEMO_PROJECTS.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`tree-btn ${projectFilter === project.id ? 'active' : ''}`}
              onClick={() => setProjectFilter(project.id)}
            >
              <FolderIcon size={14} className="tree-icon" />
              <span className="tree-label">{project.name}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="list-col">
        <div className="list-head">
          <div className="search-input-wrap">
            <input
              type="search"
              className={`search-input${query ? ' has-clear' : ''}`}
              placeholder={t('txt_search')}
              aria-label={t('txt_search')}
              value={query}
              onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
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
        <div className="list-panel">
          {visibleSecrets.length === 0 ? (
            <div className="empty">{t('txt_secrets_empty')}</div>
          ) : (
            visibleSecrets.map((secret) => (
              <div
                key={secret.id}
                className={`list-item ${selectedId === secret.id ? 'active' : ''}`}
                onClick={() => selectSecret(secret.id)}
              >
                <div className="row-main">
                  <div className="list-text">
                    <span className="list-title">{secret.name}</span>
                    <span className="list-sub">
                      {findDemoProjectName(secret.projectId) ?? t('txt_secret_project')}
                      <span className="muted-inline"> · {formatDemoTimestamp(secret.updatedAt)}</span>
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className={`detail-col ${mobileLayout ? 'mobile-detail-sheet' : ''} ${mobileLayout && mobilePanel === 'detail' ? 'open' : ''}`}>
        {mobileLayout && mobilePanel === 'detail' && (
          <div className="mobile-panel-head">
            <button type="button" className="btn btn-secondary small mobile-panel-back" onClick={() => setMobilePanel('list')}>
              <span className="btn-icon" aria-hidden="true">{'<'}</span>
              {t('txt_back')}
            </button>
          </div>
        )}
        {selected ? (
          <div className="card">
            <div className="section-head">
              <h2>{selected.name}</h2>
            </div>
            <div className="kv-line">
              <span className="muted-inline">{t('txt_secret_project')}</span>
              <span>{findDemoProjectName(selected.projectId) ?? '—'}</span>
            </div>
            <div className="kv-line">
              <span className="muted-inline">{t('txt_secret_value')}</span>
              <span className="stack">
                <code>{valueRevealed ? selected.value : '••••••••'}</code>
                <button
                  type="button"
                  className="btn btn-secondary small"
                  onClick={() => setValueRevealed((current) => !current)}
                >
                  {valueRevealed ? <EyeOff size={14} className="btn-icon" /> : <Eye size={14} className="btn-icon" />}
                  {valueRevealed ? t('txt_hide') : t('txt_show')}
                </button>
              </span>
            </div>
            {selected.note ? (
              <div className="kv-line">
                <span className="muted-inline">{t('txt_notes')}</span>
                <span>{selected.note}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="card">
            <div className="empty">{t('txt_secrets_empty')}</div>
          </div>
        )}
      </section>
    </div>
  );
}
