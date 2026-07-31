/**
 * giroxReportsService.js — Netwin (GGR) por jugador y rango de fechas en 1girox.
 *
 * Reemplaza a `referralRevenueService.js` (que pegaba contra
 * `admin.agentesadmin.bet/api/v2/admin/reports/royalty-statistics` de JUGAYGANA).
 *
 * ⚠️ ESTO NO ES LA PARTNER API. La Partner API (giroxService.js, manual v1.4) NO
 * expone reportes: no tiene netwin, ni GGR, ni historial de apuestas. Este servicio
 * habla con el PANEL de administración (admin.1girox.com), capturando el mismo request
 * que hace la pantalla "Reportes Globales → Reporte por Jugador".
 *
 * Consecuencias de eso, que hay que tener presentes:
 *   - Auth por Bearer del panel, NO por X-Api-Key. Es un token de sesión: puede vencer.
 *   - Si 1girox cambia su panel, esto se rompe sin aviso (mismo acoplamiento frágil que
 *     teníamos con JUGAYGANA). La solución definitiva es que 1girox agregue el netwin a
 *     la Partner API — está pedido; cuando lo hagan, este archivo se reemplaza por una
 *     llamada con X-Api-Key y se borra.
 *
 * DE QUÉ DEPENDE ESTO (si falla, esto se cae):
 *   - Reembolsos diario / semanal / mensual (POST /api/refunds/claim/*)
 *   - Comisiones de referidos (referralCalculationService)
 *
 * ENDPOINT (capturado del panel, 2026-07-31):
 *   GET {GIROX_ADMIN_API_URL}/reports/global
 *       ?from=YYYY-MM-DD HH:mm:ss
 *       &to=YYYY-MM-DD HH:mm:ss
 *       &user_id=<ID del AGENTE>      ← nuestra cuenta (scope del reporte)
 *       &player_id=<ID del JUGADOR>   ← el jugador consultado
 *   Header: Authorization: Bearer <token del panel>
 *
 * ⚠️ OJO con los nombres: en `reports/global` el `user_id` es el AGENTE y el jugador va
 * en `player_id`. Pero en `reports/player-games` el `user_id` es el JUGADOR. No mezclar.
 *
 * RESPUESTA (verificada contra el panel: Casino 89 apuestas, $248.830 apostado,
 * $59.078 ganado, Netwin $189.752):
 * {
 *   "categories": [
 *     { "key":"casino", "label":"Casino", "bets_count":89, "bets_amount":248830,
 *       "payout":59078, "netwin":189752, "commission":0,
 *       "providers":[ { "provider":"Pragmatic Play (pulse)", "bets_count":53,
 *                       "bets_amount":238230, "payout":53450, "netwin":184780,
 *                       "commission":0 }, ... ] },
 *     { "key":"sports", ... }
 *   ],
 *   "totals": { "casino_netwin":189752, "sports_netwin":0, "casino_commission":0,
 *               "sports_commission":0, "total_netwin":189752, "total_commission":0,
 *               "total_payable":189752 },
 *   "scope": { "id":2, "name":"admin" }
 * }
 *
 * ✅ MONTOS EN PESOS, no en centavos (verificado: 248830 − 59078 = 189752, y el panel
 *    muestra $189.752,00). A diferencia de JUGAYGANA, acá NO se divide por 100.
 *
 * AUTENTICACIÓN — auto-renovable:
 *   POST {GIROX_ADMIN_BASE_URL}/api/auth/login  con las credenciales del panel
 *   → responde { "data": "<base64 de un raw-deflate>" }
 *   → al descomprimirlo: { "token": "969|xxxx", "user": { "id":2, "name":"admin", ... } }
 *
 *   O sea que el token de sesión se puede renovar solo (a diferencia de lo que parecía
 *   al principio, no hay que cargarlo a mano cada vez que vence). Del mismo login sale
 *   el `user.id`, que es el `user_id` del agente que pide el reporte → tampoco hace
 *   falta configurarlo aparte.
 *
 * CONFIG (lazy — SSM carga después del require):
 *   GIROX_ADMIN_BASE_URL  default https://admin.1girox.com
 *   GIROX_ADMIN_USER      usuario del panel (ej. "admin"). VA EN SSM.
 *   GIROX_ADMIN_PASS      contraseña del panel. VA EN SSM.
 *   GIROX_ADMIN_TOKEN     (opcional) Bearer fijo; si está, saltea el login.
 *   GIROX_AGENT_USER_ID   (opcional) override del user_id del agente.
 *   GIROX_NETWIN_SCOPE    'casino' (default) | 'total'  ← ver abajo
 *
 * ALCANCE DEL NETWIN — decisión del owner (2026-07-31): los reembolsos se calculan
 * SÓLO sobre el netwin de CASINO. El reporte trae casino y sports separados; sports
 * queda afuera hasta que se decida incorporarlo (entonces: GIROX_NETWIN_SCOPE=total).
 */
