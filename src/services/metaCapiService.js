// ============================================
// META CONVERSIONS API (CAPI) SERVICE
// --------------------------------------------
// Envía eventos server-side a Meta para complementar el pixel del navegador.
// Mejora la precisión bajo iOS / adblockers y permite deduplicar con event_id.
//
// Variables de entorno requeridas:
//   META_PIXEL_ID                 — ID numérico del Pixel
//   META_CAPI_ACCESS_TOKEN        — Token de acceso CAPI (Eventos → Configuración → Conversions API)
//   META_TEST_EVENT_CODE          — (opcional) código de Test Events para validar antes de prod
//
// 2º PIXEL OPCIONAL (partner de tracking, 2026-08-19): cuando un tercero (ej. la
// pauta) pide recibir los MISMOS eventos server-side en SU pixel, se cargan estas
// y TODOS los eventos se disparan también a su pixel, en paralelo, sin tocar código:
//   META_PIXEL_ID_2               — Pixel ID del partner
//   META_CAPI_ACCESS_TOKEN_2      — Access Token CAPI del partner
//   META_TEST_EVENT_CODE_2        — (opcional) su código de Test Events para verificar
//
// ALCANCE POR PUBLICISTA (owner 2026-08-28): cada slot de partner puede llevar
//   META_PIXEL_PUBLISHER_N — a quién pertenece ese pixel: nombre del publicista
//                            (Campaign.publisher) y/o códigos de campaña, separados
//                            por coma, sin distinguir mayúsculas. Ej: `OneKey` o
//                            `OneKey,PWAUTO`. Con esto el slot recibe SOLO los
//                            eventos de usuarios de ESE publicista (y el pixel del
//                            navegador de la landing solo se inicializa para sus
//                            campañas). Un slot SIN publicista asignado se comporta
//                            como antes (recibe todo) — así nada se rompe hasta
//                            asignarlo.
//
// Si no hay ningún pixel configurado, el módulo queda en no-op (warning una vez).
// Nunca lanza ni bloquea el flujo de negocio: errores se loguean como warning.
// ============================================

const crypto = require('crypto');
const axios = require('axios');

let logger = console;
try { logger = require('../utils/logger') || console; } catch (e) { /* fallback */ }

const GRAPH_API_VERSION = 'v22.0';
let _missingConfigLogged = false;

// Un valor "vacío/apagado": SSM no permite guardar '' → se puede dejar el
// parámetro creado con `off` (o '-') como placeholder y activarlo después
// cambiando solo el valor. Mismo criterio que HGCASH_FANOUT_URL=off.
function _capiActive(v) {
  const s = String(v || '').trim().toLowerCase();
  return s && s !== 'off' && s !== '-' && s !== 'pendiente' && s !== 'placeholder';
}

// Destinos del CAPI: el pixel propio + un 2º OPCIONAL (partner). Se lee en cada
// envío (las env de SSM cargan en el bootstrap async, después del require).
function _capiDestinations() {
  const dests = [];
  if (_capiActive(process.env.META_PIXEL_ID) && _capiActive(process.env.META_CAPI_ACCESS_TOKEN)) {
    dests.push({ label: 'propio', pixelId: process.env.META_PIXEL_ID, token: process.env.META_CAPI_ACCESS_TOKEN, testCode: process.env.META_TEST_EVENT_CODE });
  }
  // Pixels de PARTNERS (publicistas de tracking): numerados _2, _3, _4… _9.
  // Cada uno con su token y su test code OPCIONAL propio → cada publicista ve
  // los eventos en SU Events Manager con SU código de "Probar eventos", sin
  // pisarse entre ellos (2 publicistas probando a la vez = _2 y _3).
  // Un slot con valor `off`/`-`/`pendiente` se SALTEA (placeholder para llenar
  // después) → sin requests fallidos ni ruido en los logs.
  for (let i = 2; i <= 9; i++) {
    const pid = process.env['META_PIXEL_ID_' + i];
    const tok = process.env['META_CAPI_ACCESS_TOKEN_' + i];
    if (_capiActive(pid) && _capiActive(tok)) {
      dests.push({
        label: 'partner' + i, pixelId: pid, token: tok, testCode: process.env['META_TEST_EVENT_CODE_' + i],
        scope: _parseScope(process.env['META_PIXEL_PUBLISHER_' + i])
      });
    }
  }
  return dests;
}

