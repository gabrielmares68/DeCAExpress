# DeCA Express con suscripción mensual

Proyecto preparado a partir de `DeCA Express (1).html`. Incluye la web original bajo una ruta protegida, cuentas con contraseña, suscripción recurrente de 20 €/mes en Stripe Checkout, webhook firmado para sincronizar el estado y portal de Stripe para gestionar pagos/cancelaciones.

## Qué necesitas

- Node.js 20 o posterior y npm.
- Una cuenta de Stripe.
- Un alojamiento para Node.js con HTTPS, almacenamiento persistente para SQLite y una URL pública.

## Ejecutar en local

1. Copia `.env.example` a `.env` y configura las claves de prueba de Stripe. Genera `SESSION_SECRET` con un valor aleatorio largo.
2. Instala dependencias con `npm install`.
3. Ejecuta `npm start` y abre `http://localhost:3000`.
4. Para recibir eventos en local, instala Stripe CLI y ejecuta `stripe listen --forward-to localhost:3000/webhooks/stripe`; copia el `whsec_...` que muestra Stripe a `.env`.
5. Prueba registro, Checkout en modo test, acceso a `/app` y el portal de facturación.

## Publicarlo

La carpeta incluye `render.yaml` para Render. Para publicarla necesitas una cuenta en Render y Stripe, y subir el proyecto a un repositorio Git:

1. Sube los archivos del proyecto a un repositorio privado en GitHub o GitLab. No incluyas `.env`, claves de Stripe, ni la carpeta `data/`.
2. En Render crea un servicio Blueprint y conecta ese repositorio. Render detectará `render.yaml`, instalará Node.js y creará un disco persistente para las cuentas.
3. En el formulario inicial de Render añade `STRIPE_SECRET_KEY` con una clave de prueba `sk_test_...`. Render genera `SESSION_SECRET` automáticamente y `DB_FILE` apunta al disco persistente. La URL pública se detecta automáticamente en Render.
4. Cuando el servicio esté disponible, copia su URL pública. En Stripe crea un webhook con URL `https://TU-DOMINIO/webhooks/stripe`, copia el secreto `whsec_...` y añádelo en Render: servicio → **Environment** → **Add Environment Variable** → clave `STRIPE_WEBHOOK_SECRET` y valor `whsec_...`.
5. Guarda el cambio y deja que Render despliegue la nueva configuración. Después completa el flujo de prueba antes de activar claves live.

El plan de Render está definido como `starter` porque SQLite necesita un disco persistente. Puedes cambiar el plan desde el panel si eliges otro alojamiento compatible. En otros proveedores configura las variables de entorno y monta almacenamiento persistente en `DB_FILE`.

Suscribe estos eventos en Stripe:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Configura el portal de clientes desde Stripe Dashboard para permitir la gestión/cancelación de suscripciones. Las claves `sk_test_...` y `whsec_...` son para pruebas; antes de cobrar de verdad usa las claves live y el secreto webhook live.

La publicación requiere que el propietario del proyecto conecte su repositorio y cuenta de hosting; no se puede publicar bajo tu dominio sin acceso a esas cuentas. No pegues claves secretas en el chat: introdúcelas directamente en el panel del proveedor.

## Decisiones de configuración

- El Checkout crea una suscripción mensual de 20,00 EUR por usuario; el producto y el precio se crean automáticamente mediante Stripe Checkout.
- El acceso a `/app` requiere una suscripción en estado `active` o `trialing`.
- Los datos de los DeCA siguen procesándose en el navegador, como en el HTML original; el servidor no recibe los formularios ni los PDF.
- El precio se ha configurado sin cálculo automático de impuestos. Antes de cobrar a clientes, revisa con tu gestor la configuración de IVA, facturación, términos, privacidad y política de cancelación que corresponda a tu negocio.
- La contraseña debe tener 12 caracteres o más. Las contraseñas se guardan con scrypt y las sesiones usan cookies HTTP-only.

## Operación y seguridad

Usa solo HTTPS en producción. Configura Stripe para notificar cambios de suscripción mediante webhook. Haz copias de seguridad de `data/deca.sqlite`; perder esa base elimina las cuentas y su asociación de cliente. El HTML original carga jsPDF, QR y fuentes desde CDNs.
