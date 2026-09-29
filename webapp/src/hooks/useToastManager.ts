import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ToastMessage } from '@/lib/types';

/** toast 自动消失时长（毫秒）。⚠️ 必须与 `motion.css` 的 `toast-life` 动画时长一致。 */
const TOAST_DURATION_MS = 4500;

/** 同时最多显示几条（与既有行为一致：保留最近 3 条 + 新增的 1 条）。 */
const TOAST_MAX_VISIBLE = 4;

/** 退场动画时长（毫秒）。⚠️ 必须与 `overlays.css` 的 `.toast-item.closing` 一致。 */
const TOAST_EXIT_MS = 220;

interface ToastTimer {
  /** 剩余毫秒数；暂停时扣掉已流逝的部分。 */
  remaining: number;
  /** 本段计时的起点，暂停时用来算已流逝时间。 */
  startedAt: number;
  /** `setTimeout` 句柄；暂停期间为 `null`。 */
  handle: number | null;
}

export function useToastManager() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timersRef = useRef(new Map<string, ToastTimer>());
  // 暂停态用 ref 而非 state：pushToast 需要在同一事件帧内读到它（暂停期间新出现的 toast 也要暂停）。
  const pausedRef = useRef(false);
  /** 正在播退场动画的 toast，用于忽略重复的移除请求。 */
  const closingRef = useRef(new Set<string>());
  /** 退场动画的定时器，卸载时要一并清掉。 */
  const exitTimersRef = useRef(new Set<number>());

  /** 清掉自动消失计时器（退场用）。暂停**不能**复用 —— 它要保留 `remaining` 以便恢复。 */
  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer && timer.handle !== null) window.clearTimeout(timer.handle);
    timersRef.current.delete(id);
  }, []);

  /** 移除一条 toast：**先播退场动画再出队**（直接删会让 DOM 瞬间消失，与入场不对称）。 */
  const removeToast = useCallback(
    (id: string) => {
      // 重复请求（计时到点 + 用户点关闭）要忽略第二次，否则动画会重放。
      if (closingRef.current.has(id)) return;
      closingRef.current.add(id);
      clearTimer(id);
      setToasts((prev) =>
        prev.map((toast) => (toast.id === id ? { ...toast, closing: true } : toast))
      );
      const handle = window.setTimeout(() => {
        exitTimersRef.current.delete(handle);
        closingRef.current.delete(id);
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, TOAST_EXIT_MS);
      exitTimersRef.current.add(handle);
    },
    [clearTimer]
  );

  const scheduleRemoval = useCallback(
    (id: string, delay: number) => {
      const timer = timersRef.current.get(id);
      if (!timer) return;
      timer.startedAt = Date.now();
      timer.handle = window.setTimeout(() => removeToast(id), delay);
    },
    [removeToast]
  );

  const pushToast = useCallback(
    (type: ToastMessage['type'], text: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      timersRef.current.set(id, {
        remaining: TOAST_DURATION_MS,
        startedAt: Date.now(),
        handle: null,
      });
      if (!pausedRef.current) scheduleRemoval(id, TOAST_DURATION_MS);
      setToasts((prev) => [...prev.slice(1 - TOAST_MAX_VISIBLE), { id, type, text }]);
      return id;
    },
    [scheduleRemoval]
  );

  /** 暂停全部 toast 的计时（鼠标移入通知区时调用）。 */
  const pauseToasts = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    const now = Date.now();
    timersRef.current.forEach((timer) => {
      if (timer.handle === null) return;
      window.clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
    });
  }, []);

  /** 继续计时：从**剩余**时间接着走（不是重新计满一轮）。 */
  const resumeToasts = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    timersRef.current.forEach((timer, id) => {
      if (timer.handle !== null) return;
      scheduleRemoval(id, timer.remaining);
    });
  }, [scheduleRemoval]);

  // 超出上限被挤掉的 toast，其计时器要一并清掉，否则会白跑一次回调。
  useEffect(() => {
    const alive = new Set(toasts.map((toast) => toast.id));
    timersRef.current.forEach((timer, id) => {
      if (alive.has(id)) return;
      if (timer.handle !== null) window.clearTimeout(timer.handle);
      timersRef.current.delete(id);
    });
  }, [toasts]);

  // 卸载时清干净，避免在已卸载的组件上 setState。
  useEffect(
    () => () => {
      timersRef.current.forEach((timer) => {
        if (timer.handle !== null) window.clearTimeout(timer.handle);
      });
      timersRef.current.clear();
      exitTimersRef.current.forEach((handle) => window.clearTimeout(handle));
      exitTimersRef.current.clear();
      closingRef.current.clear();
      pausedRef.current = false;
    },
    []
  );

  return {
    toasts,
    pushToast,
    removeToast,
    pauseToasts,
    resumeToasts,
  };
}
