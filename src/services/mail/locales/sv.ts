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
  notifications: {
    subject: 'Säkerhetsvarning: {event}',
    heading: 'Säkerhetsvarning: {event}',
    intro: 'En ändring gjordes nyss på ditt NodeWarden-konto. Uppgifterna finns nedan.',
    detailsTitle: 'Uppgifter',
    labels: { time: 'Tid', ip: 'IP-adress' },
    disclaimer: 'Om du inte förväntade dig den här ändringen kan någon annan ha åtkomst till ditt konto. '
      + 'Byt huvudlösenord och granska dina auktoriserade enheter direkt.',
    adminDisclaimer: 'Om du inte förväntade dig den här ändringen kontaktar du en administratör omedelbart.',
    events: {
      two_step_enabled: 'Tvåstegsinloggning aktiverad',
      two_step_disabled: 'Tvåstegsinloggning avaktiverad',
      two_step_recovery_used: 'Återställningskod för tvåstegsinloggning använd',
      api_key_created: 'API-nyckel skapad',
      api_key_rotated: 'API-nyckel roterad',
      master_password_changed: 'Huvudlösenord ändrat',
      account_disabled: 'Kontot inaktiverat av en administratör',
      account_deleted: 'Kontot borttaget av en administratör',
    },
  },
  preferencesNote: {
    timezone: 'Obs: ingen tidszon har angetts ännu, så tiderna visas i {timezone}. Ange din i inställningarna.',
  },
  footer: 'Skickat automatiskt av NodeWarden. Svar till denna adress läses inte.',
};

export default sv;
