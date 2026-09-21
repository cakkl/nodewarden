/** 邮件模板的瑞典文文案。 */
import type { MailCopy } from './en';

const sv: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'NodeWarden SMTP-test',
    heading: 'Dina e-postinställningar fungerar',
    intro: 'Detta meddelande skickades av NodeWarden för att bekräfta att utgående e-post är korrekt konfigurerad.',
    detailsTitle: 'Anslutningsuppgifter',
    labels: { server: 'Server', encryption: 'Kryptering', sentAt: 'Skickat' },
    outro: 'Om du inte väntade dig detta meddelande har någon med administratörsbehörighet ändrat e-postinställningarna.',
  },
  footer: 'Skickat automatiskt av NodeWarden. Svar till denna adress läses inte.',
};

export default sv;
