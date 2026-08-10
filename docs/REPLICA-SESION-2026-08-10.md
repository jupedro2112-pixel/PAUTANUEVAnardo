# RÉPLICA de la sesión 2026-08-10 — guía completa para implementar en la repo gemela

> **Cómo usar esto:** copiá TODO este documento como prompt inicial en una sesión
> del asistente parada en la OTRA repo (la que era idéntica a esta hasta el
> 2026-08-10). Es la especificación FINAL consolidada de todo lo implementado ese
> día en giroxNARDOnuevoo — sin las iteraciones intermedias: implementá directo
> el estado final, que es mejor.

---

## INSTRUCCIONES PARA EL ASISTENTE QUE IMPLEMENTA

1. **NO copies líneas a ciegas.** Las dos repos eran gemelas pero pueden haber
   divergido hoy. Antes de cada feature, EXPLORÁ tu repo (usá subagentes de
   exploración en paralelo para mapear: el flujo del código de bienvenida y su
   "cartel verde", la sección Notificaciones del panel, el ciclo de vida FCM,
   la sección Datos, el endpoint de conversaciones del chat). Los nombres de
   funciones/archivos acá citados existen en ambas repos salvo divergencia:
   verificalos con grep antes de tocar.
2. **Tardá lo que tengas que tardar.** Implementá en el ORDEN de este documento
   (hay dependencias). Un commit por feature, con `node --check` en cada archivo
   JS tocado antes de commitear (no hay node_modules local: solo syntax check).
3. **Convenciones del proyecto** (iguales en ambas repos, ver CLAUDE.md local):
   montos en PESOS (nunca ×100); idempotencia por `reference` única y ESTABLE
   por operación; secrets por SSM con lazy getters; sin cache en configs
   multi-instancia; bump del SW correspondiente en cada cambio de front
   (PWA: `public/firebase-messaging-sw.js`; panel: `public/admin-sw.js`);
   actualizar WORKLOG.md y docs/ARCHITECTURE.md; commit+push a main.
4. **Verificá cada feature con los "PROBAR" de cada sección** (al menos
   revisando el flujo en el código de punta a punta si no podés ejecutar).

---

## FEATURE 1 — Mínimos para cobrar el reembolso (semanal $1.500 / mensual $5.000)

**Objetivo:** si el reembolso CALCULADO del período da > $0 pero menos que el
mínimo, el reclamo se rechaza con un mensaje que incluye el mínimo VIGENTE
(nunca un texto fijo). Editables desde el panel.

**Backend (server.js):**
- Config nueva `Config['refundMinimums']` = `{weekly, monthly}`, defaults
  `{weekly: 1500, monthly: 5000}`, 0 = sin mínimo. Helper `getRefundMinimums()`
  SIN cache (mismo patrón que `getRefundTiersByPeriod`): clamp por período a
  entero ≥ 0, fallback al default si falta/inválido.
- En `POST /api/refunds/claim/weekly` y `/monthly`: después de calcular
  `refundAmount` con la escalera y ANTES de la reserva atómica del RefundClaim
  (así el rechazo NO quema el una-vez-por-período):
  `if (min > 0 && refundAmount < min)` → `res.json({ success:false, message:
  "🚫 No llegaste al mínimo del reembolso semanal: tu reembolso del período es
  $X y el mínimo para cobrarlo es $Y." (montos con toLocaleString('es-AR')),
  canClaim:true, belowMinimum:true, minAmount, amount, netAmount })`.
  El caso netLoss===0 conserva su mensaje propio anterior.
- `GET /api/refunds/status`: cada período suma `minAmount` y
  `belowMinimum` (= potentialAmount > 0 && < min). La PWA no necesita cambios
  (muestra el `message` del claim en un toast).
- `GET/POST /api/admin/refund-tiers` (solo admin general): el GET suma
  `minimums`; el POST acepta `minimums` **OPCIONAL** (un panel cacheado viejo
  que no lo manda NO pisa los mínimos vigentes), valida 0..10.000.000 por
  período, guarda con `Config.set` (registra quién), y devuelve los vigentes.

