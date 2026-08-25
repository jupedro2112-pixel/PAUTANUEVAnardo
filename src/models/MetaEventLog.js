/**
 * MetaEventLog — diagnóstico PRIVADO (solo admin) de qué `user_data` se envió a
 * Meta (Conversions API) en cada evento. Sirve para comparar, sin depender del
 * número agregado de Meta, qué parámetros de coincidencia llevó cada evento
 * (ej. CompleteRegistration vs Purchase del MISMO usuario): ¿el registro mandó
 * fbc y la compra también? ¿llegó la IP? etc.
 *
 * NO guarda PII en claro: email/teléfono/external_id se guardan sólo como los
 * primeros 10 caracteres de su HASH (para confirmar que es el mismo valor entre
 * eventos, no para identificar). fbc/fbp/ip/ua se guardan tal cual porque es
 * EXACTAMENTE lo que se manda a Meta (no son hashes) y el objetivo es verlos.
 *
 * TTL: 14 días → se autolimpia. Se puede apagar con META_EVENT_LOG_DISABLED=true.
 */
const mongoose = require('mongoose');

const TTL_SECONDS = 14 * 24 * 60 * 60; // 14 días

const metaEventLogSchema = new mongoose.Schema({
  eventId: { type: String, default: null, index: true },
  eventName: { type: String, default: null, index: true }, // 'Purchase', 'CompleteRegistration', ...
  userId: { type: String, default: null, index: true },     // id crudo del jugador (para comparar sus eventos)

  // Campos HASHEADOS que se envían a Meta: se guarda sólo un prefijo del hash
  // (confirmar "mismo valor" entre eventos, sin poder des-hashear).
  em: { type: String, default: null },          // prefijo del hash del email, o null si no se envió
  ph: { type: String, default: null },          // prefijo del hash del teléfono
  external_id: { type: String, default: null }, // prefijo del hash del external_id

  // Valores NO hasheados que se mandan tal cual a Meta (lo que se quiere ver):
  fbc: { type: String, default: null },
  fbp: { type: String, default: null },
  ip: { type: String, default: null },
  ua: { type: String, default: null, maxlength: 500 },

  // Contexto para distinguir/ordenar eventos.
  value: { type: Number, default: null },
  currency: { type: String, default: null },
  contentName: { type: String, default: null },   // custom_data.content_name (ej. 'deposit_hgcash')
  destinations: { type: [String], default: [] },   // ['propio', 'partner', ...]

  createdAt: { type: Date, default: Date.now, index: true }
});

// TTL: se borra a los 14 días.
metaEventLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
metaEventLogSchema.index({ userId: 1, createdAt: -1 });
metaEventLogSchema.index({ eventName: 1, createdAt: -1 });

module.exports = mongoose.models['MetaEventLog'] || mongoose.model('MetaEventLog', metaEventLogSchema);
