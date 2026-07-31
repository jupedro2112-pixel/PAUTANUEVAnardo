/**
 * giroxService.js — Cliente ÚNICO de la plataforma 1girox (Partner API v1.7).
 *
 * Reemplaza a los 4 clientes de JUGAYGANA (jugaygana.js, jugaygana-movements.js,
 * jugayganaService.js, jugayganaPublisherSessions.js). Diferencias de fondo:
 *
 *   - NO hay sesión que renovar: auth por header `X-Api-Key` fijo. Se van login/
 *     ensureSession/invalidateSession, el mutex de login y el pool por publicista.
 *   - NO hay HTML de Cloudflare: la API responde JSON siempre. Se va isHtmlBlocked().
 *   - Los montos van en PESOS (unidad mayor, admite decimales), NO en centavos.
 *     ⚠️ NO multiplicar ×100 en ningún lado — era el gotcha #1 de JUGAYGANA.
 *   - Cargas/retiros/bonos son IDEMPOTENTES por `reference`: reintentar con la misma
 *     reference NO duplica la operación (devuelve duplicate:true con los datos del
 *     original). Es la defensa real contra el doble cobro; ver `_withRetry`.
 *   - Todo va por `username`: 1girox no expone un ID numérico de jugador, así que
 *     `User.jugayganaUserId` NO tiene equivalente (ver giroxSyncStatus en User.js).
 *
 * FORMA DE LAS RESPUESTAS — a propósito, imita la de los clientes viejos para que
 * los ~60 call sites de server.js no tengan que reescribirse:
 *   - operaciones de plata → { success, data: { transfer_id, user_balance_after, ... } }
 *     (server.js lee `result.data?.transfer_id || result.data?.transferId` en 27 lugares
 *      y `result.data?.user_balance_after` como fallback de saldo en 7).
 *   - balance → { success, balance, username, ... }
 *   - errores → { success:false, error:'<texto para el usuario>', code, httpStatus }
 *
 * CONFIG (lazy — se leen en runtime, NUNCA en el require):
 *   GIROX_API_URL   Base URL de la Partner API, sin barra final. La entrega el agente
 *                   junto con la key. Ej: https://api.1girox.com/api/v1
 *   GIROX_API_KEY   Header X-Api-Key (`pk_...`). Va en SSM, jamás en el repo.
 *   GIROX_PLAY_URL  Sitio de juego al que se manda al cliente (default 1girox.com).
 *
 * ⚠️ Los secrets de SSM se cargan en el bootstrap async, DESPUÉS de que Node resuelve
 * los require() del top de server.js. Por eso acá todo se lee con getters lazy y el
 * cliente axios se construye on-demand — el bug que tienen hoy los 4 clientes viejos,
 * que congelan process.env en consts de módulo (funcionan sólo porque esas vars están
 * en el entorno de EB y no en SSM). Mismo patrón correcto que hgcashService.js:19.
 */
const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ============================================================
// CONFIG (lazy)
// ============================================================

function getBaseUrl() {
  const raw = process.env.GIROX_API_URL || '';
  return raw.trim().replace(/\/+$/, ''); // sin barra final
}
function getApiKey() {
  return process.env.GIROX_API_KEY || null;
}
/** URL pública del casino (la que ve el usuario). */
function getPlayUrl() {
  return (process.env.GIROX_PLAY_URL || 'https://1girox.com').replace(/\/+$/, '');
}
/** true si el cliente está configurado y puede operar. */
function isEnabled() {
  return !!(getBaseUrl() && getApiKey());
}

const TIMEOUT_MS = Number(process.env.GIROX_TIMEOUT_MS || 20000);

// Reintentos ante fallas transitorias (5xx / timeout / red / 429).
// La doc recomienda backoff 2s, 5s, 15s reusando SIEMPRE la misma reference.
const RETRY_DELAYS_MS = [2000, 5000, 15000];

