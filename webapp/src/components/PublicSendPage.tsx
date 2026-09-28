import { useEffect, useRef, useState } from 'preact/hooks';
import { Clipboard, Download, Eye, Lock } from 'lucide-preact';
import { requestSendAccessToken, accessSendWithToken, requestSendFileUrl, decryptPublicSend, decryptPublicSendFileBytes, type PublicSendAccessCredentials, type SendAccessErrorType } from '@/lib/api/send';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toBufferSource } from '@/lib/crypto';
import { downloadBytesAsFile, readResponseBytesWithProgress } from '@/lib/download';
import NotFoundPage from '@/components/NotFoundPage';
import StandalonePageFrame from '@/components/StandalonePageFrame';
import { getDemoPublicSend, IS_DEMO_MODE } from '@/lib/demo';
import { t } from '@/lib/i18n';
import { useDateTimeFormat } from '@/lib/datetime';

interface PublicSendPageProps {
  accessId: string;
  keyPart: string | null;
  /** 页面没有内联错误区：失败原因一律走全局 toast */
  onNotify: (type: 'success' | 'error' | 'warning', text: string) => void;
}

interface PublicSendFileData {
  id: string;
  fileName?: string | null;
  sizeName?: string | null;
}

interface PublicSendData {
  id: string;
  type: 0 | 1;
  decName?: string | null;
  decText?: string | null;
  decFileName?: string | null;
  expirationDate?: string | null;
  file?: PublicSendFileData | null;
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const raw = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    const decoded = atob(padded);
    const out = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) out[i] = decoded.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hasUsableSendKey(keyPart: string | null): boolean {
  if (!keyPart) return false;
  const bytes = decodeBase64Url(keyPart);
  return !!bytes && bytes.length >= 16;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parsePublicSendData(value: unknown): PublicSendData | null {
  const source = asRecord(value);
  if (!source) return null;
  const id = optionalString(source.id);
  const rawType = Number(source.type);
  if (!id || (rawType !== 0 && rawType !== 1)) return null;

  const fileSource = asRecord(source.file);
  const fileId = optionalString(fileSource?.id);
  const file = fileSource && fileId
    ? {
        id: fileId,
        fileName: optionalString(fileSource.fileName),
        sizeName: optionalString(fileSource.sizeName),
      }
    : null;
  if (rawType === 1 && !file) return null;

  return {
    id,
    type: rawType,
    decName: optionalString(source.decName),
    decText: optionalString(source.decText),
    decFileName: optionalString(source.decFileName),
    expirationDate: optionalString(source.expirationDate),
    file,
  };
}

export default function PublicSendPage(props: PublicSendPageProps) {
  const { format } = useDateTimeFormat();
  const notify = props.onNotify;
  // 空值 / 解析失败都是空串：这是给外部收件人看的页面，不出现占位符
  const formatSendDate = (value: string | null | undefined): string => format(value) ?? '';
  const initialDemoSend = IS_DEMO_MODE ? getDemoPublicSend(props.accessId) : null;
  const [loading, setLoading] = useState(!IS_DEMO_MODE);
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  /** 需要哪种凭据才能继续（`null` = 已解锁或未开始） */
  const [gate, setGate] = useState<'password' | 'email' | 'otp' | null>(null);
  /** 已经发过一轮码 —— 用来区分「刚发码」与「码不对」（服务端两者响应完全相同） */
  const [codeSent, setCodeSent] = useState(false);
  const [notFound, setNotFound] = useState(IS_DEMO_MODE && !initialDemoSend);
  const [sendData, setSendData] = useState<PublicSendData | null>(initialDemoSend);
  const [busy, setBusy] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const loadRequestRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  /** 解锁后拿到的访问令牌：下载文件时复用，避免二次提交一次性验证码 */
  const accessTokenRef = useRef<string | null>(null);

  async function loadSend(credentials: PublicSendAccessCredentials = {}): Promise<void> {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    loadAbortRef.current = controller;
    setBusy(true);
    setNotFound(false);
    setLoading(true);
    try {
      if (IS_DEMO_MODE) {
        const demoSend = getDemoPublicSend(props.accessId);
        if (!demoSend) {
          setNotFound(true);
          setSendData(null);
          return;
        }
        setSendData(demoSend);
        setGate(null);
        return;
      }
      if (!props.keyPart || !hasUsableSendKey(props.keyPart)) {
        setNotFound(true);
        setSendData(null);
        return;
      }
      const keyPart = props.keyPart;
      // 两步走：先换访问令牌（邮箱验证码是一次性的，后续请求都靠令牌）
      const token = await requestSendAccessToken(props.accessId, keyPart, credentials, { signal: controller.signal });
      if (controller.signal.aborted || requestId !== loadRequestRef.current) return;
      const data = await accessSendWithToken(token);
      if (controller.signal.aborted || requestId !== loadRequestRef.current) return;
      let decrypted: unknown;
      try {
        decrypted = await decryptPublicSend(data, keyPart);
      } catch {
        // 密钥不对时底层抛的是 `MAC mismatch`（英文技术串），别直接展示给用户
        setSendData(null);
        setGate(null);
        notify('error', t('txt_send_decrypt_failed'));
        return;
      }
      if (controller.signal.aborted || requestId !== loadRequestRef.current) return;
      const parsed = parsePublicSendData(decrypted);
      if (!parsed) {
        // 服务端返回的数据不合预期 ⇒ 当作链接失效，而不是笼统的「打开失败」
        setSendData(null);
        setNotFound(true);
        return;
      }
      setSendData(parsed);
      setGate(null);
      accessTokenRef.current = token;
    } catch (e) {
      if (controller.signal.aborted || requestId !== loadRequestRef.current) return;
      const err = e as Error & { status?: number; sendAccessErrorType?: SendAccessErrorType };
      const errorType = err.sendAccessErrorType;
      if (errorType === 'email_required') {
        setGate('email');
      } else if (errorType === 'email_and_otp_required') {
        // 服务端对「已发码」「码错」「邮箱不在名单」返回完全相同的响应，
        // 所以只能靠本地状态区分文案（名单外与码错最终都是「码不对」，不会泄露名单）。
        setGate('otp');
        if (codeSent) notify('error', t('txt_send_code_invalid'));
        setCodeSent(true);
      } else if (errorType === 'email_delivery_unavailable') {
        setGate(null);
        notify('error', t('txt_send_email_unavailable'));
      } else if (errorType === 'password_hash_b64_required') {
        setGate('password');
        // 第一次进来只是「需要密码」，已经提交过就说明密码不对
        notify(credentials.password ? 'error' : 'warning', t('txt_this_send_is_password_protected'));
      } else if (errorType === 'password_hash_b64_invalid') {
        setGate('password');
        notify('error', t('txt_send_password_invalid'));
      } else if (errorType === 'send_id_required' || errorType === 'send_id_invalid' || err.status === 404) {
        // 链接失效 / Send 已删 ⇒ 整页 404，比「空卡片 + 一闪而过的提示」清楚
        setGate(null);
        setNotFound(true);
      } else if (err.status === 429) {
        notify('error', t('txt_too_many_requests_try_later'));
      } else {
        // 对外页面不能把服务端英文原文（如 `send_id is invalid.`）或浏览器的 `Failed to fetch` 丢给收件人
        notify('error', t('txt_failed_to_open_send'));
      }
      setSendData(null);
    } finally {
      if (controller.signal.aborted || requestId !== loadRequestRef.current) return;
      setBusy(false);
      setLoading(false);
    }
  }

  async function downloadFile(): Promise<void> {
    if (!sendData?.id || !sendData?.file?.id) return;
    setBusy(true);
    setDownloadPercent(null);
    try {
      if (IS_DEMO_MODE) {
        const bytes = new TextEncoder().encode('NodeWarden demo file Send.\nThis download is generated locally in demo mode.\n');
        downloadBytesAsFile(bytes, sendData.decFileName || sendData.file?.fileName || 'nodewarden-demo-send.txt', 'application/octet-stream');
        return;
      }
      const token = accessTokenRef.current;
      if (!token) throw new Error(t('txt_failed_to_open_send'));
      const url = await requestSendFileUrl(token, sendData.file.id);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(t('txt_download_failed'));
      const encryptedBytes = await readResponseBytesWithProgress(resp, (progress) => setDownloadPercent(progress.percent));
      let blob: Blob;
      if (props.keyPart) {
        try {
          const decryptedBytes = await decryptPublicSendFileBytes(encryptedBytes, props.keyPart);
          blob = new Blob([toBufferSource(decryptedBytes)], { type: 'application/octet-stream' });
        } catch {
          // Legacy compatibility: early web-created file sends uploaded plaintext bytes.
          blob = new Blob([toBufferSource(encryptedBytes)], { type: 'application/octet-stream' });
        }
      } else {
        blob = new Blob([toBufferSource(encryptedBytes)], { type: 'application/octet-stream' });
      }
      downloadBytesAsFile(
        new Uint8Array(await blob.arrayBuffer()),
        sendData.decFileName || sendData.file?.fileName || t('txt_send_file'),
        'application/octet-stream'
      );
    } catch (e) {
      const err = e as Error & { status?: number };
      // 同样不暴露服务端英文原文，只给本地化文案
      notify('error', err.status === 429 ? t('txt_too_many_requests_try_later') : t('txt_download_failed'));
    } finally {
      setBusy(false);
      setDownloadPercent(null);
    }
  }

  useEffect(() => {
    if (IS_DEMO_MODE) {
      const demoSend = getDemoPublicSend(props.accessId);
      setSendData(demoSend);
      setNotFound(!demoSend);
      setGate(null);
      setLoading(false);
      return;
    }
    void loadSend();
    return () => {
      loadAbortRef.current?.abort();
    };
  }, [props.accessId, props.keyPart]);

  if (!loading && notFound) {
    return <NotFoundPage title={t('txt_page_not_found')} message={t('txt_send_unavailable')} />;
  }

  return (
    <div className="auth-page public-send-page">
      <StandalonePageFrame
        title={sendData ? (sendData.decName || t('txt_no_name')) : t('txt_nodewarden_send')}
        eyebrow={sendData ? t('txt_nodewarden_send') : undefined}
      >
        {loading && <p className="muted">{t('txt_loading')}</p>}

        {!loading && gate === 'password' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadSend({ password });
            }}
          >
            <label className="field">
              <span>{t('txt_password')}</span>
              <div className="password-wrap">
                <input
                  className="input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
                />
              </div>
            </label>
            <button type="submit" className="btn btn-primary full" disabled={busy}>
              <Lock size={14} className="btn-icon" /> {t('txt_unlock_send')}
            </button>
          </form>
        )}

        {!loading && gate === 'email' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadSend({ email });
            }}
          >
            <p className="muted">{t('txt_send_email_form_help')}</p>
            <label className="field">
              <span>{t('txt_email')}</span>
              <input
                className="input"
                type="email"
                value={email}
                autoComplete="email"
                onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <button type="submit" className="btn btn-primary full" disabled={busy || !email.trim()}>
              <Lock size={14} className="btn-icon" /> {t('txt_unlock_send')}
            </button>
          </form>
        )}

        {!loading && gate === 'otp' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadSend({ email, otp });
            }}
          >
            <p className="muted">{t('txt_send_code_sent')}</p>
            <label className="field">
              <span>{t('txt_email_verification_code_label')}</span>
              <input
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onInput={(e) => setOtp((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <button type="submit" className="btn btn-primary full" disabled={busy || !otp.trim()}>
              <Lock size={14} className="btn-icon" /> {t('txt_email_verification_submit')}
            </button>
            <button
              type="button"
              className="btn btn-secondary full"
              disabled={busy}
              onClick={() => void loadSend({ email })}
            >
              {t('txt_email_verification_resend_code')}
            </button>
          </form>
        )}

        {!loading && sendData && (
          <>
            {sendData.type === 0 ? (
              <div className="card public-send-card">
                <div className="public-send-card-head">
                  <span>{t('txt_text_send')}</span>
                  <button
                    type="button"
                    className="btn btn-secondary small public-send-copy-btn"
                    disabled={!sendData.decText}
                    onClick={() => void copyTextToClipboard(sendData.decText || '')}
                  >
                    <Clipboard size={14} className="btn-icon" />
                    {t('txt_copy')}
                  </button>
                </div>
                <div className="notes">{sendData.decText || ''}</div>
              </div>
            ) : (
              <div className="card public-send-card">
                <div className="kv-line">
                  <span>{t('txt_file')}</span>
                  <strong>{sendData.decFileName || sendData.file?.fileName || sendData.file?.sizeName || t('txt_encrypted_file')}</strong>
                </div>
                <button type="button" className="btn btn-primary full" disabled={busy} onClick={() => void downloadFile()}>
                  <Download size={14} className="btn-icon" /> {downloadPercent == null ? (busy ? t('txt_downloading') : t('txt_download')) : t('txt_downloading_percent', { percent: downloadPercent })}
                </button>
              </div>
            )}
            {!!sendData.expirationDate && <p className="muted">{t('txt_expires_at_value', { value: formatSendDate(sendData.expirationDate) })}</p>}
          </>
        )}

        {/* 常驻说明：失败原因走 toast，这里留一行稳定的「当前状态」，否 则卡片只剩标题 */}
        {!loading && !sendData && !gate && (
          <p className="muted">
            <Eye size={14} className="inline-status-icon" /> {t('txt_send_unavailable')}
          </p>
        )}
      </StandalonePageFrame>
    </div>
  );
}
