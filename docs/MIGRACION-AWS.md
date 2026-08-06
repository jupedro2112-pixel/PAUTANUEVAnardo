# MIGRACIÓN A CUENTA AWS NUEVA — Runbook (iniciado 2026-08-06)

> Objetivo: clonar el entorno completo del backend (Elastic Beanstalk + SSM +
> ElastiCache + SNS + S3 + IAM) de la cuenta AWS vieja a una cuenta AWS nueva
> desde cero, y que funcione idéntico. El owner ejecuta los pasos guiado por el
> asistente; este doc existe para que CUALQUIER sesión futura (Tails borra todo)
> sepa el plan completo y en qué paso quedó.
>
> **Estado: FASE 1 en curso** (extracción de datos de la cuenta vieja).
> Actualizar esta línea a medida que se avanza.

---

## Reglas de oro

1. **La cuenta vieja NO se apaga** hasta que la nueva esté probada y el DNS
   cambiado (cutover). Conviven durante la migración.
2. **`ssm-export.json` = todos los secretos.** Vive SOLO en USB/persistencia
   del owner. JAMÁS en el repo (es público) ni pegado en chats.
3. **El pedido de salida del SMS sandbox de SNS se hace PRIMERO** en la cuenta
   nueva (tarda 1-2 días hábiles; es el único bloqueante lento).
4. Misma región que la cuenta vieja (anotarla en Fase 1).

## Qué NO se migra (externo a AWS, sigue igual)

- MongoDB Atlas (misma URI; verificar que Network Access permita las IPs
  nuevas — si está en 0.0.0.0/0, no hay que tocar nada).
- Firebase/FCM, API key de 1girox, hgcash (mismas keys, viven en SSM).
- Cloudflare/dominio cargas1girox.com: solo se cambia el CNAME al ALB nuevo en
  el cutover. La regla WAF "Skip" de /api/hgcash/webhook queda como está.
- El código: se deploya el zip generado desde este repo.

---

## FASE 1 — Extraer de la cuenta VIEJA (CloudShell + capturas)

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
- [ ] Región de la cuenta (esquina superior derecha).
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

## FASE 2 — Construir la cuenta NUEVA (orden exacto)

1. **SNS sandbox:** SNS → Text messaging (SMS) → pedir salida del sandbox
   (caso de uso: OTP transaccional para app de clientes en Argentina). Setear
   límite de gasto mensual igual al viejo. *Esperar aprobación en paralelo al
   resto — mientras tanto, verificar a mano el número del owner para probar.*
2. **Elegir la misma región.**
3. **SSM:** subir todos los parámetros desde `ssm-export.json` vía CloudShell
   (upload del archivo + loop de `put-parameter`; el asistente genera el
   script en el momento). ⚠️ NO copiar `REDIS_URL` tal cual: apunta al
   ElastiCache viejo — se completa en el paso 5.
4. **ElastiCache:** crear Redis nuevo (mismo node type/engine que el viejo,
   single node alcanza). En el security group del Redis, permitir el puerto
   6379 desde el security group de las instancias EB (se ajusta después de
   crear el entorno).
5. **SSM `REDIS_URL`:** cargar con el endpoint del Redis nuevo (mismo formato
   que el viejo; en el viejo usaba base lógica /1 porque compartía Redis con
   la vieja vipcargas — en el nuevo, con Redis propio, va sin sufijo o /0).
6. **EB:** crear Application + Environment:
   - Misma Platform (Node.js 20 / Amazon Linux 2023, según captura).
   - Load balanced, mismo min/max e instance type que el viejo.
   - ALB con **stickiness habilitado** (imprescindible para Socket.IO
     multi-instancia, ver WORKLOG #145).
   - Environment properties: las mismas del viejo (mínimo `SSM_PATH=/1girox/prod`).
   - Dejar que EB cree los roles; luego en IAM pegarle al instance profile las
     mismas policies del viejo (lectura SSM + SNS publish, según captura).
   - Si el viejo tenía listener 443 con certificado ACM: pedir certificado en
     ACM para cargas1girox.com (validación DNS → agregar el CNAME en
     Cloudflare) y asignarlo al listener.
7. **S3:** crear bucket para uploads (el código lo referencia vía env/SSM —
   revisar nombre en ssm-nombres/eb-config). Contenido viejo: no hace falta
   migrar (los mensajes tienen TTL 3 días).
8. **Deploy:** zip del repo (mismo procedimiento de siempre) → subir a EB.
9. **Prueba SIN tocar DNS:** contra la URL .elasticbeanstalk.com del entorno
   nuevo: arranque limpio en logs, `GET /api/admin/girox/health`, login,
   sockets (tiempo real), y SMS a número verificado.
10. **Cutover:** en Cloudflare cambiar el CNAME de cargas1girox.com al ALB
    nuevo. Verificar webhook de hgcash (la URL pública no cambia, así que no
    hay que tocar el dashboard de hgcash — solo confirmar que llegan).
11. **Días después, con todo verificado:** apagar el entorno viejo.

## Gotchas conocidos a re-verificar en el nuevo

- Los secretos llegan por SSM en el bootstrap ASYNC → cualquier prueba de env
  vars se hace tras el arranque completo (trampa #130).
- Atlas Network Access: si NO está en 0.0.0.0/0, agregar las IPs del entorno
  nuevo ANTES del primer arranque (si no, el server no conecta a la DB).
- El rate limit local de la Partner API es por proceso (N instancias × 55/min):
  mismo comportamiento que el viejo, nada que hacer.
- hgcash fanout (`HGCASH_FANOUT_URL`) y webhook secret: vienen en el export de
  SSM, no requieren cambios.
