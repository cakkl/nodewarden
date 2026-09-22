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
  verification: {
    subject: 'Verifiera din e-postadress i NodeWarden',
    heading: 'Bekräfta din e-postadress',
    intro: 'Ange den här koden i NodeWarden för att bekräfta att adressen tillhör dig. Säkerhetsaviseringar skickas bara till en bekräftad adress.',
    codeLabel: 'Verifieringskod',
    expiresLabel: 'Koden gäller till',
    outro: 'Om du inte begärde detta kan du ignorera meddelandet. Adressen förblir obekräftad och inga aviseringar skickas.',
  },
  preferencesNote: {
    timezone: 'Obs: ingen tidszon har angetts ännu, så tiderna visas i {timezone}. Ange din i inställningarna.',
  },
  footer: 'Skickat automatiskt av NodeWarden. Svar till denna adress läses inte.',
};

export default sv;
