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
  preferencesNote: {
    timezone: 'Remarque : aucun fuseau horaire n\'a encore été défini, les heures sont donc affichées en {timezone}. Définissez le vôtre dans Paramètres → Préférences.',
  },
  footer: 'Envoyé automatiquement par NodeWarden. Les réponses à cette adresse ne sont pas lues.',
};

export default fr;
