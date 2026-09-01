/**
 * CashbackClaim — cashback INSTANTÁNEO tipo Stake (#254, 2026-09-01).
 *
 * Cada reclamo paga pct% de la pérdida REAL del día (netwin de casino de la
 * Partner API) menos lo ya cobrado ese día — así el bonus perdido no genera
 * cashback de cashback. Se acredita como depósito CON rollover (multiplier).
 *
 * IDEMPOTENCIA: reference = vip-cbk-<userId>-<dateKey>-<seq>. `seq` sale del
 * índice único (userId, dateKey, seq): si la acreditación falla y se borra el
 * doc, el reintento reusa el MISMO seq → misma reference → la plataforma
 * deduplica y jamás se paga dos veces (mismo patrón que los reembolsos).
 *
 * Lo cobrado acá se DESCUENTA del reembolso semanal/mensual del período
 * (la misma pérdida no se reembolsa dos veces).
 */
const mongoose = require('mongoose');

const cashbackClaimSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true, trim: true, index: true },
  dateKey: { type: String, required: true, index: true }, // YYYY-MM-DD ART
  seq: { type: Number, required: true },
  amount: { type: Number, required: true, min: 0 },       // ARS acreditados
  pct: { type: Number, default: 0 },                      // % vigente al reclamar
  rolloverX: { type: Number, default: 0 },
  netwinAtClaim: { type: Number, default: 0 },            // netwin del día al reclamar
  status: { type: String, enum: ['pending', 'credited'], default: 'pending', index: true },
  transactionId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});

cashbackClaimSchema.index({ userId: 1, dateKey: 1, seq: 1 }, { name: 'unique_user_day_seq', unique: true });
cashbackClaimSchema.index({ userId: 1, createdAt: 1 });

module.exports = mongoose.models['CashbackClaim'] ||
  mongoose.model('CashbackClaim', cashbackClaimSchema);
