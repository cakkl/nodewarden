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
  notifications: {
    subject: 'Tietoturvailmoitus: {event}',
    heading: 'Tietoturvailmoitus: {event}',
    intro: 'NodeWarden-tilillesi tehtiin juuri muutos. Tiedot ovat alla.',
    detailsTitle: 'Tiedot',
    labels: { time: 'Aika', ip: 'IP-osoite' },
    disclaimer: 'Jos et odottanut tätä muutosta, jollakin muulla voi olla pääsy tilillesi. '
      + 'Vaihda pääsalasanasi ja tarkista valtuutetut laitteesi heti.',
    adminDisclaimer: 'Jos et odottanut tätä muutosta, ota heti yhteyttä ylläpitäjään.',
    events: {
      two_step_enabled: 'Kaksivaiheinen kirjautuminen otettu käyttöön',
      two_step_disabled: 'Kaksivaiheinen kirjautuminen poistettu käytöstä',
      two_step_recovery_used: 'Kaksivaiheisen kirjautumisen palautuskoodia käytetty',
      api_key_created: 'API-avain luotu',
      api_key_rotated: 'API-avain vaihdettu',
      master_password_changed: 'Pääsalasana vaihdettu',
      account_disabled: 'Ylläpitäjä poisti tilin käytöstä',
      account_deleted: 'Ylläpitäjä poisti tilin',
    },
  },
  preferencesNote: {
    timezone: 'Huomautus: aikavyöhykettä ei ole vielä asetettu, joten ajat näytetään aikavyöhykkeellä {timezone}. Aseta omasi asetuksissa.',
  },
  footer: 'NodeWarden lähetti tämän automaattisesti. Tähän osoitteeseen ei vastata.',
};

export default fi;
