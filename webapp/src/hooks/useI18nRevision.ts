import { useEffect, useState } from 'preact/hooks';
import { getI18nRevision, subscribeI18n } from '@/lib/i18n';

/**
 * 订阅语言变化：语言一变就重渲染调用它的组件。
 *
 * `t()` 直接读模块级文案表（没进 context）⇒ 只有重渲染才能换文案。根组件订阅一次带动整棵树，
 * `memo` 组件（如 `CipherListItem`）得自己订阅。
 * 不用 `useSyncExternalStore`：它在 Preact 里只从 `preact/compat` 出，为它拉进 compat 层不划算。
 */
export default function useI18nRevision(): number {
  const [revision, setRevision] = useState(getI18nRevision);
  useEffect(() => subscribeI18n(() => setRevision(getI18nRevision())), []);
  return revision;
}