// ============================================================
// RATE LIMIT — 60 requests/minuto (límite de la API; 429 si se pasa)
// ============================================================
// ⚠️ MULTI-INSTANCIA (AWS EB): este limitador es POR PROCESO. Con N instancias el
// techo real es N×60/min, así que el 429 sigue siendo posible → por eso además se
// reintenta respetando Retry-After. Si con varias instancias aparecen 429 seguidos,
// bajar GIROX_MAX_RPM (ej. 30 con 2 instancias).
const MAX_RPM = Number(process.env.GIROX_MAX_RPM || 55); // 55 y no 60: margen de seguridad
const WINDOW_MS = 60000;
const MAX_QUEUE_WAIT_MS = 30000; // si hay que esperar más que esto, falla rápido

let _requestTimestamps = [];

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Espera a que haya lugar en la ventana de rate limit. Devuelve false si esperar sería excesivo. */
async function _acquireSlot() {
  const deadline = Date.now() + MAX_QUEUE_WAIT_MS;
  for (;;) {
    const now = Date.now();
    _requestTimestamps = _requestTimestamps.filter((t) => now - t < WINDOW_MS);
    if (_requestTimestamps.length < MAX_RPM) {
      _requestTimestamps.push(now);
      return true;
    }
    const oldest = _requestTimestamps[0];
    const waitMs = Math.max(50, WINDOW_MS - (now - oldest) + 25);
    if (now + waitMs > deadline) return false;
    await _sleep(waitMs);
  }
}

// ============================================================
// TRANSPORTE
// ============================================================

function _headers() {
  return {
    'X-Api-Key': getApiKey(),
    'Content-Type': 'application/json',
    // La doc lo pide explícitamente: evita que los errores vuelvan en HTML.
    Accept: 'application/json'
  };
}

/** Mensajes al usuario final por código de error de 1girox. */
const ERROR_MESSAGES = {
  unauthorized: 'La plataforma rechazó nuestras credenciales. Avisale al soporte.',
  invalid_credentials: 'Usuario o contraseña incorrectos.',
  player_not_found: 'Tu cuenta no existe en la plataforma. Contactá al soporte.',
  insufficient_funds: 'Saldo insuficiente.',
  rollover_locked: 'Tenés un objetivo de apuestas pendiente: todavía no podés retirar ese monto.',
  feature_disabled: 'Esa función no está habilitada en la plataforma.',
  bonus_out_of_range: 'El monto del bono está fuera de los límites permitidos.',
  wallet_not_configured: 'La plataforma está en mantenimiento. Reintentá en unos minutos.'
};

/** Normaliza cualquier error (de red o de la API) a { error, code, httpStatus, retryable }. */
function _normalizeError(e, opLabel) {
  // Error de red / timeout / DNS: sin response.
  if (!e.response) {
    const isTimeout = e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '');
    return {
      error: isTimeout
        ? 'La plataforma está demorada. Reintentá en un momento.'
        : 'No se pudo conectar con la plataforma. Reintentá en un momento.',
      code: e.code || 'network_error',
      httpStatus: null,
      retryable: true,
      detail: `${opLabel}: ${e.code || ''} ${e.message || ''}`.trim()
    };
  }

  const httpStatus = e.response.status;
  const body = e.response.data || {};
  const apiCode = (body.error && body.error.code) || body.code || null;
  const apiMessage = (body.error && body.error.message) || body.message || null;

  // 422 de validación estilo Laravel: { message, errors: {campo: [...]} }
  let validationDetail = null;
  if (httpStatus === 422 && body.errors && typeof body.errors === 'object') {
    validationDetail = Object.entries(body.errors)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join(' | ');
  }

  const friendly =
    ERROR_MESSAGES[apiCode] ||
    apiMessage ||
    validationDetail ||
    `Error de la plataforma (HTTP ${httpStatus}).`;

  return {
    error: friendly,
    code: apiCode || `http_${httpStatus}`,
    httpStatus,
    // 429 y 5xx son transitorios. 503 wallet_not_configured la doc pide reintentarlo
    // con la MISMA reference. 4xx de negocio (saldo, rollover, validación) NO.
    retryable: httpStatus === 429 || httpStatus >= 500,
    retryAfterMs: _parseRetryAfter(e.response.headers),
    detail: `${opLabel}: HTTP ${httpStatus} ${JSON.stringify(body).slice(0, 300)}`,
    body
  };
}

