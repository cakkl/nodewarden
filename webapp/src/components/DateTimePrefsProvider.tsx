/**
 * 把用户级时间偏好（语言 + 时区）喂给子树。
 *
 * 只做一件事：提供 Context。偏好本身由 App 的 `preferencesQuery` 持有，
 * 所以这里**不发起任何请求**。
 */
import type { ComponentChildren } from 'preact';
import { DateTimePrefsContext, type DateTimePrefs } from '@/lib/datetime';

export default function DateTimePrefsProvider(props: {
  prefs: DateTimePrefs;
  children: ComponentChildren;
}) {
  return (
    <DateTimePrefsContext.Provider value={props.prefs}>{props.children}</DateTimePrefsContext.Provider>
  );
}