// META_PIXEL_PUBLISHER_N → lista normalizada (minúsculas, sin espacios) de
// publicistas y/o códigos de campaña. [] = sin asignar (recibe todo).
function _parseScope(v) {
  if (!_capiActive(v)) return [];
  return String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}
function _scopeAllows(dest, scope) {
  if (!dest.scope || !dest.scope.length) return true; // slot sin asignar → todo
  if (!scope) return false;                            // asignado, evento sin dueño → no
  const pub = scope.publisher ? String(scope.publisher).trim().toLowerCase() : '';
  const code = scope.campaignCode ? String(scope.campaignCode).trim().toLowerCase() : '';
  return (pub && dest.scope.includes(pub)) || (code && dest.scope.includes(code));
}

// ---- Resolución del "dueño" de un evento (publicista + campaña) ----
// Lookup lazy (los modelos ya están registrados por el server). Cache corto para
// no pegarle a Mongo en cada evento. Orden para el usuario: última campaña por
// la que volvió (last-touch #228) → campaña de alta → campaña dueña de la key.
const _campaignPubCache = new Map(); // code → { publisher, ts }
const CAMPAIGN_CACHE_MS = 5 * 60 * 1000;
async function _publisherOfCampaign(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const hit = _campaignPubCache.get(c);
  if (hit && Date.now() - hit.ts < CAMPAIGN_CACHE_MS) return hit.publisher;
  let publisher = null;
  try {
    const Campaign = require('../models/Campaign');
    const doc = await Campaign.findOne({ code: c }).select('publisher').lean();
    publisher = doc && doc.publisher ? String(doc.publisher) : null;
  } catch (_) {}
  _campaignPubCache.set(c, { publisher, ts: Date.now() });
  return publisher;
}
// Devuelve { publisher, campaignCode } o null. Acepta opts.publisher /
// opts.campaignCode explícitos (evita el lookup) o resuelve por el usuario.
async function resolveEventScope(userInfo, opts) {
  const o = opts || {};
  if (o.publisher || o.campaignCode) {
    const publisher = o.publisher || await _publisherOfCampaign(o.campaignCode);
    return { publisher: publisher || null, campaignCode: o.campaignCode || null };
  }
  const userId = userInfo && userInfo.externalId != null ? String(userInfo.externalId) : null;
  if (!userId) return null;
  try {
    const User = require('../models/User');
    const u = await User.findOne({ id: userId }).select('lastTouchCampaign acquisitionCampaign giroxOwnerCampaign').lean();
    if (!u) return null;
    const code = u.lastTouchCampaign || u.acquisitionCampaign || u.giroxOwnerCampaign || null;
    if (!code) return null;
    return { publisher: await _publisherOfCampaign(code), campaignCode: code };
  } catch (_) { return null; }
}

// Pixel IDs para el pixel del NAVEGADOR de la landing según la campaña del
// visitante: el propio siempre + los partners cuyo alcance incluye a esa
// campaña/publicista + los partners SIN asignar (compatibilidad). Sin campaña
// (tráfico orgánico) → propio + sin asignar.
async function pixelIdsForCampaign(campaignCode) {
  const scope = campaignCode
    ? { publisher: await _publisherOfCampaign(campaignCode), campaignCode: String(campaignCode).trim() }
    : null;
  const ids = [];
  if (_capiActive(process.env.META_PIXEL_ID)) ids.push(String(process.env.META_PIXEL_ID).trim());
  for (let i = 2; i <= 9; i++) {
    const pid = process.env['META_PIXEL_ID_' + i];
    if (!_capiActive(pid)) continue;
    const dest = { scope: _parseScope(process.env['META_PIXEL_PUBLISHER_' + i]) };
    if (_scopeAllows(dest, scope)) ids.push(String(pid).trim());
  }
  return ids;
}

