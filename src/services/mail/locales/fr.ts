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
  footer: 'Envoyé automatiquement par NodeWarden. Les réponses à cette adresse ne sont pas lues.',
};

export default fr;