function _parseRetryAfter(headers) {
  if (!headers) return null;
  const raw = headers['retry-after'] || headers['Retry-After'];
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) ? Math.min(secs * 1000, 60000) : null;
}

/**
 * Ejecuta una request contra la Partner API con rate limit + reintentos.
 * Devuelve { ok:true, data } | { ok:false, ...normalizedError }.
 *
 * @param {object} opts
 * @param {'get'|'post'|'put'} opts.method
 * @param {string} opts.path            path relativo, ej. `/players/juan/deposit`
 * @param {object} [opts.body]
 * @param {string} opts.label           etiqueta para los logs
 * @param {boolean} [opts.retryable]    si false, no reintenta (operaciones sin idempotencia)
 */
async function _request({ method, path, body, label, retryable = true }) {
  if (!isEnabled()) {
    logger.error('[girox] GIROX_API_URL / GIROX_API_KEY no configurados');
    return { ok: false, error: 'La plataforma no está configurada. Avisale al soporte.', code: 'not_configured', httpStatus: null };
  }

  const url = `${getBaseUrl()}${path}`;
  let lastErr = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const wait = lastErr && lastErr.retryAfterMs ? lastErr.retryAfterMs : RETRY_DELAYS_MS[attempt - 1];
      logger.warn(`[girox] ${label} — reintento ${attempt}/${RETRY_DELAYS_MS.length} en ${wait}ms (${lastErr && lastErr.code})`);
      await _sleep(wait);
    }

    if (!(await _acquireSlot())) {
      logger.warn(`[girox] ${label} — rate limit local saturado (${MAX_RPM}/min), abortando`);
      return { ok: false, error: 'La plataforma está saturada. Reintentá en un minuto.', code: 'rate_limited_local', httpStatus: null };
    }

    try {
      const resp = await axios({
        method,
        url,
        data: body,
        headers: _headers(),
        timeout: TIMEOUT_MS,
        proxy: false
      });
      return { ok: true, data: resp.data || {}, httpStatus: resp.status };
    } catch (e) {
      lastErr = _normalizeError(e, label);
      // Log sin exponer la key ni la password del body.
      logger.warn(`[girox] ${lastErr.detail}`);
      if (!retryable || !lastErr.retryable || attempt === RETRY_DELAYS_MS.length) {
        return { ok: false, ...lastErr };
      }
    }
  }
  return { ok: false, ...(lastErr || { error: 'Error desconocido', code: 'unknown', httpStatus: null }) };
}

// ============================================================
// HELPERS DE DOMINIO
// ============================================================

/**
 * Reglas de username de 1girox: 3-18 caracteres, sólo letras/números/guion bajo.
 * ⚠️ MIGRACIÓN: hay que correr esto sobre TODA la base antes de migrar — cualquier
 * usuario que no pase NO se puede crear en 1girox y necesita decisión manual.
 * @returns {{valid:boolean, reason?:string}}
 */
function validateUsername(username) {
  const u = String(username || '');
  if (u.length < 3) return { valid: false, reason: 'menos de 3 caracteres' };
  if (u.length > 18) return { valid: false, reason: `${u.length} caracteres (máximo 18)` };
  if (!/^[A-Za-z0-9_]+$/.test(u)) return { valid: false, reason: 'tiene caracteres no permitidos (sólo letras, números y _)' };
  return { valid: true };
}

/** Normaliza el monto a pesos con 2 decimales. Devuelve null si es inválido. */
function _normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100; // 2 decimales, SIN convertir a centavos
}

/**
 * Arma la respuesta de una operación de plata con la MISMA forma que los clientes
 * viejos, para no tocar los 27 call sites que leen data.transfer_id / user_balance_after.
 */
function _moneyResult(data) {
  const op = data.operation || {};
  return {
    success: true,
    duplicate: !!data.duplicate,
    data: {
      // compat: server.js lee `transfer_id || transferId` en todos lados
      transfer_id: op.ledger_id != null ? String(op.ledger_id) : (op.reference || null),
      transferId: op.ledger_id != null ? String(op.ledger_id) : (op.reference || null),
      user_balance_after: data.balance != null ? Number(data.balance) : undefined,
      // datos propios de 1girox
      reference: op.reference || null,
      ledger_id: op.ledger_id != null ? Number(op.ledger_id) : null,
      type: op.type || null,
      created_at: op.created_at || null,
      duplicate: !!data.duplicate,
      wagering: data.wagering || null
    }
  };
}