function isConfigured() {
  return _capiDestinations().length > 0;
}

function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim().toLowerCase();
  if (!str) return undefined;
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Normaliza teléfono a sólo dígitos antes de hashear (requisito de Meta).
// Fix móviles AR: los formularios suelen guardar el celular sin el "9" móvil
// (ej: +54 11 2275-5331 → 541122755331), pero Facebook/WhatsApp almacenan los
// móviles AR con el "9" intercalado (5491122755331). Sin esa corrección los
// hashes nunca matchean y el Custom Audience pierde a casi todos los usuarios.
// La heurística es conservadora: sólo agrega el 9 si el número tiene 12
// dígitos, empieza con 54, y no tiene ya un 9 móvil. Cualquier otro país o
// fijo internacional queda intacto. Único falso positivo posible: un fijo
// AMBA de 12 dígitos — aceptable porque la app es de cargas/apuestas y el
// 99% de los teléfonos cargados son celulares.
function normalizePhone(phone) {
  if (!phone) return undefined;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 12 && digits.startsWith('54') && digits[2] !== '9') {
    digits = '549' + digits.slice(2);
  }
  return digits;
}

function newEventId() {
  return crypto.randomUUID();
}

// Construye el bloque user_data hasheando PII según especificación de Meta.
// userInfo: { email, phone, externalId, firstName, lastName, country, city, gender, dateOfBirth }
// requestCtx: { ip, userAgent, fbp, fbc }
function buildUserData(userInfo = {}, requestCtx = {}) {
  const user_data = {};

  const emailHash = sha256(userInfo.email);
  if (emailHash) user_data.em = [emailHash];

  const phoneHash = sha256(normalizePhone(userInfo.phone));
  if (phoneHash) user_data.ph = [phoneHash];

  const externalIdHash = sha256(userInfo.externalId);
  if (externalIdHash) user_data.external_id = [externalIdHash];

  const fnHash = sha256(userInfo.firstName);
  if (fnHash) user_data.fn = [fnHash];

  const lnHash = sha256(userInfo.lastName);
  if (lnHash) user_data.ln = [lnHash];

  const countryHash = sha256(userInfo.country);
  if (countryHash) user_data.country = [countryHash];

  const cityHash = sha256(userInfo.city);
  if (cityHash) user_data.ct = [cityHash];

  const genderHash = sha256(userInfo.gender);
  if (genderHash) user_data.ge = [genderHash];

  const dobHash = sha256(userInfo.dateOfBirth);
  if (dobHash) user_data.db = [dobHash];

  // IP / user-agent: se prioriza el REQUEST (evento del propio navegador del
  // jugador). En eventos server-side disparados por un ADMIN (ej. Purchase de
  // una carga manual) NO hay que usar la IP/UA del admin — se pasa la del
  // JUGADOR persistida (userInfo.clientIp / clientUserAgent, de su registro).
  // Enviar la del admin baja la calidad de coincidencia de Meta (matchea a otra
  // persona). owner 2026-08-24.
  const clientIp = requestCtx.ip || userInfo.clientIp;
  const clientUa = requestCtx.userAgent || userInfo.clientUserAgent;
  if (clientIp) user_data.client_ip_address = clientIp;
  if (clientUa) user_data.client_user_agent = clientUa;
  // fbp / fbc — identificadores de Meta Ads (fbp = navegador, fbc = clic del
  // anuncio, clave para atribuir conversiones a la pauta).
  // Prioridad: la cookie viva del request (eventos browser-side / self-service).
  // Fallback: el valor persistido en el usuario (userInfo.fbc / userInfo.fbp).
  // El fallback es imprescindible para eventos server-side como Purchase
  // disparado desde un request de admin, donde la cookie del jugador no existe
  // en req.headers.cookie.
  const fbp = requestCtx.fbp || userInfo.fbp;
  const fbc = requestCtx.fbc || userInfo.fbc;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  return user_data;
}

