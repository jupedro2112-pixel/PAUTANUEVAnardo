#!/usr/bin/env node
// =============================================================================
// MIGRACIÓN DE USUARIOS A 1GIROX
// =============================================================================
// Crea en 1girox (plataforma NUEVA) una cuenta para cada usuario local con
// role:'user', y le guarda el ID numérico de jugador en `User.giroxUserId`.
//
// Por qué hace falta el ID: la Partner API trabaja SÓLO por username, pero el
// panel de reportes —de donde sale el netwin— exige `player_id`. SIN ESE ID NO
// SE PUEDE CALCULAR EL REEMBOLSO NI LA COMISIÓN DE REFERIDOS de ese usuario.
// Por eso el script no se conforma con crear la cuenta: resuelve y persiste el ID.
//
// -----------------------------------------------------------------------------
// ⚠️ LAS CONTRASEÑAS NO SE PUEDEN MIGRAR (y no pasa nada)
// -----------------------------------------------------------------------------
// Las claves locales están hasheadas con bcrypt (`User.password`): son
// IRRECUPERABLES por diseño, no hay forma de leer el texto plano. Por eso cada
// cuenta se crea en 1girox con una contraseña random fuerte (crypto.randomBytes)
// que NO se guarda en ningún lado, y el usuario queda con
// `giroxPasswordSynced:false`.
//
// Esto NO deja a nadie afuera: al casino se entra por SSO (POST
// /players/{username}/session → link de un solo uso), nunca tipeando la clave de
// 1girox. La contraseña real se replica en el próximo login o cambio de clave del
// usuario en VIPCARGAS, y ahí `giroxPasswordSynced` pasa a true.
//
// -----------------------------------------------------------------------------
// USO
// -----------------------------------------------------------------------------
//   # 1) Ensayo (NO escribe nada, ni en Mongo ni en 1girox). ES EL DEFAULT.
//   node scripts/migrate-users-to-girox.js
//
//   # 2) Prueba real con pocos usuarios antes de largar las horas de corrida
//   node scripts/migrate-users-to-girox.js --execute --limit=5
//
//   # 3) Migración completa
//   node scripts/migrate-users-to-girox.js --execute
//
//   # 4) Reintentar SÓLO los que quedaron en 'error'
//   node scripts/migrate-users-to-girox.js --execute --retry-errors
//
// FLAGS
//   (ninguno) / --dry-run  Simula: no escribe en Mongo ni crea nada en 1girox.
//                          ES EL DEFAULT: para escribir hay que pedirlo explícito.
//   --execute              Escribe de verdad (Mongo + alta en 1girox).
//   --retry-errors         Procesa SÓLO los usuarios en giroxSyncStatus:'error'.
//   --limit=N              Procesa como mucho N usuarios (para pruebas / tandas).
//   --username=xxx         Procesa un solo usuario puntual (para probar el flujo).
//   Un argumento desconocido ABORTA el script: nunca se cae a "ejecutar igual".
//
// VARIABLES DE ENTORNO
//   MONGODB_URI            (obligatoria) misma base que usa el server.
//   GIROX_API_URL          (obligatoria con --execute) base de la Partner API.
//   GIROX_API_KEY          (obligatoria con --execute) header X-Api-Key.
//   GIROX_ADMIN_BASE_URL   panel (default https://admin.1girox.com) → resolver ID.
//   GIROX_ADMIN_USER       (obligatoria con --execute) usuario del panel.
//   GIROX_ADMIN_PASS       (obligatoria con --execute) contraseña del panel.
//   GIROX_MIGRATION_DELAY_MS        ms de espera entre usuarios (default 2500).
//   GIROX_MIGRATION_PROGRESS_EVERY  cada cuántos usuarios imprime avance (default 25).
//   GIROX_MIGRATION_RATE_WAIT_MS    espera ante un 429 (default 65000).
//
// -----------------------------------------------------------------------------
// THROTTLING — por qué tarda horas (y por qué está bien)
// -----------------------------------------------------------------------------
// La Partner API permite 60 requests/minuto y cada usuario consume hasta 3 llamadas
// (existe? + alta + búsqueda del ID en el panel). El techo real es ~20-30 usuarios
// por minuto. El delay default de 2500ms deja ~24 usuarios/min.
//
// ⚠️ ESE LÍMITE ES COMPARTIDO CON PRODUCCIÓN: mientras esto corre, el server sigue
// pidiendo saldos, cargas y retiros contra la misma cuota. Conviene correrlo en
// horario de poco movimiento y, si aparecen 429 seguidos, SUBIR el delay
// (GIROX_MIGRATION_DELAY_MS=4000) en vez de bajarlo. Es preferible que tarde el
// doble a que se corte a la mitad o a que un cliente no pueda cargar.
//
// -----------------------------------------------------------------------------
// IDEMPOTENTE Y REANUDABLE
// -----------------------------------------------------------------------------
// El estado vive en Mongo (`giroxSyncStatus` / `giroxUserId`), no en un archivo:
// si se corta (Ctrl+C, caída, deploy), se vuelve a correr el mismo comando y sigue
// donde quedó. Nunca duplica: los ya 'synced'/'linked' CON ID se saltean, y para
// los que tienen la cuenta creada pero les faltó el ID, sólo se reintenta el ID.
// Ctrl+C corta limpio: termina el usuario en curso y recién ahí imprime el reporte.
//
// ⚠️ NO TOCA `jugayganaUserId` / `jugayganaUsername` / `jugayganaSyncStatus`: se
// conservan intactos para poder revertir la migración.
// =============================================================================

