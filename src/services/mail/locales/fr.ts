/** 邮件模板的法文文案。 */
import type { MailCopy } from './en';

const fr: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'Test SMTP de NodeWarden',
    heading: 'Vos paramètres de courriel fonctionnent',
    intro: 'Ce message a été envoyé par NodeWarden pour confirmer que l’envoi de courriels est correctement configuré.',
    detailsTitle: 'Détails de connexion',
    labels: { server: 'Serveur', encryption: 'Chiffrement', sentAt: 'Envoyé le' },
    outro: 'Si vous n’attendiez pas ce message, quelqu’un disposant d’un accès administrateur a modifié les paramètres de courriel.',
  },
  verification: {
    subject: 'Vérifiez votre adresse courriel NodeWarden',
    heading: 'Confirmez votre adresse courriel',
    intro: 'Saisissez ce code dans NodeWarden pour confirmer que cette adresse vous appartient. Les notifications de sécurité ne sont envoyées qu’à une adresse confirmée.',
    codeLabel: 'Code de vérification',
    expiresLabel: 'Ce code expire le',
    outro: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message. Votre adresse restera non confirmée et aucune notification ne sera envoyée.',
  },
  notifications: {
    subject: 'Alerte de sécurité : {event}',
    heading: 'Alerte de sécurité : {event}',
    intro: 'Une modification vient d’être apportée à votre compte NodeWarden. Les détails figurent ci-dessous.',
    detailsTitle: 'Détails',
    labels: { time: 'Heure', ip: 'Adresse IP', device: 'Appareil', type: 'Type', location: 'Emplacement' },
    disclaimer: 'Si vous n’êtes pas à l’origine de cette modification, quelqu’un d’autre a peut-être accès à votre compte. '
      + 'Changez votre mot de passe principal et vérifiez vos appareils autorisés dès maintenant.',
    adminDisclaimer: 'Si vous n’êtes pas à l’origine de cette modification, contactez immédiatement un administrateur.',
    newMarker: ' (nouveau)',
    deviceTypes: {
      android: 'Android',
      ios: 'iOS',
      chromeExtension: 'Extension Chrome',
      firefoxExtension: 'Extension Firefox',
      operaExtension: 'Extension Opera',
      edgeExtension: 'Extension Edge',
      windowsDesktop: 'Bureau Windows',
      macosDesktop: 'Bureau macOS',
      linuxDesktop: 'Bureau Linux',
      chromeBrowser: 'Navigateur Chrome',
      firefoxBrowser: 'Navigateur Firefox',
      operaBrowser: 'Navigateur Opera',
      edgeBrowser: 'Navigateur Edge',
      ieBrowser: 'Navigateur IE',
      web: 'Web',
    },
    events: {
      two_step_enabled: 'Vérification en deux étapes activée',
      two_step_disabled: 'Vérification en deux étapes désactivée',
      two_step_recovery_used: 'Code de récupération de la vérification en deux étapes utilisé',
      api_key_created: 'Clé d’API créée',
      api_key_rotated: 'Clé d’API renouvelée',
      master_password_changed: 'Mot de passe principal modifié',
      account_disabled: 'Compte désactivé par un administrateur',
      account_deleted: 'Compte supprimé par un administrateur',
      new_sign_in: 'Connexion depuis un nouvel appareil ou un nouvel emplacement',
      two_step_recovery_created: 'Code de récupération de la vérification en deux étapes créé',
      passkey_created: 'Clé d’accès de connexion créée',
      passkey_deleted: 'Clé d’accès de connexion supprimée',
    },
  },
  preferencesNote: {
    timezone: 'Remarque : aucun fuseau horaire n\'a encore été défini, les heures sont donc affichées en {timezone}. Définissez le vôtre dans Paramètres → Préférences.',
  },
  footer: 'Envoyé automatiquement par NodeWarden. Les réponses à cette adresse ne sont pas lues.',
};

export default fr;
