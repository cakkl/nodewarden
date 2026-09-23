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
  notifications: {
    subject: 'Aviso de seguridad: {event}',
    heading: 'Aviso de seguridad: {event}',
    intro: 'Se acaba de realizar un cambio en tu cuenta de NodeWarden. Aquí tienes los detalles.',
    detailsTitle: 'Detalles',
    labels: { time: 'Hora', ip: 'Dirección IP', device: 'Dispositivo', type: 'Tipo', location: 'Ubicación' },
    disclaimer: 'Si no esperabas este cambio, es posible que otra persona tenga acceso a tu cuenta. '
      + 'Cambia tu contraseña maestra y revisa tus dispositivos autorizados ahora mismo.',
    adminDisclaimer: 'Si no esperabas este cambio, ponte en contacto con un administrador de inmediato.',
    newMarker: ' (nuevo)',
    deviceTypes: {
      android: 'Android',
      ios: 'iOS',
      chromeExtension: 'Extensión de Chrome',
      firefoxExtension: 'Extensión de Firefox',
      operaExtension: 'Extensión de Opera',
      edgeExtension: 'Extensión de Edge',
      windowsDesktop: 'Escritorio Windows',
      macosDesktop: 'Escritorio macOS',
      linuxDesktop: 'Escritorio Linux',
      chromeBrowser: 'Navegador Chrome',
      firefoxBrowser: 'Navegador Firefox',
      operaBrowser: 'Navegador Opera',
      edgeBrowser: 'Navegador Edge',
      ieBrowser: 'Navegador Internet Explorer',
      web: 'Web',
    },
    events: {
      two_step_enabled: 'Verificación en dos pasos activada',
      two_step_disabled: 'Verificación en dos pasos desactivada',
      two_step_recovery_used: 'Código de recuperación de la verificación en dos pasos utilizado',
      api_key_created: 'Clave de API creada',
      api_key_rotated: 'Clave de API rotada',
      master_password_changed: 'Contraseña maestra cambiada',
      account_disabled: 'Cuenta desactivada por un administrador',
      account_deleted: 'Cuenta eliminada por un administrador',
      new_sign_in: 'Inicio de sesión desde un dispositivo o ubicación nuevos',
      two_step_recovery_created: 'Código de recuperación de la verificación en dos pasos creado',
      passkey_created: 'Passkey de inicio de sesión creado',
      passkey_deleted: 'Passkey de inicio de sesión eliminado',
    },
  },
  preferencesNote: {
    timezone: 'Nota: aún no has configurado una zona horaria, por lo que las horas se muestran en {timezone}. Configúrala en Configuración → Preferencias.',
  },
  footer: 'Enviado automáticamente por NodeWarden. No se atienden respuestas a esta dirección.',
};

export default es;
