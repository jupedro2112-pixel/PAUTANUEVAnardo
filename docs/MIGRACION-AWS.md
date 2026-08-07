# PÁGINA NUEVA (nardo) en el Amazon VIEJO — Runbook TEMPORAL (iniciado 2026-08-06 como "clonación a 2ª cuenta"; replanteado 2026-08-07)

> ⚠️ **ARCHIVO TEMPORAL.** Existe solo para que el trabajo de clonación
> sobreviva a los reinicios de Tails (todo lo local se borra). **Cuando la
> clonación esté terminada y verificada, BORRAR este archivo del repo.**
>
> ⚠️ **NO ES UNA MIGRACIÓN. Es un CLON en PARALELO:** el entorno NUEVOgirox
> sigue funcionando igual para siempre — no se pausa ni se reemplaza NADA. El
> clon es independiente a nivel app: otra base MongoDB, otro dominio, otra
> cuenta hgcash, otra cuenta/key de 1girox.
>
> 🔴 **CAMBIO DE PLAN (owner 2026-08-07): la página nueva va en el Amazon
> VIEJO** (Lautarobaezaws2026) — la cuenta nueva (Maiteabigailsosaaws,
> 220282357357) quedó DESCARTADA (no se puede usar). Consecuencias:
> - SSM en path propio **`/nardo1girox/prod/`** (jamás tocar el
>   `/1girox/prod/` vivo). El entorno EB nuevo lleva la env property
>   **`SSM_PATH=/nardo1girox/prod/`** (loadSecrets.js lee de ahí).
> - **SNS: no hace falta NADA** (misma cuenta: límite 500 USD ya aprobado, y
>   las keys AWS del ssm-export.json sirven tal cual — chau caso SNS y chau
>   usuario IAM nuevo).
> - **Redis: se puede reusar el ElastiCache existente con base lógica /2**
>   (la /1 es de NUEVOgirox, la /0 de la vieja vipcargas; con DB distinta los
>   adapters no se cruzan — mismo esquema que ya usa NUEVOgirox).
> - Sigue haciendo falta: cert ACM para el dominio nuevo, entorno EB nuevo
>   (misma config del inventario), y los externos (Atlas/1girox/hgcash).
>
> **Estado (2026-08-06): FASE 1 COMPLETA** ✅ — todo lo necesario fue extraído
> del entorno viejo y está inventariado abajo. Los archivos exportados viven
> en la carpeta local del owner `~/Documents/amazonviejo/` — ⚠️ **GUARDAR ESA
> CARPETA EN USB/persistencia: Tails la borra al reiniciar** (en especial
> `ssm-export.json`, los secretos).

---

## Lo que falta y NO sale de AWS (lo gestiona el owner)

- [x] **Dominio nuevo** registrado + en Cloudflare (2026-08-06).
- [x] **Base MongoDB nueva** (Atlas) — el owner tiene la URI. Recordar
      Network Access (0.0.0.0/0 o IPs del clon) ANTES del primer arranque.
- [x] **Cuenta 1girox nueva** — el owner tiene la API key. Falta confirmar la
      URL de juego de la marca nueva (GIROX_PLAY_URL).
- [x] **Cuenta hgcash nueva** — el owner tiene el token. El webhook secret se
      genera en su dashboard al configurar la URL del webhook (paso 12).
- ~~Aprobación del caso SNS~~ → **YA NO HACE FALTA** (2026-08-07: misma cuenta
  vieja, SNS ya operativo con límite 500 USD).

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
- **Environment properties**: **`SSM_PATH=/nardo1girox/prod/`** (⚠️ el path
  NUEVO — no el /1girox/prod/ del entorno vivo) y
  `PUBLIC_BASE_URL=https://<dominio-del-clon>`.
- VPC/subnets/security groups: misma VPC (misma cuenta). Si se reusa el
  ElastiCache existente: permitir 6379 desde el SG de las instancias del
  entorno NUEVO en el SG del Redis.
- Versión a deployar: zip generado desde este repo (igual que siempre).

### IAM — instance profile `aws-elasticbeanstalk-ec2-role` (5 policies)
1. AmazonSNSFullAccess
2. AmazonSSMReadOnlyAccess
3. AWSElasticBeanstalkMulticontainerDocker
4. AWSElasticBeanstalkWebTier
5. AWSElasticBeanstalkWorkerTier
(En la MISMA cuenta el rol ya existe con esas policies — el entorno nuevo lo
reusa. ~~Usuario IAM nuevo para SNS~~ → NO hace falta (2026-08-07): las keys
AWS del ssm-export.json son de esta cuenta y sirven tal cual.)

### ElastiCache (Redis para Socket.IO multi-instancia)
- En el viejo: `paginacopia-redis-node`, **Redis OSS 7.1, cache.t4g.micro**,
  TLS in-transit (la URL es `rediss://...:6379/1`).
- En el clon (2026-08-07, misma cuenta): **reusar el MISMO
  `paginacopia-redis-node` con base lógica /2** →
  `REDIS_URL = rediss://<mismo-endpoint>:6379/2` (la /1 es de NUEVOgirox, la
  /0 de la vieja vipcargas; DB distinta = adapters sin cruce). Alternativa:
  crear un nodo aparte (t4g.micro, 7.x, TLS) y usar /0.

### SNS (SMS)
- Nada que hacer (2026-08-07): misma cuenta → tipo Transactional y límite
  **500 USD** ya operativos para la página nueva también.

### S3
- Nada que crear: el viejo solo tiene los buckets automáticos de EB.

