# RÉPLICA de la sesión 2026-08-14 — guía para implementar en la repo gemela

> **Cómo usar esto:** copiá TODO este documento como prompt inicial en una sesión
> del asistente parada en la OTRA repo (que ya aplicó completa la guía
> `REPLICA-SESION-2026-08-10.md`, hasta su FEATURE 6 inclusive). Es la
> especificación FINAL consolidada de lo implementado hoy en giroxNARDOnuevoo —
> implementá directo el estado final.

---

## INSTRUCCIONES PARA EL ASISTENTE QUE IMPLEMENTA

1. **NO copies líneas a ciegas.** Verificá con grep cada nombre de
   función/archivo citado antes de tocar; las repos pueden haber divergido.
2. Un commit por feature, con `node --check` en cada archivo JS tocado (no hay
   node_modules local: solo syntax check).
3. **Convenciones del proyecto** (ver CLAUDE.md local): montos en PESOS;
   idempotencia por `reference`; bump del SW en cada cambio de front (PWA:
   `public/firebase-messaging-sw.js`; panel: `public/admin-sw.js`); actualizar
   WORKLOG.md; commit+push a main.
4. Verificá cada feature con su "PROBAR".

---

## FEATURE 1 — iPhone PWA: el overlay del casino debe respetar el safe-area

**Síntoma (solo con la app instalada en iPhone, en navegador anda bien):** la
barra superior del casino embebido ("↗ Abrir aparte / ← Volver…") queda pegada
DEBAJO del reloj/status bar, y abajo aparece una franja blanca.

**Causa:** la PWA usa `viewport-fit=cover` + `apple-mobile-web-app-status-bar-style:
black-translucent` (index.html) → en standalone el viewport ocupa también la
zona del notch y la del home indicator. Todo el front compensa con
`env(safe-area-inset-*)` en los CSS, pero el overlay del casino se arma por JS
con estilos INLINE (`VIP.ui._showCasinoFrame`, `public/js/ui.js`) sin esa
compensación: barra con `padding:8px` fijo, e iframe hasta el borde físico —
la franja blanca es el fondo de la página embebida del casino asomando en la
zona del home indicator.

**Fix (solo estilos inline del overlay, en `_showCasinoFrame`):**
- Al cssText del overlay contenedor (el `position:fixed;inset:0;…background
  oscuro`) sumarle `padding-bottom:env(safe-area-inset-bottom,0px);` → el
  iframe termina antes del home indicator y esa zona queda del color del
  overlay (oscuro), no blanca.
- A la barra superior (el div del header con los botones), su `padding:8px 12px`
  pasa a `padding:8px 12px;padding-top:calc(8px + env(safe-area-inset-top,0px));`.
- En navegador normal los `env()` valen 0 → cero cambio fuera de standalone.

Bump del SW de la PWA. **PROBAR** (iPhone, app instalada; cerrar y abrir la app
2 veces para activar el SW): abrir el casino → la barra arranca DEBAJO del
reloj y no hay franja blanca abajo; en Safari normal, igual que antes.

---

## FEATURE 2 — Marca: limpiar textos visibles con la marca VIEJA

Quedaban 5 textos visibles al cliente que decían "VIPCARGAS" (la marca de la
era anterior) — en la gemela es el MISMO reemplazo: **VIPCARGAS → 1GIROX**
(confirmado por el owner: ambas repos vienen de JUGAYGANA y migraron a
1girox). Grep por `VIPCARGAS` en `public/` y corregí las apariciones VISIBLES
AL CLIENTE (no comentarios de código, no los clientes muertos jugaygana*):

Los 5 lugares:
1. `index.html` — subtítulo del modal "Información del Servicio": "Todos los
   beneficios de jugar en …".
2. `index.html` — banner de atribución de campañas: "✨ Bienvenido a …".
3. `index.html` — modal "BIENVENIDO A …".
4. `index.html` — modal "BENEFICIOS DE JUGAR EN …".
5. `public/js/ui.js` — botón "Volver a …" del recuadro de ERROR del casino
   (`_casinoFrameError`).

Bump del SW de la PWA (acá se hizo junto con nada más de front: un solo bump
sirve si se implementa junto a FEATURE 1). **PROBAR:** menú → Información del
Servicio → dice la marca nueva; grep de la marca vieja en public/ sin
resultados visibles al cliente.

**Pendiente conocido (NO resolver sin decisión del owner, solo señalarlo):**
los SMS de OTP (`src/services/otpService.js`) siguen diciendo "VIPCARGAS", y
puede haber COMANDOS guardados en la base que lo mencionen (la migración que
loguea "response aún menciona vipcargas" al arrancar ya existe desde la era
/sys_reminder — revisar sección COMANDOS del panel).

---

## FEATURE 3 — Guard bono-sobre-bono de la Bonificación: montos en el error + piso de $50

**Contexto:** `POST /api/admin/bonus` (el botón "Bonificación" del panel) tiene
un guard previo: si el jugador ya tiene bono en el casino
(`bonusLocked > 0 || claimableTotal > 0` vía `girox.getUserInfoByName`),
rechaza — otorgar otro bono PISA el anterior y le debita el resto (regla v1.7
de la plataforma). Problema doble reportado por el owner: (a) el error no
decía CUÁNTO ni de qué tipo, imposible de diagnosticar ("el cliente no tiene
saldo, ¿qué bono?" — el bono NO es saldo: puede haber un resto en rollover o
un "regalito" sin reclamar invisible en el panel); (b) saltaba con CUALQUIER
valor > 0, hasta centavos residuales de rollovers viejos → rebotes constantes.

**Cambio (solo en el guard de `/api/admin/bonus` — los guards espejo del
welcome code cash y de los lotes/notif-batch quedan ESTRICTOS en > $0, son
flujos automáticos):**
- Constante `BONUS_GUARD_MIN_ARS = 50`. El guard pasa de `(locked>0 || claim>0)`
  a `locked + claim > BONUS_GUARD_MIN_ARS`: un resto total ≤ $50 NO bloquea
  (la bonificación sale y pisa ese vuelto — decisión del owner: preferible a
  rebotarle la operación al agente).
- El mensaje de error detalla los montos, armado por partes presentes:
  «El cliente ya tiene un bono en el casino: $X de bono con rollover en curso
  y $Y de bono SIN RECLAMAR (el regalito del casino). Otorgar otro lo pisaría
  y le debitaría lo que le queda. Esperá a que lo termine/reclame o hacé una
  carga con bonus.» (formato `toLocaleString('es-AR')`; si solo hay uno de los
  dos montos, va solo esa parte).
- **Decisión explícita del owner:** NO auto-reclamar el regalito del cliente —
  solo avisar.

Solo back, sin cambios de panel. **PROBAR:** Bonificación a un cliente con
bono pendiente grande → error con los montos; con resto ≤ $50 → sale normal.

---

## NO REPLICAR (contexto, no código)

- La sesión de Safari NO pasa a la PWA instalada en iPhone (storage aislado
  por iOS): el cliente loguea UNA vez en la app y el JWT de 30 días queda.
  Es comportamiento de iOS, no hay nada que codear.

## CIERRE

Al terminar: WORKLOG.md con una entrada por feature (qué/por qué/cómo probar),
bump de SW consistente, `node --check` de todo, commit por feature y push.
Después del deploy, correr los "PROBAR".
