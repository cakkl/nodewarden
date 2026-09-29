import { useCallback, useEffect, useState } from 'preact/hooks';

/**
 * 与后端 `src/services/email-2fa.ts` / `email-verification.ts` 的 `RESEND_INTERVAL_MS` 对齐（60 秒）。
 * 服务端会通过 429 的 `Retry-After` 给出准确剩余秒数；这个常量用于「发码成功后的本地冷却」。
 */
export const RESEND_COOLDOWN_SECONDS = 60;

/** 与后端 `src/handlers/admin-mail.ts` 的测试发信窗口对齐（10 秒）。 */
export const MAIL_TEST_COOLDOWN_SECONDS = 10;

/** 倒计时进行中时把剩余秒数并到按钮文案上（禁用态必须由同一个值驱动，否则会出现「可点但显示 0s」）。 */
export function resendLabel(label: string, secondsLeft: number): string {
  return secondsLeft > 0 ? `${label} (${secondsLeft}s)` : label;
}

/**
 * 发码按钮的秒级倒计时：返回 `[剩余秒数, 开始, 清零]`，剩余 > 0 时按钮应禁用并显示「(Ns)」。
 * 服务端拿得到准确剩余秒数时（429 的 `Retry-After`）优先用它，否则用上面的本地冷却常量。
 */
export function useResendCountdown(): [number, (seconds: number) => void, () => void] {
  const [secondsLeft, setSecondsLeft] = useState(0);

  const start = useCallback((seconds: number) => {
    setSecondsLeft(Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0);
  }, []);

  const reset = useCallback(() => setSecondsLeft(0), []);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = window.setTimeout(() => setSecondsLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft]);

  return [secondsLeft, start, reset];
}