## SSM de la página nueva — los 21 parámetros de **`/nardo1girox/prod/`**

(El detalle vivo está en `scripts/clon-ssm-put.sh`, que es quien los sube.)

**COPIAR IGUAL** (del ssm-export.json del owner — misma cuenta, 8):
`ANTHROPIC_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` (mismo proyecto
Firebase — agregar el dominio nuevo a los authorized domains de Firebase),
`GIROX_API_URL` (https://api-1gx.com/api/v1), `GIROX_NETWIN_SCOPE` (casino),
`AWS_REGION` (sa-east-1), `SMS_MASIVO_PASSWORD`, y (2026-08-07, por quedar en
la misma cuenta) `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (SNS).

**NUEVOS / PROPIOS DE LA PÁGINA NUEVA (13):**
- `MONGODB_URI` → la base Atlas nueva.
- `REDIS_URL` → `rediss://<endpoint-existente>:6379/2` (base lógica /2, ver
  ElastiCache arriba).
- `PUBLIC_BASE_URL` → `https://<dominio-nuevo>`.
- `ADMIN_HOST` → la URL .elasticbeanstalk.com del entorno NUEVO (así el
  panel se abre solo por ahí, igual que en NUEVOgirox).
- `ALLOWED_ORIGINS` → `https://<eb-url-nueva>,https://<dominio-nuevo>,https://www.<dominio-nuevo>`.
- `GIROX_API_KEY` → la key de la cuenta 1girox nueva.
- `GIROX_PLAY_URL` → la página de juego de la marca nueva (confirmar con 1girox).
- `HGCASH_API_TOKEN` + `HGCASH_WEBHOOK_SECRET` → de la cuenta hgcash nueva.
- `JWT_SECRET` + `JWT_REFRESH_SECRET` → random nuevos (el script los
  AUTOGENERA; base vacía, no hay sesiones que preservar).
- `ADMIN_USERNAME` (`ignite1000`) + `ADMIN_PASSWORD` → credencial del admin
  inicial (el seed la usa al crear la base).

**REVISAR CON EL OWNER (probablemente omitir al inicio):**
- `META_PIXEL_ID` + `META_CAPI_ACCESS_TOKEN` → pauta de Meta: si la marca
  nueva va a tener pixel propio, cargar el nuevo; si no hay pauta aún, omitir.
- `FBADS_WEBHOOK_TOKEN` + `FBADS_WEBHOOK_URL` → la URL del viejo es un túnel
  trycloudflare (efímero, seguramente muerto). Omitir en el clon salvo que se
  use el reenvío de leads de fbAds.

## FASE 2 — Orden de construcción (en el Amazon VIEJO, plan 2026-08-07)

1. ~~Caso SNS~~ / ~~usuario IAM para SNS~~ → NO hacen falta (misma cuenta).
2. [ ] Región sa-east-1 en todo (como siempre).
3. [ ] Anotar el endpoint del ElastiCache existente (`paginacopia-redis-node`)
       → la página nueva va con base lógica **/2** (no se crea Redis nuevo).
4. [x] **HECHO (2026-08-07):** los 21 parámetros subidos a
       `/nardo1girox/prod/` y verificados con `--check`. (Para modificar uno
       más adelante: mismo script, `bash clon-ssm-put.sh NOMBRE`.)
       Cómo fue: subir los 21 parámetros a **`/nardo1girox/prod/`** con
       **`scripts/clon-ssm-put.sh`**: editarlo LOCAL en Tails completando los
       `COMPLETAR_*` (los "DEL_EXPORT" salen de
       `~/Documents/amazonviejo/ssm-export.json`; los JWT se autogeneran),
       subirlo a CloudShell de la cuenta VIEJA y correr `bash clon-ssm-put.sh`.
       Chequeo: `bash clon-ssm-put.sh --check`. Corregir/actualizar uno:
       `bash clon-ssm-put.sh NOMBRE`. Los sin valor se saltean (ej.
       HGCASH_WEBHOOK_SECRET recién sale en el paso 11). Guards: aborta en la
       cuenta nueva descartada y si el prefijo fuera el /1girox/prod/ vivo.
       ⚠️ NUNCA commitear el script con valores reales (repo público).
5. [ ] Crear app + entorno EB NUEVOS en la misma cuenta con la config del
       inventario (el asistente guía click por click). Env properties:
       **`SSM_PATH=/nardo1girox/prod/`** + `PUBLIC_BASE_URL`. El instance
       profile existente se reusa.
6. [ ] SG del Redis: sumar regla 6379 desde el SG de las instancias del
       entorno NUEVO (sin tocar la regla del entorno viejo).
7. [ ] Certificado ACM para el dominio nuevo (validación DNS en Cloudflare) →
       listener 443 del ALB nuevo.
8. [ ] Deploy del zip del repo.
9. [ ] Pruebas contra la URL EB directa: logs de arranque limpios (seed crea
       admin + comandos en la base nueva), /api/admin/girox/health, login,
       panel (por ADMIN_HOST), sockets, SMS.
10. [ ] Cloudflare del dominio nuevo → CNAME al ALB nuevo + regla WAF
        "Skip" para `/api/hgcash/webhook`.
11. [ ] Configurar el webhook en el dashboard de la cuenta hgcash nueva
        apuntando a `https://<dominio-nuevo>/api/hgcash/webhook` + probar
        (el secret que genere → `bash clon-ssm-put.sh HGCASH_WEBHOOK_SECRET`).
12. [ ] Verificar que el entorno VIEJO siga intacto (no comparte nada más que
        cuenta, Redis —en DB distinta— y región).

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
