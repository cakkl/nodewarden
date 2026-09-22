import { Home } from 'lucide-preact';
import { Link } from 'wouter';
import { t } from '@/lib/i18n';

interface NotFoundPageProps {
  title?: string;
  message?: string;
  homeHref?: string;
  /** 嵌在应用内容区里时关掉品牌区 —— 导航栏已经有一个了。 */
  showBrand?: boolean;
}

export default function NotFoundPage(props: NotFoundPageProps) {
  return (
    <main className="not-found-page">
      <section className="not-found-shell" aria-labelledby="not-found-title">
        {props.showBrand === false ? null : (
          <div className="not-found-brand">
            <img src="/nodewarden-logo.svg" alt="NodeWarden logo" className="not-found-logo" />
            <span className="not-found-wordmark" aria-label="NodeWarden" role="img" />
          </div>
        )}
        <div className="not-found-copy">
          <div className="not-found-code">404</div>
          <h1 id="not-found-title">{props.title || t('txt_page_not_found')}</h1>
          <p>{props.message || t('txt_page_not_found_hint')}</p>
          {/* 必须走 SPA 导航：`<a href>` 是整页刷新，会丢掉内存里的会话密钥
              （`saveSession` 只持久化 email + authMode）⇒ 用户被迫重新解锁。 */}
          <Link className="btn btn-primary not-found-action" href={props.homeHref || '/'}>
            <Home size={14} className="btn-icon" />
            {t('txt_back_to_home')}
          </Link>
        </div>
      </section>
    </main>
  );
}
