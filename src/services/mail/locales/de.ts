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
  footer: 'Automatisch von NodeWarden gesendet. Antworten an diese Adresse werden nicht gelesen.',
};

export default de;
