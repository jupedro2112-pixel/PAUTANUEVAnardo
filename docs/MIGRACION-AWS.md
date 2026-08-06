# CLONACIÓN a una 2ª cuenta AWS — Runbook TEMPORAL (iniciado 2026-08-06)

> ⚠️ **ARCHIVO TEMPORAL.** Existe solo para que el trabajo de clonación
> sobreviva a los reinicios de Tails (todo lo local se borra). **Cuando la
> clonación esté terminada y verificada, BORRAR este archivo del repo** —
> no es documentación del sistema y no debe mezclarse con el resto.
>
> ⚠️ **NO ES UNA MIGRACIÓN. Es un CLON en PARALELO** (aclaración del owner
> 2026-08-06): el Amazon viejo **sigue funcionando igual, para siempre** — no
> se pausa, no se apaga, no se reemplaza NADA, no se toca su DNS ni su config.
> De la cuenta vieja solo se LEE información (export/capturas). El resultado
> son DOS entornos independientes corriendo a la vez; la única diferencia de
> fondo del clon es que usa **OTRA base de datos MongoDB**.
>
> **Estado (2026-08-06):** FASE 2 paso 1 HECHO — caso de soporte creado en la
> cuenta NUEVA (Maiteabigailsosaaws, 220282357357): salida del sandbox SMS en
> sa-east-1 + límite de gasto a 100 USD (con aclaración enviada de que NO se
> piden short codes dedicados — el form había tomado ese resource type por
> error). Esperando respuesta de AWS (24-48h; llega al mail + "Sus casos de
> soporte"). ⚠️ Al aprobar: setear el límite en SNS → Text messaging
> preferences → Account spend limit = 100 (la aprobación sube el techo, el
> valor lo pone el owner). FASE 1 (extracción de la cuenta vieja) PENDIENTE.
> Actualizar esta línea a medida que se avanza.

---

## Reglas de oro

1. **La cuenta vieja no se toca.** Solo se exporta info (comandos de lectura
   y capturas). Nada de editar, pausar ni borrar.
2. **`ssm-export.json` = todos los secretos.** Vive SOLO en USB/persistencia
   del owner. JAMÁS en el repo (es público) ni pegado en chats.
3. **El pedido de salida del SMS sandbox de SNS se hace PRIMERO** en la cuenta
   nueva (tarda 1-2 días hábiles; es el único bloqueante lento).
4. Misma región que la cuenta vieja (anotarla en Fase 1).

## Valores que en el CLON son DISTINTOS (no copiar a ciegas)

Al subir los parámetros a SSM en la cuenta nueva, todo se copia igual SALVO:

- **`MONGODB_URI`** → la base NUEVA del clon (decisión del owner: los dos
  entornos usan bases distintas).
- **`REDIS_URL`** → el ElastiCache propio del clon (el viejo apunta al Redis
  de la cuenta vieja; jamás compartir: los adapters de Socket.IO se cruzarían).
- **`PUBLIC_BASE_URL`** → el dominio PROPIO del clon (dos backends no pueden
  compartir cargas1girox.com; el clon necesita su dominio/Cloudflare propio).

DECIDIDO por el owner (2026-08-06) — el clon es 100% INDEPENDIENTE:

- **Dominio:** propio y nuevo (con su propio Cloudflare). → `PUBLIC_BASE_URL`
  y `ADMIN_HOST` nuevos.
- **hgcash:** cuenta PROPIA → `HGCASH_API_TOKEN` y `HGCASH_WEBHOOK_SECRET`
  nuevos (los genera el owner en el dashboard de SU cuenta hgcash nueva), y el
  webhook de esa cuenta apunta al dominio del clon. SIN fan-out (cada cuenta
  tiene su webhook directo). `HGCASH_FANOUT_URL` del clon: off/no cargar.
- **1girox:** OTRA cuenta de agente → **API key nueva** (`GIROX_API_KEY` o el
  nombre que use el SSM viejo; misma `GIROX_API_URL` porque la plataforma es
  la misma). Jugadores y saldos separados por completo.
- **JWT_SECRET:** generar uno NUEVO para el clon (la base arranca vacía, no
  hay sesiones que preservar; no reusar el del viejo).
- **Firebase/FCM:** se comparte el proyecto (la config está en el código) —
  solo agregar el dominio nuevo a los "authorized domains" de Firebase cuando
  exista. Si más adelante el owner quiere proyecto aparte, es otro laburo.
- Otros tokens de negocio (Meta CAPI/ads, etc., si están en SSM): revisar
  parámetro por parámetro al subir el SSM — el asistente pregunta en ese paso.

## Qué es común y no requiere nada (si se confirma que se comparte)

- Firebase/FCM, `ANTHROPIC_API_KEY`, AWS SNS (cada cuenta AWS tiene su SNS —
  el clon usa el de su propia cuenta, por eso el trámite del sandbox).
- El código: se deploya el MISMO zip generado desde este repo en ambos.
- MongoDB Atlas como servicio: el clon usa OTRA base/cluster — verificar que
  el Network Access de ESA base permita las IPs del entorno nuevo (0.0.0.0/0
  o las IPs concretas) ANTES del primer arranque.

---

## FASE 1 — Extraer info de la cuenta VIEJA (solo lectura)

En CloudShell de la cuenta vieja:

```bash
# 1. Secretos (descargar y guardar en USB — NUNCA al repo)
aws ssm get-parameters-by-path --path "/1girox/prod" --recursive \
  --with-decryption --output json > ssm-export.json

# 2. Nombres de TODOS los parámetros (por si hay alguno fuera de /1girox/prod)
aws ssm describe-parameters --query "Parameters[].Name" --output json > ssm-nombres.json

# 3. Nombres de app/entorno EB
aws elasticbeanstalk describe-environments \
  --query "Environments[].[ApplicationName,EnvironmentName,Status]" --output table

# 4. Config completa del entorno del girox (reemplazar nombres)
aws elasticbeanstalk describe-configuration-settings \
  --application-name "NOMBRE-APP" --environment-name "NOMBRE-ENTORNO" > eb-config.json
```

Descargar los 3 archivos vía CloudShell → Actions → Download file.

Capturas de pantalla a tomar:
- [x] Región de la cuenta: **sa-east-1 (São Paulo)** — confirmada por la URL
      del entorno viejo (nuevogirox.sa-east-1.elasticbeanstalk.com).
- [ ] EB → entorno girox → página principal (Platform exacta + domain).
- [ ] EB → Configuration → Software (Environment properties, ej. SSM_PATH).
- [ ] EB → Configuration → Instances (tipo, security groups).
- [ ] EB → Configuration → Capacity (min/max, load balanced).
- [ ] EB → Configuration → Load balancer (listeners — ¿443 con certificado
      ACM? — y stickiness).
- [ ] ElastiCache → Redis (node type + engine version).
- [ ] SNS → Text messaging (SMS) → preferencias (límite de gasto, tipo).
- [ ] S3 → lista de buckets (identificar el de uploads del chat).
- [ ] IAM → Roles → aws-elasticbeanstalk-ec2-role → Permissions (policies).

---

## FASE 2 — Construir el CLON en la cuenta NUEVA (orden exacto)

1. **SNS sandbox:** SNS → Text messaging (SMS) → pedir salida del sandbox
   (caso de uso: OTP transaccional para app de clientes en Argentina). Setear
   límite de gasto mensual igual al viejo. *Esperar aprobación en paralelo al
   resto — mientras tanto, verificar a mano el número del owner para probar.*
2. **Elegir la misma región.**
3. **Base de datos NUEVA:** crear el cluster/base de MongoDB del clon (Atlas)
   y anotar su URI. Habilitar Network Access para el entorno nuevo.
4. **SSM:** subir los parámetros desde `ssm-export.json` vía CloudShell
   (upload del archivo + script de `put-parameter`; el asistente lo genera en
   el momento), aplicando los REEMPLAZOS de la sección "Valores distintos".
5. **ElastiCache:** crear Redis propio (mismo node type/engine que el viejo,
   single node alcanza) y cargar su endpoint en `REDIS_URL`. Security group:
   permitir 6379 desde el SG de las instancias EB (se ajusta tras crear el
   entorno).
6. **EB:** crear Application + Environment:
   - Misma Platform (Node.js 20 / Amazon Linux 2023, según captura).
   - Load balanced, mismo min/max e instance type que el viejo.
   - ALB con **stickiness habilitado** (imprescindible para Socket.IO
     multi-instancia, ver WORKLOG #145).
   - Environment properties: las mismas del viejo (mínimo `SSM_PATH=/1girox/prod`).
   - Dejar que EB cree los roles; luego en IAM pegarle al instance profile las
     mismas policies del viejo (lectura SSM + SNS publish, según captura).
   - Si el clon va a tener dominio con HTTPS en el ALB: certificado ACM para
     el dominio NUEVO (validación DNS en el Cloudflare del clon).
7. **S3:** crear bucket propio para uploads del chat (ajustar el nombre en la
   config/SSM del clon según cómo lo referencie el código).
8. **Deploy:** zip del repo (mismo procedimiento de siempre) → subir a EB.
9. **Prueba:** contra la URL .elasticbeanstalk.com del clon: arranque limpio
   en logs, `GET /api/admin/girox/health`, login, sockets (tiempo real), SMS a
   número verificado. El server corre las migraciones/seeds al primer arranque
   sobre la base NUEVA (queda sembrada sola: admin inicial + comandos /sys_*).
10. **Dominio del clon:** apuntar el dominio NUEVO (su propio Cloudflare) al
    ALB del clon + regla WAF "Skip" para /api/hgcash/webhook si el clon usa
    hgcash. Configurar el webhook de hgcash del clon según lo confirmado
    (cuenta propia vs fan-out).
11. **El entorno viejo queda EXACTAMENTE como está** — no hay cutover ni nada
    que apagar. Ambos conviven.

## Gotchas conocidos a re-verificar en el clon

- Los secretos llegan por SSM en el bootstrap ASYNC → cualquier prueba de env
  vars se hace tras el arranque completo (trampa #130).
- Base nueva = arranca VACÍA: el seed crea el admin inicial (`ADMIN_USERNAME`)
  y siembra los comandos; usuarios/config del viejo NO se copian (decisión
  owner: bases separadas). Si algún día se quisiera partir de una copia de
  datos, es un mongodump/mongorestore aparte — hoy NO está pedido.
- El rate limit local de la Partner API es por proceso (N instancias × 55/min)
  — y si AMBOS entornos usan la MISMA key de 1girox, el tope de 60/min se
  COMPARTE entre los dos sistemas: otro motivo para confirmar el punto 1girox.