const axios = require('axios');
const zlib = require('zlib');
const logger = require('../utils/logger');

// ============================================================
// CONFIG (lazy)
// ============================================================

function getAdminBaseUrl() {
  return (process.env.GIROX_ADMIN_BASE_URL || 'https://admin.1girox.com').replace(/\/+$/, '');
}
function getAdminApiUrl() {
  return process.env.GIROX_ADMIN_API_URL
    ? process.env.GIROX_ADMIN_API_URL.replace(/\/+$/, '')
    : `${getAdminBaseUrl()}/api/config`;
}
function getAdminCreds() {
  return {
    user: process.env.GIROX_ADMIN_USER || null,
    pass: process.env.GIROX_ADMIN_PASS || null
  };
}
function getStaticToken() {
  return process.env.GIROX_ADMIN_TOKEN || null;
}
/** 'casino' (default, decisión del owner) o 'total' (casino + sports). */
function getNetwinScope() {
  return (process.env.GIROX_NETWIN_SCOPE || 'casino').toLowerCase() === 'total' ? 'total' : 'casino';
}
/** true si se puede autenticar: o hay token fijo, o hay credenciales para loguearse. */
function isEnabled() {
  const c = getAdminCreds();
  return !!(getStaticToken() || (c.user && c.pass));
}

const TIMEOUT_MS = Number(process.env.GIROX_REPORTS_TIMEOUT_MS || 30000);
const RETRY_DELAYS_MS = [2000, 5000];

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================
// SESIÓN DEL PANEL (token + id de agente, auto-renovables)
// ============================================================

let _session = { token: null, agentUserId: null, obtainedAt: 0 };
let _loginInProgress = null;

/**
 * El panel devuelve los payloads como { data: "<base64>" }, donde el base64 es un
 * DEFLATE CRUDO (sin cabecera zlib ni gzip). Verificado contra la respuesta real del
 * login. Si algún día dejan de comprimirlo, el `data` ya vendría como objeto y se
 * devuelve tal cual.
 */
function _decodePanelPayload(body) {
  if (!body) return null;
  if (typeof body === 'object' && !body.data) return body;
  if (typeof body === 'object' && typeof body.data === 'object') return body.data;

  const raw = typeof body === 'string' ? body : body.data;
  if (typeof raw !== 'string') return null;

  try {
    return JSON.parse(zlib.inflateRawSync(Buffer.from(raw, 'base64')).toString('utf8'));
  } catch (e) {
    // Fallbacks por si cambian el algoritmo de compresión.
    for (const fn of [zlib.inflateSync, zlib.gunzipSync, zlib.brotliDecompressSync]) {
      try { return JSON.parse(fn(Buffer.from(raw, 'base64')).toString('utf8')); } catch (_) { /* seguir */ }
    }
    try { return JSON.parse(raw); } catch (_) { /* no era JSON plano */ }
    logger.error('[girox-reports] no se pudo decodificar el payload del panel');
    return null;
  }
}

