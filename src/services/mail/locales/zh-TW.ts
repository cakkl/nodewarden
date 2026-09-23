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
  verification: {
    subject: '驗證你的 NodeWarden 電子郵件地址',
    heading: '確認你的電子郵件地址',
    intro: '在 NodeWarden 中輸入以下驗證碼，確認這個電子郵件地址屬於你。安全通知只會寄送到已確認的地址。',
    codeLabel: '驗證碼',
    expiresLabel: '驗證碼有效期至',
    outro: '如果你沒有發起這個操作，忽略本郵件即可。該地址會保持未確認狀態，不會收到任何通知。',
  },
  notifications: {
    subject: '安全提醒：{event}',
    heading: '安全提醒：{event}',
    intro: '你的 NodeWarden 帳號剛剛發生變動，詳情如下。',
    detailsTitle: '詳情',
    labels: { time: '時間', ip: 'IP 位址' },
    disclaimer: '如果不是你本人的操作，代表可能有其他人能存取你的帳號。'
      + '請立即修改主密碼並檢查已授權的裝置。',
    adminDisclaimer: '如果不是你本人的操作，請立即聯絡管理員。',
    events: {
      two_step_enabled: '兩步驗證已開啟',
      two_step_disabled: '兩步驗證已關閉',
      two_step_recovery_used: '使用了復原碼登入',
      api_key_created: '建立了 API 金鑰',
      api_key_rotated: '輪替了 API 金鑰',
      master_password_changed: '主密碼已變更',
      account_disabled: '帳號已被管理員停用',
      account_deleted: '帳號已被管理員刪除',
    },
  },
  preferencesNote: {
    timezone: '提示：你還沒有設定時區，郵件裡的時間按 {timezone} 顯示。請到「設定 → 偏好」設定你的時區。',
  },
  footer: '由 NodeWarden 自動寄送。此地址不接收回覆。',
};

export default zhTW;
