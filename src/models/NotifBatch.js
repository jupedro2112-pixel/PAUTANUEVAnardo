/**
 * NotifBatch — LOTE de notificaciones con regalo (owner 2026-08-10).
 *
 * Un agente (admin general o depositor) envía una notificación a una LISTA
 * de usuarios con un regalo asociado: % extra en la próxima carga o un monto
 * fijo en $. Dos modos:
 *
 *  - 'code':   la notificación lleva un CÓDIGO. Solo los usuarios DEL LOTE
 *              pueden canjearlo (en la PWA, "Reclamar Bono con Código").
 *              Al canjear se les activa un PromoBonus (cartel verde del
 *              agente) vigente hasta expiresAt del lote.
 *  - 'window': sin código. Al enviar, TODOS los del lote reciben el
 *              PromoBonus de una, vigente por validHours.
 *
 * El "bono" en sí es un PromoBonus (src/models/PromoBonus.js) con
 * sourceRuleCode='lote' — así el cartel verde del chat y el "Marcar como
 * usado" existentes funcionan sin duplicar nada. El lote guarda además el
 * resultado del envío por destinatario (canal + entrega) para el historial
 * del panel ("quién lo mandó y a quiénes, a quién le llegó").
 */
const mongoose = require('mongoose');

const notifBatchSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Etiqueta opcional para identificar el lote en el historial.
  name: { type: String, default: '', trim: true, maxlength: 60 },

  mode: { type: String, enum: ['code', 'window'], required: true },

  // percent = % extra sobre la próxima carga; fixed = regalo de $ fijo.
  // En ambos casos lo APLICA EL AGENTE en la carga (no se acredita solo).
  giftType: { type: String, enum: ['percent', 'fixed'], required: true },
  amount: { type: Number, required: true, min: 1 },

  // Solo modo 'code'. SIEMPRE en mayúsculas (el canje compara uppercased).
  code: { type: String, default: null, uppercase: true, trim: true, index: true },

  // Horas de vigencia (configurable por lote). En 'window': cuánto dura el
  // bono desde el envío. En 'code': hasta cuándo se puede canjear el código
  // Y hasta cuándo vale el bono canjeado (un solo reloj por lote).
  validHours: { type: Number, required: true, min: 1 },
  sentAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },

  // Texto que ve el cliente (push + mensaje de chat). El código se agrega
  // al final automáticamente en modo 'code'.
  title: { type: String, default: '', trim: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 500 },

  sentBy: { type: String, required: true },
  sentByRole: { type: String, default: null },

  recipients: {
    type: [{
      userId: { type: String, required: true },
      username: { type: String, required: true },
      // Capacidad de push AL MOMENTO del envío (misma clasificación que el
      // badge del chat): app = token standalone, browser = token de
      // navegador, none = sin ningún token FCM.
      channel: { type: String, enum: ['app', 'browser', 'none'], default: 'none' },
      // Resultado real de la entrega: socket (estaba online), push (FCM OK),
      // none (sin token), error (FCM falló). null = todavía enviando.
      delivery: { type: String, default: null },
      // Modo 'code': cuándo canjeó. Modo 'window': = sentAt (bono directo).
      claimedAt: { type: Date, default: null },
      promoBonusId: { type: String, default: null },
      _id: false
    }],
    default: []
  }
}, { timestamps: false });

notifBatchSchema.index({ mode: 1, code: 1, expiresAt: -1 });
notifBatchSchema.index({ 'recipients.userId': 1 });

module.exports = mongoose.models['NotifBatch'] ||
  mongoose.model('NotifBatch', notifBatchSchema);
