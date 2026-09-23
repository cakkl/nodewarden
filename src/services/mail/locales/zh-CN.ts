/** 邮件模板的简体中文文案。 */
import type { MailCopy } from './en';

const zhCN: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'NodeWarden SMTP 测试',
    heading: '你的邮件设置可用',
    intro: '这封邮件由 NodeWarden 发出，用于确认对外发信已配置正确。',
    detailsTitle: '连接详情',
    labels: { server: '服务器', encryption: '加密方式', sentAt: '发送时间' },
    outro: '如果你没有预期收到这封邮件，说明有人以管理员身份修改了邮件设置。',
  },
  verification: {
    subject: '验证你的 NodeWarden 邮箱地址',
    heading: '确认你的邮箱地址',
    intro: '在 NodeWarden 中输入以下验证码，确认这个邮箱地址属于你。安全通知只会发送到已确认的邮箱。',
    codeLabel: '验证码',
    expiresLabel: '验证码有效期至',
    outro: '如果你没有发起这个操作，忽略本邮件即可。该邮箱会保持未确认状态，不会收到任何通知。',
  },
  notifications: {
    subject: '安全提醒：{event}',
    heading: '安全提醒：{event}',
    intro: '你的 NodeWarden 账户刚刚发生了变动，详情如下。',
    detailsTitle: '详情',
    labels: { time: '时间', ip: 'IP 地址' },
    disclaimer: '如果不是你本人的操作，说明可能有其他人能访问你的账户。'
      + '请立即修改主密码并检查已授权的设备。',
    adminDisclaimer: '如果不是你本人的操作，请立即联系管理员。',
    events: {
      two_step_enabled: '两步登录已开启',
      two_step_disabled: '两步登录已关闭',
      two_step_recovery_used: '使用了恢复码登录',
      api_key_created: '创建了 API 密钥',
      api_key_rotated: '轮换了 API 密钥',
      master_password_changed: '主密码已修改',
      account_disabled: '账户已被管理员禁用',
      account_deleted: '账户已被管理员删除',
    },
  },
  preferencesNote: {
    timezone: '提示：你还没有设定时区，邮件里的时间按 {timezone} 显示。请到「设置 → 偏好」设定你的时区。',
  },
  footer: '由 NodeWarden 自动发送。此地址不接收回复。',
};

export default zhCN;
