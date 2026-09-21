/** 邮件模板的芬兰文文案。 */
import type { MailCopy } from './en';

const fi: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'NodeWarden SMTP -testi',
    heading: 'Sähköpostiasetuksesi toimivat',
    intro: 'NodeWarden lähetti tämän viestin varmistaakseen, että lähtevä sähköposti on määritetty oikein.',
    detailsTitle: 'Yhteyden tiedot',
    labels: { server: 'Palvelin', encryption: 'Salaus', sentAt: 'Lähetetty' },
    outro: 'Jos et odottanut tätä viestiä, joku järjestelmänvalvojan oikeuksilla muutti sähköpostiasetuksia.',
  },
  footer: 'NodeWarden lähetti tämän automaattisesti. Tähän osoitteeseen ei vastata.',
};

export default fi;