// Extrae fbp/fbc/ip/userAgent de una request Express.
function extractRequestContext(req) {
  if (!req) return {};
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return {
    ip: req.ip || (req.headers && req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) || null,
    userAgent: req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']) : null,
    fbp: cookies._fbp || null,
    fbc: cookies._fbc || null
  };
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  });
  return out;
}

// Envía un evento a Conversions API. Nunca lanza.
// args:
//   eventName       — string ('Purchase', 'CompleteRegistration', 'Lead', etc. o custom)
//   userInfo        — datos del usuario (se hashea internamente)
//   customData      — { value, currency, content_name, ... } pasado tal cual a Meta
//   options         — { eventId, eventSourceUrl, actionSource, testEventCode, req }
// Qué eventos recibe un PIXEL DE PARTNER (publicista). Decisión del owner
// (2026-08-21): solo el ALTA y la PRIMERA carga (FTD) — nada de retiros ni
// cargas siguientes. El pixel PROPIO sí recibe todo (para optimización propia).
// El Purchase de la primera carga se marca con opts.firstDeposit=true desde el
// call site (la carga sabe si es el primer depósito del cliente).
function _partnerAllows(eventName, opts) {
  if (eventName === 'CompleteRegistration') return true;
  if (eventName === 'Purchase' && opts && opts.firstDeposit === true) return true;
  return false;
}

