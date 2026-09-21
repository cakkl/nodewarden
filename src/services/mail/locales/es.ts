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
  verification: {
    subject: 'Verifica tu dirección de correo de NodeWarden',
    heading: 'Confirma tu dirección de correo',
    intro: 'Introduce este código en NodeWarden para confirmar que esta dirección es tuya. Las notificaciones de seguridad solo se envían a una dirección confirmada.',
    codeLabel: 'Código de verificación',
    expiresLabel: 'Este código caduca el',
    outro: 'Si no solicitaste esto, ignora este mensaje. Tu dirección quedará sin confirmar y no se enviarán notificaciones.',
  },
  footer: 'Enviado automáticamente por NodeWarden. No se atienden respuestas a esta dirección.',
};

export default es;
