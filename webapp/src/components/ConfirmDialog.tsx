import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { LoaderCircle, TriangleAlert, X } from 'lucide-preact';
import { t } from '@/lib/i18n';

interface ConfirmDialogProps {
  open: boolean;
  title: ComponentChildren;
  message?: string;
  variant?: 'default' | 'warning';
  showIcon?: boolean;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  hideCancel?: boolean;
  hideConfirm?: boolean;
  closeButton?: boolean;
  /**
   * 是否允许「点空白区域 / 按 Esc」关掉（默认允许）。关键认证弹窗（输验证码 / 主密码）
   * 必须传 `false`：一次误点就丢掉弹窗，用户得从头再来（还可能白烧一枚码）。
   * 关掉后仍可用弹窗内的取消按钮或右上角 ✕ 退出。
   */
  dismissable?: boolean;
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  /**
   * 确认动作。返回 Promise 时弹窗会保持打开、按钮进入处理中，直到它 settle ——
   * 否则高延迟下用户会以为「点了没反应」。约定：**成功时**调用方才关弹窗，失败就留着让用户重试。
   */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  children?: ComponentChildren;
  afterActions?: ComponentChildren;
}

function incrementDialogBodyLock() {
  if (typeof document === 'undefined') return;
  const body = document.body;
  const nextCount = Number(body.dataset.dialogCount || '0') + 1;
  body.dataset.dialogCount = String(nextCount);
  body.classList.add('dialog-open');
}

function decrementDialogBodyLock() {
  if (typeof document === 'undefined') return;
  const body = document.body;
  const nextCount = Math.max(0, Number(body.dataset.dialogCount || '0') - 1);
  if (nextCount === 0) {
    delete body.dataset.dialogCount;
    body.classList.remove('dialog-open');
    return;
  }
  body.dataset.dialogCount = String(nextCount);
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

let dialogIdCounter = 0;

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute('disabled') || element.getAttribute('aria-hidden') === 'true') return false;
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  });
}

export function useDialogLifecycle(active: boolean, onCancel?: (() => void) | null) {
  useEffect(() => {
    if (!active) return;
    incrementDialogBodyLock();
    return () => decrementDialogBodyLock();
  }, [active]);

  useEffect(() => {
    if (!active || !onCancel || typeof window === 'undefined') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, onCancel]);
}

export default function ConfirmDialog(props: ConfirmDialogProps) {
  const [present, setPresent] = useState(props.open);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLFormElement | null>(null);
  const maskPointerStartedRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const lastTitleRef = useRef<ComponentChildren>(props.title);
  const dialogId = useMemo(() => `confirm-dialog-${++dialogIdCounter}`, []);
  const titleId = `${dialogId}-title`;
  const messageId = `${dialogId}-message`;
  const hasMessage = !!props.message;
  const canDismiss = !props.cancelDisabled && !closing && !busy && props.dismissable !== false;

  /**
   * 确认动作：等 `onConfirm` 的 Promise settle 再复位 `busy`。
   * 期间弹窗保持打开、按钮禁用 ⇒ 用户看得到「在处理」，也不会重复点击。
   */
  async function runConfirm(): Promise<void> {
    if (busy || props.confirmDisabled || closing) return;
    setBusy(true);
    try {
      await props.onConfirm();
    } catch (error) {
      // 调用方负责提示失败（弹窗会留着以便重试）；这里只保证 busy 复位，并留一条线索。
      console.error('Confirm dialog action failed:', error);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (props.open) {
      lastTitleRef.current = props.title;
      setPresent(true);
      setClosing(false);
      // 新的一次确认：复位上一次的处理中状态。
      setBusy(false);
      return;
    }
    if (!present) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setPresent(false);
      setClosing(false);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [props.open, present]);

  useDialogLifecycle(present, canDismiss ? props.onCancel : null);

  useEffect(() => {
    if (!props.open || typeof document === 'undefined') return;
    const activeElement = document.activeElement;
    restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;

    const frameId = window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) return;
      const focusable = getFocusableElements(card);
      const firstField = focusable.find((element) => (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ));
      const cancelButton = focusable.find((element) => element.dataset.dialogCancel === 'true');
      const confirmButton = focusable.find((element) => element.dataset.dialogConfirm === 'true');
      const target = firstField || (props.danger ? cancelButton : confirmButton) || cancelButton || focusable[0] || card;
      target.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [props.open, props.danger]);

  useEffect(() => {
    if (props.open || present || typeof document === 'undefined') return;
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (!target || !document.contains(target)) return;
    target.focus({ preventScroll: true });
  }, [props.open, present]);

  useEffect(() => {
    return () => {
      const target = restoreFocusRef.current;
      if (!target || typeof document === 'undefined' || !document.contains(target)) return;
      target.focus({ preventScroll: true });
    };
  }, []);

  function handleDialogKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const card = cardRef.current;
    if (!card) return;
    const focusable = getFocusableElements(card);
    if (focusable.length === 0) {
      event.preventDefault();
      card.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey) {
      if (activeElement === first || activeElement === card || !card.contains(activeElement)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
      return;
    }
    if (activeElement === last || activeElement === card || !card.contains(activeElement)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  if (!present || typeof document === 'undefined') return null;
  return createPortal((
    <div
      className={`dialog-mask ${props.variant === 'warning' ? 'warning' : ''} ${props.open && !closing ? 'open' : ''} ${closing ? 'closing' : ''}`}
      onPointerDown={(event) => {
        maskPointerStartedRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || !maskPointerStartedRef.current || !canDismiss) return;
        props.onCancel();
      }}
    >
      <form
        ref={cardRef}
        className={`dialog-card ${props.variant === 'warning' ? 'warning' : ''} ${props.open && !closing ? 'open' : ''} ${closing ? 'closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasMessage ? messageId : undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          void runConfirm();
        }}
      >
        {props.variant === 'warning' ? (
          <div className="dialog-warning-head">
            <div className="dialog-warning-badge" aria-hidden="true">
              <TriangleAlert size={24} />
            </div>
            <div className="dialog-warning-kicker">{t('txt_warning')}</div>
          </div>
        ) : null}
        {props.closeButton && (
          <button
            type="button"
            className="dialog-close-btn"
            aria-label={t('txt_close')}
            disabled={props.cancelDisabled || busy}
            onClick={() => {
              if (props.cancelDisabled || busy) return;
              props.onCancel();
            }}
          >
            <X size={18} />
          </button>
        )}
        <h3 id={titleId} className="dialog-title">{props.open ? props.title : lastTitleRef.current}</h3>
        {hasMessage && <div id={messageId} className={`dialog-message ${props.variant === 'warning' ? 'warning' : ''}`}>{props.message}</div>}
        {props.children}
        {!props.hideConfirm && (
          <button
            type="submit"
            className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'} dialog-btn`}
            disabled={props.confirmDisabled || busy}
            data-dialog-confirm="true"
          >
            {busy ? <LoaderCircle size={16} className="generator-spinner" /> : null}
            {busy ? t('txt_loading') : (props.confirmText || t('txt_yes'))}
          </button>
        )}
        {!props.hideCancel && (
          <button
            type="button"
            className="btn btn-secondary dialog-btn"
            disabled={props.cancelDisabled || busy}
            data-dialog-cancel="true"
            onClick={() => {
              if (props.cancelDisabled || busy) return;
              props.onCancel();
            }}
          >
            {props.cancelText || t('txt_no')}
          </button>
        )}
        {props.afterActions}
      </form>
    </div>
  ), document.body);
}