/** Se loguea en el panel y cachea { token, agentUserId }. */
async function _login() {
  const { user, pass } = getAdminCreds();
  if (!user || !pass) {
    logger.error('[girox-reports] faltan GIROX_ADMIN_USER / GIROX_ADMIN_PASS para renovar la sesión');
    return null;
  }

  const url = `${getAdminBaseUrl()}/api/auth/login`;
  try {
    // ⚠️ A CONFIRMAR con la captura del body real del login del panel: si el campo del
    // usuario fuera `email` en vez de `name`, se ajusta con GIROX_ADMIN_LOGIN_FIELD.
    const field = process.env.GIROX_ADMIN_LOGIN_FIELD || 'name';
    const resp = await axios.post(url, { [field]: user, password: pass }, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
      proxy: false,
      validateStatus: () => true
    });

    if (resp.status < 200 || resp.status >= 300) {
      logger.error(`[girox-reports] login falló: HTTP ${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
      return null;
    }

    const payload = _decodePanelPayload(resp.data);
    if (!payload || !payload.token) {
      logger.error('[girox-reports] login sin token en la respuesta');
      return null;
    }

    _session = {
      token: payload.token,
      agentUserId: payload.user && payload.user.id != null ? Number(payload.user.id) : null,
      obtainedAt: Date.now()
    };
    logger.info(`[girox-reports] sesión del panel renovada (agente ${_session.agentUserId}, ${_tokenFingerprint()})`);
    return _session;
  } catch (e) {
    logger.error(`[girox-reports] login falló: ${e.code || ''} ${e.message}`);
    return null;
  }
}

/** Token vigente; se loguea si hace falta. Coordina logins concurrentes con una sola promesa. */
async function _ensureSession(force = false) {
  const stat = getStaticToken();
  if (stat && !force) {
    return { token: stat, agentUserId: _envAgentUserId() || _session.agentUserId };
  }
  if (!force && _session.token) return _session;

  if (_loginInProgress) return _loginInProgress;
  _loginInProgress = _login().finally(() => { _loginInProgress = null; });
  return _loginInProgress;
}

function _envAgentUserId() {
  const n = Number(process.env.GIROX_AGENT_USER_ID);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ID del agente: override por env, o el que trajo el login. */
function getAgentUserId() {
  return _envAgentUserId() || _session.agentUserId || null;
}

// ============================================================
// FECHAS
// ============================================================

/**
 * Formatea una Date al formato que espera el panel: "YYYY-MM-DD HH:mm:ss",
 * expresado en hora de ARGENTINA (UTC-3) — que es como el owner ve y define los
 * períodos de reembolso (el día "de ayer" corta a la medianoche argentina).
 *
 * ⚠️ A VERIFICAR EN PRODUCCIÓN: no sabemos en qué huso interpreta el panel de 1girox
 * las fechas que recibe. Si las tomara como UTC, los cortes diarios quedarían corridos
 * 3 horas y el reembolso "de ayer" incluiría parte de anteayer. Forma de comprobarlo:
 * pedir un rango de un solo día para un jugador con actividad conocida y comparar el
 * netwin contra lo que muestra el panel. Si no coincide, ajustar acá (única fuente).
 */
function formatArgentinaDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  // en-CA da "YYYY-MM-DD"; en-GB con hour12:false da "HH:mm:ss"
  const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
  const datePart = d.toLocaleDateString('en-CA', opts);
  const timePart = d.toLocaleTimeString('en-GB', { ...opts, hour12: false });
  return `${datePart} ${timePart}`;
}

// ============================================================
// TRANSPORTE
// ============================================================

function _headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json'
  };
}

/** Huella segura del token para logs (nunca el valor completo). */
function _tokenFingerprint() {
  const t = _session.token || getStaticToken();
  if (!t) return '(sin token)';
  const pipe = t.indexOf('|');
  return pipe > 0 ? `id=${t.slice(0, pipe)} len=${t.length}` : `len=${t.length}`;
}

async function _get(path, params, label) {
  if (!isEnabled()) {
    logger.error('[girox-reports] sin configurar: falta GIROX_ADMIN_USER/GIROX_ADMIN_PASS (o GIROX_ADMIN_TOKEN)');
    return { ok: false, error: 'El servicio de reportes no está configurado.', code: 'not_configured' };
  }

  const url = `${getAdminApiUrl()}${path}`;
  let lastErr = null;
  let reloggedIn = false;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await _sleep(RETRY_DELAYS_MS[attempt - 1]);

    const sess = await _ensureSession();
    if (!sess || !sess.token) {
      lastErr = { error: 'No se pudo autenticar contra la plataforma.', code: 'login_failed', httpStatus: null };
      continue;
    }

    try {
      const resp = await axios.get(url, {
        params: typeof params === 'function' ? params(sess) : params,
        headers: _headers(sess.token),
        timeout: TIMEOUT_MS,
        proxy: false,
        validateStatus: () => true
      });

      // El panel está detrás de Cloudflare: ante un challenge devuelve HTML, no JSON.
      if (typeof resp.data === 'string' && resp.data.trim().startsWith('<')) {
        lastErr = { error: 'La plataforma respondió HTML (Cloudflare).', code: 'html_blocked', httpStatus: resp.status };
        logger.warn(`[girox-reports] ${label} — respuesta HTML (HTTP ${resp.status})`);
      } else if (resp.status === 401 || resp.status === 403) {
        // El Bearer del panel es un token de SESIÓN y vence. Se renueva UNA vez y se
        // reintenta; si vuelve a fallar, es un problema de credenciales, no de vencimiento.
        if (!reloggedIn) {
          reloggedIn = true;
          logger.warn(`[girox-reports] ${label} — token rechazado (HTTP ${resp.status}); renovando sesión`);
          await _ensureSession(true);
          continue;
        }
        logger.error(`[girox-reports] ${label} — TOKEN RECHAZADO tras renovar (HTTP ${resp.status}, ${_tokenFingerprint()}). ` +
          'Revisar GIROX_ADMIN_USER/GIROX_ADMIN_PASS: sin esto NO se calculan reembolsos ni comisiones.');
        return { ok: false, error: 'La plataforma rechazó nuestras credenciales de reportes.', code: 'token_rejected', httpStatus: resp.status };
      } else if (resp.status >= 200 && resp.status < 300) {
        // Algunos endpoints del panel devuelven el payload comprimido en `data`
        // (base64 + raw deflate, como el login) y otros JSON plano (como
        // reports/global). Se maneja cualquiera de los dos.
        const body = resp.data || {};
        const decoded = (body && typeof body.data === 'string') ? _decodePanelPayload(body) : body;
        return { ok: true, data: decoded || body };
      } else {
        lastErr = {
          error: `Error de la plataforma (HTTP ${resp.status}).`,
          code: `http_${resp.status}`,
          httpStatus: resp.status
        };
        logger.warn(`[girox-reports] ${label} — HTTP ${resp.status} ${JSON.stringify(resp.data).slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = { error: 'No se pudo conectar con la plataforma.', code: e.code || 'network_error', httpStatus: null };
      logger.warn(`[girox-reports] ${label} — ${e.code || ''} ${e.message}`);
    }
  }
  return { ok: false, ...lastErr };
}

// ============================================================
// PARSEO
// ============================================================

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parsea la respuesta de /reports/global.
 * NO divide por 100: los montos ya vienen en pesos.
 */
function _parseGlobalReport(data) {
  const totals = (data && data.totals) || {};
  const categories = Array.isArray(data && data.categories) ? data.categories : [];

  // Netwin por categoría. Se recalcula desde `categories` como respaldo por si el
  // campo de `totals` faltara en alguna versión del panel.
  const catNetwin = (key) => {
    const c = categories.find((x) => x && x.key === key);
    return c ? _num(c.netwin) : 0;
  };
  const casinoNetwin = totals.casino_netwin != null ? _num(totals.casino_netwin) : catNetwin('casino');
  const sportsNetwin = totals.sports_netwin != null ? _num(totals.sports_netwin) : catNetwin('sports');
  const combinedNetwin = totals.total_netwin != null
    ? _num(totals.total_netwin)
    : categories.reduce((acc, c) => acc + _num(c.netwin), 0);

  // ⚠️ DECISIÓN DEL OWNER (2026-07-31): los reembolsos se calculan SÓLO sobre casino.
  // Sports queda afuera hasta nuevo aviso (para incluirlo: GIROX_NETWIN_SCOPE=total).
  const totalNetwin = getNetwinScope() === 'total' ? combinedNetwin : casinoNetwin;

  const byCategory = categories.map((c) => ({
    key: c.key || null,
    label: c.label || null,
    betsCount: _num(c.bets_count),
    betsAmount: _num(c.bets_amount),
    payout: _num(c.payout),
    netwin: _num(c.netwin),
    commission: _num(c.commission)
  }));

  // Desglose por proveedor (equivalente al `providersBreakdown` que persiste
  // ReferralCommission). ⚠️ `commission` viene en 0 en nuestra cuenta: la comisión
  // de referidos se calcula con nuestro propio porcentaje, NO con este campo.
  // ⚠️ El desglose respeta el MISMO alcance que el netwin: si sólo se cuenta casino,
  // los proveedores de sports no entran. Si no, `providersBreakdown` (que se persiste
  // en ReferralCommission) sumaría más que el `totalOwnerRevenue` calculado sobre el
  // netwin, y los números del panel de referidos no cerrarían.
  const scopeKeys = getNetwinScope() === 'total' ? null : ['casino'];
  const providers = [];
  for (const c of categories) {
    if (scopeKeys && !scopeKeys.includes(c.key)) continue;
    if (!Array.isArray(c.providers)) continue;
    for (const p of c.providers) {
      providers.push({
        providerName: p.provider || 'desconocido',
        category: c.key || null,
        betsCount: _num(p.bets_count),
        betsAmount: _num(p.bets_amount),
        payout: _num(p.payout),
        netwin: _num(p.netwin),
        commission: _num(p.commission)
      });
    }
  }

  // Apostado/pagado: sólo los de las categorías que entran en el alcance elegido,
  // para que sean coherentes con el netwin que se devuelve (si no, un usuario que
  // apostó en sports mostraría un apostado que no se corresponde con su netwin).
  const inScope = getNetwinScope() === 'total'
    ? byCategory
    : byCategory.filter((c) => c.key === 'casino');

  return {
    totalNetwin,
    netwinScope: getNetwinScope(),      // 'casino' | 'total' — qué se contó
    totalBets: inScope.reduce((a, c) => a + c.betsAmount, 0),
    totalPayout: inScope.reduce((a, c) => a + c.payout, 0),
    casinoNetwin,
    sportsNetwin,
    combinedNetwin,
    totalCommission: _num(totals.total_commission),
    byCategory,
    providers,
    scope: (data && data.scope) || null  // scope del AGENTE que devolvió la API
  };
}

// ============================================================
// API PÚBLICA
// ============================================================

/**
 * Netwin (GGR) de un jugador en un rango de fechas.
 *
 * Es el reemplazo directo de `referralRevenueService.getUserNetwinForDateRange`.
 * Mantiene el campo `totalGgr` en la respuesta para no romper los 6 call sites de
 * server.js que ya lo leen; `totalNetwin` es el nombre nuevo (mismo valor).
 *
 * @param {number} giroxUserId  ID numérico del jugador en 1girox (User.giroxUserId)
 * @param {Date} fromDate
 * @param {Date} toDate
 * @param {string} [label]      etiqueta para logs (ej. 'refund-daily')
 * @returns {{success:boolean, totalGgr:number, totalNetwin:number, ...}}
 */
async function getPlayerNetwinForDateRange(giroxUserId, fromDate, toDate, label = 'netwin') {
  const playerId = Number(giroxUserId);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    // Igual que en JUGAYGANA: sin el ID del jugador el reporte devolvería el agregado
    // del AGENTE (toda la operación), no el del usuario. Sería pagar reembolsos sobre
    // la pérdida de TODOS los jugadores. Se aborta antes de llamar.
    logger.warn(`[girox-reports] ${label} — sin giroxUserId; no se puede pedir el netwin individual`);
    return { success: false, totalGgr: 0, totalNetwin: 0, error: 'Usuario sin ID de plataforma', code: 'no_player_id' };
  }

  const from = formatArgentinaDateTime(fromDate);
  const to = formatArgentinaDateTime(toDate);
  if (!from || !to) {
    return { success: false, totalGgr: 0, totalNetwin: 0, error: 'Rango de fechas inválido', code: 'invalid_range' };
  }

  // `params` se arma como función porque el user_id del agente sale del login, que
  // puede no haber ocurrido todavía en la primera llamada del proceso.
  const r = await _get(
    '/reports/global',
    (sess) => ({
      from,
      to,
      user_id: _envAgentUserId() || (sess && sess.agentUserId) || null,
      player_id: playerId
    }),
    `${label}(player=${playerId}, ${from} → ${to})`
  );

  if (!r.ok) {
    return { success: false, totalGgr: 0, totalNetwin: 0, error: r.error, code: r.code };
  }

  const parsed = _parseGlobalReport(r.data);

  // Chequeo de cordura: el reporte tiene que venir con NUESTRO scope de agente. Si
  // vuelve con otro, los números no son los nuestros — se descarta antes de pagar nada.
  const agentId = getAgentUserId();
  if (agentId && parsed.scope && parsed.scope.id != null && Number(parsed.scope.id) !== agentId) {
    logger.error(`[girox-reports] ${label} — scope inesperado: la API devolvió el agente ${parsed.scope.id} ` +
      `pero el nuestro es ${agentId}. NO se usa el resultado.`);
    return { success: false, totalGgr: 0, totalNetwin: 0, error: 'Scope de reporte inesperado', code: 'scope_mismatch' };
  }

  logger.info(`[girox-reports] ${label} — player ${playerId} [${parsed.netwinScope}]: ` +
    `apostado $${parsed.totalBets}, pagado $${parsed.totalPayout}, netwin $${parsed.totalNetwin} ` +
    `(casino $${parsed.casinoNetwin} / sports $${parsed.sportsNetwin})`);

  return {
    success: true,
    // alias de compatibilidad con el código que venía de JUGAYGANA (lee `totalGgr`)
    totalGgr: parsed.totalNetwin,
    totalNetwin: parsed.totalNetwin,
    netwinScope: parsed.netwinScope,
    totalBets: parsed.totalBets,
    totalPayout: parsed.totalPayout,
    casinoNetwin: parsed.casinoNetwin,
    sportsNetwin: parsed.sportsNetwin,
    combinedNetwin: parsed.combinedNetwin,
    byCategory: parsed.byCategory,
    providers: parsed.providers,
    from,
    to
  };
}

