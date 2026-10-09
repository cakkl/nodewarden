import { t } from '@/lib/i18n';
import { SECRETS_DEMO_MACHINE_ACCOUNTS, SECRETS_DEMO_PROJECTS, SECRETS_DEMO_SECRETS } from '@/lib/secrets-demo';

/**
 * 项目（Projects）—— 机密管理器的顶层视图之一。
 *
 * 独立成页是有意的：project 是**授权单位**（决定谁能看到哪些机密），不是分组标签。
 * 骨架阶段用占位数据渲染。
 */
export default function SecretProjectsPage() {
  return (
    <div className="stack">
      {SECRETS_DEMO_PROJECTS.length === 0 ? (
        <div className="card">
          <div className="empty">{t('txt_secret_projects_empty')}</div>
        </div>
      ) : (
        SECRETS_DEMO_PROJECTS.map((project) => {
          const secretCount = SECRETS_DEMO_SECRETS.filter((secret) => secret.projectId === project.id).length;
          const machineCount = SECRETS_DEMO_MACHINE_ACCOUNTS.filter((machine) =>
            machine.projectIds.includes(project.id)
          ).length;

          return (
            <div key={project.id} className="card">
              <div className="section-head">
                <h3>{project.name}</h3>
              </div>
              <div className="kv-line">
                <span className="muted-inline">{t('nav_secrets')}</span>
                <span>{secretCount}</span>
              </div>
              <div className="kv-line">
                <span className="muted-inline">{t('nav_machine_accounts')}</span>
                <span>{machineCount}</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
