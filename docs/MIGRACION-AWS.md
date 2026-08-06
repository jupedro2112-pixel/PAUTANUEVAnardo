# CLONACIÓN a una 2ª cuenta AWS — Runbook TEMPORAL (iniciado 2026-08-06)

> ⚠️ **ARCHIVO TEMPORAL.** Existe solo para que el trabajo de clonación
> sobreviva a los reinicios de Tails (todo lo local se borra). **Cuando la
> clonación esté terminada y verificada, BORRAR este archivo del repo.**
>
> ⚠️ **NO ES UNA MIGRACIÓN. Es un CLON en PARALELO:** el Amazon viejo sigue
> funcionando igual para siempre — no se pausa ni se reemplaza NADA. El clon
> es 100% independiente: otra base MongoDB, otro dominio, otra cuenta hgcash,
> otra cuenta/key de 1girox, su propio Redis y su propio SNS.
>
> **Estado (2026-08-06): FASE 1 COMPLETA** ✅ — todo lo necesario fue extraído
> de la cuenta vieja (Lautarobaezaws2026) y está inventariado abajo. Los
> archivos exportados viven en la carpeta local del owner
> `~/Documents/amazonviejo/` — ⚠️ **GUARDAR ESA CARPETA EN USB/persistencia:
> Tails la borra al reiniciar** (en especial `ssm-export.json`, los secretos).
> Cuenta NUEVA: Maiteabigailsosaaws (220282357357).
> Esperando: aprobación del caso SNS (sandbox + límite 100 USD). Al aprobar:
> SNS → Text messaging preferences → Account spend limit = 100 (a mano).

---

## Lo que falta y NO sale de AWS (lo gestiona el owner)

- [x] **Dominio nuevo** registrado + en Cloudflare (2026-08-06).
- [x] **Base MongoDB nueva** (Atlas) — el owner tiene la URI. Recordar
      Network Access (0.0.0.0/0 o IPs del clon) ANTES del primer arranque.
- [x] **Cuenta 1girox nueva** — el owner tiene la API key. Falta confirmar la
      URL de juego de la marca nueva (GIROX_PLAY_URL).
- [x] **Cuenta hgcash nueva** — el owner tiene el token. El webhook secret se
      genera en su dashboard al configurar la URL del webhook (paso 12).
- [ ] Aprobación del caso SNS (en curso).

**Decisiones del owner (2026-08-06):** sin pixel de Meta por ahora
(`META_PIXEL_ID`/`META_CAPI_ACCESS_TOKEN` se OMITEN); fbAds no se usa más
(`FBADS_WEBHOOK_TOKEN`/`FBADS_WEBHOOK_URL` se OMITEN); admin inicial del clon:
usuario `ignite1000` con contraseña definida por el owner (NO se escribe acá —
va directo al SSM). → El SSM del clon queda en **21 parámetros**.

## Inventario del entorno viejo (lo que hay que REPLICAR)

**Región: sa-east-1 (São Paulo) — usar la MISMA en la cuenta nueva.**

### Elastic Beanstalk (app `paginaaaacreada` / env `NUEVOgirox`)
- Platform: **Node.js 24 running on 64bit Amazon Linux 2023** (v6.11.5 — en el
  clon usar la última versión de esa misma rama).
- Entorno **Load balanced** con **Application Load Balancer** (no compartido).
- Capacidad: **min 2 / max 8**, instancia **t3.medium** (alternativa t3.large),
  x86_64, sin spot.
- Proceso default: puerto **8080** HTTP, health check path `/`, código 200,
  **Stickiness HABILITADO** (lb_cookie, 86400 s) ← imprescindible (Socket.IO).
- Listeners: **80 HTTP** + **443 HTTPS** con certificado **ACM** (en el clon:
  pedir cert ACM nuevo para el dominio nuevo, validación DNS en su Cloudflare)
  con policy TLS13-1-2-2021-06.
- Deploys: **AllAtOnce**, IgnoreHealthCheck true, timeout 600. Rolling updates
  (config): Time, batch 1, min in service 2, pause PT5M30S.
- Root volume: **io1 30GB 1000 IOPS** (idéntico; gp3 sería más barato si el
  owner acepta la diferencia). IMDSv1 deshabilitado. Monitoreo enhanced,
  intervalo 5 min. EC2 key pair: crear uno NUEVO en la cuenta nueva
  (el viejo `vipcargas-prod-key` no se puede exportar).
- **Environment properties**: `SSM_PATH=/1girox/prod/` y
  `PUBLIC_BASE_URL=https://<dominio-del-clon>`.
- VPC/subnets/security groups: usar la VPC default de la cuenta nueva (EB los
  crea). Tras crear el Redis: permitir 6379 desde el SG de las instancias EB.
- Versión a deployar: zip generado desde este repo (igual que siempre).

### IAM — instance profile `aws-elasticbeanstalk-ec2-role` (5 policies)
1. AmazonSNSFullAccess
2. AmazonSSMReadOnlyAccess
3. AWSElasticBeanstalkMulticontainerDocker
4. AWSElasticBeanstalkWebTier
5. AWSElasticBeanstalkWorkerTier
(EB crea el rol al armar el entorno; después pegarle las 2 primeras a mano.)
Además: crear **usuario IAM** con permiso SNS (para las keys
AWS_ACCESS_KEY_ID/SECRET del SSM — las viejas son de la otra cuenta, NO sirven).

### ElastiCache (Redis para Socket.IO multi-instancia)
- En el viejo: `paginacopia-redis-node`, **Redis OSS 7.1, cache.t4g.micro**,
  TLS in-transit (la URL es `rediss://...:6379/1`).