const crypto = require('crypto');
const mongoose = require('mongoose');
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ silent: true });

const giroxService = require('../src/services/giroxService');
const giroxReportsService = require('../src/services/giroxReportsService');

// =============================================================================
// ARGUMENTOS
// =============================================================================

const KNOWN_FLAGS = ['--dry-run', '--execute', '--retry-errors'];
const KNOWN_OPTS = ['--limit', '--username'];

function parseArgs(argv) {
  const out = { dryRun: true, retryErrors: false, limit: 0, username: null };
  for (const arg of argv) {
    const [key, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];

    if (KNOWN_FLAGS.includes(key) && value === null) {
      if (key === '--execute') out.dryRun = false;
      if (key === '--dry-run') out.dryRun = true;
      if (key === '--retry-errors') out.retryErrors = true;
      continue;
    }
    if (KNOWN_OPTS.includes(key) && value !== null) {
      if (key === '--limit') {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return { error: `--limit debe ser un número > 0 (recibí "${value}")` };
        out.limit = Math.floor(n);
      }
      if (key === '--username') out.username = String(value).trim();
      continue;
    }
    // Argumento desconocido: se aborta. Si alguien escribió mal "--execute" no
    // queremos ni ejecutar por accidente ni hacer un dry-run que parezca real.
    return { error: `argumento desconocido: "${arg}"` };
  }
  return out;
}

// =============================================================================
// CONFIG
// =============================================================================

const DELAY_MS = Math.max(0, Number(process.env.GIROX_MIGRATION_DELAY_MS || 2500));
const PROGRESS_EVERY = Math.max(1, Number(process.env.GIROX_MIGRATION_PROGRESS_EVERY || 25));
const RATE_WAIT_MS = Math.max(5000, Number(process.env.GIROX_MIGRATION_RATE_WAIT_MS || 65000));

// Reintentos POR USUARIO ante fallas transitorias (429 / red). Los clientes ya
// reintentan adentro; esto cubre el caso "la API nos frenó por cuota", donde hay
// que esperar en serio (más de un minuto) y no tiene sentido darlo por error.
const MAX_TRANSIENT_RETRIES = 3;

