/** 邮件模板的繁體中文文案。 */
import type { MailCopy } from './en';

const zhTW: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'NodeWarden SMTP 測試',
    heading: '你的郵件設定可用',
    intro: '這封郵件由 NodeWarden 發出，用於確認對外寄信已設定正確。',
    detailsTitle: '連線詳情',
    labels: { server: '伺服器', encryption: '加密方式', sentAt: '寄送時間' },
    outro: '如果你沒有預期收到這封郵件，表示有人以管理員身分修改了郵件設定。',
  },
  footer: '由 NodeWarden 自動寄送。此地址不接收回覆。',
};

export default zhTW;
