import { Plus } from 'lucide-preact';
import type { BackupDestinationRecord, BackupDestinationType } from '@/lib/api/backup';
import { formatDateTime, getDestinationTypeLabel } from '@/lib/backup-center';
import { t } from '@/lib/i18n';

interface BackupDestinationSidebarProps {
  destinations: BackupDestinationRecord[];
  selectedDestinationId: string | null;
  disableWhileBusy: boolean;
  showAddChooser: boolean;
  onSelectDestination: (destinationId: string) => void;
  onToggleAddChooser: () => void;
  onAddDestination: (type: BackupDestinationType) => void;
}

export function BackupDestinationSidebar(props: BackupDestinationSidebarProps) {
  return (
    <aside className="backup-destination-sidebar">
      <div className="section-head">
        <h3>{t('txt_backup_destinations_title')}</h3>
      </div>

      <div className="backup-destination-list">
        {props.destinations.map((destination) => {
          const isSelected = destination.id === props.selectedDestinationId;
          const isScheduled = destination.schedule.enabled;
          return (
            <button
              key={destination.id}
              type="button"
              className={`backup-destination-item ${isSelected ? 'active' : ''}`}
              onClick={() => props.onSelectDestination(destination.id)}
            >
              <span className="backup-destination-top">
                <span className="backup-destination-name">{destination.name || getDestinationTypeLabel(destination.type)}</span>
                <span className="backup-destination-type">{getDestinationTypeLabel(destination.type)}</span>
              </span>
              <span className="backup-destination-meta">
                {isScheduled ? t('txt_backup_destination_active_badge') : t('txt_backup_destination_idle_badge')}
              </span>
              <span className="backup-destination-meta">
                {destination.runtime.lastSuccessAt
                  ? t('txt_backup_destination_last_success', { time: formatDateTime(destination.runtime.lastSuccessAt) })
                  : t('txt_backup_destination_never_run')}
              </span>
              {/* 只显示时间不显示原因：侧栏很窄，而原因可能很长且会挤掉其它信息，
                  完整原因在右侧详情页的「最近运行」里（见 BackupDestinationDetail）。 */}
              {destination.runtime.lastErrorMessage ? (
                <span className="backup-destination-meta backup-destination-failed">
                  {t('txt_backup_destination_failed_at', { time: formatDateTime(destination.runtime.lastErrorAt) })}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="actions backup-destination-addbar">
        <button type="button" className="btn btn-secondary small" disabled={props.disableWhileBusy} onClick={props.onToggleAddChooser}>
          <Plus size={14} className="btn-icon" />
          {t('txt_backup_add_destination')}
        </button>
      </div>

      {props.showAddChooser ? (
        <div className="backup-add-chooser">
          <button type="button" className="btn btn-secondary small" onClick={() => props.onAddDestination('webdav')}>
            {t('txt_backup_protocol_webdav')}
          </button>
          <button type="button" className="btn btn-secondary small" onClick={() => props.onAddDestination('s3')}>
            {t('txt_backup_protocol_s3')}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
