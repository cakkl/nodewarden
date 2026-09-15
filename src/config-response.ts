import { LIMITS } from './config/limits';

function buildIconServiceTemplate(origin: string): string {
  return `${origin}/icons/{}/icon.png`;
}

function buildIconServiceCsp(origin: string): string {
  return `img-src 'self' data: ${origin}`;
}

export function buildConfigResponse(origin: string) {
  const fillAssistBase = `${origin}/fill-assist/`;
  return {
    version: LIMITS.compatibility.bitwardenServerVersion,
    gitHash: 'nodewarden',
    server: null,
    environment: {
      cloudRegion: 'self-hosted',
      vault: origin,
      api: origin + '/api',
      identity: origin + '/identity',
      notifications: origin + '/notifications',
      icons: origin,
      sso: '',
      fillAssistRules: fillAssistBase,
    },
    push: {
      pushTechnology: 0,
      vapidPublicKey: null,
    },
    communication: null,
    settings: {
      disableUserRegistration: false,
      suppressOnboardingInterstitials: false,
    },
    _icon_service_url: buildIconServiceTemplate(origin),
    _icon_service_csp: buildIconServiceCsp(origin),
    featureStates: {
      'cipher-key-encryption': LIMITS.compatibility.cipherKeyEncryptionFeatureEnabled,
      'desktop-ui-settings-dialog': true,
      'duo-redirect': true,
      // 本服务器不提供邮件发送通道：/accounts/register/send-verification-email、
      // /accounts/verify-email、/api/two-factor/send-email-login 等端点一律返回 501
      // “Email delivery is not supported by this server.”（见 router-public.ts / router-authenticated.ts）。
      // 因此不能告诉客户端“支持邮箱验证”，否则客户端会展示相应的设置项并调用注定失败的接口。
      // 将来接入邮件能力（见 docs/TODO/MAIL.md）时再改回 true。
      'email-verification': false,
      'fill-assist-targeting-rules': true,
      'pm-19051-send-email-verification': false,
      'pm-19148-innovation-archive': true,
      'pm-4516-devices-add-last-activity-date': true,
      'pm-30529-webauthn-related-origins': true,
      'unauth-ui-refresh': true,
      'web-push': false,
    },
    object: 'config',
  };
}
