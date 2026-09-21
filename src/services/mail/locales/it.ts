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
  footer: 'Inviato automaticamente da NodeWarden. Le risposte a questo indirizzo non vengono lette.',
};

export default it;
