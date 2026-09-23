/** 邮件模板的德文文案。 */
import type { MailCopy } from './en';

const de: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'NodeWarden SMTP-Test',
    heading: 'Deine E-Mail-Einstellungen funktionieren',
    intro: 'Diese Nachricht wurde von NodeWarden gesendet, um zu bestätigen, dass der Versand korrekt konfiguriert ist.',
    detailsTitle: 'Verbindungsdetails',
    labels: { server: 'Server', encryption: 'Verschlüsselung', sentAt: 'Gesendet' },
    outro: 'Wenn du diese Nachricht nicht erwartet hast, hat jemand mit Administratorzugriff die E-Mail-Einstellungen geändert.',
  },
  verification: {
    subject: 'Bestätige deine NodeWarden-E-Mail-Adresse',
    heading: 'Bestätige deine E-Mail-Adresse',
    intro: 'Gib diesen Code in NodeWarden ein, um zu bestätigen, dass diese Adresse dir gehört. Sicherheitsbenachrichtigungen gehen nur an eine bestätigte Adresse.',
    codeLabel: 'Bestätigungscode',
    expiresLabel: 'Dieser Code läuft ab am',
    outro: 'Wenn du das nicht angefordert hast, ignoriere diese Nachricht. Deine Adresse bleibt unbestätigt und es werden keine Benachrichtigungen gesendet.',
  },
  notifications: {
    subject: 'Sicherheitshinweis: {event}',
    heading: 'Sicherheitshinweis: {event}',
    intro: 'An deinem NodeWarden-Konto wurde soeben eine Änderung vorgenommen. Die Details findest du unten.',
    detailsTitle: 'Details',
    labels: { time: 'Zeit', ip: 'IP-Adresse' },
    disclaimer: 'Falls du diese Änderung nicht erwartet hast, hat möglicherweise jemand anderes Zugriff auf dein Konto. '
      + 'Ändere jetzt dein Master-Passwort und prüfe deine autorisierten Geräte.',
    adminDisclaimer: 'Falls du diese Änderung nicht erwartet hast, wende dich sofort an einen Administrator.',
    events: {
      two_step_enabled: 'Zwei-Faktor-Anmeldung aktiviert',
      two_step_disabled: 'Zwei-Faktor-Anmeldung deaktiviert',
      two_step_recovery_used: 'Wiederherstellungscode für die Zwei-Faktor-Anmeldung verwendet',
      api_key_created: 'API-Schlüssel erstellt',
      api_key_rotated: 'API-Schlüssel erneuert',
      master_password_changed: 'Master-Passwort geändert',
      account_disabled: 'Konto von einem Administrator deaktiviert',
      account_deleted: 'Konto von einem Administrator gelöscht',
    },
  },
  preferencesNote: {
    timezone: 'Hinweis: Es ist noch keine Zeitzone festgelegt, daher werden die Zeiten in {timezone} angezeigt. Lege deine in den Einstellungen fest.',
  },
  footer: 'Automatisch von NodeWarden gesendet. Antworten an diese Adresse werden nicht gelesen.',
};

export default de;
