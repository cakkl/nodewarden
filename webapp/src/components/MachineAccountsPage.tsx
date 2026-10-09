import { t } from '@/lib/i18n';
import { SECRETS_DEMO_MACHINE_ACCOUNTS, findDemoProjectName } from '@/lib/secrets-demo';

/**
 * 机器账号（Machine accounts）—— 机密管理器的顶层视图之一。
 *
 * 真实实现里详情的三个 tab 为 Projects（授权）/ Access tokens（创建时明文只显示一次）/ Event logs。
 * 骨架阶段只列出账号与它的授权范围。
 */
export default function MachineAccountsPage() {
  return (
    <div className="stack">
      {SECRETS_DEMO_MACHINE_ACCOUNTS.length === 0 ? (
        <div className="card">
          <div className="empty">{t('txt_machine_accounts_empty')}</div>
        </div>
      ) : (
        SECRETS_DEMO_MACHINE_ACCOUNTS.map((machine) => (
          <div key={machine.id} className="card">
            <div className="section-head">
              <h3>{machine.name}</h3>
            </div>
            <div className="kv-line">
              <span className="muted-inline">{t('nav_secret_projects')}</span>
              <span>
                {machine.projectIds
                  .map((projectId) => findDemoProjectName(projectId))
                  .filter((name): name is string => Boolean(name))
                  .join(', ') || '—'}
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
