import type { Env, User } from './types';
import { errorResponse, jsonResponse, unsupportedResponse } from './utils/response';
import {
  handleGetProfile,
  handleUpdateProfile,
  handleGetKeys,
  handleSetKeys,
  handleGetRevisionDate,
  handleVerifyPassword,
  handleChangePassword,
  handleSetVerifyDevices,
  handleGetTotpStatus,
  handleSetTotpStatus,
  handleGetTotpRecoveryCode,
  handleGetTwoFactorProviders,
  handleGetTwoFactorAuthenticator,
  handlePutTwoFactorAuthenticator,
  handleGetTwoFactorYubiKey,
  handlePutTwoFactorYubiKey,
  handlePutTwoFactorYubiKeyConfig,
  handleBootstrapTwoFactorYubiKeyConfig,
  handleDisableTwoFactorProvider,
  handlePutTwoFactorDefaultProvider,
  handleGetTwoFactorEmail,
  handlePutTwoFactorEmail,
  handleDeleteTwoFactorEmail,
  handleGetApiKey,
  handleRotateApiKey,
} from './handlers/accounts';
import { handleRequestAccountOtp, handleVerifyAccountOtp } from './handlers/accounts-user-verification';
import {
  handleGetEmailVerificationStatus,
  handleSendEmailVerificationCode,
  handleVerifyEmailCode,
} from './handlers/account-email-verification';
import {
  handleDetectPreferences,
  handleGetPreferences,
  handleUpdatePreferences,
} from './handlers/account-preferences';
import {
  handleGetCiphers,
  handleGetCipher,
  handleCreateCipher,
  handleUpdateCipher,
  handleDeleteCipher,
  handleDeleteCipherCompat,
  handlePermanentDeleteCipher,
  handleRestoreCipher,
  handleBulkArchiveCiphers,
  handlePartialUpdateCipher,
  handleBulkUnarchiveCiphers,
  handleBulkMoveCiphers,
  handleBulkDeleteCiphers,
  handleBulkPermanentDeleteCiphers,
  handleBulkRestoreCiphers,
  handleArchiveCipher,
  handleUnarchiveCipher,
} from './handlers/ciphers';
import {
  handleGetFolders,
  handleGetFolder,
  handleCreateFolder,
  handleUpdateFolder,
  handleDeleteFolder,
} from './handlers/folders';
import {
  handleGetSecretsOrganization,
  handleGetSecretsOrganizationKey,
  handlePutSecretsOrganizationKey,
} from './handlers/secrets';
import { handleSecretsMachineAccountRoute } from './handlers/secrets-machine';
import {
  handleGetSends,
  handleGetSend,
  handleCreateSend,
  handleCreateFileSendV2,
  handleGetSendFileUpload,
  handleUploadSendFile,
  handleUpdateSend,
  handleDeleteSend,
  handleBulkDeleteSends,
  handleRemoveSendPassword,
  handleRemoveSendAuth,
} from './handlers/sends';
import { handleSync } from './handlers/sync';
import { handleCiphersImport } from './handlers/import';
import {
  handleCreateAttachment,
  handleUploadAttachment,
  handleGetAttachment,
  handleUpdateAttachmentMetadata,
  handleDeleteAttachment,
} from './handlers/attachments';
import { handleDeleteAllDevices } from './handlers/devices';
import { handleAuthenticatedDeviceRoute } from './router-devices';
import { handleAdminRoute } from './router-admin';
import { handleGetDomains, handleUpdateDomains } from './handlers/domains';
import {
  handleCreateAccountPasskeyCredential,
  handleDeleteAccountPasskeyCredential,
  handleDeleteTwoFactorWebAuthn,
  handleGetAccountPasskeyAttestationOptions,
  handleGetAccountPasskeyCredentials,
  handleGetAccountPasskeyUpdateAssertionOptions,
  handleGetTwoFactorWebAuthn,
  handleGetTwoFactorWebAuthnChallenge,
  handlePutTwoFactorWebAuthn,
  handleUpdateAccountPasskeyEncryption,
} from './handlers/account-passkeys';
import {
  handleCreateAdminAuthRequest,
  handleGetAuthRequest,
  handleListAuthRequests,
  handleListPendingAuthRequests,
  handleUpdateAuthRequest,
} from './handlers/auth-requests';