async function sendEvent(eventName, userInfo, customData, options) {
  const allDests = _capiDestinations();
  if (!allDests.length) {
    if (!_missingConfigLogged) {
      _missingConfigLogged = true;
      logger.warn('[MetaCAPI] META_PIXEL_ID o META_CAPI_ACCESS_TOKEN no configurados — eventos server-side deshabilitados');
    }
    return { sent: false, reason: 'not_configured' };
  }

  if (!eventName || typeof eventName !== 'string') {
    return { sent: false, reason: 'invalid_event' };
  }

  const opts = options || {};

  // Filtro por destino: el pixel propio recibe TODO; los de partner solo alta +
  // primera carga (#221) Y solo de usuarios de SU publicista/campaña (#250, si el
  // slot tiene META_PIXEL_PUBLISHER_N). Si un evento no va para ningún destino,
  // no se manda nada. El scope se resuelve una sola vez (y solo si hay algún
  // partner con alcance asignado, para no consultar Mongo al pedo).
  const _needScope = allDests.some((d) => d.label !== 'propio' && d.scope && d.scope.length);
  const scope = _needScope ? await resolveEventScope(userInfo, opts) : null;
  const dests = allDests.filter((d) =>
    d.label === 'propio' ? true : (_partnerAllows(eventName, opts) && _scopeAllows(d, scope))
  );
  if (!dests.length) {
    return { sent: false, reason: 'filtered_for_all_destinations' };
  }
  const req = opts.req || null;
  const requestCtx = extractRequestContext(req);

  const user_data = buildUserData(userInfo || {}, requestCtx);

  // El MISMO event_id para todos los destinos (cada pixel deduplica por su lado).
  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: opts.eventId || newEventId(),
    action_source: opts.actionSource || 'website',
    user_data,
    custom_data: customData || {}
  };

  if (opts.eventSourceUrl) {
    event.event_source_url = opts.eventSourceUrl;
  } else if (req && req.headers && req.headers.referer) {
    event.event_source_url = String(req.headers.referer);
  }

  // Diagnóstico PRIVADO (solo admin): guarda en la base qué user_data se envió,
  // para comparar registro vs compra sin depender del número agregado de Meta.
  // Fire-and-forget: nunca bloquea ni rompe el envío. TTL 14d (en el modelo).
  // Se apaga con META_EVENT_LOG_DISABLED=true.
  if (process.env.META_EVENT_LOG_DISABLED !== 'true') {
    try {
      const MetaEventLog = require('../models/MetaEventLog');
      const cd = customData || {};
      MetaEventLog.create({
        eventId: event.event_id,
        eventName,
        userId: (userInfo && userInfo.externalId != null) ? String(userInfo.externalId) : null,
        em: user_data.em ? String(user_data.em[0]).slice(0, 10) : null,
        ph: user_data.ph ? String(user_data.ph[0]).slice(0, 10) : null,
        external_id: user_data.external_id ? String(user_data.external_id[0]).slice(0, 10) : null,
        fbc: user_data.fbc || null,
        fbp: user_data.fbp || null,
        ip: user_data.client_ip_address || null,
        ua: user_data.client_user_agent ? String(user_data.client_user_agent).slice(0, 500) : null,
        value: (cd.value != null && !isNaN(Number(cd.value))) ? Number(cd.value) : null,
        currency: cd.currency || null,
        contentName: cd.content_name || null,
        destinations: dests.map((d) => d.label)
      }).catch(() => {});
    } catch (_) { /* el diagnóstico nunca rompe el envío */ }
  }

  // Se dispara a CADA pixel configurado (propio + partner) en paralelo. Un fallo
  // en uno no afecta al otro. Cada destino usa su propio test_event_code.
  const results = await Promise.all(dests.map(async (d) => {
    const payload = { data: [event] };
    const tc = opts.testEventCode || d.testCode;
    if (tc) payload.test_event_code = tc;
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${d.pixelId}/events`;
    try {
      const response = await axios.post(url, payload, {
        params: { access_token: d.token },
        timeout: 5000
      });
      return { dest: d.label, sent: true, data: response.data };
    } catch (err) {
      const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
      logger.warn(`[MetaCAPI] Error enviando evento ${eventName} a pixel ${d.label}: ${detail}`);
      return { dest: d.label, sent: false, error: detail };
    }
  }));

  return { sent: results.some((r) => r.sent), eventId: event.event_id, results };
}

// Fire-and-forget. Útil para no bloquear el response del endpoint.
function track(eventName, userInfo, customData, options) {
  return sendEvent(eventName, userInfo, customData, options).catch((e) => {
    logger.warn(`[MetaCAPI] track() fallo no esperado: ${e.message}`);
    return { sent: false, reason: 'unexpected', error: e.message };
  });
}

// ============================================
// ADVANCED MATCHING (browser pixel)
// --------------------------------------------
// Devuelve los hashes precalculados que el frontend pasa a `fbq('init', ID, {...})`
// para que cada evento browser-side incluya identificadores hasheados del usuario.
// Mantiene la normalización en un solo lugar (este archivo) y evita exponer PII
// en cleartext al cliente. `country` default 'ar' porque el negocio opera en AR.
// `external_id` se hashea para consistencia con los eventos server-side; Meta
// acepta tanto hasheado como en texto plano.
// ============================================
function buildAdvancedMatching(userInfo) {
  if (!userInfo) return null;
  const matching = {};
  const em = sha256(userInfo.email);
  if (em) matching.em = em;
  const ph = sha256(normalizePhone(userInfo.phone));
  if (ph) matching.ph = ph;
  const ext = sha256(userInfo.externalId);
  if (ext) matching.external_id = ext;
  const fn = sha256(userInfo.firstName);
  if (fn) matching.fn = fn;
  const ln = sha256(userInfo.lastName);
  if (ln) matching.ln = ln;
  const country = sha256(userInfo.country || 'ar');
  if (country) matching.country = country;
  return Object.keys(matching).length ? matching : null;
}

// ============================================
// VALUE BUCKETS (Purchase content_category)
// --------------------------------------------
// Buckets de monto para alimentar Value Optimization de Meta Ads. Los umbrales
// están pensados para cargas en ARS — si cambia la moneda, recalibrar.
// ============================================
function valueCategory(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n < 5000) return 'low';
  if (n < 20000) return 'medium';
  if (n < 50000) return 'high';
  return 'whale';
}

module.exports = {
  isConfigured,
  newEventId,
  extractRequestContext,
  buildUserData, // expuesto para la vista previa admin (qué user_data llevaría un evento)
  sendEvent,
  track,
  buildAdvancedMatching,
  valueCategory,
  pixelIdsForCampaign,
  resolveEventScope
};
