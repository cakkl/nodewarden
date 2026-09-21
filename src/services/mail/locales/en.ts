/**
 * 邮件模板的英文文案。
 *
 * 加新语言时：复制本文件、改 `MailCopy` 里的值，并在 `index.ts` 的 `COPY` 里注册。
 * 缺失的语言会回退到英文（见 `resolveMailCopy`）。
 */
export interface MailCopy {
  /** 邮件顶部与页脚显示的产品名 */
  brand: string;
  test: {
    subject: string;
    heading: string;
    intro: string;
    detailsTitle: string;
    labels: { server: string; encryption: string; sentAt: string };
    outro: string;
  };
  /** 页脚统一说明 */
  footer: string;
}

const en: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'NodeWarden SMTP test',
    heading: 'Your mail settings work',
    intro: 'This message was sent by NodeWarden to confirm that outgoing mail is configured correctly.',
    detailsTitle: 'Connection details',
    labels: { server: 'Server', encryption: 'Encryption', sentAt: 'Sent at' },
    outro: 'If you did not expect this message, someone with administrator access changed the mail settings.',
  },
  footer: 'Sent automatically by NodeWarden. Replies to this address are not monitored.',
};

export default en;
