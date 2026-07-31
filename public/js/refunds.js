// ========================================
// REFUNDS - Reembolsos module
// ========================================

window.VIP = window.VIP || {};

VIP.refunds = (function () {

    async function loadRefundStatus() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (response.ok) {
                VIP.state.refundStatus = await response.json();
                updateRefundButtons();
            }
        } catch (error) {
            console.error('Error cargando reembolsos:', error);
        }
    }

    function updateRefundButtons() {
        if (!VIP.state.refundStatus) return;
        updateRefundButton('daily', VIP.state.refundStatus.daily);
        updateRefundButton('weekly', VIP.state.refundStatus.weekly);
        updateRefundButton('monthly', VIP.state.refundStatus.monthly);
        updateRefundLabels();
    }

    // Actualiza los % visibles (tooltips de los botones del dashboard y los spans
    // del modal unificado) con el valor real configurado en el panel.
    function updateRefundLabels() {
        const s = VIP.state.refundStatus;
        if (!s) return;
        const tip = (id, label, t) => {
            const el = document.getElementById(id);
            if (el && s[t] && s[t].percentage != null) el.title = `${label} ${s[t].percentage}%`;
        };
        tip('dailyRefundBtn', 'Reembolso Diario', 'daily');
        tip('weeklyRefundBtn', 'Reembolso Semanal (Lun-Mar)', 'weekly');
        tip('monthlyRefundBtn', 'Reembolso Mensual (Desde día 7)', 'monthly');
        const pctSpan = (id, t) => {
            const el = document.getElementById(id);
            if (el && s[t] && s[t].percentage != null) el.textContent = s[t].percentage;
        };
        pctSpan('unifiedDailyPct', 'daily');
        pctSpan('unifiedWeeklyPct', 'weekly');
        pctSpan('unifiedMonthlyPct', 'monthly');
    }

    function updateRefundButton(type, data) {
        const btn    = document.getElementById(`${type}RefundBtn`);
        const amount = document.getElementById(`${type}RefundAmount`);
        const timer  = document.getElementById(`${type}RefundTimer`);

        amount.textContent = `$${data.potentialAmount.toLocaleString()}`;

        // Medallita del rango (🥉/🥈/🥇) arriba a la derecha del botón. El rango sale
        // de la pérdida DE ESE período, así que cada reembolso puede tener el suyo:
        // el mismo jugador puede ser Oro en el mensual y Bronce en el diario.
        if (btn && data.tier) {
            let badge = btn.querySelector('.refund-tier');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'refund-tier';
                btn.appendChild(badge);
            }
            badge.textContent = data.tier.emoji;
            badge.title = `${data.tier.name} — ${data.tier.pct}% de reembolso`;
            badge.style.borderColor = data.tier.color;
        }

        btn.disabled = false;
        btn.classList.remove('claimed');

        if (data.canClaim && data.potentialAmount > 0) {
            timer.textContent = '¡Listo!';
            btn.style.opacity = '1';
        } else {
            btn.style.opacity = '0.7';
            if (data.nextClaim) {
                startCountdown(type, data.nextClaim);
            } else {
                timer.textContent = 'Ver info';
            }
        }
    }

    function startCountdown(type, targetDate) {
        const timerElement = document.getElementById(`${type}RefundTimer`);

        function update() {
            const now    = getArgentinaDate();
            const target = new Date(targetDate);
            const diff   = target - now;

            if (diff <= 0) {
                timerElement.textContent = '¡Listo!';
                loadRefundStatus();
                return;
            }

            const hours   = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

            if (hours > 24) {
                timerElement.textContent = `${Math.floor(hours / 24)}d`;
            } else {
                timerElement.textContent = `${hours}h ${minutes}m`;
            }
        }

        update();
        if (VIP.state.refundTimers[type]) clearInterval(VIP.state.refundTimers[type]);
        VIP.state.refundTimers[type] = setInterval(update, 60000);
    }

    async function showRefundModal(type) {

        if (!VIP.state.refundStatus) {
            VIP.ui.showToast('Cargando información de reembolsos...', 'info');
            await loadRefundStatus();
            if (!VIP.state.refundStatus) {
                VIP.ui.showToast('Error: No se pudo cargar la información de reembolsos. Intenta recargar la página.', 'error');
                return;
            }
        }

        const typeData = VIP.state.refundStatus[type];
        // Los porcentajes son configurables desde el panel; los tomamos del estado
        // (campo `percentage` que devuelve /api/refunds/status) en vez de hardcodear.
        const pctOf = (t) => {
            const p = VIP.state.refundStatus[t] && VIP.state.refundStatus[t].percentage;
            return (p !== undefined && p !== null) ? p : { daily: 20, weekly: 10, monthly: 5 }[t];
        };
        const titles = {
            daily:   `📅 Reembolso Diario (${pctOf('daily')}%)`,
            weekly:  `📆 Reembolso Semanal (${pctOf('weekly')}%)`,
            monthly: `🗓️ Reembolso Mensual (${pctOf('monthly')}%)`
        };
        const periodLabels = {
            daily:   '🎮 TU NETWIN DE AYER (pérdida real jugando)',
            weekly:  '🎮 TU NETWIN DE LA SEMANA PASADA (Lun-Dom)',
            monthly: '🎮 TU NETWIN DEL MES PASADO'
        };

        document.getElementById('refundModalTitle').textContent = titles[type];
        document.getElementById('refundMovementsTitle').textContent = periodLabels[type];

        const currentBalance = VIP.state.refundStatus.user?.currentBalance || 0;
        document.getElementById('refundCurrentBalance').textContent = `$${currentBalance.toLocaleString()}`;
        document.getElementById('refundPeriod').textContent = typeData.period || '-';
        document.getElementById('refundNetAmount').textContent = `$${(typeData.netAmount || 0).toLocaleString()}`;
        document.getElementById('refundAmount').textContent = `$${(typeData.potentialAmount || 0).toLocaleString()}`;

        const availabilityInfo = document.getElementById('refundAvailabilityInfo');
        availabilityInfo.style.display = 'none';
        availabilityInfo.innerHTML = '';

        if (type === 'weekly') {
            const today = new Date().getDay();
            const isClaimableDay = today === 1 || today === 2;
            if (!isClaimableDay) {
                availabilityInfo.style.display = 'block';
                availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
                availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
                availabilityInfo.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">ℹ️</span>
                        <div>
                            <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Semanal</p>
                            <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable los días <strong>LUNES y MARTES</strong></p>
                            <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde a la semana anterior (Lunes a Domingo)</p>
                        </div>
                    </div>
                `;
            }
        } else if (type === 'monthly') {
            const today = new Date().getDate();
            const isClaimableDay = today >= 7;
            if (!isClaimableDay) {
                availabilityInfo.style.display = 'block';
                availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
                availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
                availabilityInfo.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">ℹ️</span>
                        <div>
                            <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Mensual</p>
                            <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable <strong>después del día 7</strong> de cada mes</p>
                            <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde al mes anterior completo</p>
                        </div>
                    </div>
                `;
            }
        }

        const extraInfo = document.getElementById('refundExtraInfo');
        const claimBtn  = document.getElementById('claimRefundBtn');
        let isClaimed     = false;
        let timeRemaining = '';

        if (typeData.lastClaim) {
            const lastClaim = new Date(typeData.lastClaim);
            const now = new Date();

            if (type === 'daily') {
                const tomorrow = new Date(lastClaim);
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 0, 0, 0);
                if (now < tomorrow) {
                    isClaimed = true;
                    const diff = tomorrow - now;
                    const hours   = Math.floor(diff / (1000 * 60 * 60));
                    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    timeRemaining = `${hours}h ${minutes}m`;
                }
            } else if (type === 'weekly') {
                const nextMonday = new Date(lastClaim);
                const daysUntilMonday = (8 - lastClaim.getDay()) % 7 || 7;
                nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
                nextMonday.setHours(0, 0, 0, 0);
                if (now < nextMonday) {
                    isClaimed = true;
                    const diff = nextMonday - now;
                    const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
                    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    timeRemaining = `${days}d ${hours}h`;
                }
            } else if (type === 'monthly') {
                const nextMonth = new Date(lastClaim.getFullYear(), lastClaim.getMonth() + 1, 7);
                nextMonth.setHours(0, 0, 0, 0);
                if (now < nextMonth) {
                    isClaimed = true;
                    const diff = nextMonth - now;
                    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                    timeRemaining = `${days}d`;
                }
            }
        }

        if (typeData.potentialAmount <= 0) {
            extraInfo.innerHTML = '<span style="color: #ff8888;">⚠️ No tenés pérdida (NETWIN) en el período. El reembolso es sobre lo que perdiste jugando.</span>';
            claimBtn.disabled = true;
            claimBtn.textContent = '❌ Sin pérdida para reembolsar';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else if (isClaimed) {
            extraInfo.innerHTML = `<span style="color: #ffaa44;">⏳ Ya reclamaste este reembolso. Disponible en: <strong>${timeRemaining}</strong></span>`;
            claimBtn.disabled = true;
            claimBtn.textContent = `⏳ Disponible en ${timeRemaining}`;
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else if (!typeData.canClaim) {
            extraInfo.innerHTML = '<span style="color: #ffaa44;">⏳ No puedes reclamar este reembolso en este momento.</span>';
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ No disponible';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else {
            extraInfo.innerHTML = '<span style="color: #00ff88;">✅ ¡Puedes reclamar este reembolso!</span>';
            claimBtn.disabled = false;
            claimBtn.textContent = '🎁 Reclamar Reembolso';
            claimBtn.style.background = '';
        }

        claimBtn.onclick = () => claimRefund(type);

        VIP.ui.showModal('refundModal');
    }

    async function claimRefund(type) {
        const claimBtn = document.getElementById('claimRefundBtn');
        if (claimBtn) {
            if (claimBtn.disabled) return;
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ Procesando...';
        }
        try {
            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/claim/${type}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ metaEventId })
            });

            const data = await response.json();

            if (data.success) {
                VIP.ui.showToast(`✅ ${data.message}`, 'success');
                VIP.ui.hideModal('refundModal');
                loadRefundStatus();
                VIP.chat.sendSystemMessage(`🎁 Reembolso ${type} reclamado: $${data.amount.toLocaleString()}`);

                // Meta Pixel — RefundClaim (custom, deduplicado con CAPI).
                if (VIP.pixel) VIP.pixel.trackWithId(metaEventId, 'RefundClaim', {
                    value: data.amount,
                    currency: 'ARS',
                    content_name: `refund_${type}`
                });
            } else {
                VIP.ui.showToast(`ℹ️ ${data.message}`, 'info');
                VIP.ui.hideModal('refundModal');
                loadRefundStatus();
            }
        } catch (error) {
            VIP.ui.showToast('Error de conexión', 'error');
        } finally {
            if (claimBtn) {
                claimBtn.disabled = false;
                claimBtn.textContent = '🎁 Reclamar Reembolso';
            }
        }
    }

    async function showUnifiedRefundModal() {
        // Req 3: Precargar el estado de reembolsos ANTES de mostrar el modal unificado,
        // para que al presionar una opción funcione de inmediato sin depender de cargas previas.
        if (!VIP.state.refundStatus) {
            await loadRefundStatus();
        }
        VIP.ui.showModal('unifiedRefundModal');
    }

    // ============================================
    // PERFIL DEL JUGADOR + RANGOS
    // ============================================

    /**
     * Modal que se abre al tocar el recuadro USUARIO. Muestra los datos de la cuenta,
     * el rango de cada reembolso y cuánto le falta para subir al siguiente.
     *
     * ⚠️ El rango NO es del usuario: es DE CADA REEMBOLSO. Se calcula sobre lo que
     * perdió en ese período puntual, así que el mismo jugador puede ser Oro en el
     * mensual y Bronce en el diario. La UI lo dice explícitamente para que nadie
     * crea que "bajó de categoría".
     */
    async function showProfileModal() {
        if (!VIP.state.refundStatus) {
            await loadRefundStatus();
        }
        const s = VIP.state.refundStatus;
        const user = VIP.state.currentUser || {};
        const money = (n) => '$' + (Number(n) || 0).toLocaleString('es-AR');

        // Tabla de rangos: viene del backend para no duplicar los umbrales acá.
        const tiers = (s && s.tiers) || [];
        const tiersHtml = tiers.map((t) => {
            const rango = t.max === null
                ? `más de ${money(t.max === null ? t.min : t.max)}`
                : (t.min === 0 ? `hasta ${money(t.max)}` : `${money(t.min)} a ${money(t.max)}`);
            return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;
                        padding:9px 12px;background:rgba(255,255,255,0.04);border-radius:9px;
                        border-left:3px solid ${t.color};">
                        <span style="font-size:13px;font-weight:800;color:#fff;">${t.emoji} ${t.name}</span>
                        <span style="font-size:11px;color:#aaa;flex:1;text-align:center;">${rango}</span>
                        <span style="font-size:14px;font-weight:900;color:${t.color};">${t.pct}%</span>
                    </div>`;
        }).join('');

        // Estado por período: rango actual + cuánto falta para el siguiente.
        const periodo = (label, d) => {
            if (!d || !d.tier) return '';
            const t = d.tier;
            const falta = t.faltaParaSubir != null && t.next
                ? `<div style="font-size:11px;color:#ffd479;margin-top:3px;">
                     Te faltan <strong>${money(t.faltaParaSubir)}</strong> de pérdida para ${t.next.emoji} ${t.next.name} (${t.next.pct}%)
                   </div>`
                : `<div style="font-size:11px;color:#7fe07f;margin-top:3px;">¡Estás en el rango máximo! 🎉</div>`;
            return `<div style="padding:10px 12px;background:rgba(0,0,0,0.25);border-radius:10px;margin-bottom:8px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                            <span style="font-size:12px;font-weight:800;color:#d4af37;">${label}</span>
                            <span style="font-size:12px;font-weight:900;color:${t.color};">${t.emoji} ${t.name} · ${t.pct}%</span>
                        </div>
                        <div style="font-size:11px;color:#aaa;margin-top:3px;">
                            Perdiste ${money(d.netAmount)} · te corresponden <strong style="color:#7fe07f;">${money(d.potentialAmount)}</strong>
                        </div>
                        ${falta}
                    </div>`;
        };

        let overlay = document.getElementById('profileModal');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'profileModal';
            overlay.style.cssText =
                'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.85);display:flex;' +
                'align-items:center;justify-content:center;padding:16px;overflow-y:auto;';
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) VIP.refunds.closeProfileModal();
            });
            document.body.appendChild(overlay);
        }

        overlay.innerHTML =
            `<div style="background:linear-gradient(135deg,#1a0033,#2d0052);border:1px solid rgba(212,175,55,0.4);
                        border-radius:16px;max-width:420px;width:100%;padding:18px;max-height:92vh;overflow-y:auto;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                    <span style="font-size:17px;font-weight:900;color:#d4af37;">👤 Mi perfil</span>
                    <button type="button" onclick="VIP.refunds.closeProfileModal()"
                        style="background:none;border:none;color:#888;font-size:22px;cursor:pointer;line-height:1;">×</button>
                </div>

                <div style="background:rgba(0,0,0,0.3);border-radius:10px;padding:12px;margin-bottom:14px;">
                    <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;">
                        <span style="color:#aaa;font-size:12px;">Usuario</span>
                        <span style="color:#fff;font-size:12px;font-weight:800;">${user.username || '—'}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;gap:8px;">
                        <span style="color:#aaa;font-size:12px;">Saldo</span>
                        <span style="color:#7fe07f;font-size:12px;font-weight:800;">${money((s && s.user && s.user.currentBalance) || user.balance || 0)}</span>
                    </div>
                </div>

                <div style="font-size:13px;font-weight:800;color:#d4af37;margin-bottom:8px;">🏆 Tus rangos</div>
                <div style="font-size:11px;color:#999;margin-bottom:10px;line-height:1.45;">
                    Cuanto más perdés en un período, mayor es el porcentaje que te devolvemos.
                    El rango se calcula por separado en cada reembolso.
                </div>
                ${periodo('📅 Diario', s && s.daily)}
                ${periodo('🗓️ Semanal', s && s.weekly)}
                ${periodo('📆 Mensual', s && s.monthly)}

                <div style="font-size:13px;font-weight:800;color:#d4af37;margin:14px 0 8px;">Escala de rangos</div>
                <div style="display:flex;flex-direction:column;gap:6px;">${tiersHtml}</div>

                <button type="button" onclick="VIP.refunds.closeProfileModal()"
                    style="width:100%;margin-top:16px;background:linear-gradient(135deg,#6a0dad,#9b30ff);color:#fff;
                           border:none;padding:12px;border-radius:22px;font-weight:800;font-size:14px;cursor:pointer;">
                    Cerrar</button>
            </div>`;
        overlay.style.display = 'flex';
    }

    function closeProfileModal() {
        const overlay = document.getElementById('profileModal');
        if (overlay) overlay.style.display = 'none';
    }

    return {
        loadRefundStatus,
        updateRefundButtons,
        updateRefundButton,
        startCountdown,
        showRefundModal,
        claimRefund,
        showUnifiedRefundModal,
        showProfileModal,
        closeProfileModal
    };

})();

// Window aliases
window.showRefundModal = VIP.refunds.showRefundModal;
window.claimRefund     = VIP.refunds.claimRefund;
