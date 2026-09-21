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
  footer: '由 NodeWarden 自动发送。此地址不接收回复。',
};

export default zhCN;