/** Extrae el desglose de saldo de un objeto `player`. */
function _playerBalances(player) {
  const balance = player.balance != null ? Number(player.balance) : 0;
  const w = player.wagering || null;
  return {
    balance,
    // `available` = lo único RETIRABLE si el feat de rollover está activo.
    // Sin rollover, 1girox no manda `wagering` → disponible == balance.
    available: w && w.available != null ? Number(w.available) : balance,
    // Bloqueado por objetivos de apuesta pendientes.
    locked: w && w.locked != null ? Number(w.locked) : 0,
    bonusLocked: w && w.bonus_locked != null ? Number(w.bonus_locked) : 0,
    // BONOS A RECLAMAR (Partner API v1.7, 2026-07-31): un bono que cumplió su
    // objetivo —o que se otorgó con multiplier 0— YA NO se libera solo. Queda
    // bloqueado hasta que el jugador lo reclama en el casino (el "regalito" del
    // header). Si esto es > 0, el usuario tiene plata esperándolo que no ve en su
    // saldo disponible: conviene avisárselo.
    claimableTotal: w && w.claimable_total != null ? Number(w.claimable_total) : 0,
    claimable: (w && Array.isArray(w.claimable)) ? w.claimable : [],
    wagering: w
  };
}

// ============================================================
// JUGADORES — alta, consulta, credenciales
// ============================================================

/**
 * Crea un jugador en 1girox. POST /players
 * @returns { success, player } | { success:false, error, code, alreadyExists? }
 */
async function createPlatformUser({ username, password }) {
  const check = validateUsername(username);
  if (!check.valid) {
    return { success: false, error: `Usuario inválido para la plataforma: ${check.reason}`, code: 'invalid_username' };
  }
  if (!password || String(password).length < 6) {
    return { success: false, error: 'La contraseña debe tener al menos 6 caracteres', code: 'invalid_password' };
  }

  const r = await _request({
    method: 'post',
    path: '/players',
    body: { username: String(username), password: String(password) },
    label: `createPlayer(${username})`
  });

  if (r.ok) return { success: true, player: (r.data && r.data.player) || null };

  // Username ya tomado → la API lo devuelve como 422 de validación. Lo tratamos como
  // "ya existe" (no es un error para syncUserToPlatform).
  if (r.httpStatus === 422 && /username/i.test(JSON.stringify(r.body || {}))) {
    return { success: false, error: r.error, code: 'username_taken', alreadyExists: true };
  }
  return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
}

/**
 * Consulta un jugador (datos + saldo + desglose de rollover). GET /players/{username}
 * @returns { username, balance, available, wagering, email, active, id } | null si no existe
 */
async function getUserInfoByName(username) {
  const r = await _request({
    method: 'get',
    path: `/players/${encodeURIComponent(String(username))}`,
    label: `getPlayer(${username})`
  });
  if (!r.ok) {
    if (r.code === 'player_not_found' || r.httpStatus === 404) return null;
    return null; // mismo contrato que el cliente viejo: null ante cualquier fallo
  }
  const player = (r.data && r.data.player) || null;
  if (!player) return null;
  const bal = _playerBalances(player);
  return {
    // La Partner API NO devuelve el ID numérico del jugador: el username ES la clave.
    // (El ID existe y hace falta para los reportes de netwin, pero se resuelve contra
    // el panel — ver giroxReportsService.findPlayerIdByUsername.)
    id: null,
    username: player.username || String(username),
    email: player.email || null,
    active: player.active !== false,
    balance: bal.balance,
    available: bal.available,
    locked: bal.locked,
    bonusLocked: bal.bonusLocked,
    claimableTotal: bal.claimableTotal,
    claimable: bal.claimable,
    wagering: bal.wagering,
    createdAt: player.created_at || null
  };
}

/** @returns {boolean} true si el jugador existe en 1girox. */
async function checkUserExists(username) {
  const info = await getUserInfoByName(username);
  return !!info;
}

