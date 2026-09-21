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
  verification: {
    subject: 'Vahvista NodeWarden-sähköpostiosoitteesi',
    heading: 'Vahvista sähköpostiosoitteesi',
    intro: 'Syötä tämä koodi NodeWardeniin ja vahvista, että osoite on sinun. Turvallisuusilmoituksia lähetetään vain vahvistettuun osoitteeseen.',
    codeLabel: 'Vahvistuskoodi',
    expiresLabel: 'Koodi vanhenee',
    outro: 'Jos et pyytänyt tätä, jätä viesti huomiotta. Osoite pysyy vahvistamattomana eikä ilmoituksia lähetetä.',
  },
  footer: 'NodeWarden lähetti tämän automaattisesti. Tähän osoitteeseen ei vastata.',
};

export default fi;