**Panel (admin.js):** en la card "Rangos de reembolso", bloque "💵 Mínimo para
cobrar" con 2 inputs (semanal/mensual) renderizado por el mismo
`renderRefundTiersEditor` (pasarle `minimums`), guardado con el MISMO botón
"Guardar rangos" (validación client-side ≥ 0). Bump admin-sw.

**PROBAR:** panel muestra 1500/5000 y los guarda; cliente con reembolso chico →
error con el monto del panel; con reembolso ≥ mínimo → cobra normal.

---

## FEATURE 2 — Fixes de push (hacer ANTES de los lotes: los lotes los usan)

**2a. `sendPushIfOffline` devuelve resultado + `forcePush`:**
- Firma nueva: `sendPushIfOffline(user, title, body, data = {}, opts = {})`.
- Devuelve `{ delivery: 'socket'|'push'|'error'|'none', sent, failed, cleaned }`
  ('none' = sin tokens; 'error' = todos los push fallaron). Los callers viejos
  ignoran el retorno — no romper nada.
- `opts.forcePush === true` saltea el atajo del socket (`connectedUsers.has`).

**2b. Fix del "socket fantasma" en el chat:** `_maybeSendPushFallback` se llama
en dos casos donde el socket YA falló (offline real, o socket que no acusó
recibo en 3s pero SIGUE en `connectedUsers`). Sin fix, al fantasma se le
re-emitía por el mismo socket muerto y el push real nunca salía. Fix: ese
helper llama `sendPushIfOffline(..., { forcePush: true })` (el tag
'chat-message' colapsa duplicados si el mensaje igual llegó por la sala).

**2c. Fix del badge en vivo del panel:** el handler socket `user_app_status`
clasificaba APP INSTALADA / NAVEGADOR con el contexto del ÚLTIMO token → un
cliente CON app que abría Chrome pasaba a "NOTIS EN NAVEGADOR" hasta recargar.
Fix: el handler solo hace `loadUserInfo(data.userId)` si es el chat abierto
(recalcula el badge con la lógica multi-token completa que ya tiene
`loadUserInfo`).

---

## FEATURE 3 — Ajustes a PromoBonus (cartel verde) para los lotes

El "cartel verde" del chat sale de `_getActivePromoBonus(username)` →
`GET /api/admin/promo-bonus?username=` → render en `loadChatPromoBonus`
(admin.js), y se consume con `POST /api/admin/promo-bonus/:id/use`. Cambios:

- `_getActivePromoBonus(username, opts = {})`: por default sigue filtrando
  `percent > 0`. Con `opts.includeFixed === true` (lo pasa SOLO el endpoint
  admin) suma los regalos de $ fijo: condición
  `$or: [{percent:{$gt:0}}, {montoFijoARS:{$gt:0}}]`.
- El **cap de lectura de 30%** sobre `percent` queda SOLO para bonos
  automáticos: los de lote (`sourceRuleCode === 'lote'`) están EXENTOS (los
  configura un agente a mano). El endpoint de la PWA (`/api/promo-bonus/mine`)
  NO cambia.
- El endpoint admin agrega `montoFijoARS` a la respuesta.
- `loadChatPromoBonus` (admin.js): si `montoFijoARS > 0 && !(percent > 0)` →
  título "REGALO PENDIENTE: $X — sumáselo en su próxima carga"; si no, el "%
  en la carga" de siempre. Origen: si `sourceRuleCode === 'lote'` mostrar
  `sourceRuleName` (ej. "Lote de AGENTE — nombre"), si no "regla <code>".
  Vencimiento en horas cuando ≥ 120 min.

**Dato clave que ya existe y NO hay que tocar:** el depósito con bonus marca el
PromoBonus activo del usuario como usado automáticamente (con cargaMonto).

---

## FEATURE 4 — LOTES DE NOTIFICACIONES CON REGALO (el sistema grande — estado final)

### 4.1 Modelo `src/models/NotifBatch.js` (nuevo)

