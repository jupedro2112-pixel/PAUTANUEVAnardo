/**
 * VipWagerMonth — Apostado de casino de UN usuario en UN mes calendario (ART).
 *
 * Es la base del acumulado de por vida de los niveles VIP (User.lifetimeWagered =
 * suma de estos buckets). Se guarda POR MES porque la Partner API no expone un
 * "apostado histórico": sólo stats por rango de hasta 92 días. Un mes entra
 * siempre en ese límite y coincide con los períodos que ya usa el negocio.
 *
 * ⚠️ DISEÑO ANTI-DOBLE-CONTEO: el motor NUNCA hace $inc sobre estos docs — siempre
 * $set con el total del mes que devuelve la plataforma. Recalcular un mes es
 * idempotente por construcción: dos instancias del cron pisándose escriben el
 * mismo valor. Por eso este esquema es seguro en multi-instancia (AWS EB) sin
 * locks. El índice único userId+monthKey evita buckets duplicados.
 *
 * `closed`: el mes ya terminó y se recalculó COMPLETO después de su fin → no se
 * vuelve a consultar a la plataforma (ahorra requests del cupo de 60/min).
 * El mes corriente vive con closed:false y se refresca en cada tick.
 */
const mongoose = require('mongoose');

const vipWagerMonthSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  username: {
    type: String,
    required: true,
    trim: true
  },
  // 'YYYY-MM' en hora argentina (mismo formato que periodKey de referidos)
  monthKey: {
    type: String,
    required: true,
    index: true
  },
  // Apostado del mes en PESOS (sólo casino por default — ver VIP_WAGER_SCOPE)
  wagered: {
    type: Number,
    default: 0,
    min: 0
  },
  closed: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

// Un bucket por usuario+mes. NO quitar: es la garantía de no duplicar meses.
vipWagerMonthSchema.index({ userId: 1, monthKey: 1 }, { unique: true });

module.exports = mongoose.models['VipWagerMonth'] || mongoose.model('VipWagerMonth', vipWagerMonthSchema);