/**
 * Chequeo de salud REAL contra la Partner API, para diagnóstico.
 *
 * ⚠️ NO usar `getUserInfoByName` para esto: devuelve `null` ante CUALQUIER fallo
 * (404, 401, timeout…), así que un `null` no distingue "el jugador no existe" de
 * "la key fue rechazada". Ese fue exactamente el falso positivo que hizo que el
 * endpoint de health dijera "la key es válida" mientras el alta de usuarios fallaba
 * con 401. Acá se mira el código de error crudo.
 *
 * Consulta un jugador inexistente: la respuesta ESPERADA es 404 player_not_found.
 * @returns { ok, estado, detalle, httpStatus, code }
 */
async function ping() {
  if (!isEnabled()) {
    return { ok: false, estado: 'sin_configurar', detalle: 'Faltan GIROX_API_URL y/o GIROX_API_KEY' };
  }
  const probe = 'zz_probe_' + Date.now().toString(36).slice(-8);
  const r = await _request({
    method: 'get',
    path: `/players/${probe}`,
    label: `ping(${probe})`,
    retryable: false // diagnóstico: queremos la respuesta cruda, sin esperar reintentos
  });

  if (r.ok) {
    return { ok: false, estado: 'inesperado', detalle: 'Devolvió datos para un jugador que no existe' };
  }
  if (r.code === 'player_not_found' || r.httpStatus === 404) {
    return { ok: true, estado: 'ok', detalle: 'La plataforma responde y la API key es válida', httpStatus: r.httpStatus };
  }
  if (r.code === 'unauthorized' || r.httpStatus === 401) {
    return {
      ok: false,
      estado: 'key_rechazada',
      detalle: 'La plataforma respondió, pero RECHAZÓ la API key (401 unauthorized). ' +
        'O la Base URL es de otra instalación, o la key está inactiva/regenerada.',
      httpStatus: r.httpStatus,
      code: r.code
    };
  }
  return { ok: false, estado: 'error', detalle: r.error, httpStatus: r.httpStatus, code: r.code };
}

/**
 * Crea el jugador si no existe; si ya existe, lo reporta como vinculado.
 * Equivalente a jugaygana.syncUserToPlatform, pero SIN jugayganaUserId (1girox va por username).
 * @returns { success, alreadyExists, platformUsername, player } | { success:false, error, code }
 */
async function syncUserToPlatform({ username, password }) {
  const existing = await getUserInfoByName(username);
  if (existing) {
    return { success: true, alreadyExists: true, platformUsername: existing.username, player: existing };
  }
  const created = await createPlatformUser({ username, password });
  if (created.success) {
    return { success: true, alreadyExists: false, platformUsername: username, player: created.player };
  }
  if (created.alreadyExists) {
    return { success: true, alreadyExists: true, platformUsername: username, player: null };
  }
  return { success: false, error: created.error, code: created.code };
}

/**
 * Valida usuario+contraseña contra la plataforma. POST /players/validate
 * Reemplaza a jugayganaService.loginAsUser (que devolvía un token de sesión).
 * OJO: la API responde 200 con { valid:false } cuando la contraseña es incorrecta.
 * @returns { success, valid, player } | { success:false, error, code }
 */
async function validateCredentials(username, password) {
  const r = await _request({
    method: 'post',
    path: '/players/validate',
    body: { username: String(username), password: String(password) },
    label: `validate(${username})`
  });
  if (!r.ok) return { success: false, valid: false, error: r.error, code: r.code };
  return { success: true, valid: !!(r.data && r.data.valid), player: (r.data && r.data.player) || null };
}

/**
 * Cambia la contraseña del jugador sin necesitar su sesión (ya lo autenticamos nosotros).
 * PUT /players/{username}/password — cierra todas sus sesiones abiertas en la plataforma.
 * Reemplaza a jugayganaService.changeUserPasswordAsAdmin.
 * @returns { success } | { success:false, error, code }
 */