- En el clon: crear UNO igual (1 solo nodo, t4g.micro, Redis OSS 7.x,
  encryption in transit ON) → `REDIS_URL = rediss://<endpoint>:6379/0`.
  (El /1 del viejo era solo para no cruzarse con la vieja vipcargas que
  compartía el mismo Redis — el clon tiene Redis propio, va /0.)

### SNS (SMS)
- Preferencias del viejo: tipo default **Transactional**, límite de gasto
  **500 USD** (el clon arranca con 100 y va subiendo), delivery status
  logging con tasa 100 (opcional).

### S3
- Nada que crear: el viejo solo tiene los buckets automáticos de EB.

## SSM del clon — los 25 parámetros de `/1girox/prod/` y qué hacer con cada uno

**COPIAR IGUAL** (del ssm-export.json del owner):
`ANTHROPIC_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (mismo proyecto
Firebase — agregar el dominio nuevo a los authorized domains de Firebase),
`GIROX_API_URL` (https://api-1gx.com/api/v1), `GIROX_NETWIN_SCOPE` (casino),
`AWS_REGION` (sa-east-1), `SMS_MASIVO_PASSWORD`.

**NUEVOS / PROPIOS DEL CLON:**
- `MONGODB_URI` → la base Atlas nueva.
- `REDIS_URL` → el Redis nuevo (`rediss://.../0`).
- `PUBLIC_BASE_URL` → `https://<dominio-nuevo>`.
- `ADMIN_HOST` → la URL .elasticbeanstalk.com del entorno del clon (así el
  panel se abre solo por ahí, igual que en el viejo).
- `ALLOWED_ORIGINS` → `https://<eb-url-del-clon>,https://<dominio-nuevo>,https://www.<dominio-nuevo>`.
- `GIROX_API_KEY` → la key de la cuenta 1girox nueva.
- `GIROX_PLAY_URL` → la página de juego de la marca nueva (confirmar con 1girox).
- `HGCASH_API_TOKEN` + `HGCASH_WEBHOOK_SECRET` → de la cuenta hgcash nueva.
- `JWT_SECRET` + `JWT_REFRESH_SECRET` → generar random nuevos (base vacía, no
  hay sesiones que preservar).
- `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` → del usuario IAM nuevo (SNS).
- `ADMIN_PASSWORD` (+ `ADMIN_USERNAME` si quiere otro) → credencial nueva del
  admin inicial del clon (el seed la usa al crear la base).

**REVISAR CON EL OWNER (probablemente omitir al inicio):**
- `META_PIXEL_ID` + `META_CAPI_ACCESS_TOKEN` → pauta de Meta: si la marca
  nueva va a tener pixel propio, cargar el nuevo; si no hay pauta aún, omitir.
- `FBADS_WEBHOOK_TOKEN` + `FBADS_WEBHOOK_URL` → la URL del viejo es un túnel
  trycloudflare (efímero, seguramente muerto). Omitir en el clon salvo que se
  use el reenvío de leads de fbAds.

## FASE 2 — Orden de construcción en la cuenta nueva

1. [x] Caso SNS creado (sandbox + 100 USD) — esperando. Mientras: verificar el
       celular del owner en "Sandbox destination phone numbers" para probar.
2. [ ] Región sa-east-1 en todo.
3. [ ] Usuario IAM para SNS → generar Access Key (va al SSM).
4. [ ] ElastiCache Redis (t4g.micro, 7.x, TLS) → anotar endpoint.
5. [ ] Subir los 25 parámetros a `/1girox/prod/` (CloudShell: upload de
       ssm-export.json + script de put-parameter con los reemplazos de arriba
       — el asistente lo genera en el momento).
6. [ ] Crear app + entorno EB con la config del inventario (el asistente guía
       click por click). Roles: dejar que EB los cree + pegar las policies.
7. [ ] SG del Redis: permitir 6379 desde el SG de las instancias del entorno.
8. [ ] Certificado ACM para el dominio nuevo (validación DNS en Cloudflare) →
       listener 443.
9. [ ] Deploy del zip del repo.
10. [ ] Pruebas contra la URL EB directa: logs de arranque limpios (seed crea
        admin + comandos en la base nueva), /api/admin/girox/health, login,
        panel (por ADMIN_HOST), sockets, SMS al número verificado.
11. [ ] Cloudflare del dominio nuevo → CNAME al ALB del clon + regla WAF
        "Skip" para `/api/hgcash/webhook`.
12. [ ] Configurar el webhook en el dashboard de la cuenta hgcash nueva
        apuntando a `https://<dominio-nuevo>/api/hgcash/webhook` + probar.
13. [ ] Al aprobar SNS: setear Account spend limit = 100 en preferencias.

## Gotchas a re-verificar en el clon
- Secretos llegan por SSM en bootstrap ASYNC (trampa #130) — probar tras
  arranque completo.
- La base nueva arranca VACÍA: el seed crea el admin inicial (ADMIN_USERNAME/
  ADMIN_PASSWORD del SSM) y siembra los /sys_*. Usuarios del viejo NO se
  copian (decisión owner).
- Firebase: agregar el dominio nuevo en Authorized domains (Firebase console)
  para que el push/FCM funcione desde el dominio del clon.
- El branding visible (nombre de la app, SMS "VIPCARGAS: codigo...", textos)
  es el MISMO código: si la marca nueva necesita otro nombre visible, es un
  cambio de código aparte (pendiente señalado en WORKLOG #151).