export async function handleAuthenticatedRoute(
  request: Request,
  env: Env,
  userId: string,
  currentUser: User,
  path: string,
  method: string
): Promise<Response | null> {
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    const blockedAccountPaths = new Set([
      '/api/accounts/set-password',
      '/api/accounts/delete',
      '/api/accounts/delete-account',
      '/api/accounts/delete-vault',
    ]);
    if (blockedAccountPaths.has(path)) {
      return errorResponse('Not implemented', 501);
    }
  }

  if ((path === '/api/accounts/kdf' || path === '/accounts/kdf') && (method === 'POST' || method === 'PUT')) {
    return unsupportedResponse('KDF changes are not supported by this server.');
  }

  // ⚠️ 官方「改邮箱」流程的两个端点。本站**不支持改邮箱**（`users.email` 只在注册时写入），
  // 必须**明确拒绝**：官方 `/accounts/email-token` 传的是 `newEmail`，若落到我们
  // 「给当前邮箱发验证码」的实现上，会**静默给旧地址发一枚码**（无报错、行为错位）。
  const changeEmailPaths = new Set([
    '/api/accounts/email-token',
    '/accounts/email-token',
    '/api/accounts/email',
    '/accounts/email',
  ]);
  if (changeEmailPaths.has(path) && (method === 'POST' || method === 'PUT')) {
    return unsupportedResponse('Changing the email address is not supported by this server.');
  }

  const mailBackedAccountPaths = new Set([
    // 本站的邮箱验证是**自有流程**（6 位数字码），端点见下方分发；
    // 这里只剩官方那套**邮件链接**能力（仅邀请注册 ⇒ 有意不做）。
    '/api/accounts/verify-email',
    '/accounts/verify-email',
    '/api/accounts/verify-email-token',
    '/accounts/verify-email-token',
  ]);
  if (mailBackedAccountPaths.has(path) && (method === 'POST' || method === 'PUT')) {
    return unsupportedResponse('Email link and email OTP flows are not implemented by this server.');
  }

  // User Verification（敏感操作的二次确认）：`request-otp` 的官方请求体是空的，`verify-otp` 的是 `{ OTP }`。
  if ((path === '/api/accounts/request-otp' || path === '/accounts/request-otp') && method === 'POST') {
    return handleRequestAccountOtp(request, env, userId);
  }

  if ((path === '/api/accounts/verify-otp' || path === '/accounts/verify-otp') && method === 'POST') {
    return handleVerifyAccountOtp(request, env, userId);
  }

  // 邮件两步登录（2FA provider 1）的开关端点。发码端点 `/api/two-factor/send-email-login`
  // 是**公开**的（登录前调用、无会话）⇒ 在 router-public 里处理，不在这里。
  if (path === '/api/two-factor/get-email' || path === '/two-factor/get-email') {
    if (method === 'POST') return handleGetTwoFactorEmail(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/two-factor/email' || path === '/two-factor/email') {
    if (method === 'PUT' || method === 'POST') return handlePutTwoFactorEmail(request, env, userId);
    if (method === 'DELETE') return handleDeleteTwoFactorEmail(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/accounts/profile') {
    if (method === 'GET') return handleGetProfile(request, env, userId);
    if (method === 'PUT') return handleUpdateProfile(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  // 邮箱验证（**本站自有流程**）：状态查询、发码、确认码。
  // ⚠️ 路径必须与官方**分开命名** —— 官方同名路径语义相反（改邮箱 / 发链接邮件），
  // 已在上面显式拒绝。
  if (path === '/api/accounts/email-verification') {
    if (method === 'GET') return handleGetEmailVerificationStatus(request, env, currentUser);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/accounts/email-verification/send') {
    if (method === 'POST') return handleSendEmailVerificationCode(request, env, currentUser);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/accounts/email-verification/confirm') {
    if (method === 'POST') return handleVerifyEmailCode(request, env, currentUser);
    return errorResponse('Method not allowed', 405);
  }

  // 用户级「语言 / 时区」偏好（普通用户也必须能设，故**不做**管理员检查）
  if (path === '/api/accounts/preferences') {
    if (method === 'GET') return handleGetPreferences(request, env, currentUser);
    if (method === 'PUT') return handleUpdatePreferences(request, env, currentUser);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/accounts/preferences/detect' && method === 'POST') {
    return handleDetectPreferences(request, env, currentUser);
  }

  if (path === '/api/accounts/password' && (method === 'POST' || method === 'PUT')) {
    return handleChangePassword(request, env, userId);
  }

  if (path === '/api/accounts/keys') {
    if (method === 'GET') return handleGetKeys(request, env, userId);
    if (method === 'POST') return handleSetKeys(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  // 机密管理器：隐式组织与组织密钥（Web 会话）。与官方端点**分开命名**：官方那套
  // （`/api/organizations/...`）服务 `bws`，复用会把 Web 端字段泄露进官方线格式。
  if (path === '/api/secrets/organization' && method === 'GET') {
    return handleGetSecretsOrganization(request, env, userId);
  }

  if (path === '/api/secrets/organization-key') {
    if (method === 'GET') return handleGetSecretsOrganizationKey(request, env, userId);
    if (method === 'PUT' || method === 'POST') return handlePutSecretsOrganizationKey(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  // 机器账号与访问令牌（仅自家 Web UI）：路径带 id 段，整棵子树交给同一个处理器解析。
  if (path.startsWith('/api/secrets/machine-accounts') || path.startsWith('/api/secrets/tokens')) {
    return handleSecretsMachineAccountRoute(request, env, userId, path, method);
  }

  if (path === '/api/accounts/totp') {
    if (method === 'GET') return handleGetTotpStatus(request, env, userId);
    if (method === 'PUT' || method === 'POST') return handleSetTotpStatus(request, env, userId);
    return null;
  }

  if ((path === '/api/accounts/totp/recovery-code' || path === '/api/two-factor/get-recover') && method === 'POST') {
    return handleGetTotpRecoveryCode(request, env, userId);
  }

  if (path === '/api/two-factor') {
    if (method === 'GET') return handleGetTwoFactorProviders(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  // 登录时优先使用的两步登录提供程序（本站扩展；官方客户端没有这个偏好，它们只读列表顺序）。
  if (path === '/api/accounts/two-factor/default-provider') {
    if (method === 'PUT' || method === 'POST') return handlePutTwoFactorDefaultProvider(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/two-factor/get-authenticator' && method === 'POST') {
    return handleGetTwoFactorAuthenticator(request, env, userId);
  }

  if ((path === '/api/two-factor/get-yubikey') && method === 'POST') {
    return handleGetTwoFactorYubiKey(request, env, userId);
  }

  if (path === '/api/two-factor/get-webauthn' && method === 'POST') {
    return handleGetTwoFactorWebAuthn(request, env, userId, currentUser);
  }

  if (path === '/api/two-factor/get-webauthn-challenge' && method === 'POST') {
    return handleGetTwoFactorWebAuthnChallenge(request, env, userId, currentUser);
  }

  if (path === '/api/two-factor/authenticator') {
    if (method === 'PUT' || method === 'POST') return handlePutTwoFactorAuthenticator(request, env, userId);
    if (method === 'DELETE') return handleDisableTwoFactorProvider(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/two-factor/yubikey') {
    if (method === 'PUT' || method === 'POST') return handlePutTwoFactorYubiKey(request, env, userId);
    if (method === 'DELETE') return handleDisableTwoFactorProvider(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/two-factor/webauthn') {
    if (method === 'PUT' || method === 'POST') return handlePutTwoFactorWebAuthn(request, env, userId, currentUser);
    if (method === 'DELETE') return handleDeleteTwoFactorWebAuthn(request, env, userId, currentUser);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/two-factor/yubikey/config' && (method === 'PUT' || method === 'POST')) {
    return handlePutTwoFactorYubiKeyConfig(request, env, userId);
  }

  if (path === '/api/two-factor/yubikey/bootstrap' && method === 'POST') {
    return handleBootstrapTwoFactorYubiKeyConfig(request, env, userId);
  }

  if (path === '/api/two-factor/disable' && (method === 'PUT' || method === 'POST')) {
    return handleDisableTwoFactorProvider(request, env, userId);
  }

  if (path === '/api/accounts/revision-date' && method === 'GET') {
    return handleGetRevisionDate(request, env, userId);
  }

  if (path === '/api/accounts/verify-password' && method === 'POST') {
    return handleVerifyPassword(request, env, userId);
  }

  if (path === '/api/accounts/verify-devices' && (method === 'PUT' || method === 'POST')) {
    return handleSetVerifyDevices(request, env, userId);
  }

  // 官方客户端「撤销所有会话」走 POST /api/accounts/security-stamp（`postSecurityStamp`）；
  // 本站等价实现是 DELETE /api/devices，加别名让官方客户端也能用上。
  if (path === '/api/accounts/security-stamp' && method === 'POST') {
    return handleDeleteAllDevices(request, env, userId);
  }

  if ((path === '/api/accounts/api-key' || path === '/api/accounts/api_key') && method === 'POST') {
    return handleGetApiKey(request, env, userId);
  }

  if ((path === '/api/accounts/rotate-api-key' || path === '/api/accounts/rotate_api_key') && method === 'POST') {
    return handleRotateApiKey(request, env, userId);
  }

  if (path === '/api/webauthn' || path === '/webauthn') {
    if (method === 'GET') return handleGetAccountPasskeyCredentials(request, env, userId);
    if (method === 'POST') return handleCreateAccountPasskeyCredential(request, env, userId);
    if (method === 'PUT') return handleUpdateAccountPasskeyEncryption(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if ((path === '/api/webauthn/attestation-options' || path === '/webauthn/attestation-options') && method === 'POST') {
    return handleGetAccountPasskeyAttestationOptions(request, env, userId, currentUser);
  }

  if ((path === '/api/webauthn/assertion-options' || path === '/webauthn/assertion-options') && method === 'POST') {
    return handleGetAccountPasskeyUpdateAssertionOptions(request, env, userId, currentUser);
  }

  const accountPasskeyDeleteMatch =
    path.match(/^\/api\/webauthn\/([^/]+)\/delete$/i) ||
    path.match(/^\/webauthn\/([^/]+)\/delete$/i);
  if (accountPasskeyDeleteMatch && method === 'POST') {
    return handleDeleteAccountPasskeyCredential(request, env, userId, accountPasskeyDeleteMatch[1], currentUser);
  }

  if (path === '/api/sync' && method === 'GET') {
    return handleSync(request, env, userId);
  }

  if (path.startsWith('/notifications/')) {
    return errorResponse('Not found', 404);
  }

  if (path === '/api/ciphers' || path === '/api/ciphers/create') {
    if (method === 'GET') return handleGetCiphers(request, env, userId);
    if (method === 'POST') return handleCreateCipher(request, env, userId);
    if (path === '/api/ciphers' && method === 'DELETE') return handleBulkPermanentDeleteCiphers(request, env, userId);
    return null;
  }

  if (path === '/api/ciphers/import' && method === 'POST') {
    return handleCiphersImport(request, env, userId);
  }

  if (path === '/api/ciphers/delete' && (method === 'PUT' || method === 'POST')) {
    return handleBulkDeleteCiphers(request, env, userId);
  }

  if (path === '/api/ciphers/delete-permanent' && method === 'POST') {
    return handleBulkPermanentDeleteCiphers(request, env, userId);
  }

  if (path === '/api/ciphers/restore' && (method === 'PUT' || method === 'POST')) {
    return handleBulkRestoreCiphers(request, env, userId);
  }

  if (path === '/api/ciphers/archive' && (method === 'PUT' || method === 'POST')) {
    return handleBulkArchiveCiphers(request, env, userId);
  }

  if (path === '/api/ciphers/unarchive' && (method === 'PUT' || method === 'POST')) {
    return handleBulkUnarchiveCiphers(request, env, userId);
  }

  if (path === '/api/ciphers/move' && (method === 'POST' || method === 'PUT')) {
    return handleBulkMoveCiphers(request, env, userId);
  }

  const cipherMatch = path.match(/^\/api\/ciphers\/([a-f0-9-]+)(\/.*)?$/i);
  if (cipherMatch) {
    const cipherId = cipherMatch[1];
    const subPath = cipherMatch[2] || '';

    if (subPath === '' || subPath === '/') {
      if (method === 'GET') return handleGetCipher(request, env, userId, cipherId);
      if (method === 'PUT' || method === 'POST') return handleUpdateCipher(request, env, userId, cipherId);
      if (method === 'DELETE') return handleDeleteCipherCompat(request, env, userId, cipherId);
    }

    if (subPath === '/delete' && method === 'PUT') return handleDeleteCipher(request, env, userId, cipherId);
    if (subPath === '/delete' && (method === 'DELETE' || method === 'POST')) return handlePermanentDeleteCipher(request, env, userId, cipherId);
    if (subPath === '/restore' && method === 'PUT') return handleRestoreCipher(request, env, userId, cipherId);
    if (subPath === '/archive' && (method === 'PUT' || method === 'POST')) return handleArchiveCipher(request, env, userId, cipherId);
    if (subPath === '/unarchive' && (method === 'PUT' || method === 'POST')) return handleUnarchiveCipher(request, env, userId, cipherId);
    if (subPath === '/partial' && (method === 'PUT' || method === 'POST')) return handlePartialUpdateCipher(request, env, userId, cipherId);
    if (subPath === '/share' && method === 'POST') return handleGetCipher(request, env, userId, cipherId);
    if (subPath === '/details' && method === 'GET') return handleGetCipher(request, env, userId, cipherId);
    if (subPath === '/attachment/v2' && method === 'POST') return handleCreateAttachment(request, env, userId, cipherId);
    if (subPath === '/attachment' && method === 'POST') return handleCreateAttachment(request, env, userId, cipherId);

    const attachmentMatch = subPath.match(/^\/attachment\/([a-f0-9-]+)$/i);
    if (attachmentMatch) {
      const attachmentId = attachmentMatch[1];
      if (method === 'POST' || method === 'PUT') return handleUploadAttachment(request, env, userId, cipherId, attachmentId);
      if (method === 'GET') return handleGetAttachment(request, env, userId, cipherId, attachmentId);
      if (method === 'DELETE') return handleDeleteAttachment(request, env, userId, cipherId, attachmentId);
    }

    const attachmentMetadataMatch = subPath.match(/^\/attachment\/([a-f0-9-]+)\/metadata$/i);
    if (attachmentMetadataMatch && (method === 'POST' || method === 'PUT')) {
      return handleUpdateAttachmentMetadata(request, env, userId, cipherId, attachmentMetadataMatch[1]);
    }

    const attachmentDeleteMatch = subPath.match(/^\/attachment\/([a-f0-9-]+)\/delete$/i);
    if (attachmentDeleteMatch && method === 'POST') {
      return handleDeleteAttachment(request, env, userId, cipherId, attachmentDeleteMatch[1]);
    }
  }

  if (path === '/api/folders') {
    if (method === 'GET') return handleGetFolders(request, env, userId);
    if (method === 'POST') return handleCreateFolder(request, env, userId);
    return null;
  }

  const folderMatch = path.match(/^\/api\/folders\/([a-f0-9-]+)$/i);
  if (folderMatch) {
    const folderId = folderMatch[1];
    if (method === 'GET') return handleGetFolder(request, env, userId, folderId);
    if (method === 'PUT') return handleUpdateFolder(request, env, userId, folderId);
    if (method === 'DELETE') return handleDeleteFolder(request, env, userId, folderId);
  }

  if (path === '/api/auth-requests' || path === '/api/auth-requests/' || path === '/auth-requests' || path === '/auth-requests/') {
    if (method === 'GET') return handleListAuthRequests(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/auth-requests/pending' || path === '/auth-requests/pending') {
    if (method === 'GET') return handleListPendingAuthRequests(request, env, userId);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/auth-requests/admin-request' || path === '/auth-requests/admin-request') {
    if (method === 'POST') return handleCreateAdminAuthRequest(request, env, userId, currentUser.email);
    return errorResponse('Method not allowed', 405);
  }

  const authRequestMatch = path.match(/^\/(?:api\/)?auth-requests\/([a-f0-9-]+)$/i);
  if (authRequestMatch) {
    if (method === 'GET') return handleGetAuthRequest(request, env, userId, authRequestMatch[1]);
    if (method === 'PUT') return handleUpdateAuthRequest(request, env, userId, authRequestMatch[1]);
    return errorResponse('Method not allowed', 405);
  }

  if (path === '/api/collections' || path.startsWith('/api/collections/')) {
    if (method === 'GET') {
      return jsonResponse({ data: [], object: 'list', continuationToken: null });
    }
    return null;
  }

  if (path === '/api/organizations' || path.startsWith('/api/organizations/')) {
    if (method === 'GET') {
      return jsonResponse({ data: [], object: 'list', continuationToken: null });
    }
    return null;
  }

  if (path === '/api/sends') {
    if (method === 'GET') return handleGetSends(request, env, userId);
    if (method === 'POST') return handleCreateSend(request, env, userId);
    return null;
  }

  if (path === '/api/sends/file/v2' && method === 'POST') {
    return handleCreateFileSendV2(request, env, userId);
  }

  if (path === '/api/sends/delete' && method === 'POST') {
    return handleBulkDeleteSends(request, env, userId);
  }

  const sendMatch = path.match(/^\/api\/sends\/([^/]+)(\/.*)?$/i);
  if (sendMatch) {
    const sendId = sendMatch[1];
    const subPath = sendMatch[2] || '';

    if (subPath === '' || subPath === '/') {
      if (method === 'GET') return handleGetSend(request, env, userId, sendId);
      if (method === 'PUT') return handleUpdateSend(request, env, userId, sendId);
      if (method === 'DELETE') return handleDeleteSend(request, env, userId, sendId);
    }

    if (subPath === '/remove-password' && (method === 'PUT' || method === 'POST')) {
      return handleRemoveSendPassword(request, env, userId, sendId);
    }

    if (subPath === '/remove-auth' && (method === 'PUT' || method === 'POST')) {
      return handleRemoveSendAuth(request, env, userId, sendId);
    }

    const sendFileUploadMatch = subPath.match(/^\/file\/([^/]+)\/?$/i);
    if (sendFileUploadMatch) {
      const fileId = sendFileUploadMatch[1];
      if (method === 'GET') return handleGetSendFileUpload(request, env, userId, sendId, fileId);
      if (method === 'POST' || method === 'PUT') return handleUploadSendFile(request, env, userId, sendId, fileId);
    }
  }

  if (path === '/api/policies' || path.startsWith('/api/policies/')) {
    if (method === 'GET') {
      return jsonResponse({ data: [], object: 'list', continuationToken: null });
    }
    return null;
  }

  if (path === '/api/settings/domains' || path === '/settings/domains') {
    if (method === 'GET') return handleGetDomains(request, env, userId);
    if (method === 'PUT' || method === 'POST') return handleUpdateDomains(request, env, userId);
    return null;
  }

  const authenticatedDeviceResponse = await handleAuthenticatedDeviceRoute(request, env, userId, path, method);
  if (authenticatedDeviceResponse) return authenticatedDeviceResponse;

  const adminResponse = await handleAdminRoute(request, env, currentUser, path, method);
  if (adminResponse) return adminResponse;

  return null;
}