async function changeUserPassword(username, newPassword) {
  if (!newPassword || String(newPassword).length < 6) {
    return { success: false, error: 'La contraseña debe tener al menos 6 caracteres', code: 'invalid_password' };
  }
  const r = await _request({
    method: 'put',
    path: `/players/${encodeURIComponent(String(username))}/password`,
    body: { password: String(newPassword) },
    label: `changePassword(${username})`
  });
  if (!r.ok) return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
  return { success: true };
}

// ============================================================
// LOGIN ÚNICO (SSO) — el botón CASINO
// ============================================================

/**
 * Pide un link de acceso directo a la plataforma. POST /players/{username}/session
 *
 * El `redirect_url` lleva un código de UN SOLO USO que vence a los 60 segundos:
 * hay que redirigir al usuario apenas se recibe. NO cachear ni guardar el token.
 *
 * La contraseña es opcional (ya autenticamos al usuario en VIPCARGAS). Sólo se manda
 * si se quiere revalidar.
 *
 * @returns { success, redirectUrl, token } | { success:false, error, code }
 */
async function createSession(username, password = null) {
  const body = {};
  if (password) body.password = String(password);

  const r = await _request({
    method: 'post',
    path: `/players/${encodeURIComponent(String(username))}/session`,
    body,
    label: `session(${username})`,
    // No es idempotente, pero reintentar sólo emite otro código de un uso: es inocuo.
    retryable: true
  });

  if (!r.ok) return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };

  const redirectUrl = r.data && r.data.redirect_url;
  if (!redirectUrl) {
    logger.error(`[girox] session(${username}) — respuesta sin redirect_url: ${JSON.stringify(r.data).slice(0, 200)}`);
    return { success: false, error: 'La plataforma no devolvió el link de acceso.', code: 'no_redirect_url' };
  }
  return { success: true, redirectUrl, token: (r.data && r.data.token) || null };
}

// ============================================================
// PLATA — depósitos, retiros, bonos
// ============================================================
//
// `reference` es la LLAVE DE IDEMPOTENCIA: única por operación. Si se reintenta con
// la misma, 1girox NO duplica (devuelve duplicate:true con la operación original).
// REGLA DE ORO de la doc: ante timeout o error de red, reintentar SIEMPRE con la
// misma reference; nunca generar una nueva para el mismo depósito.
//
// Los call sites deben pasar una reference ESTABLE y persistida (ej. el id de la
// Transaction). Si no se pasa, se genera una acá — cubre los reintentos internos de
// esta llamada, pero NO protege si el usuario/agente reintenta la operación entera.

function _buildReference(prefix, explicit) {
  if (explicit) return String(explicit).slice(0, 100);
  const generated = `${prefix}-${uuidv4()}`;
  logger.warn(`[girox] operación SIN reference estable — se generó ${generated}. ` +
    'Pasar una reference persistida para tener idempotencia real entre requests.');
  return generated;
}

/**
 * Acredita saldo (carga). POST /players/{username}/deposit
 *
 * @param {string} username
 * @param {number} amount        en PESOS (no centavos)
 * @param {string} [description]
 * @param {string} [reference]   llave de idempotencia (RECOMENDADO: id de la Transaction)
 * @param {object} [wagering]    opcional, sólo si el feat "Rollover y Bonos" está activo:
 *                               { multiplier, bonusPercent, bonusAmount, bonusMultiplier }
 * @returns { success, duplicate, data:{ transfer_id, user_balance_after, ... } } | { success:false, error, code }
 */
