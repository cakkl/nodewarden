import { useEffect, useMemo, useState } from 'preact/hooks';
import ConfirmDialog from '@/components/ConfirmDialog';
import ToastHost from '@/components/ToastHost';
import { resendLabel } from '@/hooks/useResendCountdown';
import { t } from '@/lib/i18n';
import {
  TWO_FACTOR_PROVIDER_EMAIL,
  TWO_FACTOR_PROVIDER_ORDER,
  TWO_FACTOR_PROVIDER_RECOVERY_CODE,
  TWO_FACTOR_PROVIDER_WEBAUTHN,
  TWO_FACTOR_PROVIDER_YUBIKEY,
  twoFactorProviderLabel,
} from '@/lib/two-factor-providers';
import type { ToastMessage } from '@/lib/types';

export interface AppConfirmState {
  title: string;
  message: string;
  danger?: boolean;
  showIcon?: boolean;
  confirmText?: string;
  cancelText?: string;
  hideCancel?: boolean;
  /** When true, dialog shows a master-password field and passes it to onConfirm. */
  requireMasterPassword?: boolean;
  onConfirm: (masterPassword?: string) => void;
  onCancel?: () => void;
}

/**
 * 新设备验证（NDV）输码界面的外部状态。
 *
 * 聚成一个可选对象：本组件在两个分支里各渲染一次，拆成多个 prop 要在两处各补一遍。
 */
interface DeviceVerificationDialogState {
  email: string;
  code: string;
  submitting: boolean;
  resending: boolean;
  /** 重发倒计时剩余秒数；> 0 时按钮禁用并显示「(Ns)」。服务端对该接口的限流响应刻意与成功一致，只能本地计时。 */
  resendIn?: number;
  onCodeChange: (value: string) => void;
  onConfirm: () => void;
  onResend: () => void;
  onCancel: () => void;
}

interface AppGlobalOverlaysProps {
  toasts: ToastMessage[];
  onCloseToast: (id: string) => void;
  /** 鼠标悬停在通知区时暂停全部 toast 计时；移开继续。 */
  onPauseToasts?: () => void;
  onResumeToasts?: () => void;
  confirm: AppConfirmState | null;
  onCancelConfirm: () => void;
  pendingTotpOpen: boolean;
  pendingTotpProviderType?: number;
  pendingTotpAvailableProviders?: number[];
  totpCode: string;
  rememberDevice: boolean;
  onTotpCodeChange: (value: string) => void;
  onRememberDeviceChange: (checked: boolean) => void;
  onConfirmTotp: () => void;
  onSelectTotpProvider: (providerType: number) => void;
  onCancelTotp: () => void;
  /** 用一次性恢复码停用两步登录并完成登录（就地提交，不跳页）。 */
  onSubmitRecoveryCode: (recoveryCode: string) => void;
  totpSubmitting: boolean;
  /** 邮件 2FA：重新发送验证码。未提供时（或非邮件 provider）不显示该按钮。 */
  onResendEmailCode?: () => void;
  emailCodeResending?: boolean;
  /** 重发倒计时剩余秒数；> 0 时按钮禁用并显示「(Ns)」。邮件 2FA 的 429 会带 `Retry-After`，可对齐真实剩余时间。 */
  emailCodeResendIn?: number;
  /** 非空时弹出新设备验证的输码对话框；未提供则不渲染。 */
  deviceVerification?: DeviceVerificationDialogState | null;
  disableTotpOpen: boolean;
  disableTotpPassword: string;
  onDisableTotpPasswordChange: (value: string) => void;
  onConfirmDisableTotp: () => void;
  onCancelDisableTotp: () => void;
  disableTotpSubmitting: boolean;
}

function uniqueSupportedProviders(providerTypes: number[] | undefined): number[] {
  const available = new Set(providerTypes || []);
  return TWO_FACTOR_PROVIDER_ORDER.filter((provider) => available.has(provider));
}