/**
 * Datos del usuario/jugador por su ID en 1girox. GET /users/{id}/info
 * Respuesta verificada:
 *   { id, name, email, parent, role, agents_count, players_count, created_at,
 *     structure:[{id,name},...] }
 * @returns { success, id, name, role, parent } | { success:false, error, code }
 */
async function getPlayerInfoById(giroxUserId) {
  const id = Number(giroxUserId);
  if (!Number.isFinite(id) || id <= 0) {
    return { success: false, error: 'ID inválido', code: 'invalid_id' };
  }
  const r = await _get(`/users/${id}/info`, {}, `userInfo(${id})`);
  if (!r.ok) return { success: false, error: r.error, code: r.code };
  const d = r.data || {};
  return {
    success: true,
    id: d.id != null ? Number(d.id) : null,
    name: d.name || null,
    email: d.email || null,
    parent: d.parent || null,
    role: d.role || null,
    createdAt: d.created_at || null,
    structure: Array.isArray(d.structure) ? d.structure : []
  };
}

/**
 * Busca un jugador por nombre y devuelve su ID numérico en 1girox.
 * POST /users/fetch?page=N  (listado paginado del panel, estilo Laravel)
 *
 * ⚠️ EL BUSCADOR DEL PANEL HACE "LIKE", NO COINCIDENCIA EXACTA: buscar "prueba1"
 * devuelve prueba1, prueba100, prueba12, prueba111 y Prueba123girox. Por eso acá se
 * exige coincidencia EXACTA (case-insensitive) sobre `name` antes de aceptar el ID.
 * Confundir un jugador con otro significaría pagarle el reembolso a la persona
 * equivocada, así que ante cualquier ambigüedad se devuelve null.
 *
 * Respuesta (verificada): { current_page, data:[{ id, name, role_id, parent_id,
 *   role:{id,name}, parent:{...}, balance:{balance:"32248.00", currency:"ARS"} }],
 *   total, per_page, last_page, ... }
 *
 * @returns { success, id, name, balance, parentId } | { success:false, error, code }
 */