```
id (uuid, unique, index)
name (String, '', max 60)              — etiqueta para el historial
mode: 'code' | 'window'
giftType: 'percent' | 'fixed'
amount (Number, min 1)                 — % (1..200) o $ (1..500000)
rolloverX (Number, default 0, min 0)   — solo fichas: rollover del bono auto-acreditado
code (String, null, UPPERCASE, index)  — solo mode code
isPublic (Boolean, default false)      — código público (ver 4.6)
maxClaims (Number, null)               — cupo total de canjes del código público
validHours (Number, min 1)             — 1..168; UN solo reloj por lote
sentAt / expiresAt (Date, index)       — expiresAt = sentAt + validHours
title ('', max 100) / message (max 500)
sentBy / sentByRole
audienceType: 'list'|'inactive'|'all'|'public'   + audienceDays, audienceLimit
sendDone (Boolean, default false, index)         — motor de envío
recipients: [{ userId, username,
  channel: 'app'|'browser'|'none',               — capacidad al enviar
  delivery: null|'sending'|'socket'|'push'|'none'|'error',
  deliveryAt (Date),
  claimedAt (Date, null),                        — window: = sentAt
  promoBonusId (String, null),                   — solo regalos %
  creditedAt / creditTxId / creditError,         — solo fichas auto-acreditadas
  _id: false }]
Índices: {mode, code, expiresAt:-1}, {'recipients.userId':1}, {sentAt:-1(ya via index sentAt)}
```

### 4.2 Regla de oro del regalo (quién pone la plata)

- **`percent`** (cualquier modo): lo aplica EL AGENTE en la carga. Al activarse
  se crea un **PromoBonus** `{percent: amount, montoFijoARS: 0,
  sourceRuleCode: 'lote', sourceRuleId: batch.id, sourceRuleName: "Lote de
  <sentBy> — <name>", expiresAt: batch.expiresAt}` (helper
  `_activateBatchPromoBonus`: antes VENCE todos los PromoBonus activos del
  username — un cartel a la vez, igual que el motor de reglas). Cartel verde +
  "Marcar usado" existentes.
- **`fixed` (fichas)**: SIEMPRE automático, vía helper único
  `_creditNotifBatchGift(uDoc, batch)` (ver 4.3): por código al canjear; por
  tiempo al enviarse el lote (lo acredita el motor a cada uno). SIN PromoBonus,
  sin cartel: el agente recibe nota admin-only "no hay que hacer nada".

### 4.3 Helper `_creditNotifBatchGift` + candados anti-abuso + alerta urgente

Constantes: `NOTIF_BATCH_USER_MAX_CREDITS_24H = 3`,
`NOTIF_BATCH_USER_MAX_ARS_7D = 300000` (topes POR USUARIO, cruzando TODOS los
lotes).

Flujo del helper (devuelve `{ok, txId}` o `{ok:false, reason, blocked?, retryable?}`):
1. **Cap-check**: aggregate sobre `Transaction` `{type:'bonus',
   'metadata.source':'notif_batch', userId, timestamp ≥ now-7d}` → count en 24h
   y suma en 7d. Si `count24 ≥ 3` o `total7d + amount > 300000` →
   `_emitNotifBatchSecurityAlert(uDoc, detalle)` y `{blocked:true, reason:
   'tope de seguridad'}`.
2. **Guard bono-sobre-bono** (v1.7 de la plataforma: otorgar un bono a quien ya
   tiene uno activo lo PISA): `girox.getUserInfoByName` → si no responde →
   `{retryable:true}`; si `bonusLocked>0 || claimableTotal>0` →
   `{blocked:true, reason:'bono activo en el casino'}`.
3. **Crédito**: `girox.creditUserBalance(username, amount, ref, {multiplier:
   rolloverX, description})` con reference ESTABLE
   **`vip-nbatch-${batch.id}-${userId}`** (slice 0,100) → reintentos jamás
   pagan dos veces (duplicate:true). Fallo → `{retryable:true}`.
4. **Auto-claim v1.7**: `girox.claimPendingBonus(username)` (warn si falla, no
   bloquea).