async function depositToUser(username, amount, description = '', reference = null, wagering = null) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };

  const body = { amount: amt, reference: _buildReference('dep', reference) };
  if (description) body.description = String(description).slice(0, 500);

  if (wagering) {
    if (wagering.multiplier != null) body.multiplier = Number(wagering.multiplier);
    if (wagering.bonusPercent != null) body.bonus_percent = Number(wagering.bonusPercent);
    if (wagering.bonusAmount != null) body.bonus_amount = Number(wagering.bonusAmount);
    if (wagering.bonusMultiplier != null) body.bonus_multiplier = Number(wagering.bonusMultiplier);
  }

  let r = await _request({
    method: 'post',
    path: `/players/${encodeURIComponent(String(username))}/deposit`,
    body,
    label: `deposit(${username}, $${amt}, ref=${body.reference})`
  });

  // RED DE SEGURIDAD — auto-creación del jugador.
  // JUGAYGANA creaba la cuenta sola dentro del depósito, así que un usuario que
  // existía en VIPCARGAS pero no en la plataforma se arreglaba solo en la primera
  // carga. 1girox NO hace eso: devuelve `player_not_found` y la carga falla.
  // Sin esto, cualquier usuario que se haya creado sin llegar a la plataforma (alta
  // vieja, migración incompleta, caída momentánea de la API) queda imposible de
  // cargar, y el cliente transfirió la plata. Se crea al vuelo y se reintenta UNA vez
  // con la MISMA reference (así el reintento sigue siendo idempotente).
  if (!r.ok && r.code === 'player_not_found') {
    logger.warn(`[girox] deposit(${username}) — el jugador no existe en la plataforma; creándolo al vuelo`);
    // Contraseña random: acá no tenemos la del usuario. No lo deja afuera (al casino
    // se entra por SSO) y la real se sincroniza en su próximo login.
    const provisional = crypto.randomBytes(12).toString('base64url');
    const created = await createPlatformUser({ username, password: provisional });
    if (created.success || created.alreadyExists) {
      r = await _request({
        method: 'post',
        path: `/players/${encodeURIComponent(String(username))}/deposit`,
        body,
        label: `deposit-retry(${username}, $${amt}, ref=${body.reference})`
      });
    } else {
      logger.error(`[girox] deposit(${username}) — no se pudo crear al jugador: ${created.error}`);
    }
  }

  if (!r.ok) return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };

  const out = _moneyResult(r.data);
  // Caso excepcional documentado: la carga se acreditó pero el bono no.
  const bonusStatus = r.data && r.data.wagering && r.data.wagering.bonus && r.data.wagering.bonus.status;
  if (bonusStatus === 'failed') {
    logger.error(`[girox] deposit(${username}) — la carga se acreditó pero el BONO falló (ref=${body.reference}). ` +
      'NO reintentar el depósito completo: la reference devolvería duplicate. Escalar a soporte de 1girox.');
    out.bonusFailed = true;
  }
  return out;
}

/**
 * Debita saldo (retiro). POST /players/{username}/withdraw
 * Errores de negocio esperables: insufficient_funds, rollover_locked (422).
 * @returns misma forma que depositToUser
 */
async function withdrawFromUser(username, amount, description = '', reference = null) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };

  const body = { amount: amt, reference: _buildReference('wd', reference) };
  if (description) body.description = String(description).slice(0, 500);

  const r = await _request({
    method: 'post',
    path: `/players/${encodeURIComponent(String(username))}/withdraw`,
    body,
    label: `withdraw(${username}, $${amt}, ref=${body.reference})`
  });

  if (!r.ok) {
    return {
      success: false,
      error: r.error,
      code: r.code,
      httpStatus: r.httpStatus,
      // El body de rollover_locked trae el desglose — útil para el mensaje al usuario.
      wagering: (r.body && r.body.wagering) || null
    };
  }
  return _moneyResult(r.data);
}

/**
 * Acredita un bono / premio / reembolso.
 *
 * Por defecto usa el endpoint de DEPÓSITO sin multiplier (carga libre) — es el
 * equivalente exacto del `individual_bonus` de JUGAYGANA que se usaba para reembolsos,
 * premios de ruleta, fueguito y bono de instalación. La plata queda jugable Y retirable
 * al instante, que es como funcionaba hasta ahora.
 *
 * ⚠️ NO USAR `/bonus` PARA ESTOS FLUJOS (Partner API v1.7, 2026-07-31): desde esa
 * versión, un bono otorgado por `POST /players/{username}/bonus` NO se libera solo — ni
 * siquiera con `multiplier: 0`. Queda BLOQUEADO hasta que el jugador entre al casino y
 * lo RECLAME (aparece en `wagering.claimable`, es el "regalito" del header). Para un
 * reembolso o un premio de ruleta eso sería un cambio de comportamiento fuerte: el
 * usuario vería el mensaje "¡reembolso acreditado!" pero no la plata en su saldo.
 * Por eso el default es depósito libre.
 *
 * Si algún día se quiere el bono con objetivo de apuestas (para que el regalo pida al
 * menos una vuelta de juego antes de poder retirarse), se pasa `opts.multiplier` y ahí
 * sí usa `/bonus`. ⚠️ Ojo además con "bono sobre bono": otorgarle un bono a alguien que
 * ya tiene uno activo PISA el anterior y le debita lo que le quede del viejo.
 *
 * @returns misma forma que depositToUser
 */
