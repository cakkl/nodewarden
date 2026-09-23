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
  notifications: {
    subject: 'Avviso di sicurezza: {event}',
    heading: 'Avviso di sicurezza: {event}',
    intro: 'È stata appena apportata una modifica al tuo account NodeWarden. I dettagli sono riportati di seguito.',
    detailsTitle: 'Dettagli',
    labels: { time: 'Ora', ip: 'Indirizzo IP', device: 'Dispositivo', type: 'Tipo', location: 'Posizione' },
    disclaimer: 'Se non hai richiesto questa modifica, qualcun altro potrebbe avere accesso al tuo account. '
      + 'Cambia subito la password principale e controlla i dispositivi autorizzati.',
    adminDisclaimer: 'Se non hai richiesto questa modifica, contatta subito un amministratore.',
    newMarker: ' (nuovo)',
    deviceTypes: {
      android: 'Android',
      ios: 'iOS',
      chromeExtension: 'Estensione Chrome',
      firefoxExtension: 'Estensione Firefox',
      operaExtension: 'Estensione Opera',
      edgeExtension: 'Estensione Edge',
      windowsDesktop: 'Desktop Windows',
      macosDesktop: 'Desktop macOS',
      linuxDesktop: 'Desktop Linux',
      chromeBrowser: 'Browser Chrome',
      firefoxBrowser: 'Browser Firefox',
      operaBrowser: 'Browser Opera',
      edgeBrowser: 'Browser Edge',
      ieBrowser: 'Browser IE',
      web: 'Web',
    },
    events: {
      two_step_enabled: 'Verifica in due passaggi attivata',
      two_step_disabled: 'Verifica in due passaggi disattivata',
      two_step_recovery_used: 'Codice di recupero della verifica in due passaggi utilizzato',
      api_key_created: 'Chiave API creata',
      api_key_rotated: 'Chiave API ruotata',
      master_password_changed: 'Password principale modificata',
      account_disabled: 'Account disattivato da un amministratore',
      account_deleted: 'Account eliminato da un amministratore',
      new_sign_in: 'Accesso da un nuovo dispositivo o una nuova posizione',
      two_step_recovery_created: 'Codice di recupero della verifica in due passaggi creato',
      passkey_created: 'Passkey di accesso creata',
      passkey_deleted: 'Passkey di accesso eliminata',
    },
  },
  preferencesNote: {
    timezone: 'Nota: non hai ancora impostato un fuso orario, quindi gli orari sono mostrati in {timezone}. Impostalo in Impostazioni → Preferenze.',
  },
  footer: 'Inviato automaticamente da NodeWarden. Le risposte a questo indirizzo non vengono lette.',
};

export default it;