5. **Transaction** `type:'bonus'` con `metadata: {source:'notif_batch',
   batchId}` (regalo: NO cuenta como carga real en ningún reporte).

`_emitNotifBatchSecurityAlert`: log **ERROR** `[notif-batch][ALERTA] 🚨
URGENTE — POSIBLE ABUSO DE REGALOS DE LOTE: <user> <detalle>. El crédito se
BLOQUEÓ...` + `_emitAdminOnlyChatNote` al chat del usuario + `io.to('admins')
.emit('security_alert', {username, message, at})`. En el panel: listener
`socket.on('security_alert')` → `showToast(message, 'error')` (toast rojo).

### 4.4 Motor de envío reanudable (el "nunca falle")

El envío NO vive en la request. `POST /api/admin/notif-batches` guarda el lote
con todos los recipients `delivery:null` y patea `setImmediate(
_processNotifBatchQueue)`. El motor también corre por `setInterval` cada 45s
(retoma tras deploy/reinicio, y lotes creados en la otra instancia EB).

`_processNotifBatchQueue` (guard booleano por proceso): busca
`NotifBatch.find({sendDone:{$ne:true}})` (límite 20, sentAt asc) y procesa cada
uno con `_processOneNotifBatch(batchId)`:

- **Claim atómico por destinatario**: `findOneAndUpdate({id, recipients:
  {$elemMatch: {$or: [{delivery:null}, {delivery:'sending', deliveryAt:{$lt:
  now-10min}}]}}}, {$set: {'recipients.$.delivery':'sending',
  'recipients.$.deliveryAt': now}}, {new:false, projection:{id:1,
  'recipients.$':1}})` — la proyección posicional devuelve el elemento
  reclamado (pre-update) sin traer 20k subdocs. Sin match → break.
  Dos instancias EB nunca procesan el mismo recipient (el claim es la barrera);
  un 'sending' colgado >10 min se recupera solo.
- **Por recipient**: cargar el User (`id username fcmToken fcmTokens`).
  - `window`+`fixed`: si ya tiene `creditedAt` (retome) no re-acreditar; si no
    → `_creditNotifBatchGift`. Retryable → set `creditError` y DEJARLO EN
    'sending' (el vencimiento de 10 min lo reintenta solo; no resetear a null
    para no hacer un loop apretado contra la API caída) y NO notificar.
    Blocked → set `creditError` + `claimedAt:null`, NO notificar (no se le
    promete nada). OK → set `creditedAt`/`creditTxId`, mensaje de chat
    "💰 ¡Te ACREDITAMOS $X en fichas (rollover…)! Ya están en tu cuenta".
  - `window`+`percent` sin promoBonusId: `_activateBatchPromoBonus` + set
    positional del id.
  - Notificar (si corresponde): `Message.create` (senderId 'system',
    senderUsername 'Sistema', senderRole 'admin', type 'system') con el
    contenido de 4.5 + `sendPushIfOffline(u, title, message.slice(0,150),
    {tag:'notif-batch'})` → guardar `delivery` = resultado.
  - Pausa 35ms entre destinatarios (ritmo; con fichas el limitador de la API
    marca el paso real: ~3 requests/usuario → lote de 300 tarda 15-20 min).
- **Cierre**: si no queda ningún recipient `delivery null|'sending'` →
  `sendDone:true` (update condicionado, log "COMPLETADO").

### 4.5 Endpoints (server.js, junto a la sección PromoBonus)

Roles: enviar/preview `['admin','depositor']`; ver historial
`['admin','depositor','withdrawer']`. Todo con authMiddleware+adminMiddleware
más el check de rol explícito.

**`POST /api/admin/notif-batches/preview`** — resuelve la audiencia SIN enviar:
por usuario `{username, channel}` (máx 150 en la lista visible, `truncated`
con el resto), `notFound`, `skipped` (bloqueados), `totals {ok, app, browser,
none}`. Clasificación `_notifChannelOf(u)`: token con context 'standalone' en
CUALQUIER entrada (o legacy fcmToken+fcmTokenContext) → 'app'; algún token →
'browser'; nada → 'none' (misma lógica multi-token que el badge del chat).