async function creditUserBalance(username, amount, reference = null, opts = {}) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };

  // Bono con rollover propio (feat opcional)
  if (opts && opts.multiplier != null) {
    const body = {
      amount: amt,
      multiplier: Number(opts.multiplier),
      reference: _buildReference('bonus', reference)
    };
    // El endpoint /bonus no documenta `description`, pero se manda igual para que el
    // historial de la plataforma no quede sin contexto (un campo extra se ignora).
    // Sin esto, la descripción se perdía sólo en esta rama y no en la de depósito.
    if (opts.description) body.description = String(opts.description).slice(0, 500);
    const r = await _request({
      method: 'post',
      path: `/players/${encodeURIComponent(String(username))}/bonus`,
      body,
      label: `bonus(${username}, $${amt}, x${body.multiplier}, ref=${body.reference})`
    });
    if (!r.ok) return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
    return _moneyResult(r.data);
  }

  // Bono libre = depósito sin rollover (comportamiento por defecto)
  return depositToUser(username, amt, opts.description || '', _buildReference('bonus', reference));
}

// ============================================================
// SALDO
// ============================================================

/**
 * @returns { success, balance, available, username, wagering } | { success:false, error, code }
 */
async function getUserBalance(username) {
  const info = await getUserInfoByName(username);
  if (!info) {
    return { success: false, error: 'No se pudo leer el saldo en la plataforma.', code: 'player_not_found' };
  }
  return {
    success: true,
    username: info.username,
    balance: info.balance,
    // ⚠️ Para VALIDAR RETIROS hay que usar `available`, no `balance`: con el feat de
    // rollover activo (lo está), el jugador puede tener saldo que todavía no puede
    // retirar. Si se valida contra `balance`, la plataforma rechaza el retiro con
    // `rollover_locked` y queda un retiro colgado en el panel.
    available: info.available,
    locked: info.locked,
    bonusLocked: info.bonusLocked,
    claimableTotal: info.claimableTotal,
    wagering: info.wagering
  };
}

/**
 * Igual que getUserBalance pero con reintentos. Se conserva por compatibilidad con
 * los 8 call sites que lo usan; el backoff real ya vive en _request, así que acá los
 * intentos extra sólo cubren el caso "player_not_found transitorio".
 */
async function getUserBalanceWithRetry(username, { maxAttempts = 3, baseDelayMs = 500 } = {}) {
  let last = null;
  for (let i = 1; i <= maxAttempts; i++) {
    last = await getUserBalance(username);
    if (last.success) return last;
    if (i < maxAttempts) await _sleep(baseDelayMs * Math.pow(2, i - 1));
  }
  return { ...last, attemptsExhausted: true };
}

// ============================================================
// NO DISPONIBLE EN LA PARTNER API
// ============================================================

/**
 * Historial de movimientos por rango de fechas.
 * ❌ La Partner API v1.4 de 1girox NO expone este endpoint (lo usaba GET /api/movements
 * contra `ShowUserMovements` de JUGAYGANA). Queda explícito y falla claro en vez de
 * romper con un TypeError.
 */
async function getUserMovements() {
  return {
    success: false,
    error: 'El historial de movimientos no está disponible en la plataforma nueva.',
    code: 'not_supported'
  };
}

module.exports = {
  // config
  isEnabled,
  getPlayUrl,
  getBaseUrl,
  validateUsername,
  // jugadores
  createPlatformUser,
  getUserInfoByName,
  checkUserExists,
  ping,
  syncUserToPlatform,
  validateCredentials,
  changeUserPassword,
  // SSO
  createSession,
  // plata
  depositToUser,
  withdrawFromUser,
  creditUserBalance,
  // saldo
  getUserBalance,
  getUserBalanceWithRetry,
  // no soportado
  getUserMovements
};
