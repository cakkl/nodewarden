/** 邮件模板的意大利文文案。 */
import type { MailCopy } from './en';

const it: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'Test SMTP di NodeWarden',
    heading: 'Le tue impostazioni email funzionano',
    intro: 'Questo messaggio è stato inviato da NodeWarden per confermare che l’invio è configurato correttamente.',
    detailsTitle: 'Dettagli connessione',
    labels: { server: 'Server', encryption: 'Crittografia', sentAt: 'Inviato' },
    outro: 'Se non aspettavi questo messaggio, qualcuno con accesso amministratore ha modificato le impostazioni email.',
  },
  verification: {
    subject: 'Verifica il tuo indirizzo email NodeWarden',
    heading: 'Conferma il tuo indirizzo email',
    intro: 'Inserisci questo codice in NodeWarden per confermare che questo indirizzo è tuo. Le notifiche di sicurezza vengono inviate solo a un indirizzo confermato.',
    codeLabel: 'Codice di verifica',
    expiresLabel: 'Questo codice scade il',
    outro: 'Se non hai richiesto tu questa operazione, ignora questo messaggio. Il tuo indirizzo resterà non confermato e non verranno inviate notifiche.',
  },
  preferencesNote: {
    timezone: 'Nota: non hai ancora impostato un fuso orario, quindi gli orari sono mostrati in {timezone}. Impostalo in Impostazioni → Preferenze.',
  },
  footer: 'Inviato automaticamente da NodeWarden. Le risposte a questo indirizzo non vengono lette.',
};

export default it;
