
/**
 * Modelo de Reclamos de Reembolso
 * Gestiona reembolsos semanales y mensuales (y el rakeback VIP).
 */
const mongoose = require('mongoose');

const refundClaimSchema = new mongoose.Schema({
  id: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  userId: { 
    type: String, 
    required: true, 
    index: true 
  },
  username: { 
    type: String, 
    required: true, 
    index: true,
    trim: true
  },
  type: {
    type: String,
    // 'rakeback' = rakeback semanal del nivel VIP (% del APOSTADO de la semana
    // pasada, gane o pierda — no de la pérdida). Reusa este modelo porque el
    // candado anti doble-cobro es el mismo: índice único userId+type+periodKey.
    // ⚠️ 'daily' quedó SOLO por los documentos HISTÓRICOS: el reembolso diario
    // se eliminó del producto el 2026-08-07 y ya no se crean claims nuevos de
    // ese tipo. No sacarlo del enum: rompería cualquier save() de un doc viejo.
    enum: ['daily', 'weekly', 'monthly', 'rakeback'],
    required: true,
    index: true
  },
  amount: { 
    type: Number, 
    required: true,
    min: 0
  },
  netAmount: { 
    type: Number, 
    required: true 
  },
  percentage: { 
    type: Number, 
    required: true,
    min: 0,
    max: 100
  },
  deposits: { 
    type: Number, 
    default: 0,
    min: 0
  },
  withdrawals: { 
    type: Number, 
    default: 0,
    min: 0
  },
  period: { 
    type: String, 
    default: '',
    trim: true
  },
  periodKey: {
    type: String,
    default: null,
    trim: true
  },
  transactionId: { 
    type: String, 
    default: null,
    index: true
  },
  claimedAt: { 
    type: Date, 
    default: Date.now, 
    index: true,
    immutable: true
  }
}, {
  timestamps: true
});

// Índices para consultas frecuentes
refundClaimSchema.index({ userId: 1, type: 1 });
refundClaimSchema.index({ userId: 1, claimedAt: -1 });
refundClaimSchema.index({ claimedAt: -1 });
refundClaimSchema.index({ type: 1, claimedAt: -1 });
// Índice único por período para prevenir doble reclamo (sparse permite valores null para registros históricos)
refundClaimSchema.index({ userId: 1, type: 1, periodKey: 1 }, { unique: true, sparse: true });

// Método estático para verificar si puede reclamar
// (El tipo 'daily' se eliminó del producto 2026-08-07; ya no es válido acá.)
refundClaimSchema.statics.canClaim = async function(userId, type) {
  const now = new Date();
  let startDate;

  switch(type) {
    case 'weekly':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'monthly':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      return { canClaim: false, reason: 'Tipo inválido' };
  }
  
  const lastClaim = await this.findOne({
    userId,
    type,
    claimedAt: { $gte: startDate }
  }).sort({ claimedAt: -1 });
  
  if (lastClaim) {
    const nextClaim = new Date(lastClaim.claimedAt.getTime());
    switch(type) {
      case 'weekly':
        nextClaim.setDate(nextClaim.getDate() + 7);
        break;
      case 'monthly':
        nextClaim.setDate(nextClaim.getDate() + 30);
        break;
    }
    
    return {
      canClaim: false,
      lastClaim: lastClaim.claimedAt,
      nextClaim,
      message: `Ya reclamaste tu reembolso ${type}. Próximo disponible: ${nextClaim.toLocaleDateString()}`
    };
  }
  
  return { canClaim: true };
};

// Método estático para obtener historial de usuario
refundClaimSchema.statics.getUserHistory = function(userId, options = {}) {
  const { limit = 50 } = options;
  
  return this.find({ userId })
    .sort({ claimedAt: -1 })
    .limit(limit)
    .lean();
};

// Método estático para obtener resumen
refundClaimSchema.statics.getSummary = async function() {
  return this.aggregate([
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' }
      }
    }
  ]);
};

module.exports = mongoose.models['RefundClaim'] || mongoose.model('RefundClaim', refundClaimSchema);