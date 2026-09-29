import { t } from '@/lib/i18n';
import type { ToastMessage } from '@/lib/types';

interface ToastHostProps {
  toasts: ToastMessage[];
  onClose: (id: string) => void;
  /** 鼠标移入通知区 ⇒ 暂停**全部** toast 的计时器（避免刚要看就消失）。 */
  onPause?: () => void;
  /** 鼠标移出 ⇒ 从剩余时间继续。 */
  onResume?: () => void;
}

export default function ToastHost({ toasts, onClose, onPause, onResume }: ToastHostProps) {
  if (!toasts.length) return null;
  return (
    <ul className="toast-stack" onMouseEnter={onPause} onMouseLeave={onResume}>
      {toasts.map((toast) => (
        <li key={toast.id} className={`toast-item ${toast.type}${toast.closing ? ' closing' : ''}`}>
          <div className="toast-text">{toast.text}</div>
            <button type="button" className="toast-close" onClick={() => onClose(toast.id)} aria-label={t('txt_close')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
          <div className="toast-progress" />
        </li>
      ))}
    </ul>
  );
}