**`POST /api/admin/notif-batches`** — crea y dispara. Validaciones:
- mode ∈ {code,window}; giftType ∈ {percent,fixed}; percent 1..200; fixed
  1..500000; validHours 1..168; message 5..500 (opcional si audiencia public);
  title ≤100 (default "🎁 Tenés un regalo"); name ≤60.
- `rolloverX` (solo fixed, cualquier modo): 0..50 Y validado contra
  `bonus.multipliers` de `girox.getPlatformConfig()` (⚠️ NO
  `rollover.multipliers`, esos son de depósitos) — si la config no responde,
  alcanza el rango. Error con la lista permitida.
- `code` (mode code): del body o autogenerado (8 chars de
  'ABCDEFGHJKMNPQRSTUVWXYZ23456789' — sin confundibles), regex
  `^[A-Z0-9-]{4,30}$`, sin colisión con el código de bienvenida vigente
  (case-insensitive) ni con otro lote ACTIVO (expiresAt > now) del mismo código.
- Audiencia (`_resolveNotifBatchAudience(body)`):
  - `list`: usernames pegados; match case-insensitive vía
    `.collation({locale:'en', strength:2})` con `$in`; dedupe por id; excluir
    `isBlocked`; devolver notFound/skipped. Tope 20000 (sanidad).
  - `inactive`: `audienceDays` 1..365; mismo criterio que el push masivo
    (`lastLogin < cutoff` O inexistente), `role:'user'`, sin bloqueados,
    `sort({lastLogin:-1})` (los más recientes primero = más probables de
    volver) + `audienceLimit` opcional (el "lote de 300").
  - `all`: todos los role user activos (límite 20000).
  - `public`: ver 4.6.
- Crea el doc (recipients con channel precalculado; en `window`
  `claimedAt = sentAt`) y responde YA con totals/notFound/skipped — el envío
  sigue en el motor.

**`GET /api/admin/notif-batches`** (limit ≤100, default 30) — aggregation con
`$project` de tamaños: `total`, `claimed` (claimedAt≠null), `delivered`
(delivery ∈ socket|push), `pendientes` (delivery ∈ null|'sending'), `sinNotis`
(channel none), + meta (audience*, isPublic, maxClaims, sendDone...). SIN el
array recipients.

**`GET /api/admin/notif-batches/:id`** — detalle: por recipient
`{username, channel, delivery, claimedAt, creditedAt, creditError,
bonusStatus, usedBy, usedAt}` (bonusStatus/usedBy salen del join por
promoBonusId contra PromoBonus).

### 4.6 CÓDIGO PÚBLICO (para Telegram/redes)

- Create con `audienceType:'public'`: fuerza mode 'code'; message opcional;
  `maxClaims` opcional 1..100000; `recipients: []`; **`sendDone: true`** (no
  hay nada que enviar — el código se sube a mano a las redes). Respuesta
  devuelve el código listo para copiar.
- Canje: CUALQUIER `role:'user'` una vez. El usuario se APPENDEA a recipients
  con update atómico: filtro `{id, expiresAt:{$gt:now}, recipients:{$not:
  {$elemMatch:{userId}}}}` + (si hay cupo) `$expr: {$lt: [{$size:
  {$ifNull:['$recipients',[]]}}, maxClaims]}`; update `$push` del recipient
  `{channel:'none', delivery:'none', claimedAt:now, ...}`. Los updates sobre un
  doc se serializan en Mongo → dos claims concurrentes no se duplican. Si no
  matcheó: si ya está en recipients → "una sola vez por cuenta"; si no →
  "llegó a su límite de canjes (o venció)".
- Si el crédito de fichas falla → `$pull` del recipient (no consume cupo,
  puede reintentar). Código público VENCIDO → mensaje "venció" para cualquiera
  (no "no válido").

### 4.7 Canje por código — hook en el claim existente

