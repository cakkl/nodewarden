/** 邮件模板的俄文文案。 */
import type { MailCopy } from './en';

const ru: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'Тест SMTP NodeWarden',
    heading: 'Настройки почты работают',
    intro: 'Это письмо отправлено NodeWarden, чтобы подтвердить, что исходящая почта настроена правильно.',
    detailsTitle: 'Параметры подключения',
    labels: { server: 'Сервер', encryption: 'Шифрование', sentAt: 'Отправлено' },
    outro: 'Если вы не ожидали это письмо, значит кто-то с правами администратора изменил настройки почты.',
  },
  footer: 'Отправлено автоматически NodeWarden. Ответы на этот адрес не читаются.',
};

export default ru;