export default function AppGlobalOverlays(props: AppGlobalOverlaysProps) {
  const [methodChooserOpen, setMethodChooserOpen] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  // 恢复码是**弹窗内**的一种验证方式（不跳页、不重发邮件码），所以自成一个模式。
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryConfirmOpen, setRecoveryConfirmOpen] = useState(false);
  const availableProviders = useMemo(
    () => uniqueSupportedProviders(props.pendingTotpAvailableProviders),
    [props.pendingTotpAvailableProviders]
  );
  // 恢复码模式下，**当前**这个提供程序也要列出来 —— 否则用户选了恢复码就回不去了：
  // 例如账号只开了邮件，切换列表里就只剩「恢复代码」一项（实测就是这个问题）。
  const switchableProviders = availableProviders.filter(
    (provider) => recoveryMode || provider !== props.pendingTotpProviderType
  );
  // 恢复码永远排在最后：它是一次性破窗（会停用全部两步登录），不该与常规方式并列在最前面。
  const methodOptions = [...switchableProviders, TWO_FACTOR_PROVIDER_RECOVERY_CODE];
  const isYubiKeyOtp = !recoveryMode && props.pendingTotpProviderType === TWO_FACTOR_PROVIDER_YUBIKEY;
  const isWebAuthn = !recoveryMode && props.pendingTotpProviderType === TWO_FACTOR_PROVIDER_WEBAUTHN;
  const isEmailOtp = !recoveryMode && props.pendingTotpProviderType === TWO_FACTOR_PROVIDER_EMAIL;
  const requireMasterPassword = !!props.confirm?.requireMasterPassword;

  useEffect(() => {
    setMethodChooserOpen(false);
    // 关闭弹窗 / 换 provider 都要退出恢复码模式，否则下次打开会停在恢复码上（白让人输一次码）。
    setRecoveryMode(false);
    setRecoveryCode('');
    setRecoveryConfirmOpen(false);
  }, [props.pendingTotpOpen, props.pendingTotpProviderType]);

  useEffect(() => {
    setConfirmPassword('');
  }, [props.confirm?.title, props.confirm?.message, requireMasterPassword]);

  return (
    <>
      <ConfirmDialog
        open={!!props.confirm}
        title={props.confirm?.title || ''}
        message={props.confirm?.message || ''}
        danger={props.confirm?.danger}
        showIcon={props.confirm?.showIcon}
        confirmText={props.confirm?.confirmText}
        cancelText={props.confirm?.cancelText}
        hideCancel={props.confirm?.hideCancel}
        // 要输主密码的确认框不能误关（其余普通确认框点空白关闭无损失）
        dismissable={!requireMasterPassword}
        confirmDisabled={requireMasterPassword && !confirmPassword.trim()}
        onConfirm={() => {
          if (requireMasterPassword && !confirmPassword.trim()) return;
          props.confirm?.onConfirm(requireMasterPassword ? confirmPassword : undefined);
          setConfirmPassword('');
        }}
        onCancel={() => {
          setConfirmPassword('');
          (props.confirm?.onCancel || props.onCancelConfirm)();
        }}
      >
        {requireMasterPassword && (
          <label className="field">
            <span>{t('txt_master_password')}</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={confirmPassword}
              onInput={(e) => setConfirmPassword((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={props.pendingTotpOpen}
        title={recoveryMode ? t('txt_recover_two_step_login') : isYubiKeyOtp ? `${t('txt_two_step_verification')} YubiKey` : isWebAuthn ? (
          <span className="dialog-title-stack">
            <span>{t('txt_two_step_verification')}</span>
            <span>{t('txt_passkey')}</span>
          </span>
        ) : t('txt_two_step_verification')}
        message={recoveryMode ? t('txt_use_your_one_time_recovery_code_to_disable_two_step_verification') : isYubiKeyOtp ? t('txt_press_yubikey_to_authenticate') : isWebAuthn ? t('txt_use_passkey_to_complete_two_step_verification') : isEmailOtp ? t('txt_email_code_sent_to_your_address') : t('txt_password_is_already_verified')}
        confirmText={recoveryMode ? t('txt_continue') : t('txt_verify')}
        hideCancel
        closeButton
        // 输验证码的弹窗：点空白/按 Esc 都不能关（误触会丢掉刚输的码，甚至白烧一枚邮件码）
        dismissable={false}
        showIcon={false}
        confirmDisabled={recoveryMode ? !recoveryCode.trim() || props.totpSubmitting : props.totpSubmitting}
        cancelDisabled={props.totpSubmitting}
        onConfirm={recoveryMode ? () => setRecoveryConfirmOpen(true) : props.onConfirmTotp}
        onCancel={props.onCancelTotp}
        afterActions={(
          <div className="dialog-extra">
            <div className="dialog-divider" />
            {/* 恢复码也在列表里 ⇒ 即使只剩一种常规方式，切换入口也必须存在。
                原先那个独立按钮点一下就跳到另一个页面，既丢当前进度又白烧一枚邮件码。 */}
            <div className="two-factor-method-switcher">
              <button
                type="button"
                className="btn btn-secondary dialog-btn"
                disabled={props.totpSubmitting}
                aria-expanded={methodChooserOpen}
                onClick={() => setMethodChooserOpen((open) => !open)}
              >
                {t('txt_select_another_verification_method')}
              </button>
              {methodChooserOpen && (
                <div className="two-factor-method-list" role="list" aria-label={t('txt_select_two_step_login_method')}>
                  <div className="two-factor-method-label">{t('txt_select_two_step_login_method')}</div>
                  {methodOptions.map((providerType) => {
                    // 只有「已经是当前选项」的那一项该置灰：恢复码模式下就是恢复码自己；
                    // 常规提供程序在普通模式下本来就不在列表里，所以永远可点（含从恢复码切回邮件）。
                    const isActiveOption = providerType === TWO_FACTOR_PROVIDER_RECOVERY_CODE && recoveryMode;
                    return (
                      <button
                        key={providerType}
                        type="button"
                        className="btn btn-secondary two-factor-method-option"
                        disabled={props.totpSubmitting || isActiveOption}
                        onClick={() => {
                          setMethodChooserOpen(false);
                          if (providerType === TWO_FACTOR_PROVIDER_RECOVERY_CODE) {
                            setRecoveryMode(true);
                            setRecoveryCode('');
                            return;
                          }
                          setRecoveryMode(false);
                          props.onSelectTotpProvider(providerType);
                        }}
                      >
                        {twoFactorProviderLabel(providerType)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      >
        {recoveryMode ? (
          <>
            {/* 红字警告：服务端收到恢复码后会停用**全部**两步登录并轮换恢复码，必须说清楚。 */}
            <p className="muted-inline settings-field-note two-step-recovery-code-warning" role="alert">
              {t('txt_recovery_code_disables_all_two_step_warning')}
            </p>
            <label className="field">
              <span>{t('txt_recovery_code')}</span>
              <input
                className="input"
                value={recoveryCode}
                autoComplete="one-time-code"
                onInput={(e) => setRecoveryCode((e.currentTarget as HTMLInputElement).value.toUpperCase())}
              />
            </label>
          </>
        ) : (
          <>
            {isWebAuthn ? (
              <p className="muted-inline settings-field-note">{t('txt_touch_your_passkey_when_prompted')}</p>
            ) : (
              <label className="field">
                <span>{isYubiKeyOtp ? t('txt_otp_from_yubikey') : isEmailOtp ? t('txt_email_verification_code') : t('txt_totp_code')}</span>
                <input className="input" type={isYubiKeyOtp ? 'password' : 'text'} value={props.totpCode} autoComplete="one-time-code" onInput={(e) => props.onTotpCodeChange((e.currentTarget as HTMLInputElement).value)} />
              </label>
            )}
            {isEmailOtp && props.onResendEmailCode && (
              <button
                type="button"
                className="btn btn-secondary dialog-btn"
                disabled={props.totpSubmitting || props.emailCodeResending || (props.emailCodeResendIn ?? 0) > 0}
                onClick={props.onResendEmailCode}
              >
                {resendLabel(t('txt_resend_code'), props.emailCodeResendIn ?? 0)}
              </button>
            )}
            <label className="check-line check-line-compact">
              <input type="checkbox" checked={props.rememberDevice} onChange={(e) => props.onRememberDeviceChange((e.currentTarget as HTMLInputElement).checked)} />
              <span>{t('txt_trust_this_device_for_30_days')}</span>
            </label>
          </>
        )}
      </ConfirmDialog>

      {/* 二次确认：恢复码不可逆（全部两步登录会被停用），不能只靠一次点击。 */}
      <ConfirmDialog
        open={recoveryConfirmOpen}
        title={t('txt_recover_two_step_login')}
        message={t('txt_recovery_code_disable_confirm_message')}
        variant="warning"
        danger
        dismissable={false}
        confirmText={t('txt_continue')}
        cancelText={t('txt_cancel')}
        confirmDisabled={props.totpSubmitting}
        cancelDisabled={props.totpSubmitting}
        onConfirm={() => {
          setRecoveryConfirmOpen(false);
          props.onSubmitRecoveryCode(recoveryCode);
        }}
        onCancel={() => setRecoveryConfirmOpen(false)}
      />

      {props.deviceVerification && (
        <ConfirmDialog
          open
          title={t('txt_new_device_verification')}
          message={t('txt_new_device_verification_email_sent', { email: props.deviceVerification.email })}
          confirmText={t('txt_verify')}
          hideCancel
          closeButton
          dismissable={false}
          showIcon={false}
          confirmDisabled={props.deviceVerification.submitting || !props.deviceVerification.code.trim()}
          cancelDisabled={props.deviceVerification.submitting}
          onConfirm={props.deviceVerification.onConfirm}
          onCancel={props.deviceVerification.onCancel}
        >
          <label className="field">
            <span>{t('txt_email_verification_code')}</span>
            <input
              className="input"
              type="text"
              autoComplete="one-time-code"
              value={props.deviceVerification.code}
              onInput={(e) => props.deviceVerification?.onCodeChange((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          {/* 说明为何被拦：用户第一次在这个浏览器登录，看到「新设备验证」不会一头雾水。 */}
          <p className="muted-inline settings-field-note">{t('txt_new_device_verification_help')}</p>
          <button
            type="button"
            className="btn btn-secondary dialog-btn"
            disabled={props.deviceVerification.submitting || props.deviceVerification.resending || (props.deviceVerification.resendIn ?? 0) > 0}
            onClick={props.deviceVerification.onResend}
          >
            {resendLabel(t('txt_resend_code'), props.deviceVerification.resendIn ?? 0)}
          </button>
        </ConfirmDialog>
      )}

      <ConfirmDialog
        open={props.disableTotpOpen}
        title={t('txt_disable_totp')}
        message={t('txt_enter_master_password_to_disable_two_step_verification')}
        confirmText={t('txt_disable_totp')}
        hideCancel
        closeButton
        danger
        dismissable={false}
        showIcon={false}
        confirmDisabled={props.disableTotpSubmitting}
        cancelDisabled={props.disableTotpSubmitting}
        onConfirm={props.onConfirmDisableTotp}
        onCancel={props.onCancelDisableTotp}
      >
        <label className="field">
          <span>{t('txt_master_password')}</span>
          <input className="input" type="password" autoComplete="current-password" value={props.disableTotpPassword} onInput={(e) => props.onDisableTotpPasswordChange((e.currentTarget as HTMLInputElement).value)} />
        </label>
      </ConfirmDialog>

      <ToastHost
        toasts={props.toasts}
        onClose={props.onCloseToast}
        onPause={props.onPauseToasts}
        onResume={props.onResumeToasts}
      />
    </>
  );
}