// Códigos que significan "no es culpa del usuario, reintentar más tarde".
const TRANSIENT_CODES = new Set([
  'http_429', 'rate_limited_local', 'network_error', 'ECONNABORTED', 'ECONNRESET',
  'ETIMEDOUT', 'EAI_AGAIN', 'http_500', 'http_502', 'http_503', 'http_504',
  'html_blocked', 'login_failed', 'token_rejected'
]);

function isTransient(code) {
  return TRANSIENT_CODES.has(String(code || ''));
}
function isRateLimit(code) {
  return code === 'http_429' || code === 'rate_limited_local';
}

// =============================================================================
// CORTE LIMPIO (SIGINT)
// =============================================================================

let stopRequested = false;
let stopResolvers = [];

process.on('SIGINT', () => {
  if (stopRequested) {
    console.log('\n⛔ Segundo Ctrl+C: corte forzado.');
    process.exit(130);
  }
  stopRequested = true;
  console.log('\n⏸  Ctrl+C recibido: termino el usuario en curso y corto limpio. ' +
    '(Otro Ctrl+C fuerza la salida — puede dejar un usuario a medias.)');
  // Despertar cualquier espera larga para no quedarnos 60s colgados.
  stopResolvers.forEach((r) => r());
  stopResolvers = [];
});

/** sleep que se interrumpe si pidieron cortar (para no comerse los 65s de un 429). */
function sleep(ms) {
  if (ms <= 0 || stopRequested) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      stopResolvers = stopResolvers.filter((r) => r !== wake);
      resolve();
    }, ms);
    const wake = () => { clearTimeout(t); resolve(); };
    stopResolvers.push(wake);
  });
}

// =============================================================================
// HELPERS
// =============================================================================

const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Contraseña random fuerte para el alta en 1girox.
 * NO se guarda en ningún lado a propósito: nadie la necesita (el acceso es por SSO)
 * y guardarla sería crear un secreto nuevo para cuidar. La clave real se replica en
 * el próximo login del usuario.
 */
function generateStrongPassword(length = 24) {
  const max = 256 - (256 % PASSWORD_ALPHABET.length); // evita el sesgo del módulo
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= max) continue;
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// =============================================================================
// PASOS DE LA MIGRACIÓN (con reintentos ante 429 / red)
// =============================================================================

/**
 * Alta (o vinculación) en 1girox.
 * `syncUserToPlatform` ya es idempotente: si el jugador existe devuelve
 * alreadyExists:true sin tocar nada, así que reintentar es seguro.
 * @returns {{ok:true, alreadyExists:boolean} | {ok:false, error:string, code:string}}
 */
async function createOrLinkPlayer(username) {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    const res = await giroxService.syncUserToPlatform({
      username,
      password: generateStrongPassword()
    });

    if (res.success) return { ok: true, alreadyExists: !!res.alreadyExists };

    if (isTransient(res.code) && attempt < MAX_TRANSIENT_RETRIES) {
      const wait = isRateLimit(res.code) ? RATE_WAIT_MS : 5000 * attempt;
      console.log(`\n      ⏳ ${res.code} en el alta — espero ${Math.round(wait / 1000)}s y reintento (${attempt}/${MAX_TRANSIENT_RETRIES - 1})`);
      await sleep(wait);
      if (stopRequested) return { ok: false, error: 'interrumpido por Ctrl+C', code: 'interrupted' };
      continue;
    }
    return { ok: false, error: res.error || 'error desconocido', code: res.code || 'unknown' };
  }
  return { ok: false, error: 'se agotaron los reintentos', code: 'retries_exhausted' };
}

/**
 * Resuelve el ID numérico del jugador contra el panel.
 * Es una lectura pura: reintentarla no tiene ningún efecto secundario.
 * @returns {{ok:true, id:number} | {ok:false, error:string, code:string}}
 */
