/** 邮件模板的西班牙文文案。 */
import type { MailCopy } from './en';

const es: MailCopy = {
  brand: 'NodeWarden',
  test: {
    subject: 'Prueba SMTP de NodeWarden',
    heading: 'Tus ajustes de correo funcionan',
    intro: 'Este mensaje lo envió NodeWarden para confirmar que el correo saliente está configurado correctamente.',
    detailsTitle: 'Detalles de conexión',
    labels: { server: 'Servidor', encryption: 'Cifrado', sentAt: 'Enviado' },
    outro: 'Si no esperabas este mensaje, alguien con acceso de administrador cambió los ajustes de correo.',
  },
  footer: 'Enviado automáticamente por NodeWarden. No se atienden respuestas a esta dirección.',
};

export default es;
