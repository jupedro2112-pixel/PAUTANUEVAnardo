/**
 * refundTiers.js — Rangos de reembolso (Bronce / Plata / Oro).
 *
 * REGLA DE NEGOCIO (owner, 2026-07-31):
 *
 *   Pérdida del período        Rango    Reembolso
 *   ─────────────────────      ──────   ─────────
 *   hasta $30.000              Bronce      3%
 *   $30.001 a $100.000         Plata       6%
 *   más de $100.000            Oro        10%
 *
 * ⚠️ EL RANGO SE CALCULA SOBRE LA PÉRDIDA DEL PERÍODO QUE SE RECLAMA, no sobre un
 * acumulado histórico (decisión del owner). O sea: cada reembolso mira su propio
 * período. Si esta semana perdió $120.000, ESE reembolso se paga al 10%, aunque el
 * mes pasado hubiera sido Bronce. No hay medalla permanente ni progreso que se
 * arrastre entre períodos.
 *
 * Consecuencia práctica: un mismo jugador puede ser Oro en el mensual y Bronce en el
 * diario al mismo tiempo, porque son períodos distintos con pérdidas distintas. La
 * UI tiene que mostrar el rango POR REEMBOLSO, no uno solo para el usuario.
 *
 * Los umbrales son en PESOS y se comparan contra el netwin (apostado − ganado) que
 * devuelve la plataforma para ese rango de fechas.
 */

/**
 * Escalones, de menor a mayor. `max: null` = sin techo (el último).
 * El orden importa: `getRefundTier` recorre de arriba a abajo y corta en el primero
 * que entra.
 */
const REFUND_TIERS = [
  {
    key: 'bronce',
    name: 'Bronce',
    emoji: '🥉',
    color: '#cd7f32',
    pct: 3,
    min: 0,
    max: 30000
  },
  {
    key: 'plata',
    name: 'Plata',
    emoji: '🥈',
    color: '#c0c0c0',
    pct: 6,
    min: 30000,
    max: 100000
  },
  {
    key: 'oro',
    name: 'Oro',
    emoji: '🥇',
    color: '#ffd700',
    pct: 10,
    min: 100000,
    max: null
  }
];

/**
 * Devuelve el rango que corresponde a una pérdida.
 *
 * Los límites son INCLUSIVOS por abajo del corte: "hasta 30.000" significa que
 * $30.000 exactos todavía es Bronce, y $30.001 ya es Plata. Idem con los 100.000.
 * Se define así a propósito para que coincida con cómo lo dijo el owner ("hasta
 * 30.000", "más de 100.000") y para que el usuario no vea un salto de rango justo
 * en el número redondo que le mostramos como objetivo.
 *
 * @param {number} netLoss - pérdida del período, en pesos
 * @returns {{key,name,emoji,color,pct,min,max,next,faltaParaSubir}}
 */
function getRefundTier(netLoss) {
  const loss = Number(netLoss) || 0;

  let idx = 0;
  for (let i = 0; i < REFUND_TIERS.length; i++) {
    const t = REFUND_TIERS[i];
    if (t.max === null || loss <= t.max) { idx = i; break; }
    idx = i; // por si el for termina sin cortar (no debería: el último no tiene techo)
  }

  const tier = REFUND_TIERS[idx];
  const next = REFUND_TIERS[idx + 1] || null;

  return {
    ...tier,
    // Cuánto MÁS tendría que perder para subir de rango. null si ya está en el tope.
    // Es +1 peso sobre el techo actual porque el corte es "más de X".
    faltaParaSubir: next ? Math.max(0, (tier.max + 1) - loss) : null,
    next: next ? { key: next.key, name: next.name, emoji: next.emoji, pct: next.pct } : null
  };
}

/**
 * Calcula el monto del reembolso aplicando el rango correspondiente.
 * @param {number} netLoss - pérdida del período, en pesos
 * @returns {{amount, pct, tier}}
 */
function calcRefund(netLoss) {
  const loss = Math.max(0, Number(netLoss) || 0);
  const tier = getRefundTier(loss);
  return {
    amount: Math.round(loss * (tier.pct / 100)),
    pct: tier.pct,
    tier
  };
}

/** Los 3 escalones, para mostrarlos en la UI (tabla de rangos). */
function listTiers() {
  return REFUND_TIERS.map((t) => ({ ...t }));
}

module.exports = {
  REFUND_TIERS,
  getRefundTier,
  calcRefund,
  listTiers
};
