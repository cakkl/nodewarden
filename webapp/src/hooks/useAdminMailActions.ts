import { useMemo } from 'preact/hooks';
import {
  MailDeliveryError,
  getMailSettings,
  saveMailSettings as saveMailSettingsApi,
  sendTestMail as sendTestMailApi,
} from '@/lib/api/admin';
import { deriveLoginHash } from '@/lib/api/auth';
import { t } from '@/lib/i18n';
import type { AuthedFetch } from '@/lib/api/shared';
import type { MailSettings, MailSettingsInput, MailTestResult, Profile } from '@/lib/types';

type Notify = (type: 'success' | 'error' | 'warning', text: string) => void;

interface UseAdminMailActionsOptions {
  authedFetch: AuthedFetch;
  profile: Profile | null;
  defaultKdfIterations: number;
  onNotify: Notify;
}

/** 失败环节 → 文案键；只区分用户能采取不同动作的几类。 */
const STAGE_MESSAGE_KEYS: Record<string, string> = {
  connect: 'txt_mail_error_connect',
  auth: 'txt_mail_error_auth',
};

/** 按环节与状态码给出可操作的提示，拿不到就退回服务端原文。 */
export function describeMailFailure(error: unknown): string {
  if (!(error instanceof MailDeliveryError)) {
    return error instanceof Error ? error.message : t('txt_mail_test_failed');
  }
  if (error.timedOut) return t('txt_mail_error_timeout');
  if (error.stage === 'auth' && error.code === 535) return t('txt_mail_error_auth_rejected');
  const key = error.stage ? STAGE_MESSAGE_KEYS[error.stage] : undefined;
  if (key) return t(key);
  if (!error.stage) return error.message || t('txt_mail_test_failed');
  return t('txt_mail_error_delivery');
}

export function useAdminMailActions({
  authedFetch,
  profile,
  defaultKdfIterations,
  onNotify,
}: UseAdminMailActionsOptions) {
  return useMemo(() => {
    async function deriveHash(masterPassword: string): Promise<string> {
      if (!profile) throw new Error(t('txt_profile_unavailable'));
      const normalized = String(masterPassword || '');
      if (!normalized) throw new Error(t('txt_master_password_is_required'));
      return (await deriveLoginHash(profile.email, normalized, defaultKdfIterations)).hash;
    }

    return {
      async loadMailSettings(): Promise<MailSettings> {
        return getMailSettings(authedFetch);
      },

      async saveMailSettings(input: MailSettingsInput, masterPassword: string): Promise<MailSettings> {
        const settings = await saveMailSettingsApi(authedFetch, input, await deriveHash(masterPassword));
        onNotify('success', t('txt_mail_settings_saved'));
        return settings;
      },

      async sendTestMail(input: MailSettingsInput): Promise<MailTestResult> {
        const result = await sendTestMailApi(authedFetch, input);
        onNotify('success', t('txt_mail_test_sent', { email: result.recipient }));
        return result;
      },
    };
  }, [authedFetch, profile, defaultKdfIterations, onNotify]);
}

export default useAdminMailActions;