async function resolvePlayerId(username) {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    const res = await giroxReportsService.findPlayerIdByUsername(username);

    if (res.success && Number.isFinite(Number(res.id)) && Number(res.id) > 0) {
      return { ok: true, id: Number(res.id) };
    }
    if (res.success) {
      return { ok: false, error: 'el panel devolvió el jugador sin ID', code: 'no_id_in_response' };
    }

    if (isTransient(res.code) && attempt < MAX_TRANSIENT_RETRIES) {
      const wait = isRateLimit(res.code) ? RATE_WAIT_MS : 5000 * attempt;
      console.log(`\n      ⏳ ${res.code} al buscar el ID — espero ${Math.round(wait / 1000)}s y reintento (${attempt}/${MAX_TRANSIENT_RETRIES - 1})`);
      await sleep(wait);
      if (stopRequested) return { ok: false, error: 'interrumpido por Ctrl+C', code: 'interrupted' };
      continue;
    }
    return { ok: false, error: res.error || 'no se pudo resolver el ID', code: res.code || 'unknown' };
  }
  return { ok: false, error: 'se agotaron los reintentos', code: 'retries_exhausted' };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`⛔ ${args.error}`);
    console.error('   Uso: node scripts/migrate-users-to-girox.js [--execute] [--retry-errors] [--limit=N] [--username=xxx]');
    process.exit(1);
  }

  const { dryRun, retryErrors, limit } = args;

  console.log('==========================================================');
  console.log('  MIGRACIÓN DE USUARIOS → 1GIROX');
  console.log('==========================================================');
  console.log(`  Modo             : ${dryRun ? '🧪 DRY RUN (no escribe nada)' : '🚀 EJECUCIÓN REAL'}`);
  console.log(`  Selección        : ${retryErrors ? "SÓLO los que quedaron en 'error'" : 'pendientes (+ los creados sin ID)'}`);
  console.log(`  Delay por usuario: ${DELAY_MS}ms  (~${Math.floor(60000 / Math.max(DELAY_MS, 1))} usuarios/min como techo)`);
  if (limit) console.log(`  Límite           : ${limit} usuarios`);
  if (args.username) console.log(`  Usuario puntual  : ${args.username}`);
  console.log('');

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('⛔ MONGODB_URI no definida. Setear la variable de entorno y reintentar.');
    process.exit(1);
  }

  // Sin credenciales no se puede migrar nada. Se chequea ANTES de conectarnos a
  // Mongo para fallar en 2 segundos y no en la mitad de la corrida.
  if (!dryRun) {
    if (!giroxService.isEnabled()) {
      console.error('⛔ Falta GIROX_API_URL / GIROX_API_KEY: sin eso no se pueden crear jugadores.');
      process.exit(1);
    }
    if (!giroxReportsService.isEnabled()) {
      console.error('⛔ Falta GIROX_ADMIN_USER / GIROX_ADMIN_PASS (o GIROX_ADMIN_TOKEN): sin el panel no se puede ' +
        'resolver el giroxUserId, y sin ese ID no se calculan reembolsos.');
      process.exit(1);
    }
  }

  console.log('🔌 Conectando a MongoDB...');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('✅ Conectado\n');

  const User = require('../src/models/User');

  // ---------------------------------------------------------------------------
  // SELECCIÓN DE CANDIDATOS
  // ---------------------------------------------------------------------------
  // Default: los que nunca se intentaron, MÁS los que ya tienen cuenta creada pero
  // se quedaron sin giroxUserId (ahí sólo falta resolver el ID: la cuenta ya está).
  // Los 'invalid_username' se incluyen a propósito aunque no se pueda hacer nada
  // con ellos: revalidarlos no cuesta una sola llamada a la API y así el reporte
  // final SIEMPRE lista la tanda completa que el owner tiene que resolver a mano.
  const baseFilter = { role: 'user' };
  if (args.username) baseFilter.username = args.username;

  const selection = retryErrors
    ? { giroxSyncStatus: 'error' }
    : {
      $or: [
        { giroxSyncStatus: { $in: ['pending', 'invalid_username'] } },
        { giroxSyncStatus: { $exists: false } },
        { giroxSyncStatus: null },
        // cuenta creada pero sin ID → se reintenta SÓLO la resolución del ID
        { giroxSyncStatus: { $in: ['synced', 'linked'] }, giroxUserId: { $in: [null, 0] } },
        { giroxSyncStatus: { $in: ['synced', 'linked'] }, giroxUserId: { $exists: false } }
      ]
    };

  const query = { ...baseFilter, ...selection };

  const totalUsers = await User.countDocuments(baseFilter);
  let candidates = await User.find(
    query,
    { _id: 1, id: 1, username: 1, giroxUserId: 1, giroxSyncStatus: 1, giroxPasswordSynced: 1 }
  ).sort({ createdAt: 1 }).lean();

  if (limit && candidates.length > limit) candidates = candidates.slice(0, limit);

  const total = candidates.length;
  const skipped = totalUsers - total;

  console.log(`👥 Usuarios con role:'user' : ${totalUsers}`);
  console.log(`🎯 A procesar en esta corrida: ${total}`);
  console.log(`⏭  Salteados (ya migrados / fuera de la selección): ${skipped}\n`);

  if (total === 0) {
    console.log('✅ No hay nada para hacer. Fin.');
    await mongoose.disconnect();
    return;
  }

  const estimate = total * (DELAY_MS + 1500); // +1.5s estimados de latencia de red por usuario
  console.log(`⏱  Duración estimada: ~${fmtDuration(estimate)} (con ${DELAY_MS}ms de delay). ` +
    'Se puede cortar con Ctrl+C y retomar después con el mismo comando.\n');

  // Chequeo de cordura ANTES de largar horas de corrida: una lectura contra cada
  // API con el primer candidato. No escribe nada — sólo confirma que las
  // credenciales andan. Si esto falla, no tiene sentido seguir.
  if (!dryRun) {
    const probe = candidates[0].username;
    console.log(`🔍 Prueba de credenciales (sólo lectura) con "${probe}"...`);
    const partnerOk = await giroxService.getUserInfoByName(probe);
    const panelProbe = await giroxReportsService.findPlayerIdByUsername(probe);
    console.log(`   Partner API : ${partnerOk ? 'responde (el jugador ya existe)' : 'responde (el jugador no existe todavía)'}`);
    if (!panelProbe.success && (panelProbe.code === 'login_failed' || panelProbe.code === 'token_rejected' || panelProbe.code === 'not_configured')) {
      console.error(`⛔ El panel rechazó nuestras credenciales (${panelProbe.code}). Revisar GIROX_ADMIN_USER / GIROX_ADMIN_PASS.`);
      console.error('   Sin el panel no se puede resolver el giroxUserId → se aborta antes de crear nada.');
      await mongoose.disconnect();
      process.exit(1);
    }
    console.log(`   Panel       : responde (${panelProbe.success ? `ID ${panelProbe.id}` : panelProbe.code})\n`);
  }

  // ---------------------------------------------------------------------------
  // PROCESAMIENTO
  // ---------------------------------------------------------------------------
  const counters = { created: 0, linked: 0, idResolved: 0, invalid: 0, errors: 0, noId: 0, pendingIdOnly: 0, processed: 0 };
  const invalidList = [];   // usernames que 1girox no acepta → decisión manual
  const errorList = [];     // fallaron el alta → reintentar con --retry-errors
  const noIdList = [];      // cuenta creada pero sin giroxUserId → sin ID no hay reembolso

  const startedAt = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    if (stopRequested) {
      console.log(`\n⏹  Corte pedido: freno acá. Procesados ${counters.processed} de ${total}.`);
      break;
    }

    const user = candidates[i];
    const username = String(user.username || '');
    const alreadyOnPlatform = ['synced', 'linked'].includes(user.giroxSyncStatus);
    const prefix = `[${i + 1}/${total}] ${username}`;

    counters.processed++;

    // --- 1) Validación del username (local, sin llamadas a la API) -----------
    const check = giroxService.validateUsername(username);
    if (!check.valid) {
      const reason = `El username no cumple las reglas de 1girox: ${check.reason}`;
      console.log(`${prefix} → 🚫 INVÁLIDO (${check.reason})`);
      counters.invalid++;
      invalidList.push({ username, reason: check.reason });

      if (!dryRun) {
        await User.updateOne(
          { _id: user._id },
          { $set: { giroxSyncStatus: 'invalid_username', giroxSyncError: reason } }
        );
      }
      // Sin delay: no consumimos cuota de la API en este caso.
      continue;
    }

    // --- 2) Alta en la plataforma ------------------------------------------
    let status = user.giroxSyncStatus;

    if (dryRun) {
      // En dry run no se llama a la API ni para leer: el objetivo es ver el PLAN.
      if (alreadyOnPlatform) {
        console.log(`${prefix} → [DRY RUN] ya está en 1girox (${status}): buscaría sólo su giroxUserId`);
        counters.pendingIdOnly++;
      } else {
        console.log(`${prefix} → [DRY RUN] crearía el jugador y buscaría su ID`);
        counters.created++;
      }
      continue;
    }

    if (alreadyOnPlatform) {
      // Ya tenía cuenta de una corrida anterior: sólo falta el ID.
      console.log(`${prefix} → ya estaba en 1girox (${status}), falta el ID`);
    } else {
      const alta = await createOrLinkPlayer(username);
      if (!alta.ok) {
        console.log(`${prefix} → ❌ ERROR en el alta: ${alta.error} (${alta.code})`);
        counters.errors++;
        errorList.push({ username, error: `${alta.error} [${alta.code}]` });
        await User.updateOne(
          { _id: user._id },
          { $set: { giroxSyncStatus: 'error', giroxSyncError: String(alta.error).slice(0, 500) } }
        );
        await sleep(DELAY_MS);
        continue;
      }
      status = alta.alreadyExists ? 'linked' : 'synced';
      if (alta.alreadyExists) counters.linked++; else counters.created++;
    }

    // --- 3) ID numérico del jugador (imprescindible para los reembolsos) -----
    const idRes = await resolvePlayerId(username);

    const update = {
      giroxSyncStatus: status,
      giroxSyncError: null
    };
    // ⚠️ Sólo se pisa a false si NO estaba ya sincronizada: si el usuario ya se
    // logueó y su contraseña real viajó a 1girox, volver a correr el script no
    // tiene que hacernos olvidar eso.
    if (user.giroxPasswordSynced !== true) update.giroxPasswordSynced = false;

    if (idRes.ok) {
      update.giroxUserId = idRes.id;
      counters.idResolved++;
      console.log(`${prefix} → ✅ ${status} · giroxUserId=${idRes.id}`);
    } else {
      // La cuenta EXISTE (paso 2 salió bien), lo que faltó es el ID. No se marca
      // 'error' a propósito: el estado real es "creado". Se deja el motivo en
      // giroxSyncError y la próxima corrida lo levanta por el filtro
      // "synced/linked sin giroxUserId" y reintenta SÓLO la búsqueda del ID.
      update.giroxSyncError = `Cuenta creada pero sin ID de jugador: ${idRes.error}`.slice(0, 500);
      counters.noId++;
      noIdList.push({ username, error: `${idRes.error} [${idRes.code}]` });
      console.log(`${prefix} → ⚠️  ${status} pero SIN ID (${idRes.error})`);
    }

    // ⚠️ $set explícito y acotado a los campos girox: los jugayganaXxx no se tocan
    // NUNCA (son el camino de vuelta si hay que revertir la migración).
    await User.updateOne({ _id: user._id }, { $set: update });

    // --- 4) Progreso --------------------------------------------------------
    if (counters.processed % PROGRESS_EVERY === 0) {
      const elapsed = Date.now() - startedAt;
      const perUser = elapsed / counters.processed;
      const remaining = (total - counters.processed) * perUser;
      const pct = ((counters.processed / total) * 100).toFixed(1);
      console.log(`\n   📊 ${counters.processed}/${total} (${pct}%) · transcurrido ${fmtDuration(elapsed)} · ` +
        `restante ~${fmtDuration(remaining)} · ✅${counters.created + counters.linked} ⚠️${counters.noId} ❌${counters.errors} 🚫${counters.invalid}\n`);
    }

    await sleep(DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // REPORTE FINAL
  // ---------------------------------------------------------------------------
  const elapsed = Date.now() - startedAt;

  console.log('\n==========================================================');
  console.log('  RESUMEN DE LA MIGRACIÓN');
  console.log('==========================================================');
  if (dryRun) console.log('  🧪 DRY RUN: no se escribió nada. Repetir con --execute.');
  console.log(`  Duración                 : ${fmtDuration(elapsed)}`);
  console.log(`  Procesados               : ${counters.processed} de ${total} seleccionados`);
  console.log(`  ✅ ${dryRun ? 'Se crearían' : 'Creados en 1girox '}      : ${counters.created}`);
  if (dryRun) {
    console.log(`  🆔 Sólo les falta el ID   : ${counters.pendingIdOnly}`);
  } else {
    console.log(`  🔗 Ya existían (linked)   : ${counters.linked}`);
    console.log(`  🆔 IDs resueltos          : ${counters.idResolved}`);
    console.log(`  ⚠️  Creados SIN ID         : ${counters.noId}`);
  }
  console.log(`  ❌ Errores                : ${counters.errors}`);
  console.log(`  🚫 Usernames inválidos    : ${counters.invalid}`);
  console.log(`  ⏭  Salteados (ya migrados): ${skipped}`);
  if (stopRequested) {
    console.log(`  ⏸  INTERRUMPIDO: quedan ${total - counters.processed} sin procesar. ` +
      'Volvé a correr el mismo comando para retomar.');
  }

  // Los tres listados que el owner necesita para trabajar a mano.
  if (invalidList.length) {
    console.log('\n----------------------------------------------------------');
    console.log('  🚫 USERNAMES INVÁLIDOS — NECESITAN DECISIÓN MANUAL');
    console.log('  No se pueden crear en 1girox con ese nombre (regla: 3-18');
    console.log('  caracteres, sólo letras, números y guion bajo). Hay que');
    console.log('  renombrarlos en VIPCARGAS y volver a correr el script.');
    console.log('----------------------------------------------------------');
    invalidList.forEach((u) => console.log(`  - ${u.username}  (${u.reason})`));
  }

  if (errorList.length) {
    console.log('\n----------------------------------------------------------');
    console.log('  ❌ FALLARON EL ALTA — reintentar con --retry-errors');
    console.log('----------------------------------------------------------');
    errorList.forEach((u) => console.log(`  - ${u.username}: ${u.error}`));
  }

  if (noIdList.length) {
    console.log('\n----------------------------------------------------------');
    console.log('  ⚠️  CUENTA CREADA PERO SIN giroxUserId');
    console.log('  La cuenta existe y el usuario puede jugar, pero SIN ese ID');
    console.log('  NO se le puede calcular el reembolso ni la comisión de');
    console.log('  referidos. Volver a correr el script (sin flags) los');
    console.log('  reintenta solos: no vuelve a crear la cuenta, sólo busca el ID.');
    console.log('----------------------------------------------------------');
    noIdList.forEach((u) => console.log(`  - ${u.username}: ${u.error}`));
  }

  console.log('==========================================================\n');

  await mongoose.disconnect();
  console.log('✅ Desconectado de MongoDB. Fin.');
}

main().catch(async (err) => {
  console.error('\n⛔ Error fatal en la migración:', err && err.stack ? err.stack : err);
  console.error('   El progreso guardado en Mongo sigue siendo válido: volvé a correr el mismo comando para retomar.');
  try { await mongoose.disconnect(); } catch (_) { /* ya estaba caída */ }
  process.exit(1);
});