En `POST /api/community-code/claim` (el del código de bienvenida), ANTES de
leer `communityWelcomeCode`: `const r = await _tryClaimNotifBatchCode(req.user,
attempt); if (r) return res.status(r.http).json(r.body);` — null = no es un
código de lote → sigue el flujo del welcome code intacto.

`_tryClaimNotifBatchCode`:
1. Buscar lote ACTIVO `{mode:'code', code: attempt.toUpperCase(),
   expiresAt:{$gt:now}}`. Si no hay: buscar uno vencido con ese código — si el
   usuario estaba en él (o es público) → "⏰ ya venció"; si no → return null.
2. Membresía: lote con lista → si NO está → log warn + "código no válido"
   (NO revelar que existe); si ya canjeó → "ya canjeaste". Público → solo el
   check de re-canje.
3. Solo `role:'user'`.
4. Reserva atómica (lista: `$elemMatch {userId, claimedAt:null}` → `$set`
   claimedAt; público: el append de 4.6).
5. `fixed` → `_creditNotifBatchGift`; fallo → liberar reserva (lista:
   claimedAt null + creditError; público: $pull) y responder según el caso
   (bono activo / "hablá con soporte" si tope / 502 reintentable). OK → set
   creditedAt/creditTxId, mensaje al cliente "💰 tu regalo de $X ya está
   ACREDITADO (+ nota de rollover si >0)", nota admin-only "no hay que hacer
   nada", respuesta `{success:true, status:'credited', amount, type:'cash',
   message}` → la PWA ya renderiza la tarjeta verde y refresca el saldo con su
   flujo existente del welcome code.
6. `percent` → `_activateBatchPromoBonus` + set promoBonusId, mensaje al
   cliente "+X% EXTRA... avisale al agente... válido hasta <fecha ART>", nota
   admin-only "aplicáselo y marcalo usado", respuesta `{success:true,
   status:'pending', amount, type:'next_charge', message}`.

**SIN gate de app instalada** para códigos de lote (la exclusividad ES la
membresía; el público es a propósito abierto) — a diferencia del welcome code.

### 4.8 PWA — "Reclamar Bono con Código"

El modal del código de bienvenida (inline en public/index.html, IIFE con
`openWelcomeCodeModal`/`submitWelcomeCode`):
- Renombrar menú ☰ y header del modal a **"🎁 Reclamar Bono con Código"** con
  subtítulo que mencione códigos de la Comunidad Y de notificaciones.
- **CRÍTICO:** hoy los estados pending/used/credited del welcome code NO
  renderizan el input → quien ya canjeó la bienvenida no puede meter códigos de
  lote. Refactor: extraer `_inputHtml()` y agregar `_extraInputHtml()`
  ("¿Te llegó OTRO código por notificación? Canjealo acá:") DEBAJO de las
  tarjetas de estado en los 3 renders. El response-handling existente ya cubre
  los shapes de lote (credited → tarjeta verde + syncBalance; pending →
  tarjeta azul). Bump del SW de la PWA.

### 4.9 Panel — cards en la sección Notificaciones

**Card "🎁 Lote con regalo"** (entre "Difusión por etiqueta" y "Resultado"):
- Nombre (opcional) · Modo (🔑 código / ⏰ por tiempo) · Regalo (％ "cartel al
  agente" / 💵 "Fichas (automático)") · Monto · 🎯 Rollover (visible solo con
  fichas) · Vigencia horas (default 24) · Código + botón 🎲 (visible solo modo
  código) · Título push · Mensaje (nota: "el regalo, código y vigencia se
  agregan solos al final") · **Destinatarios**: radios 📋 Lista pegada
  (textarea, separadores coma/espacio/enter) / 😴 Inactivos (días + cupo, nota
  "más recientes primero") / 🌍 Lote completo (aviso) / 📣 Código PÚBLICO
  (nota explicativa + cupo de canjes; fuerza modo código y deshabilita
  "por tiempo").
- Botón "🔍 Validar lista" → preview (chips por usuario con canal, totales
  completos, no-encontrados, bloqueados). Botón "🚀 Enviar lote": SIEMPRE corre
  el preview por atrás para confirmar con el CONTEO REAL; el confirm muestra
  regalo/modo/audiencia/destinatarios + nota según el caso — fichas por
  código: "se acredita AUTOMÁTICAMENTE al canjear"; fichas por tiempo:
  "🚨 $X A CADA UNO apenas se envíe — TOTAL ≈ $X×N"; público con fichas sin
  cupo: "SIN CUPO TOTAL — pensalo bien"; %: "lo aplicás VOS".
- Botón **"❓ Cómo funciona"** en el header de la card → guía desplegable
  completa (regla de quién pone la plata, modos, audiencias, validar lista
  📱/🌐/🔕, candados anti-abuso y alerta roja, cartel verde y flujo del
  cajero, paso a paso del código público, historial, respuestas rápidas a
  clientes).

**Card "📤 Lotes enviados"**: lista del GET — por lote: regalo, 🔑 código /
⏰ hs, audiencia (📣 público con "N canjes de M" / 😴 / 🌍 / 📋), vigente/
vencido, fecha, **quién lo envió**, totales, progreso en vivo
"⏳ enviando (X/N)" si hay pendientes, "sin notis" en naranja. "👥 Ver lote" →
detalle por usuario: canal + entrega (🟢 en la app / 🔔 push / ⚠ falló / solo
chat / ⏳ enviando) + estado (💰 acreditado automático / ⚠ sin acreditar:
motivo / 🎁 bono ACTIVO / ✔ usado por X / ⏰ vencido / canjeado / sin canjear).
Render capado a 400 filas + "… y N más". `loadNotifBatches()` se suma a
`loadNotificationsPanel()`.

**PROBAR (mínimo):** lote código % a 2-3 cuentas (push+chat, canje → cartel
verde, código desde cuenta ajena → "no válido"); lote fichas por código
(saldo entra solo + nota al agente); lote fichas por tiempo a 2 cuentas
(confirm muestra el total, acredita solo); 4 créditos seguidos a la misma
cuenta → el 4° se bloquea + toast rojo; código público con cupo 2 → tercera
cuenta rechazada; usuario que ya usó el welcome code puede canjear códigos de
lote; reiniciar el server a mitad de un lote → el motor lo termina solo.

---

## FEATURE 5 — DATOS 2.0 (cohortes de retención)

**Concepto:** la sección Datos mira el PERÍODO; esta mira las CAMADAS: cada día
ART es la cohorte de Users registrados ese día, seguida en el tiempo.

**Endpoint `GET /api/admin/datos2?days=7..90`** (default 30; mismo gate que
/api/admin/datos — cualquier rol staff):
- Días en hora ARGENTINA (UTC-3 fijo, igual que el resto del archivo).
- Cohortes: `User.find({role:'user', createdAt: {$gte: inicioVentana}})` con
  `id username createdAt acquisitionCampaign createdByEmployeeId`.
- Cargas: UNA aggregation sobre Transaction `{type:'deposit',
  'metadata.source':{$ne:'payout_refund'}, username:{$in:usernames}}` agrupada
  por username: `count, total, lastAt ($max timestamp), dias ($addToSet
  $dateToString %Y-%m-%d timezone ART)`.
- Por usuario: retención Dx = `lastAt ≥ createdAt + x días` (mira la ÚLTIMA
  carga → capta a los que se van y vuelven). Una cohorte solo es ELEGIBLE para
  Dx cuando ya cumplió esa edad — si no, la celda es null (el front muestra
  "—", jamás un % falso bajo). RET_DAYS = [1,3,7,14,30].
- Acumular por día ART de registro Y por campaña: nuevos (desglose 📣 pauta =
  acquisitionCampaign / 🧑‍💼 agente = createdByEmployeeId / 🌱 orgánico), c1/c2/
  c3 (cargó ≥1/2/3 veces) con %, cargas promedio por depositante, días
  distintos con carga, $ depositado, **$/nuevo** (depositado / TODOS los
  nuevos — para comparar contra el costo por registro de la pauta), ret por
  ventana `{ok, eligible, pct}`.
- Respuesta: `resumen` (totales + **c3Pct10d**: % de 3+ cargas ponderado sobre
  las cohortes de los últimos 10 días — la métrica pedida), `cohortes[]` (día a
  día, más reciente primero, incluyendo días sin registros), `campanias[]`
  (por acquisitionCampaign con publisher resuelto de Campaign + buckets
  'CREADOS POR AGENTE' y 'ORGÁNICO / DIRECTO', orden por nuevos desc).

**Panel:** nav item "📊 Datos 2.0" (después de Datos) + sección con:
explicación en criollo arriba, selector 10/14/30/60/90 días, 4 stat-cards
(nuevos con desglose / % cargó ≥1 / **% 3+ últimos 10 días** / $ depositado y
$/nuevo), tabla "📅 Camada por camada" (Día | Nuevos 📣/🧑‍💼/🌱 | ≥1 | ≥2 | ≥3 |
cargas prom | $ | $/nuevo | D1 D3 D7 D14 D30 con celdas semáforo verde/
amarillo/rojo por % y tooltip "X de Y seguían cargando"), tabla "🎯 Rendimiento
por campaña" (nuevos, %≥1, 3+, $, $/nuevo, Ret. D7) + tip de lectura. Hook en
el switch de secciones (`loadDatos2`). Botones **"❓ Cómo leer esta hoja"**
en Datos Y Datos 2.0 (recuadro desplegable con la explicación completa para
agentes: Datos = "la foto del día", Datos 2.0 = "la película de cada camada",
qué significa cada columna, el "—", la regla práctica y un ejemplo concreto).

---

## FEATURE 6 — Chats CERRADOS: 48 horas paginadas con números

En `GET /api/admin/conversations` (el del panel, sobre ChatStatus): el corte
actual es top 100 por actividad por pestaña. Cambio SOLO para
`status==='closed'` (un chat ABIERTO viejo es trabajo pendiente y debe
aparecer siempre):
- match `{status:'closed', lastMessageAt: {$gte: now-48h}}` (los mensajes viven
  72h por TTL, así que 48h siempre tiene historial completo).
- Paginado `?page=N` (1..50): `$skip (page-1)*100`, `$limit 101` (para saber
  `hasMore` sin count extra; slice a 100), + `totalPages` con
  `countDocuments(match)` (usa el índice `{status, lastMessageAt}` existente).
- Respuesta suma `{page, hasMore, totalPages}`.

**Panel:** paginador arriba de la lista, visible solo en Cerrados:
`‹ [21][22][23][24][25][26] › [N°] Página 23 de 48 · últimas 48hs` — ventana
de 6 números centrada en la actual (todas si ≤6), botón activo resaltado,
input para escribir el número y saltar con Enter (clamp 1..total), ‹ › de a 1.
Al cambiar de pestaña y volver: SIEMPRE arranca en página 1 (decisión del
owner). El cache de 30s por pestaña guarda SOLO la página 1 (helper único para
los sets del cache — las páginas viejas ni lo usan ni lo pisan). Si el total
baja (chats saliendo de la ventana) y quedaste más allá, se reacomoda a la
última.

---

## NO REPLICAR (cosas de infra/entorno de la otra repo)

- El upgrade de Atlas M0→M10 y `HGCASH_FANOUT_URL` son del ENTORNO, no del
  código (evaluar si aplican allá).
- El caso "requiere Chrome" (WebAPK Android) es diagnóstico, no código: si
  aparece, la solución es desinstalar la app + actualizar Chrome + reinstalar.

## CIERRE

Al terminar: WORKLOG.md con una entrada por feature (qué/por qué/cómo probar),
ARCHITECTURE.md actualizado (PromoBonus con exención 'lote', NotifBatch
completo con motor y candados, Datos 2.0, ventana de Cerrados), bumps de SW
consistentes, `node --check` de todo, commit por feature y push. Después del
deploy, correr los "PROBAR" de cada sección.
