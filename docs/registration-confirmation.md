# Registro con confirmación de correo

La cuenta, la empresa y sus permisos se crean **después** de confirmar el correo. La creación y el consumo del código se guardan en una sola transacción: si falla el guardado, ninguno de los dos queda aplicado.

## Cómo continuar

1. Completá el registro y abrí el correo con el código de seis dígitos.
2. Ingresá el código y confirmá. El primer registro completado recibe la jerarquía inicial de administrador; los siguientes son usuarios comunes.
3. Si el correo no llega o el código venció, usá **Reenviar código** y revisá spam. El código dura diez minutos; se mantienen los límites de intentos y reenvíos.

Si cerrás o recargás la página, al volver a **Registrarse** se recupera el paso de confirmación. El navegador conserva solamente los datos no secretos del formulario. La contraseña se vuelve a pedir: nunca se guarda junto al borrador, ni tampoco el código o una sesión. El borrador se elimina al completar la confirmación o un inicio de sesión válido.

Una cuenta incompleta anterior no se borra ni se recrea. Al iniciar sesión con su contraseña correcta, se ofrece confirmar el correo y pedir otro código. La confirmación conserva la contraseña, la identidad, la empresa y los datos existentes. Una contraseña incorrecta sigue dando un error genérico y no revela si falta confirmar.

Si el navegador bloquea el almacenamiento, el flujo de la pestaña continúa en memoria, pero no se garantiza recuperarlo después de cerrarla. No se afirma que se envió un correo cuando el transporte informó un fallo.

## Volver a empezar después de eliminar una cuenta

Podés registrarte nuevamente con el mismo correo y los mismos datos, o con datos nuevos. La eliminación correcta limpia las solicitudes de confirmación, los códigos, los tokens de recuperación y las sesiones de esa cuenta. El registro nuevo exige una confirmación nueva; no recupera la contraseña ni los accesos anteriores.

Si la cuenta se eliminó antes de incorporar esa limpieza y quedó una solicitud ya confirmada, **Registrarse** o **Reenviar código** la reemplaza por una solicitud nueva: no tenés que esperar las 24 horas de la anterior. Esto no reemplaza cuentas que todavía existen ni borra empresas conservadas. Se mantienen una auditoría mínima y los límites contra abusos; los correos ya entregados no se pueden retirar del buzón, pero sus códigos anteriores no habilitan la cuenta nueva.

## Contratos para mantenimiento

- `POST /api/auth/register` responde `{ requiresVerification, deliveryFailed, email }`, sin usuario definitivo ni cookie de sesión.
- `POST /api/auth/login` responde `403 EMAIL_VERIFICATION_REQUIRED` únicamente con contraseña válida de una cuenta nueva pendiente. El detalle contiene solo su email; no crea una sesión. Usuarios verificados o de transición conservan su comportamiento.
- `POST /api/auth/verify` valida el formulario completo para una cuenta nueva. Una cuenta incompleta existente puede confirmar con email y código, sin reemplazar sus datos.
- `AuthService.login(input)` conserva el rechazo genérico anterior; el endpoint activa explícitamente `resumeVerification`.
- Los endpoints conservan CSRF, controles de sesión y límites de frecuencia. El reenvío público responde de forma neutral.

## Pruebas sin tocar la base real

Usá las configuraciones específicas, **no** `vitest.config.ts`, cuyo arranque puede sincronizar y sembrar datos:

```bash
node node_modules/vitest/vitest.mjs run --config vitest.registration-verification.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.identity-unit.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.clean-identity.config.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

La integración `vitest.registration-integration.config.ts` requiere la base PostgreSQL descartable autorizada `registration_test@127.0.0.1:59521` en `DATABASE_URL`. Rechaza otro destino antes de construir el cliente. Sus fixtures reemplazan datos **solo de esa base de prueba**, sin enviar SMTP real. No ejecutés estos preparativos contra una base de trabajo.
