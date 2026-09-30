/**
 * `lib/api/vault.ts`（~64 KB 源码）只在**解锁后**才被调用，却是入口 chunk 里最大的非 tree-shake 模块
 * ⇒ 入口静态引它会让未登录访客也下整份（实测首屏 193.2 KB gzip）。本模块做一层惰性转发把它移出首屏，
 * 调用方写法不变（照样 `await createCipher(...)`）。
 *
 * ⚠️ 导出必须与 `vault.ts` 一一对应 —— 漏掉的会静默变成 `undefined`（护栏见 vault-lazy-guards.test.ts）。
 */
export type { AttachmentDownloadInfo, CiphersImportPayload, ImportedCipherMapEntry } from './vault';

type VaultApi = typeof import('./vault');

let vaultApiLoader: Promise<VaultApi> | null = null;

function loadVaultApi(): Promise<VaultApi> {
  vaultApiLoader ??= import('./vault');
  return vaultApiLoader;
}

/** 把 `vault.ts` 的某个 async 函数包成「先确保模块已加载、再调用」的同签名函数。 */
function forward<K extends keyof VaultApi>(name: K): VaultApi[K] {
  return ((...args: unknown[]) =>
    loadVaultApi().then((api) => (api[name] as (...inner: unknown[]) => unknown)(...args))) as VaultApi[K];
}

export const getFolders = forward('getFolders');
export const getFolderById = forward('getFolderById');
export const createFolder = forward('createFolder');
export const encryptFolderImportName = forward('encryptFolderImportName');
export const deleteFolder = forward('deleteFolder');
export const updateFolder = forward('updateFolder');
export const getCiphers = forward('getCiphers');
export const getCipherById = forward('getCipherById');
export const importCiphers = forward('importCiphers');
export const getAttachmentDownloadInfo = forward('getAttachmentDownloadInfo');
export const uploadCipherAttachment = forward('uploadCipherAttachment');
export const deleteCipherAttachment = forward('deleteCipherAttachment');
export const repairCipherAttachmentMetadata = forward('repairCipherAttachmentMetadata');
export const downloadCipherAttachmentDecrypted = forward('downloadCipherAttachmentDecrypted');
export const repairCipherUriChecksums = forward('repairCipherUriChecksums');
export const repairCipherKeyMismatches = forward('repairCipherKeyMismatches');
export const buildCipherImportPayload = forward('buildCipherImportPayload');
export const createCipher = forward('createCipher');
export const updateCipher = forward('updateCipher');
export const deleteCipher = forward('deleteCipher');
export const permanentDeleteCipher = forward('permanentDeleteCipher');
export const archiveCipher = forward('archiveCipher');
export const unarchiveCipher = forward('unarchiveCipher');
export const bulkDeleteCiphers = forward('bulkDeleteCiphers');
export const bulkArchiveCiphers = forward('bulkArchiveCiphers');
export const bulkPermanentDeleteCiphers = forward('bulkPermanentDeleteCiphers');
export const bulkRestoreCiphers = forward('bulkRestoreCiphers');
export const bulkUnarchiveCiphers = forward('bulkUnarchiveCiphers');
export const bulkMoveCiphers = forward('bulkMoveCiphers');
