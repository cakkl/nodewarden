import { useCallback } from 'preact/hooks';
import { t } from '@/lib/i18n';

/** 应用内的 toast 通知回调（由外壳注入）。 */
export type AppNotify = (type: 'success' | 'error' | 'warning', text: string) => void;

export interface ActionRunnerOptions {
  onNotify: AppNotify;
  /** demo 站点没有后端 ⇒ 操作一律只提示「只读」 */
  demoMode: boolean;
  /** 成功后的刷新（失败不刷新） */
  reload: () => Promise<unknown>;
  /** 可选：把整个操作包在忙碌态里 */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * 统一的「操作 → 成功提示 → 刷新」包装；失败时把服务端文案透给用户。
 *
 * ⚠️ `successText` 是**成功后**弹的提示语 —— 传「已保存 / 已删除 / 已撤销」这类完成态，
 * 别把按钮名或失败文案（如 `txt_save_failed`）传进来，否则保存成功却显示「保存失败」。
 *
 * 返回是否成功：**表单类调用方必须据此决定要不要关表单** —— 失败时关掉，用户就再也拿不回输入了。
 */
export function useActionRunner(
  options: ActionRunnerOptions
): (action: () => Promise<unknown>, successText: string) => Promise<boolean> {
  const { onNotify, demoMode, reload, onBusyChange } = options;

  return useCallback(
    async (action: () => Promise<unknown>, successText: string): Promise<boolean> => {
      if (demoMode) {
        onNotify('warning', t('txt_demo_readonly_message'));
        return false;
      }
      onBusyChange?.(true);
      try {
        await action();
        onNotify('success', successText);
        await reload();
        return true;
      } catch (err) {
        onNotify('error', err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        onBusyChange?.(false);
      }
    },
    [onNotify, demoMode, reload, onBusyChange]
  );
}