async function findPlayerIdByUsername(username) {
  const name = String(username || '').trim();
  if (!name) return { success: false, error: 'Username vacío', code: 'invalid_username' };

  const sess = await _ensureSession();
  if (!sess || !sess.token) {
    return { success: false, error: 'No se pudo autenticar contra la plataforma.', code: 'login_failed' };
  }

  const url = `${getAdminApiUrl()}/users/fetch`;
  // ⚠️ FORMA DEL BODY A CONFIRMAR contra la captura del panel (pestaña "Solicitud").
  // Se manda el nombre bajo varias claves posibles porque el filtro real todavía no
  // está verificado; las que el backend no conozca las ignora. El filtrado fino lo
  // hace igual la coincidencia exacta de abajo, así que un filtro que no matchee
  // sólo cuesta traer más filas, nunca devolver el jugador equivocado.
  const body = { name, search: name, q: name, filters: { name } };

  try {
    const resp = await axios.post(url, body, {
      params: { page: 1 },
      headers: _headers(sess.token),
      timeout: TIMEOUT_MS,
      proxy: false,
      validateStatus: () => true
    });

    if (resp.status === 401 || resp.status === 403) {
      await _ensureSession(true);
      return { success: false, error: 'Sesión del panel vencida, reintentar.', code: 'token_rejected' };
    }
    if (resp.status < 200 || resp.status >= 300) {
      logger.warn(`[girox-reports] findPlayerId(${name}) — HTTP ${resp.status}`);
      return { success: false, error: `Error de la plataforma (HTTP ${resp.status}).`, code: `http_${resp.status}` };
    }

    const decoded = (resp.data && typeof resp.data.data === 'string')
      ? _decodePanelPayload(resp.data)
      : resp.data;
    const rows = Array.isArray(decoded && decoded.data) ? decoded.data : [];

    const target = name.toLowerCase();
    const exact = rows.filter((r) => String(r && r.name || '').toLowerCase() === target);

    if (exact.length === 0) {
      logger.warn(`[girox-reports] findPlayerId(${name}) — sin coincidencia exacta entre ${rows.length} resultados`);
      return { success: false, error: 'Jugador no encontrado en la plataforma.', code: 'player_not_found' };
    }
    if (exact.length > 1) {
      // No debería pasar (el username es único), pero si pasara, elegir uno al azar
      // sería elegir a quién pagarle. Se aborta.
      logger.error(`[girox-reports] findPlayerId(${name}) — ${exact.length} jugadores con el MISMO nombre. Se aborta.`);
      return { success: false, error: 'Nombre ambiguo en la plataforma.', code: 'ambiguous_username' };
    }

    const p = exact[0];
    return {
      success: true,
      id: p.id != null ? Number(p.id) : null,
      name: p.name,
      parentId: p.parent_id != null ? Number(p.parent_id) : null,
      role: (p.role && p.role.name) || null,
      balance: p.balance && p.balance.balance != null ? Number(p.balance.balance) : null
    };
  } catch (e) {
    logger.warn(`[girox-reports] findPlayerId(${name}) — ${e.code || ''} ${e.message}`);
    return { success: false, error: 'No se pudo conectar con la plataforma.', code: e.code || 'network_error' };
  }
}

module.exports = {
  isEnabled,
  getNetwinScope,
  getAgentUserId,
  formatArgentinaDateTime,
  getPlayerNetwinForDateRange,
  getPlayerInfoById,
  findPlayerIdByUsername
};
