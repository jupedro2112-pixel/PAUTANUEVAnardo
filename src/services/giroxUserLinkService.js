/**
 * giroxUserLinkService.js — Vinculación automática de `User.giroxUserId`.
 *
 * Espejo de `jugayganaUserLinkService.js`, pero para 1girox. Resuelve el ID
 * numérico del jugador en 1girox cuando falta (usuarios viejos / migrados) y lo
 * persiste en la base local (backfill al vuelo).
 *
 * ⚠️ POR QUÉ HACE FALTA UN ID SI 1girox VA POR USERNAME: la Partner API
 * (`giroxService.js`) trabaja SÓLO con el username y nunca devuelve un ID. Pero
 * el panel de reportes —de donde sale el netwin para REEMBOLSOS y COMISIONES DE
 * REFERIDOS— exige `player_id` numérico. Sin este ID no se le puede calcular el
 * reembolso a ese usuario (ver giroxReportsService.getPlayerNetwinForDateRange).
 *
 * Reglas de seguridad (idénticas a las del servicio de JUGAYGANA):
 * - Sólo completa si el campo está vacío/null.
 * - Sólo persiste si el match del nombre es EXACTO (case-insensitive).
 * - Nunca sobrescribe un ID válido existente (update condicional → sin races).
 * - Si no hay match confiable, devuelve null SIN escribir nada.
 *
 * ⚠️ EL BUSCADOR DEL PANEL HACE "LIKE": buscar "prueba1" trae prueba1, prueba100,
 * prueba12… `findPlayerIdByUsername` ya exige coincidencia exacta internamente,
 * pero acá se REVALIDA. Un ID equivocado significa pagarle el reembolso a otra
 * persona: la doble verificación es barata y el error es caro.
 */

const { User } = require('../models');
const giroxReportsService = require('./giroxReportsService');
const logger = require('../utils/logger');

/**
 * Obtener el giroxUserId de un usuario, completándolo automáticamente si todavía
 * no está cargado.
 *
 * @param {string} userId   - ID interno del usuario en la base local
 * @param {string} username - Username del usuario (el mismo en VIPCARGAS y 1girox)
 * @returns {Promise<number|null>} giroxUserId resuelto, o null si no se pudo determinar
 */
async function resolveGiroxUserId(userId, username) {
  // 1. Leer el campo actual de la base
  let userDoc = null;
  try {
    userDoc = await User.findOne({ id: userId }).select('giroxUserId').lean();
  } catch (err) {
    logger.error(`[GiroxUserLink] Error leyendo el usuario local | user=${username} (id=${userId}): ${err.message}`);
    return null;
  }

  const existing = userDoc?.giroxUserId ?? null;
  if (existing) {
    return existing;
  }

  // 2. Campo vacío: backfill al vuelo buscando en el panel de 1girox por username
  logger.info(
    `[GiroxUserLink] giroxUserId faltante para user=${username} (id=${userId}). Intentando backfill al vuelo…`
  );

  let found = null;
  try {
    found = await giroxReportsService.findPlayerIdByUsername(username);
  } catch (err) {
    logger.error(
      `[GiroxUserLink] Error buscando el jugador en 1girox | user=${username}: ${err.message}`
    );
    return null;
  }

  if (!found || !found.success || !found.id) {
    logger.warn(
      `[GiroxUserLink] Jugador no encontrado en 1girox | user=${username} ` +
      `(code=${found?.code || 'sin_respuesta'}). No se puede completar giroxUserId.`
    );
    return null;
  }

  // 3. Revalidar la coincidencia EXACTA del nombre antes de persistir.
  //    findPlayerIdByUsername ya lo filtra, pero el buscador del panel es un LIKE:
  //    si algún día ese filtro se afloja, acá se corta igual. Un ID equivocado =
  //    reembolso pagado a otra persona.
  const remoteUsername = String(found.name || '').toLowerCase().trim();
  const localUsername = String(username || '').toLowerCase().trim();

  if (!remoteUsername || remoteUsername !== localUsername) {
    logger.error(
      `[GiroxUserLink] Match NO confiable: local="${localUsername}" vs 1girox="${remoteUsername}" ` +
      `(id=${found.id}). NO se persiste giroxUserId para user=${username}.`
    );
    return null;
  }

  const resolvedId = Number(found.id);
  if (!Number.isFinite(resolvedId) || resolvedId <= 0) {
    logger.warn(`[GiroxUserLink] ID inválido devuelto por el panel (${found.id}) | user=${username}`);
    return null;
  }

  // 4. Persistir SÓLO si el campo sigue vacío (evita pisar un ID que otra request
  //    concurrente ya haya resuelto).
  try {
    const updateResult = await User.updateOne(
      { id: userId, $or: [{ giroxUserId: null }, { giroxUserId: { $exists: false } }] },
      {
        $set: {
          giroxUserId: resolvedId,
          giroxSyncStatus: 'linked'
        }
      }
    );

    if (updateResult.modifiedCount > 0) {
      logger.info(
        `[GiroxUserLink] giroxUserId completado automáticamente | user=${username} giroxUserId=${resolvedId}`
      );
    } else {
      logger.info(
        `[GiroxUserLink] giroxUserId ya estaba cargado (sin cambios) | user=${username}`
      );
    }
  } catch (saveErr) {
    logger.error(
      `[GiroxUserLink] Error al persistir giroxUserId | user=${username}: ${saveErr.message}`
    );
    // Devolvemos el ID resuelto igual para no bloquear el flujo en curso.
  }

  return resolvedId;
}

module.exports = { resolveGiroxUserId };
