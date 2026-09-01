// ========================================
// UI - User-interface utilities module
// ========================================

window.VIP = window.VIP || {};

VIP.ui = (function () {

    // ---- Modal helpers ----

    function showModal(modalId) {
        document.getElementById(modalId).classList.remove('hidden');
    }

    function hideModal(modalId) {
        if (modalId === 'changePasswordModal' && VIP.state.passwordChangePending) {
            return;
        }
        document.getElementById(modalId).classList.add('hidden');

        // Reset OTP step states when closing modals
        if (modalId === 'resetPassModal') {
            const s1 = document.getElementById('resetStep1');
            const s2 = document.getElementById('resetStep2');
            const s3 = document.getElementById('resetStep3');
            if (s1) s1.style.display = '';
            if (s2) s2.style.display = 'none';
            if (s3) s3.style.display = 'none';
        }
        if (modalId === 'registerModal') {
            const s1 = document.getElementById('registerStep1');
            if (s1) s1.style.display = '';
        }
    }

    // ---- Toast & copy ----

    function showToast(message, type = 'success') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), 3000);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            showToast('✅ Copiado');
        } catch (error) {
            showToast('Error al copiar', 'error');
        }
    }

    function copyToClipboard(elementId) {
        const element = document.getElementById(elementId);
        const text = element.textContent;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('📋 Copiado al portapapeles', 'success');
            }).catch(() => { fallbackCopy(text); });
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity  = '0';
        document.body.appendChild(el);
        el.focus();
        el.select();
        try { document.execCommand('copy'); showToast('✅ Copiado', 'success'); } catch (e) {}
        document.body.removeChild(el);
    }

    // ---- Screen switching ----

    function showLoginScreen() {
        // Sacar el splash de arranque (#253): acá SÍ hay que ver el login.
        try { document.documentElement.classList.remove('casino-boot'); } catch (e) {}
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('chatScreen').classList.add('hidden');
    }

    function showChatScreen() {
        // Splash de arranque (#253): para roles que NO van al casino se saca ya;
        // para clientes, lo saca _showCasinoFrame al abrir el casino. Red de
        // seguridad: si a los 4s el casino no abrió (modal de cambio de clave,
        // error de SSO, etc.), se saca igual para no dejar la pantalla tapada.
        try {
            const _role = VIP.state.currentUser && VIP.state.currentUser.role;
            if (_role && _role !== 'user') document.documentElement.classList.remove('casino-boot');
            else setTimeout(function () {
                try { if (!VIP.ui._casinoOpen) document.documentElement.classList.remove('casino-boot'); } catch (e) {}
            }, 4000);
        } catch (e) {}
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('chatScreen').classList.remove('hidden');
        const _username = VIP.state.currentUser?.username || 'Usuario';
        const _curUser = document.getElementById('currentUser');
        if (_curUser) _curUser.textContent = _username;
        const _dashUser = document.getElementById('dashUserName');
        if (_dashUser) _dashUser.textContent = _username;

        adjustLayout();
        syncBalance();
        startBalancePolling();
        sendWelcomeMessages();

        // Cartel del bono por instalar la app (se muestra si no lo reclamó aún).
        if (VIP.installBonus && typeof VIP.installBonus.init === 'function') {
            VIP.installBonus.init();
        }

        // Encuesta de notificaciones: aparece una sola vez para que el
        // usuario elija su grupo (suave / normal / activo / solo reembolsos).
        if (VIP.notifSurvey && typeof VIP.notifSurvey.maybeShow === 'function') {
            VIP.notifSurvey.maybeShow();
        }
        // NOTA: el welcome del publicista NO se muestra acá. Se muestra
        // pre-auth desde app.js al cargar la página si el visitante llegó
        // por una vanity URL / ?p=CODE. Ver public/js/publisherwelcome.js.
    }

    // ---- Layout ----

    function adjustLayout() {
        // El layout ahora es una columna flex (.chat-screen): el header y la
        // barra de escribir están en el flujo normal y el chat ocupa el resto
        // con flex:1. No hace falta compensar con márgenes.
    }

    // ---- Balance ----

    async function syncBalance() {
        if (!VIP.state.currentToken || !VIP.state.currentUser) return;

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/balance/live`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.balance !== undefined) {
                    VIP.state.currentUser.balance = data.balance;
                    updateBalanceDisplay(data.balance);

                    const previousBalance = parseFloat(localStorage.getItem('lastBalance') || '0');
                    const newBalance      = parseFloat(data.balance);
                    if (Math.abs(newBalance - previousBalance) > 0.01) {
                        localStorage.setItem('lastBalance', newBalance);
                        if (newBalance > previousBalance) {
                            // Subió el saldo (carga/premio): invitación grande al
                            // casino en vez del toast chico (owner 2026-08-05).
                            showCasinoInvite(newBalance);
                        } else {
                            showBalanceToast(newBalance);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error sincronizando saldo:', error);
        }
    }

    // Saldo empujado por SOCKET (el server emite `balance_updated` al acreditar
    // una carga, premio o devolución): mismo tratamiento que el polling, pero
    // instantáneo — el cliente ve la invitación al casino apenas el agente carga.
    function handleBalancePush(balance) {
        const newBalance = parseFloat(balance);
        if (!Number.isFinite(newBalance)) return;
        if (VIP.state.currentUser) VIP.state.currentUser.balance = newBalance;
        updateBalanceDisplay(newBalance);
        const previousBalance = parseFloat(localStorage.getItem('lastBalance') || '0');
        if (Math.abs(newBalance - previousBalance) > 0.01) {
            localStorage.setItem('lastBalance', newBalance);
            if (newBalance > previousBalance) {
                // CARTEL GRANDE + sonido SIEMPRE que se acredite (auto o manual
                // del admin) — el cliente se da cuenta (owner 2026-08-21). El
                // cartel de invitación viejo solo si NO está en el casino.
                if (VIP.ui.casinoBotDepositConfirmed) {
                    try { VIP.ui.casinoBotDepositConfirmed(newBalance); } catch (e) {}
                } else {
                    showCasinoInvite(newBalance);
                }
            } else {
                showBalanceToast(newBalance);
            }
        }
    }

    // ---- Invitación al casino tras una carga (owner 2026-08-05) ----
    // Cuando el saldo SUBE, un recuadro grande y bien visible invita a entrar al
    // casino YA LOGUEADO (VIP.ui.enterCasino, el SSO de siempre). Se va solo a
    // los 15 segundos (barra de tiempo incluida) o con la ✕. Throttle de 60s:
    // el evento puede llegar por socket Y por el polling de saldo — una sola vez.
    let _lastCasinoInviteAt = 0;
    let _casinoInviteTimer = null;

    function showCasinoInvite(balance) {
        const now = Date.now();
        if (now - _lastCasinoInviteAt < 60000) return;
        if (!VIP.state.currentUser) return;
        if (VIP.ui._casinoOpen) return; // ya está jugando: no tapar el casino
        _lastCasinoInviteAt = now;

        let box = document.getElementById('casinoInviteBox');
        if (!box) {
            box = document.createElement('div');
            box.id = 'casinoInviteBox';
            box.style.cssText =
                'position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:19000;' +
                'width:min(92vw,380px);background:linear-gradient(150deg,#1a0033,#2d0052);' +
                'border:2px solid #ffd700;border-radius:18px;padding:18px 16px 14px;text-align:center;' +
                'box-shadow:0 12px 44px rgba(212,175,55,0.6);display:none;';
            document.body.appendChild(box);
        }
        const amt = Number(balance) || 0;
        box.innerHTML =
            '<button type="button" onclick="VIP.ui.hideCasinoInvite()" ' +
                'style="position:absolute;top:6px;right:10px;background:none;border:none;color:#999;font-size:20px;cursor:pointer;line-height:1;">×</button>' +
            '<div style="font-size:30px;line-height:1;margin-bottom:6px;">💰</div>' +
            '<div style="color:#00ff88;font-weight:900;font-size:16px;margin-bottom:2px;">¡Saldo acreditado!</div>' +
            '<div style="color:#fff;font-weight:800;font-size:22px;margin-bottom:10px;">$' + amt.toLocaleString('es-AR') + '</div>' +
            '<button type="button" onclick="VIP.ui.hideCasinoInvite();VIP.ui.enterCasino();" ' +
                'style="width:100%;background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;' +
                'padding:14px;border-radius:26px;font-weight:900;font-size:16px;cursor:pointer;' +
                'box-shadow:0 4px 16px rgba(212,175,55,0.5);">🎰 JUGAR AHORA EN 1GIROX</button>' +
            '<div style="color:#aaa;font-size:10.5px;margin-top:7px;">Entrás directo, con tu sesión ya iniciada</div>' +
            // 🪦 Acá iba el cartel informativo del código de $5.000: reemplazado
            // (owner 2026-08-05) por la mini-ENCUESTA de Comunidad de abajo.
            (localStorage.getItem('communitySurveyDone') === '1' ? '' :
            '<div id="casinoInviteSurvey" style="margin-top:9px;padding:9px 10px;background:rgba(41,169,235,0.10);border:1px solid rgba(41,169,235,0.45);border-radius:10px;">' +
                '<div style="color:#9ad8f7;font-size:11.5px;font-weight:800;">📣 ¿Ya estás en nuestra Comunidad de Telegram?</div>' +
                '<div style="color:#8fb9cc;font-size:10px;margin-top:2px;">Bonos, códigos gratis y avisos exclusivos.</div>' +
                '<div style="display:flex;gap:8px;margin-top:8px;">' +
                    '<button type="button" onclick="VIP.ui.casinoInviteJoinCommunity()" ' +
                        'style="flex:1;background:linear-gradient(135deg,#29a9eb,#53bdeb);color:#fff;border:none;padding:9px 6px;border-radius:18px;font-weight:900;font-size:12px;cursor:pointer;">🚀 SÍ, quiero entrar</button>' +
                    '<button type="button" onclick="VIP.ui.casinoInviteAlreadyIn()" ' +
                        'style="flex:1;background:rgba(255,255,255,0.10);color:#cde;border:1px solid rgba(255,255,255,0.25);padding:9px 6px;border-radius:18px;font-weight:800;font-size:12px;cursor:pointer;">✅ Ya estoy en la Comunidad</button>' +
                '</div>' +
            '</div>') +
            '<div style="height:3px;background:rgba(255,255,255,0.12);border-radius:2px;margin-top:9px;overflow:hidden;">' +
                '<div id="casinoInviteBar" style="height:100%;width:100%;background:#ffd700;transition:width 15s linear;"></div></div>';
        box.style.display = 'block';

        // Barra de tiempo: 100% → 0 en los 15s de vida del recuadro.
        requestAnimationFrame(function () {
            const bar = document.getElementById('casinoInviteBar');
            if (bar) requestAnimationFrame(function () { bar.style.width = '0%'; });
        });
        clearTimeout(_casinoInviteTimer);
        _casinoInviteTimer = setTimeout(hideCasinoInvite, 15000);
    }

    function hideCasinoInvite() {
        clearTimeout(_casinoInviteTimer);
        const box = document.getElementById('casinoInviteBox');
        if (box) box.style.display = 'none';
    }

    // ---- Mini-encuesta de Comunidad dentro de la invitación al casino ----
    // "SÍ, quiero entrar" → abre la Comunidad de Telegram (el link que se carga
    // en el panel → sección Comandos → card Comunidad; chat.js lo mantiene
    // aplicado en el pill del header, con fallback al dominio propio).
    // Cualquiera de las dos respuestas queda recordada: la encuesta no se
    // repite en próximas cargas (localStorage), el resto del cartel sigue igual.
    function casinoInviteJoinCommunity() {
        try { localStorage.setItem('communitySurveyDone', '1'); } catch (e) {}
        const pill = document.getElementById('canalTelegramHeaderBtn');
        // Fallback /go/comunidad: el server redirige al link vigente de la config
        // (owner 2026-08-06 — nunca más el 404 de canal-proximamente).
        const url = (pill && pill.href) || '/go/comunidad';
        window.open(url, '_blank', 'noopener');
        const s = document.getElementById('casinoInviteSurvey');
        if (s) s.style.display = 'none';
    }

    function casinoInviteAlreadyIn() {
        try { localStorage.setItem('communitySurveyDone', '1'); } catch (e) {}
        const s = document.getElementById('casinoInviteSurvey');
        if (s) s.style.display = 'none';
        showToast('¡Genial! 🙌 Gracias por estar en la Comunidad', 'success');
    }

    function showBalanceToast(balance) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 100px;
            right: 20px;
            background: linear-gradient(135deg, #00ff88 0%, #00cc6a 100%);
            color: #000;
            padding: 15px 25px;
            border-radius: 12px;
            font-weight: bold;
            font-size: 16px;
            z-index: 10000;
            animation: slideIn 0.3s ease;
            box-shadow: 0 5px 20px rgba(0, 255, 136, 0.4);
        `;
        toast.innerHTML = `💰 Saldo actualizado: <span style="font-size: 20px;">$${balance.toLocaleString()}</span>`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function updateBalanceDisplay(balance) {
        const balanceElement = document.getElementById('userBalance');
        if (balanceElement) {
            balanceElement.textContent = `$${balance.toLocaleString()}`;
        }
    }

    function startBalancePolling() {
        if (VIP.state.balanceCheckInterval) {
            clearInterval(VIP.state.balanceCheckInterval);
        }
        // 90s (antes 30s): el poll de saldo por-usuario era la causa raíz del lag
        // — para jugadores de un publicista TODAS las lecturas van por una única
        // key (30/min) y con pocos usuarios online se saturaba (logs 2026-08-16).
        // El saldo igual se actualiza al instante por socket (`balance_updated`)
        // en cargas/retiros/bonos, y al cerrar el casino (syncBalance). El poll
        // solo cubre cambios por juego mientras el cliente mira la PWA sin jugar.
        VIP.state.balanceCheckInterval = setInterval(syncBalance, 90000);
    }

    function stopBalancePolling() {
        if (VIP.state.balanceCheckInterval) {
            clearInterval(VIP.state.balanceCheckInterval);
            VIP.state.balanceCheckInterval = null;
        }
    }

    // ---- Welcome message ----

    async function sendWelcomeMessages() {
        const welcomeKey  = 'lastWelcome_' + (VIP.state.currentUser?.userId || '');
        const lastWelcome = parseInt(localStorage.getItem(welcomeKey) || '0');
        const hoursSince  = (Date.now() - lastWelcome) / 3600000;
        if (hoursSince < 24) {
            return;
        }

        // La bienvenida ahora la genera el BACKEND como mensaje de sistema
        // (lado admin), no el cliente. Antes se mandaba con el token del
        // usuario vía sendSystemMessage → quedaba registrada con
        // senderRole='user' y aparecía como si la hubiera escrito el propio
        // usuario. El endpoint /api/messages/welcome la crea con
        // senderRole='admin' y tiene su propio throttle de 24h server-side.
        //
        // CON REINTENTOS (fix 2026-08-05): antes un fallo de red se tragaba en
        // silencio y sin retry → el cliente entraba (típico: por link de acceso
        // en una red lenta/Tor) con el chat VACÍO, y como la bienvenida es la
        // que crea el ChatStatus, el chat tampoco aparecía del lado del admin
        // hasta que el cliente escribiera o recargara la página.
        const delays = [0, 2500, 7000]; // 3 intentos
        for (let i = 0; i < delays.length; i++) {
            if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
            try {
                const response = await fetch(`${VIP.config.API_URL}/api/messages/welcome`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${VIP.state.currentToken}`
                    }
                });
                if (response.ok) {
                    // Refrescar el chat para mostrar los mensajes recién creados.
                    setTimeout(() => { try { VIP.chat.loadMessages(); } catch (e) {} }, 300);
                    localStorage.setItem(welcomeKey, Date.now().toString());
                    return;
                }
                // 4xx (ej. 401 por sesión a medio armar): reintentar igual — el
                // endpoint es idempotente (throttle server-side de 24h).
            } catch (error) {
                // red caída/lenta: probamos de nuevo con el próximo delay
            }
        }
        console.warn('[welcome] no se pudo enviar la bienvenida tras 3 intentos (se reintenta en la próxima carga)');
    }

    // ---- CBU ----

    async function loadAndShowCBU() {
        const now = Date.now();
        if (now - VIP.state.lastCbuClickTime < VIP.config.CBU_CLICK_COOLDOWN_MS) {
            showToast('Espera unos segundos antes de volver a solicitar el CBU.', 'info');
            return;
        }
        VIP.state.lastCbuClickTime = now;

        try {
            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            const response = await fetch(`${VIP.config.API_URL}/api/cbu/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ metaEventId })
            });

            if (response.ok) {
                const data = await response.json();
                document.getElementById('cbuBankDisplay').textContent    = data.cbu.bank    || '-';
                document.getElementById('cbuTitularDisplay').textContent = data.cbu.titular || '-';
                document.getElementById('cbuNumberDisplay').textContent  = data.cbu.number  || '-';
                document.getElementById('cbuAliasDisplay').textContent   = data.cbu.alias   || '-';

                showModal('cbuModal');
                setTimeout(() => VIP.chat.loadMessages(), 500);
                showToast('💳 Datos CBU enviados al chat', 'success');

                // Meta Pixel — InitiateCheckout (usuario va a depositar).
                if (VIP.pixel) VIP.pixel.trackWithId(metaEventId, 'InitiateCheckout', { content_name: 'cbu_request' });
            } else {
                showToast('Error solicitando CBU', 'error');
            }
        } catch (error) {
            console.error('Error solicitando CBU:', error);
            showToast('Error de conexión', 'error');
        }
    }

    // ---- Referrals ----

    async function openReferralModal() {
        showModal('referralModal');
        await loadReferralData();
    }

    async function loadReferralData() {
        const histContainer = document.getElementById('referralPayoutHistory');
        if (histContainer) histContainer.innerHTML = '<span style="color:#888;font-size:12px;">Cargando...</span>';

        try {
            const [meRes, histRes] = await Promise.all([
                fetch(`${VIP.config.API_URL}/api/referrals/me`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                }),
                fetch(`${VIP.config.API_URL}/api/referrals/history?limit=20`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                })
            ]);

            if (!meRes.ok) {
                if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
                return;
            }
            const meData = await meRes.json();
            const me = meData.data;

            document.getElementById('myReferralCode').textContent = me.referralCode || '—';
            document.getElementById('myReferralLink').textContent = me.referralLink || '—';
            const activeCountEl = document.getElementById('referralActiveCount');
            if (activeCountEl) activeCountEl.textContent = me.activeReferred != null ? me.activeReferred : (me.totalReferred || 0);
            document.getElementById('referralHistoricalTotal').textContent =
                '$' + new Intl.NumberFormat('es-AR').format(Math.round(me.historicalTotalCredited || 0));
            document.getElementById('referralCurrentPeriod').textContent = me.currentPeriodLabel || me.currentPeriod || '—';

            VIP.state.referralData = me;

            try {
                const sumRes = await fetch(`${VIP.config.API_URL}/api/referrals/summary`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                });
                if (sumRes.ok) {
                    const sumData = await sumRes.json();
                    const sum = sumData.data;
                    document.getElementById('referralPendingAmount').textContent =
                        '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.pendingEstimatedAmount || 0));
                    document.getElementById('referralCreditDate').textContent =
                        sum.estimatedCreditDate || 'Inicio del próximo mes';
                    const lastPayoutEl = document.getElementById('referralLastPayoutAmount');
                    if (lastPayoutEl) {
                        if (sum.lastPayout && sum.lastPayout.amount > 0) {
                            lastPayoutEl.textContent = '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.lastPayout.amount));
                            lastPayoutEl.title = sum.lastPayout.periodLabel || sum.lastPayout.periodKey || '';
                        } else {
                            lastPayoutEl.textContent = '—';
                        }
                    }
                }
            } catch (e) { /* ignorar */ }

            const EMPTY_HISTORY_HTML = '<span style="color:#888;font-size:12px;">Todavía no tenés pagos por referidos.</span>';

            if (histRes.ok) {
                const histData = await histRes.json();
                const payouts  = histData.data?.payouts || [];
                if (payouts.length === 0) {
                    histContainer.innerHTML = EMPTY_HISTORY_HTML;
                } else {
                    const byPeriod = new Map();
                    for (const p of payouts) {
                        const key = p.periodKey || '?';
                        if (!byPeriod.has(key)) byPeriod.set(key, []);
                        byPeriod.get(key).push(p);
                    }

                    const statusBadgeHtml = (status) => {
                        if (status === 'paid')
                            return '<span style="background:rgba(0,255,136,0.12);border:1px solid rgba(0,255,136,0.4);color:#00ff88;font-size:10px;border-radius:4px;padding:2px 6px;">✅ Pagado</span>';
                        if (status === 'failed')
                            return '<span style="background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.4);color:#ff4444;font-size:10px;border-radius:4px;padding:2px 6px;">❌ Fallido</span>';
                        if (status === 'cancelled')
                            return '<span style="background:rgba(136,136,136,0.12);border:1px solid rgba(136,136,136,0.4);color:#888;font-size:10px;border-radius:4px;padding:2px 6px;">🚫 Cancelado</span>';
                        return '<span style="background:rgba(247,147,30,0.12);border:1px solid rgba(247,147,30,0.4);color:#f7931e;font-size:10px;border-radius:4px;padding:2px 6px;">⏳ Pendiente</span>';
                    };

                    let html = '';
                    for (const [pk, periodPayouts] of byPeriod) {
                        const label    = periodPayouts[0].periodLabel || pk;
                        const paidTotal = periodPayouts
                            .filter(p => p.status === 'paid')
                            .reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
                        const hasMultiple = periodPayouts.length > 1;

                        html += `<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.05);">`;
                        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
                        html += `<span style="font-size:12px;color:#d4af37;font-weight:600;">📅 ${label}</span>`;
                        if (paidTotal > 0)
                            html += `<span style="font-size:12px;color:#00ff88;font-weight:bold;">$${new Intl.NumberFormat('es-AR').format(Math.round(paidTotal))}</span>`;
                        html += `</div>`;

                        for (const p of periodPayouts) {
                            const isDelta = p.isDelta || (p.payoutIndex || 1) > 1;
                            const amount  = p.totalCommissionAmount || 0;
                            html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;${hasMultiple ? 'padding-left:8px;' : ''}">`;
                            html += `<div style="display:flex;align-items:center;gap:6px;">`;
                            if (isDelta)
                                html += `<span style="background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.35);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>`;
                            html += `${statusBadgeHtml(p.status)}`;
                            html += `</div>`;
                            html += `<span style="font-size:13px;color:${p.status === 'paid' ? '#d4af37' : '#888'};font-weight:${p.status === 'paid' ? '600' : 'normal'};">$${new Intl.NumberFormat('es-AR').format(Math.round(amount))}</span>`;
                            html += `</div>`;
                        }
                        html += `</div>`;
                    }
                    histContainer.innerHTML = html;
                }
            } else {
                histContainer.innerHTML = EMPTY_HISTORY_HTML;
            }
        } catch (err) {
            console.error('[Referrals] Error cargando datos:', err);
            if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
        }
    }

    function copyReferralCode() {
        const code = document.getElementById('myReferralCode').textContent;
        if (code && code !== '—') {
            navigator.clipboard.writeText(code).then(() => {
                showToast('✅ Código copiado', 'success');
            }).catch(() => { fallbackCopy(code); });
        }
    }

    function copyReferralLink() {
        const link = document.getElementById('myReferralLink').textContent;
        if (link && link !== '—') {
            navigator.clipboard.writeText(link).then(() => {
                showToast('✅ Link copiado', 'success');
            }).catch(() => { fallbackCopy(link); });
        }
    }

    // ---- Canal informativo (delegated from chat module) ----

    function loadCanalInformativoUrl() {
        return VIP.chat.loadCanalInformativoUrl();
    }

    // ---- PWA install ----

    async function installApp() {
        const ua        = navigator.userAgent;
        const isIOS     = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        const isAndroid = /Android/.test(ua);
        const isWindows = /Windows/.test(ua);
        const isMac     = /Macintosh|MacIntel/.test(ua) && !isIOS;

        if (!window.deferredPrompt) {
            if (isIOS)          showInstallInstructions('ios');
            else if (isAndroid) showInstallInstructions('android');
            else if (isWindows) showInstallInstructions('windows');
            else if (isMac)     showInstallInstructions('mac');
            else                showInstallInstructions('generic');
            return;
        }

        window.deferredPrompt.prompt();
        const { outcome } = await window.deferredPrompt.userChoice;

        if (outcome === 'accepted') {
            showToast('✅ Instalando app...', 'success');
            // Recordatorio de notificaciones para Android (flujo directo via deferredPrompt)
            setTimeout(() => {
                showInstallInstructions('android-notif');
            }, 2000);
        } else {
            showToast('❌ Instalación cancelada', 'error');
        }
        window.deferredPrompt = null;
    }

    function showInstallInstructions(platform) {
        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';

        let title, steps, note;
        // Plataformas móviles: se muestra el aviso de notificaciones
        const isMobilePlatform = platform === 'ios' || platform === 'android' || platform === 'android-notif';

        // Pantalla dedicada de recordatorio de notificaciones post-instalación (Android nativo)
        if (platform === 'android-notif') {
            modal.innerHTML = `
                <div class="ios-install-content">
                    <h3>🔔 Un paso más</h3>
                    <div style="
                        background: rgba(255, 107, 53, 0.15);
                        border: 2px solid #ff6b35;
                        border-radius: 10px;
                        padding: 14px 16px;
                        text-align: left;
                    ">
                        <p style="margin: 0; color: #ff6b35; font-weight: bold; font-size: 15px;">
                            🔔 LO MÁS IMPORTANTE: PERMITIR NOTIFICACIONES
                        </p>
                        <p style="margin: 10px 0 0; color: #fff; font-size: 13px;">
                            Cuando abras la app instalada y te pida acceso,
                            <strong>aceptá y permitir notificaciones</strong>.<br>
                            Sin esto, <u>no te van a llegar los avisos importantes</u>.
                        </p>
                    </div>
                    <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
                </div>
            `;
            document.body.appendChild(modal);
            return;
        }

        if (platform === 'ios') {
            title = '📱 Instalar en iPhone / iPad';
            note  = '⚠️ <strong>Solo funciona desde Safari.</strong>';
            steps = [
                'Abrí esta página en <strong>Safari</strong> (no Chrome, no otro navegador)',
                'Tocá el botón <strong>Compartir</strong> <span style="font-size:18px">⬆️</span> en la barra inferior de Safari',
                'Deslizá hacia abajo y tocá <strong>"Agregar a pantalla de inicio"</strong>',
                'Presioná <strong>"Agregar"</strong>'
            ];
        } else if (platform === 'android') {
            title = '📱 Instalar en Android';
            note  = '⚠️ <strong>Solo funciona desde Google Chrome.</strong>';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong>',
                'Tocá el ícono <strong>⋮</strong> (tres puntos) en la esquina superior derecha',
                'Seleccioná <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong>',
                'Presioná <strong>"Agregar"</strong> o <strong>"Instalar"</strong>'
            ];
        } else if (platform === 'windows') {
            title = '💻 Instalar en Windows (PC)';
            note  = '💡 Funciona en Chrome o Edge.';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong> o <strong>Microsoft Edge</strong>',
                'En Chrome: hacé clic en el ícono de instalación <strong>⊕</strong> en la barra de direcciones',
                'En Edge: hacé clic en el ícono <strong>⊕</strong> o el menú <strong>⋯</strong> → <strong>"Aplicaciones"</strong> → <strong>"Instalar este sitio como aplicación"</strong>',
                'Confirmá la instalación'
            ];
        } else if (platform === 'mac') {
            title = '💻 Instalar en Mac';
            note  = '💡 Funciona en Chrome o Safari.';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong> o <strong>Safari</strong>',
                'En Chrome: hacé clic en el ícono <strong>⊕</strong> en la barra de direcciones',
                'En Safari: usá <strong>Archivo → Agregar a Dock</strong> (macOS Sonoma o superior)',
                'Confirmá la instalación'
            ];
        } else {
            title = '📱 Instalar App';
            note  = '';
            steps = [
                'Abrí esta página en <strong>Chrome</strong> o <strong>Safari</strong>',
                'Buscá la opción <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong> en el menú del navegador',
                'Confirmá la instalación'
            ];
        }

        // Aviso de notificaciones destacado para iOS y Android
        const notifWarning = isMobilePlatform ? `
            <div style="
                background: rgba(255, 107, 53, 0.15);
                border: 2px solid #ff6b35;
                border-radius: 10px;
                padding: 12px 15px;
                margin-top: 15px;
                text-align: left;
            ">
                <p style="margin: 0; color: #ff6b35; font-weight: bold; font-size: 14px;">
                    🔔 LO MÁS IMPORTANTE: PERMITIR NOTIFICACIONES
                </p>
                <p style="margin: 8px 0 0; color: #fff; font-size: 13px;">
                    Una vez instalada, cuando la app te pida acceso, <strong>aceptá y permitir notificaciones</strong>.
                    Sin esto, <u>no te van a llegar los avisos importantes</u>.
                </p>
            </div>` : '';

        modal.innerHTML = `
            <div class="ios-install-content">
                <h3>${title}</h3>
                ${note ? `<p style="color: #f7931e; margin-bottom: 12px;">${note}</p>` : ''}
                <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
                ${notifWarning}
                <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
            </div>
        `;
        document.body.appendChild(modal);
    }

    function isAppInstalled() {
        const standalone = window.matchMedia('(display-mode: standalone)').matches ||
                           window.navigator.standalone === true;
        if (!standalone) return false;
        // Also require notification permission to be granted
        const notifGranted = ('Notification' in window) && Notification.permission === 'granted';
        return notifGranted;
    }

    function isAppStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true;
    }

    return {
        showModal,
        hideModal,
        showToast,
        copyText,
        copyToClipboard,
        fallbackCopy,
        showLoginScreen,
        showChatScreen,
        adjustLayout,
        syncBalance,
        handleBalancePush,
        showCasinoInvite,
        hideCasinoInvite,
        casinoInviteJoinCommunity,
        casinoInviteAlreadyIn,
        showBalanceToast,
        updateBalanceDisplay,
        startBalancePolling,
        stopBalancePolling,
        sendWelcomeMessages,
        loadAndShowCBU,
        openReferralModal,
        loadReferralData,
        copyReferralCode,
        copyReferralLink,
        loadCanalInformativoUrl,
        installApp,
        showInstallInstructions,
        isAppInstalled,
        isAppStandalone
    };

})();

// Window aliases for onclick="..." in HTML
window.showModal             = VIP.ui.showModal;
window.hideModal             = VIP.ui.hideModal;
window.showToast             = VIP.ui.showToast;
window.copyText              = VIP.ui.copyText;
window.copyToClipboard       = VIP.ui.copyToClipboard;
window.copyReferralCode      = VIP.ui.copyReferralCode;
window.copyReferralLink      = VIP.ui.copyReferralLink;
window.installApp            = VIP.ui.installApp;
window.showInstallInstructions = VIP.ui.showInstallInstructions;

// ---- PWA install prompt event handlers (must be top-level) ----

window.deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
        return;
    }
    window.deferredPrompt = e;
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'flex'; loginInstallBtn.classList.remove('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'flex'; headerInstallBtn.classList.remove('hidden'); }
    if (appInstallBtn)    { appInstallBtn.style.display = 'flex'; appInstallBtn.classList.add('show'); }
});

window.addEventListener('appinstalled', () => {
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    if (appInstallBtn)    { appInstallBtn.classList.add('hidden'); }
    window.deferredPrompt = null;
    VIP.ui.showToast('✅ App instalada exitosamente', 'success');
});

// Hide install buttons if already running as standalone
if (VIP.ui.isAppStandalone()) {
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    if (appInstallBtn)    { appInstallBtn.classList.add('hidden'); }
}


// Platform modal — private state (no DOM exposure for sensitive data)
VIP.ui._platformPasswordVisible = false;

VIP.ui._copyUsernameToClipboard = function(username, onSuccess) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(username).then(onSuccess).catch(function() {
      VIP.ui.showToast('👤 Tu usuario: ' + username, 'info');
    });
  } else {
    VIP.ui.showToast('👤 Tu usuario: ' + username, 'info');
  }
};

VIP.ui.openPlatformModal = function() {
  const modal = document.getElementById('platformModal');
  if (!modal) return;
  const username = VIP.state.currentUser?.username || '';
  const userEl = document.getElementById('platformModalUser');
  if (userEl) userEl.textContent = username || 'Usuario';

  // Mostrar contraseña si está disponible en memoria de sesión (sin exponerla en el DOM)
  const pwd = VIP.state.sessionPassword || '';
  VIP.ui._platformPasswordVisible = false;
  const pwdEl = document.getElementById('platformModalPassword');
  const pwdInputSection = document.getElementById('platformPasswordInputSection');
  const pwdToggle = document.getElementById('platformPasswordToggle');
  if (pwdEl) {
    pwdEl.textContent = pwd ? '••••••••' : '—';
    if (pwdToggle) pwdToggle.textContent = '👁';
  }
  if (pwdInputSection) pwdInputSection.style.display = pwd ? 'none' : 'block';

  // Resetear feedback de copia
  const feedback = document.getElementById('platformCopyFeedback');
  if (feedback) feedback.style.display = 'none';

  modal.style.display = 'flex';

  // Auto-copiar usuario al abrir el modal
  if (username) {
    VIP.ui._copyUsernameToClipboard(username, function() {
      if (feedback) feedback.style.display = 'block';
      VIP.ui.showToast('✅ Usuario copiado: ' + username, 'success');
    });
  }
};

VIP.ui.closePlatformModal = function() {
  const modal = document.getElementById('platformModal');
  if (modal) modal.style.display = 'none';
};

VIP.ui.copyPlatformUsername = function() {
  const username = VIP.state.currentUser?.username || '';
  if (!username) return;
  const feedback = document.getElementById('platformCopyFeedback');
  VIP.ui._copyUsernameToClipboard(username, function() {
    if (feedback) feedback.style.display = 'block';
    VIP.ui.showToast('✅ Usuario copiado: ' + username, 'success');
  });
};

// ============================================
// ENTRAR AL CASINO — login único (SSO) contra 1girox
// ============================================
//
// Antes: se abría el casino y el usuario tenía que copiar y pegar su usuario y
// contraseña a mano. Ahora el backend pide un link de acceso directo
// (POST /api/platform/session → 1girox POST /players/{username}/session) y el
// usuario entra ya logueado.
//
// ⚠️ POP-UP BLOCKER: el link viene de un fetch (asíncrono) y los navegadores —sobre
// todo en mobile— bloquean window.open si no ocurre DENTRO del gesto del usuario.
// Por eso la pestaña se abre PRIMERO, vacía, y recién después se le cambia la URL.
// Además el código de acceso vence a los 60 segundos, así que no se cachea nada.
VIP.ui._casinoOpening = false;

/**
 * Abre el casino EMBEBIDO en un recuadro a pantalla completa, dentro de la PWA.
 * El jugador nunca sale de VIPCARGAS: cierra el recuadro con la ✕ y vuelve al chat.
 *
 * Orden de las cosas (importa):
 *   1. Se muestra el recuadro con un "cargando" — INMEDIATO, en el mismo click.
 *   2. Recién ahí se pide el link de acceso al backend.
 *   3. Apenas llega, se carga en el iframe.
 *
 * ⚠️ Por qué se pide el link DESPUÉS de abrir el recuadro y no antes: el código de
 * acceso vence a los 60 SEGUNDOS y es de un solo uso. Cuanto menos tiempo pase entre
 * que la plataforma lo emite y el navegador lo usa, mejor. En conexiones lentas (o por
 * Tor) pedirlo antes y usarlo después llegaba vencido: "El enlace expiró".
 */
VIP.ui._casinoOpen = false;

VIP.ui.enterCasino = async function() {
  if (VIP.ui._casinoOpening) return; // anti doble-click
  VIP.ui._casinoOpening = true;

  VIP.ui.closePlatformModal();
  VIP.ui._showCasinoFrame();   // recuadro visible YA, con "cargando"

  try {
    const response = await fetch(`${VIP.config.API_URL}/api/platform/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VIP.state.currentToken}`
      }
    });
    const data = await response.json();

    if (response.ok && data.success && data.redirectUrl) {
      if (data.logoutUrl) VIP.state._casinoLogoutUrl = data.logoutUrl;
      // Carga "fresca": primero mata la sesión anterior de 1girox en el iframe
      // (si conocemos su URL de logout) y recién después el SSO (#252).
      VIP.ui._loadCasinoUrlFresh(data.redirectUrl);
      return;
    }

    VIP.ui._casinoFrameError(data.error || 'No pudimos abrirte el casino en este momento.');
  } catch (error) {
    VIP.ui._casinoFrameError('Sin conexión. Revisá tu internet e intentá de nuevo.');
  } finally {
    VIP.ui._casinoOpening = false;
  }
};

/**
 * Camino RÁPIDO de la landing: el link SSO ya vino adelantado en el canje del
 * access-link (una sola ida al server), así que acá no se pide nada — se abre
 * el recuadro y se carga el casino DIRECTO. El código SSO vence a los 60s pero
 * se usa en el mismo instante en que llegó. Si por lo que sea no hay URL, cae
 * al camino normal (enterCasino pide la sesión como siempre).
 */
VIP.ui.enterCasinoWithUrl = function(url) {
  if (!url) return VIP.ui.enterCasino();
  VIP.ui.closePlatformModal();
  VIP.ui._showCasinoFrame();
  VIP.ui._loadCasinoUrlFresh(url);
};

/**
 * Carga el SSO en el iframe del casino matando ANTES la sesión anterior de
 * 1girox (#252, 2026-08-28). Problema real: en un mismo celular, si el usuario A
 * ya tenía sesión en 1girox (cookie del iframe) y la PWA pasa al usuario B, el
 * link SSO de B podía caer sobre la sesión viva de A → casino = A, chat = B.
 * Si el back nos dio la URL de logout (SSM `GIROX_PLAY_LOGOUT_URL`), primero se
 * navega ahí (borra la cookie), y al `load` (o a los 1500ms, lo que ocurra
 * primero) se carga el SSO. Sin URL de logout, va el SSO directo como antes.
 */
VIP.ui._loadCasinoUrlFresh = function(url) {
  const frame = document.getElementById('casinoFrame');
  if (!frame) return;
  const lo = VIP.state._casinoLogoutUrl;
  let done = false;
  const go = function() {
    if (done) return;
    done = true;
    VIP.ui._casinoLogoutLoading = false;
    frame.src = url;
    // Red de seguridad: aviso "abrir aparte" solo si el iframe no carga en 12s.
    VIP.ui._armCasinoEscape();
  };
  if (!lo || VIP.ui._casinoSessionKilled) { VIP.ui._casinoSessionKilled = false; go(); return; }
  VIP.ui._casinoLogoutLoading = true;
  const onLo = function() { frame.removeEventListener('load', onLo); go(); };
  frame.addEventListener('load', onLo);
  frame.src = lo;
  setTimeout(go, 1500);
};

/** Mata la sesión de 1girox del dispositivo cargando su URL de logout en un
 *  iframe OCULTO (no toca el casino visible). Best-effort; si no hay URL, nada. */
VIP.ui._killCasinoSession = function() {
  const lo = VIP.state._casinoLogoutUrl;
  if (!lo) return;
  try {
    let f = document.getElementById('casinoLogoutFrame');
    if (!f) {
      f = document.createElement('iframe');
      f.id = 'casinoLogoutFrame';
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;';
      document.body.appendChild(f);
    }
    f.src = lo;
    VIP.ui._casinoSessionKilled = true;
  } catch (e) {}
};

/** "Cambiar de cuenta" desde el widget (#252): cierra el casino, mata la sesión
 *  de 1girox y hace el logout de la PWA → pantalla de login. Antes NO había forma
 *  de cerrar sesión en el formato casino (el botón quedó en el menú viejo, tapado),
 *  y la gente cambiaba de usuario ADENTRO de 1girox → chat de A, casino de B. */
VIP.ui.casinoLogout = function() {
  if (!confirm('¿Cerrar sesión para entrar con otra cuenta?')) return;
  try { VIP.ui.casinoRouletteClose(true); } catch (e) {}
  try { if (VIP.auth && VIP.auth.handleLogout) VIP.auth.handleLogout(); } catch (e) {}
};

/**
 * RED DE SEGURIDAD universal (owner 2026-08-21): a los 12s, MUESTRA un aviso
 * discreto abajo del casino para abrirlo APARTE. A diferencia del watchdog,
 * este timer NO se cancela con el `load` del iframe — porque el caso que nos
 * importa (cookies de terceros bloqueadas en Tor / Safari-iPhone) hace que el
 * HTML cargue —load dispara— pero la sesión quede girando adentro, algo que
 * desde afuera no se puede detectar. Para el que le carga bien (Android), el
 * aviso es una barrita chica abajo que puede cerrar con la ✕.
 */
VIP.ui._armCasinoEscape = function() {
  VIP.ui._casinoFrameLoaded = false; // se pone true en el `load` del iframe
  clearTimeout(VIP.ui._casinoEscapeTimer);
  VIP.ui._casinoEscapeTimer = setTimeout(function() {
    if (!VIP.ui._casinoOpen) return;
    // Si el casino YA cargó, no se muestra NADA (aunque adentro esté trabado
    // por cookies, el propio casino muestra su estado). El aviso es solo para
    // cuando el iframe ni siquiera cargó.
    if (VIP.ui._casinoFrameLoaded) return;
    VIP.ui._showCasinoEscapeBar();
  }, 12000);
};

VIP.ui._showCasinoEscapeBar = function() {
  if (VIP.ui._casinoFrameLoaded) return; // cargó bien → sin cartel
  if (document.getElementById('casinoEscapeBar')) return;
  const overlay = document.getElementById('casinoOverlay');
  if (!overlay) return;
  const bar = document.createElement('div');
  bar.id = 'casinoEscapeBar';
  bar.style.cssText =
    'position:absolute;left:12px;right:12px;z-index:8;' +
    'bottom:calc(12px + env(safe-area-inset-bottom,0px));' +
    'background:linear-gradient(135deg,#1a0033,#2d0052);border:1px solid #ffd70066;' +
    'border-radius:14px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,0.6);' +
    'display:flex;flex-direction:column;gap:8px;max-width:520px;margin:0 auto;';
  bar.innerHTML =
    '<button type="button" onclick="VIP.ui._hideCasinoEscapeBar()" ' +
      'style="position:absolute;top:6px;right:10px;background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;">×</button>' +
    '<div style="color:#ffd479;font-weight:800;font-size:13.5px;line-height:1.4;">' +
      '🎰 ¿El juego no termina de abrir?</div>' +
    '<div style="color:#cbb8e6;font-size:12px;line-height:1.45;">' +
      'Tu navegador puede estar bloqueando el casino acá adentro. Tocá para abrirlo aparte y va a funcionar normal.<br>' +
      '<b style="color:#9ad8f7;">💬 Usá ESTA página para cargar o retirar tu saldo.</b></div>' +
    '<button type="button" onclick="VIP.ui.openCasinoInTab()" ' +
      'style="background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;' +
      'padding:12px;border-radius:12px;font-weight:900;font-size:14px;cursor:pointer;">↗ Abrir el juego aparte</button>';
  overlay.appendChild(bar);
};

VIP.ui._hideCasinoEscapeBar = function() {
  const b = document.getElementById('casinoEscapeBar');
  if (b) b.remove();
};

// ============================================================
// ENTRADA POR LANDING v4 (`ir=creds`, owner 2026-08-19): recuadro de
// usuario+clave APENAS carga la PWA. Mientras el cliente lee sus datos, por
// atrás ya se canjeó el link, se conectó el chat y quedó el SSO listo →
// "ENTRAR AL CASINO" abre 1girox al instante (la espera se solapa, no se suma).
// ============================================================

/** Muestra el recuadro de credenciales (lo llama tryAccessLink ANTES del canje;
 *  el botón queda "Preparando…" hasta que el canje confirma). */
VIP.ui._showLandingCredsScreen = function(creds) {
  let ov = document.getElementById('landingCredsOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'landingCredsOverlay';
    ov.style.cssText =
      'position:fixed;inset:0;z-index:99998;background:#0d0d1a;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;padding-top:calc(24px + env(safe-area-inset-top,0px));';
    ov.innerHTML =
      '<div style="width:min(420px,100%);background:#151226;border:1px solid rgba(212,175,55,0.4);' +
      'border-radius:18px;padding:26px 22px;text-align:center;box-shadow:0 14px 44px rgba(0,0,0,0.6);">' +
        '<div style="font-size:34px;">🎰</div>' +
        '<div style="color:#25d366;font-weight:900;font-size:20px;margin:6px 0 2px;">¡Tu cuenta está lista!</div>' +
        '<div style="color:#a7b7a8;font-size:13px;margin-bottom:16px;">Guardá tus datos para volver a entrar cuando quieras.</div>' +
        '<div style="background:#0d0b16;border:1px dashed rgba(212,175,55,0.5);border-radius:12px;' +
        'padding:12px;margin-bottom:18px;text-align:left;">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 2px;">' +
            '<span style="color:#8a8fa3;font-size:13px;">Usuario</span>' +
            '<b id="landingCredsUser" style="color:#fff;font-size:15px;word-break:break-all;">…</b></div>' +
          '<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 2px;">' +
            '<span style="color:#8a8fa3;font-size:13px;">Clave</span>' +
            '<b id="landingCredsPass" style="color:#e3bd48;font-size:15px;">…</b></div>' +
        '</div>' +
        '<button type="button" id="landingCredsEnter" onclick="VIP.ui.landingEnterCasino()" ' +
          'style="width:100%;background:linear-gradient(135deg,#128c4a,#25d366);color:#fff;border:none;' +
          'border-radius:14px;padding:15px;font-size:16px;font-weight:900;cursor:pointer;">⏳ Preparando tu cuenta…</button>' +
      '</div>';
    document.body.appendChild(ov);
  }
  if (creds && creds.username) document.getElementById('landingCredsUser').textContent = creds.username;
  if (creds && creds.password) document.getElementById('landingCredsPass').textContent = creds.password;
  VIP.ui._landingCredsShownAt = Date.now();
  VIP.ui._landingCredsReadyFlag = false;
  ov.style.display = 'flex';
  // AUTO-INICIO a los 10s (owner 2026-08-21): si el cliente se queda mirando,
  // entra solo al casino pasado ese máximo. Solo si el canje ya terminó.
  clearTimeout(VIP.ui._landingAutoEnterTimer);
  VIP.ui._landingAutoEnterTimer = setTimeout(function() {
    if (VIP.state._landingCredsActive && VIP.ui._landingCredsReadyFlag) {
      VIP.ui.landingEnterCasino();
    }
  }, 10000);
};

/** El canje terminó OK: habilita el botón (y completa el usuario si el
 *  fragmento no vino — la clave en ese caso queda en el mensaje del chat).
 *  El botón se habilita recién a los 2 SEGUNDOS de mostrarse la pantalla
 *  (owner 2026-08-21): tiempo mínimo OBLIGATORIO para que el cliente VEA su
 *  usuario — si toca antes, se lo avisa y no lo deja. */
VIP.ui._landingCredsReady = function(username, ssoUrl) {
  VIP.ui._landingSsoUrl = ssoUrl || null;
  VIP.ui._landingSsoAt = Date.now();
  VIP.ui._landingCredsReadyFlag = true;
  const u = document.getElementById('landingCredsUser');
  if (u && username && u.textContent === '…') u.textContent = username;
  const wait = Math.max(0, 2000 - (Date.now() - (VIP.ui._landingCredsShownAt || 0)));
  setTimeout(function() {
    const btn = document.getElementById('landingCredsEnter');
    if (btn) btn.textContent = '🎰 ENTRAR AL CASINO';
  }, wait);
};

VIP.ui._hideLandingCreds = function() {
  const ov = document.getElementById('landingCredsOverlay');
  if (ov) ov.style.display = 'none';
};

/** ENTRAR AL CASINO: usa el SSO adelantado si sigue fresco (el código vive
 *  60s; margen 45s), si no pide uno nuevo — igual es rápido porque la PWA ya
 *  está cargada. Después abre el chat de soporte a la derecha. */
VIP.ui.landingEnterCasino = function() {
  const btn = document.getElementById('landingCredsEnter');
  if (btn && btn.textContent.indexOf('Preparando') !== -1) return; // canje en curso
  // ESPERA OBLIGATORIA de 2s: si toca antes, avisar y no dejar entrar todavía.
  const shown = Date.now() - (VIP.ui._landingCredsShownAt || 0);
  if (shown < 2000) {
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✋ Esperá ' + Math.ceil((2000 - shown) / 1000) + 's — guardá tus datos';
      setTimeout(function() { if (btn.textContent.indexOf('Esperá') !== -1) btn.textContent = orig; }, 1200);
    }
    return;
  }
  clearTimeout(VIP.ui._landingAutoEnterTimer);
  VIP.state._landingCredsActive = false; // el cliente YA tocó ENTRAR
  VIP.ui._hideLandingCreds();
  const url = VIP.ui._landingSsoUrl;
  const fresh = url && (Date.now() - (VIP.ui._landingSsoAt || 0)) < 45000;
  VIP.ui._landingSsoUrl = null;
  if (fresh) VIP.ui.enterCasinoWithUrl(url); else VIP.ui.enterCasino();
  // Panel del ASISTENTE abierto a la derecha apenas el casino está arriba.
  setTimeout(function() {
    try {
      const d = document.getElementById('casinoChatDrawer');
      if (VIP.ui._casinoOpen && d && (d.style.display === 'none' || !d.style.display) && VIP.ui.openCasinoChat) {
        VIP.ui.openCasinoChat();
      }
    } catch (e) {}
  }, 500);
};

/**
 * Abre el casino en una PESTAÑA APARTE (no embebido).
 *
 * Es la salida cuando el navegador no deja que el casino funcione dentro del
 * recuadro. Al abrirse como sitio principal, sus cookies dejan de ser "de terceros"
 * y la sesión funciona normal.
 *
 * ⚠️ La pestaña se abre ANTES del fetch, dentro del gesto del usuario: si se abriera
 * después, el bloqueador de pop-ups (sobre todo en mobile) la mataría.
 * Y se pide un link NUEVO a propósito: el anterior ya lo consumió el iframe y los
 * códigos son de un solo uso.
 */
VIP.ui.openCasinoInTab = async function() {
  let win = null;
  try {
    win = window.open('', '_blank');
    if (win && win.document) {
      win.document.write(
        '<!doctype html><meta charset="utf-8"><title>Entrando al casino…</title>' +
        '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
        'height:100vh;background:#12101a;color:#d4af37;font-family:system-ui,sans-serif;' +
        'font-size:18px;font-weight:700">🎰 Entrando al casino…</body>'
      );
    }
  } catch (e) { win = null; }

  try {
    const response = await fetch(`${VIP.config.API_URL}/api/platform/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VIP.state.currentToken}`
      }
    });
    const data = await response.json();

    if (response.ok && data.success && data.redirectUrl) {
      if (win && !win.closed) {
        win.location.href = data.redirectUrl;
      } else {
        // Pop-up bloqueado → se navega en la pestaña actual.
        window.location.href = data.redirectUrl;
        return;
      }
      VIP.ui.closeCasinoFrame();
      return;
    }
    if (win && !win.closed) win.close();
    VIP.ui.showToast(data.error || 'No pudimos abrirte el casino.', 'error');
  } catch (e) {
    if (win && !win.closed) win.close();
    VIP.ui.showToast('Sin conexión. Intentá de nuevo.', 'error');
  }
};

/** El casino no terminó de cargar dentro del recuadro: se ofrece abrirlo aparte. */
VIP.ui._casinoFrameStuck = function() {
  const status = document.getElementById('casinoFrameStatus');
  const frame = document.getElementById('casinoFrame');
  if (!status) return;
  // El iframe se deja visible por si en realidad terminó de cargar y sólo tardó:
  // el aviso se muestra encima, sin tapar el juego.
  status.style.display = 'flex';
  status.style.position = 'absolute';
  status.style.inset = 'auto 0 0 0';
  status.style.background = 'rgba(13,13,26,0.96)';
  status.style.padding = '18px';
  status.innerHTML =
    '<div style="color:#ffd479;font-size:15px;font-weight:700;line-height:1.45;max-width:460px;">' +
      '¿El casino no termina de cargar?</div>' +
    '<div style="color:#aaa;font-size:13px;font-weight:400;line-height:1.45;max-width:460px;">' +
      'Tu navegador puede estar bloqueando el casino por estar abierto acá adentro. ' +
      'Abrilo aparte y va a funcionar normal.</div>' +
    '<button type="button" onclick="VIP.ui.openCasinoInTab()" ' +
      'style="background:linear-gradient(135deg,#6a0dad,#9b30ff);color:#fff;border:none;' +
      'padding:12px 26px;border-radius:24px;font-weight:800;font-size:15px;cursor:pointer;">' +
      '↗ Abrir el casino aparte</button>' +
    '<button type="button" onclick="document.getElementById(\'casinoFrameStatus\').style.display=\'none\'" ' +
      'style="background:none;color:#888;border:none;font-size:13px;cursor:pointer;">' +
      'Seguir esperando</button>';
  if (frame) frame.style.display = 'block';
};

// (owner 2026-08-25) Removidas las acciones rápidas del pop-up VIEJO del casino
// (_casinoChip / _casinoSendQuick / casinoQuickAction + #casinoAmountRow):
// quedaron sin ningún caller al reemplazar ese pop-up por el asistente/bot
// (casinoBotGo). Código muerto verificado (0 referencias). Ver WORKLOG #234.

/** Crea (una sola vez) y muestra el recuadro del casino. */
VIP.ui._showCasinoFrame = function() {
  let overlay = document.getElementById('casinoOverlay');

  // Paleta del widget en CSS (una vez): claro/oscuro colgado de `body.wa-dark`
  // — el MISMO switch del chat de soporte, así los dos modos SIEMPRE coinciden
  // (owner 2026-08-21). Las burbujas/cajas usan clases, no colores inline.
  if (!document.getElementById('casinoWidgetTheme')) {
    const st = document.createElement('style');
    st.id = 'casinoWidgetTheme';
    st.textContent =
      '#casinoBotArea{background:#ece5dd;}' +
      'body.wa-dark #casinoBotArea{background:#0b141a;}' +
      '.cwB{background:#fff;color:#111b21;box-shadow:0 1px 1px rgba(0,0,0,0.12);}' +
      'body.wa-dark .cwB{background:#202c33;color:#e9edef;box-shadow:0 1px 1px rgba(0,0,0,0.3);}' +
      '.cwTime{color:#8a939b;}body.wa-dark .cwTime{color:#8696a0;}' +
      '.cwBox{background:#f0f2f5;}body.wa-dark .cwBox{background:#111b21;}' +
      '.cwLbl{color:#6b7680;}body.wa-dark .cwLbl{color:#8696a0;}' +
      '.cwVal{color:#111b21;}body.wa-dark .cwVal{color:#e9edef;}' +
      '.cwSec{background:#fff;color:#54656f;border:1px solid #cfd6db;}' +
      'body.wa-dark .cwSec{background:#2a3942;color:#e9edef;border:1px solid #3b4a54;}' +
      '.cwSop{background:#fff;color:#128c4a;border:1.5px solid #128c4a;}' +
      'body.wa-dark .cwSop{background:#2a3942;color:#25d366;border:1.5px solid #25d366;}' +
      '.cwWarn{background:#fff8e1;border:1px solid #f0c36d;color:#8a6d1a;}' +
      'body.wa-dark .cwWarn{background:#332b12;border:1px solid #6b5a22;color:#f0c36d;}' +
      '.cwIn{background:#fff;color:#111b21;border:1px solid #cfd6db;}' +
      'body.wa-dark .cwIn{background:#2a3942;color:#e9edef;border:1px solid #3b4a54;}' +
      '.cwBar{background:#f0f2f5;border-color:#e0e3e7;}' +
      'body.wa-dark .cwBar{background:#1f2c33;border-color:#0b141a;}' +
      '.cwFakeIn{background:#fff;color:#8a939b;}body.wa-dark .cwFakeIn{background:#2a3942;color:#8696a0;}' +
      '.cwFoot{background:#e9edef;}body.wa-dark .cwFoot{background:#15211f;}' +
      '.cwGrn{color:#128c4a;}body.wa-dark .cwGrn{color:#25d366;}' +
      '.cwMut{color:#8a939b;}body.wa-dark .cwMut{color:#8696a0;}' +
      '.cwUp{border:2px dashed #128c4a !important;background:#eafaf0 !important;color:#128c4a !important;}' +
      'body.wa-dark .cwUp{border-color:#25d366 !important;background:#14251c !important;color:#25d366 !important;}';
    document.head.appendChild(st);
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'casinoOverlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:#0d0d1a;display:flex;flex-direction:column;' +
      // PWA instalada en iPhone (viewport-fit=cover): padding de safe-area arriba
      // y abajo → el casino no queda bajo el notch ni en la zona del home
      // indicator (barras oscuras discretas del color del overlay).
      'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);';
    // Diseño (owner 2026-08-16): el casino se ve TAL CUAL 1girox.com (iframe a
    // pantalla completa, sin barra propia arriba). Todo el "chrome" (soporte,
    // salir, abrir aparte) vive en una BURBUJA de soporte flotante abajo a la
    // derecha que abre el chat con las acciones rápidas.
    overlay.innerHTML =
      '<div id="casinoFrameStatus" style="flex:1;display:flex;flex-direction:column;gap:14px;' +
        'align-items:center;justify-content:center;color:#d4af37;font-size:16px;font-weight:700;' +
        'text-align:center;padding:20px;">🎰 Entrando al casino…</div>' +
      // `allow` habilita pantalla completa y sonido dentro de los juegos.
      '<iframe id="casinoFrame" title="Casino" style="flex:1;width:100%;border:0;display:none;" ' +
        'allow="autoplay; fullscreen; payment"></iframe>' +
      // BURBUJA "Carga automática" (abre/cierra el widget) — logo de la marca +
      // etiqueta "⚡ CARGA AUTOMÁTICA": con el 🎧 pelado los clientes creían que
      // era el soporte propio de la página del casino. Todo vive DENTRO del
      // button para moverse junto (owner 2026-08-25, réplica tanda C).
      '<button type="button" id="casinoSupportBubble" onclick="VIP.ui.toggleCasinoChat()" ' +
        'style="position:absolute;right:16px;bottom:calc(18px + env(safe-area-inset-bottom,0px));' +
        'display:flex;flex-direction:column;align-items:center;gap:4px;padding:0;z-index:6;' +
        'background:none;border:none;cursor:pointer;user-select:none;-webkit-user-select:none;">' +
        '<span style="position:relative;display:block;width:60px;height:60px;">' +
          '<img src="/images/soporte-1girox.png" alt="Carga automática 1Girox" draggable="false" ' +
            'style="width:60px;height:60px;border-radius:50%;object-fit:cover;display:block;' +
            'border:2px solid #00e676;box-shadow:0 6px 22px rgba(0,200,83,0.55);-webkit-user-drag:none;">' +
          '<span id="casinoChatBadge" style="display:none;position:absolute;top:-3px;right:-3px;' +
            'background:#ff3b30;color:#fff;font-size:11px;font-weight:800;min-width:19px;height:19px;' +
            'border-radius:10px;line-height:19px;padding:0 4px;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></span>' +
        '</span>' +
        '<span style="display:block;background:linear-gradient(135deg,#00a844,#00e676);color:#04240f;' +
          'font-size:10px;font-weight:900;letter-spacing:0.3px;padding:3px 8px;border-radius:9px;' +
          'white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,0.45);">⚡ CARGA AUTOMÁTICA</span>' +
      '</button>' +
      // WIDGET de soporte flotante en la ESQUINA (owner 2026-08-17, referencia
      // Bet33): se abre "medio abierto" sobre el casino, NO parte la pantalla.
      // Ancho fijo pegado abajo a la derecha (arriba de la burbuja). El chat real
      // se muda al body al abrir y vuelve a su lugar al cerrar.
      '<div id="casinoChatDrawer" style="display:none;position:absolute;z-index:7;' +
      'right:16px;bottom:calc(88px + env(safe-area-inset-bottom,0px));' +
      'width:min(380px,calc(100vw - 24px));height:min(600px,72vh);' +
      // Sin borde (owner 2026-08-21: "sacá esas líneas blancas") — solo sombra.
      'flex-direction:column;background:#0d0d1a;border:none;' +
      'border-radius:16px;overflow:hidden;box-shadow:0 14px 44px rgba(0,0,0,0.6);">' +
        // Header verde con "EN LÍNEA" + cerrar.
        '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;flex:0 0 auto;' +
        'background:linear-gradient(135deg,#128c4a,#0f7a3d);">' +
          // En modo soporte este círculo muestra la FOTO del logo (misma que
          // la cabecera del chat, configurable desde el panel); en asistente, 🎧.
          '<div id="casinoWidgetIcon" style="width:34px;height:34px;border-radius:50%;background:#0d0d1a;flex:0 0 auto;' +
          'display:flex;align-items:center;justify-content:center;font-size:16px;overflow:hidden;">' +
          '<img src="/images/soporte-1girox.png" alt="" draggable="false" style="width:34px;height:34px;border-radius:50%;object-fit:cover;display:block;-webkit-user-drag:none;"></div>' +
          '<div style="flex:1;min-width:0;">' +
            // El título cambia según el modo: asistente ("Cargas Automáticas")
            // o chat humano ("SOPORTE") — así el cliente diferencia (owner).
            '<div id="casinoWidgetTitle" style="color:#fff;font-weight:800;font-size:14px;">Cargas Automáticas 1Girox</div>' +
            '<div style="color:#c9f5d8;font-size:11px;display:flex;align-items:center;gap:5px;">' +
              '<span style="width:7px;height:7px;border-radius:50%;background:#7dffa8;box-shadow:0 0 6px #7dffa8;"></span>EN LÍNEA</div>' +
          '</div>' +
          // Toggle claro/oscuro: el MISMO modo que el chat de soporte (wa-dark).
          '<button type="button" id="casinoThemeBtn" onclick="VIP.ui.casinoToggleTheme()" title="Modo claro/oscuro" ' +
            'style="background:rgba(255,255,255,0.18);color:#fff;border:none;border-radius:50%;' +
            'width:28px;height:28px;font-size:14px;cursor:pointer;flex:0 0 auto;">🌙</button>' +
          '<button type="button" onclick="VIP.ui.toggleCasinoChat()" title="Cerrar" ' +
            'style="background:rgba(255,255,255,0.18);color:#fff;border:none;border-radius:50%;' +
            'width:28px;height:28px;font-size:14px;cursor:pointer;flex:0 0 auto;">✕</button>' +
        '</div>' +
        // FILA FIJA de opciones (siempre a la vista, owner 2026-08-21 ref
        // Bet33): las 3 acciones ancladas bajo el header.
        '<div class="cwBar" style="flex:0 0 auto;display:flex;gap:6px;padding:8px;">' +
          '<button type="button" onclick="VIP.ui.casinoBotGo(\'deposit\')" style="flex:1.2;background:#128c4a;' +
          'color:#fff;border:none;border-radius:9px;padding:10px 6px;font-size:12px;font-weight:800;cursor:pointer;">💳 Quiero Depositar</button>' +
          '<button type="button" onclick="VIP.ui.casinoBotGo(\'withdraw\')" style="flex:1.2;background:#128c4a;' +
          'color:#fff;border:none;border-radius:9px;padding:10px 6px;font-size:12px;font-weight:800;cursor:pointer;">💲 Solicitar Retiro</button>' +
          '<button type="button" id="casinoSoporteBtn" class="cwSop" onclick="VIP.ui.casinoBotSupport()" style="flex:0.8;' +
          'position:relative;border-radius:9px;padding:10px 4px;font-size:12px;font-weight:800;cursor:pointer;">🎧 Soporte' +
          '<span id="casinoSoporteBadge" style="display:none;position:absolute;top:-6px;right:-6px;' +
          'background:#e53935;color:#fff;border-radius:11px;min-width:18px;height:18px;line-height:18px;' +
          'font-size:11px;font-weight:800;padding:0 4px;text-align:center;">0</span></button>' +
        '</div>' +
        // 2ª fila: 🎁 PREMIOS (hub de recompensas #254, dentro de Cargas
        // Automáticas — pedido owner 2026-09-01) + Información. El puntito rojo
        // avisa cuando hay giro o cashback reclamable.
        '<div class="cwBar" style="flex:0 0 auto;display:flex;gap:6px;padding:0 8px 8px;">' +
          '<button type="button" id="casinoRewardsBtn" onclick="VIP.ui.openRewardsHub()" style="flex:1.3;display:none;' +
          'align-items:center;justify-content:center;position:relative;background:linear-gradient(135deg,#ffd700,#ff9800);' +
          'color:#231a00;border:none;border-radius:9px;padding:8px 4px;font-size:11.5px;font-weight:900;cursor:pointer;">' +
          '🎁 PREMIOS' +
          '<span id="rwDot" style="display:none;position:absolute;top:-4px;right:-4px;width:13px;height:13px;' +
          'border-radius:50%;background:#e53935;border:2px solid #fff;box-shadow:0 0 8px rgba(229,57,53,0.9);"></span></button>' +
          '<button type="button" class="cwSop" onclick="VIP.ui.casinoBotGo(\'info\')" style="flex:1;' +
          'border-radius:9px;padding:8px 4px;font-size:11.5px;font-weight:800;cursor:pointer;">ℹ️ ¿Cómo funciona?</button>' +
        '</div>' +
        // ASISTENTE (bot) — modo DEFAULT del widget: flujo guiado de depósito
        // (datos + copiar + comprobante) y retiro EN el panel. Look tipo
        // WhatsApp (claro u oscuro según wa-dark). Chat humano = FALLBACK.
        '<div id="casinoBotArea" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
        'padding:10px;display:flex;flex-direction:column;gap:8px;"></div>' +
        // Chat EN VIVO (solo soporte): acá se MUDA el chat real al activarlo.
        '<div id="casinoChatDrawerBody" style="flex:1;display:none;flex-direction:column;min-height:0;"></div>' +
        // SIN barra de mensaje en el asistente (owner 2026-08-21): derivaba a
        // soporte con un toque de más — la ÚNICA vía a soporte es el botón 🎧.
        // En modo soporte el chat real trae su barra de escribir verdadera.
        // Barrita inferior mínima. SIN "Salir del casino" ni "Casino aparte"
        // (owner 2026-08-21) — el abrir-aparte queda solo en el recuadro de
        // error del casino (openCasinoInTab sigue existiendo para eso).
        '<div class="cwFoot" style="flex:0 0 auto;display:flex;gap:14px;justify-content:center;padding:4px;">' +
          '<button type="button" class="cwGrn" onclick="VIP.ui.casinoBotGo(\'home\')" style="background:none;border:none;' +
          'font-size:10.5px;cursor:pointer;font-weight:700;">🤖 Asistente</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Burbuja ARRASTRABLE con imán al borde (owner 2026-08-25): el cliente la
    // puede mover si le tapa el juego. Se engancha UNA vez (el overlay se cachea).
    try { VIP.ui._makeBubbleDraggable(); } catch (e) {}

    // Cuando el casino termina de cargar, se esconde el "cargando" y se muestra el juego.
    const frame = overlay.querySelector('#casinoFrame');
    frame.addEventListener('load', function() {
      if (!frame.src) return; // el load inicial del iframe vacío no cuenta
      if (VIP.ui._casinoLogoutLoading) return; // el load de la URL de logout tampoco (#252)
      const status = document.getElementById('casinoFrameStatus');
      if (status) status.style.display = 'none';
      frame.style.display = 'block';
      // El casino cargó → se cancelan TODOS los avisos (watchdog + escape) y se
      // esconde la barrita si ya estaba (owner 2026-08-21: "si abre que quede
      // abierto sin ningún cartel para no marear"). El aviso "abrir aparte"
      // queda SOLO para el caso en que el iframe nunca carga (conexión al
      // casino bloqueada) — no para el que le abre bien.
      VIP.ui._casinoFrameLoaded = true;
      clearTimeout(VIP.ui._casinoWatchdog);
      clearTimeout(VIP.ui._casinoEscapeTimer);
      VIP.ui._hideCasinoEscapeBar();
    });
  }

  // Reset al abrir (por si venía de un intento anterior que falló).
  const frame = overlay.querySelector('#casinoFrame');
  const status = overlay.querySelector('#casinoFrameStatus');
  if (frame) { frame.src = ''; frame.style.display = 'none'; }
  if (status) { status.style.display = 'flex'; status.textContent = '🎰 Entrando al casino…'; }
  VIP.ui._hideCasinoEscapeBar();
  clearTimeout(VIP.ui._casinoEscapeTimer);

  overlay.style.display = 'flex';
  // El casino ya tapa todo → fuera el splash de arranque (#253).
  try { document.documentElement.classList.remove('casino-boot'); } catch (e) {}
  // Bloquea el scroll del fondo mientras el casino está abierto.
  document.body.style.overflow = 'hidden';
  VIP.ui._casinoOpen = true;
  // Hub de premios (#254): traer el resumen (bienvenida/diaria/cashback) y
  // prender el botón + puntito. Fire-and-forget.
  try { VIP.ui._refreshRewards(); } catch (e) {}

  // Badge de mensajes sin leer mientras juega: observa el listado real del chat
  // (chat.js sigue appendeando ahí aunque el casino lo tape) y cuenta lo que
  // llega con el panel de chat CERRADO. Vive para siempre; los guards de arriba
  // lo apagan fuera del casino.
  if (!VIP.ui._casinoChatObserver && window.MutationObserver) {
    const msgs = document.getElementById('chatMessages');
    if (msgs) {
      VIP.ui._casinoChatObserver = new MutationObserver(function(muts) {
        if (!VIP.ui._casinoOpen) return;
        // Con el asistente (bot) el chat real puede NO estar a la vista aunque
        // el panel esté abierto — el badge solo se calla si el chat vivo está
        // montado (modo soporte, _casinoChatPh seteado).
        const drawer = document.getElementById('casinoChatDrawer');
        const supportOnView = drawer && drawer.style.display !== 'none' && VIP.ui._casinoChatPh;
        if (supportOnView) return;
        // Contar SOLO los mensajes ENTRANTES (de soporte). Los del propio
        // usuario tienen clase `.message.agente`; los de soporte, `.usuario`.
        let incoming = 0;
        for (let i = 0; i < muts.length; i++) {
          for (let j = 0; j < muts[i].addedNodes.length; j++) {
            const node = muts[i].addedNodes[j];
            if (node && node.querySelector) {
              // Solo mensajes de SOPORTE HUMANO: entrantes (.usuario) que NO
              // sean automáticos del sistema (.msg-auto) — así la bienvenida y
              // el mensaje de credenciales NO disparan "Soporte te respondió".
              const m = node.querySelector('.message.usuario:not(.msg-auto)') ||
                (node.classList && node.classList.contains('usuario') && !node.classList.contains('msg-auto') ? node : null);
              if (m) incoming++;
            }
          }
        }
        if (!incoming) return;
        // Badge genérico en la burbuja + badge y aviso de SOPORTE (owner
        // 2026-08-22): que el usuario sepa que el sonido vino de Soporte.
        VIP.ui._casinoChatUnread = (VIP.ui._casinoChatUnread || 0) + incoming;
        const badge = document.getElementById('casinoChatBadge');
        if (badge) {
          badge.textContent = VIP.ui._casinoChatUnread > 9 ? '9+' : String(VIP.ui._casinoChatUnread);
          badge.style.display = 'inline-block';
        }
        VIP.ui._notifySupportReply(incoming);
      });
      VIP.ui._casinoChatObserver.observe(msgs, { childList: true });
    }
  }
  VIP.ui._casinoChatUnread = 0;

  // El panel del asistente SIEMPRE abierto al entrar al casino (owner
  // 2026-08-21) — el cliente puede cerrarlo con la ✕ si molesta.
  setTimeout(function() {
    try { if (VIP.ui._casinoOpen && VIP.ui.openCasinoChat) VIP.ui.openCasinoChat(); } catch (e) {}
  }, 250);
};

/** Abre/cierra el panel SOBRE el casino (el juego no se corta). Al abrir
 *  arranca en modo ASISTENTE (bot); el chat vivo solo aparece vía soporte. */
VIP.ui.toggleCasinoChat = function() {
  // Si venía de ARRASTRAR la burbuja, el click sintético que sigue al soltar NO
  // debe abrir/cerrar el panel (owner 2026-08-25).
  if (VIP.ui._bubbleWasDragged) return;
  const drawer = document.getElementById('casinoChatDrawer');
  if (!drawer) return;
  if (drawer.style.display === 'none' || !drawer.style.display) VIP.ui.openCasinoChat();
  else { VIP.ui.closeCasinoChat(); VIP.ui._showBubbleDragHintOnce(); }
};

/**
 * Hace la burbuja del casino ARRASTRABLE con imán al borde (owner 2026-08-25).
 * Pointer events (mouse + touch), umbral de 8px para separar TOQUE de ARRASTRE,
 * `setPointerCapture` + `touch-action:none` (no scrollea la página mientras se
 * arrastra). Al soltar se pega al borde izq/der más cercano y guarda lado + alto
 * en localStorage. Setea `_bubbleWasDragged` para que el click sintético del
 * pointerup NO abra/cierre el panel; se limpia a los ~400ms. Usa
 * getBoundingClientRect: la burbuja es una columna logo+etiqueta SIN tamaño fijo.
 */
VIP.ui._makeBubbleDraggable = function() {
  const bubble = document.getElementById('casinoSupportBubble');
  if (!bubble || bubble._dragArmed) return;
  bubble._dragArmed = true;
  bubble.style.touchAction = 'none';

  // Restaurar posición guardada (lado + alto), si ya la movió antes.
  VIP.ui._applyBubblePosition();

  const THRESH = 8; // px para pasar de "toque" a "arrastre"
  let startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false, moved = false, pid = null;

  function onDown(e) {
    if (e.button != null && e.button !== 0) return; // solo botón primario
    const r = bubble.getBoundingClientRect();
    dragging = true; moved = false;
    origLeft = r.left; origTop = r.top;
    startX = e.clientX; startY = e.clientY;
    // Fijar por left/top absolutos desde el rect actual (deja right/bottom).
    bubble.style.left = r.left + 'px';
    bubble.style.top = r.top + 'px';
    bubble.style.right = 'auto';
    bubble.style.bottom = 'auto';
    pid = e.pointerId;
    try { if (pid != null && bubble.setPointerCapture) bubble.setPointerCapture(pid); } catch (_) {}
    // Con setPointerCapture los eventos del puntero llegan SIEMPRE a la burbuja,
    // aunque el dedo/mouse salga de ella → escuchamos en la burbuja.
    bubble.addEventListener('pointermove', onMove, { passive: false });
    bubble.addEventListener('pointerup', onUp);
    bubble.addEventListener('pointercancel', onUp);
  }

  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && (Math.abs(dx) + Math.abs(dy)) > THRESH) { moved = true; VIP.ui._bubbleWasDragged = true; }
    if (!moved) return;
    e.preventDefault();
    const bw = bubble.offsetWidth || 64, bh = bubble.offsetHeight || 84;
    let nl = origLeft + dx, nt = origTop + dy;
    nl = Math.max(6, Math.min(window.innerWidth - bw - 6, nl));
    nt = Math.max(6, Math.min(window.innerHeight - bh - 6, nt));
    bubble.style.left = nl + 'px';
    bubble.style.top = nt + 'px';
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    bubble.removeEventListener('pointermove', onMove);
    bubble.removeEventListener('pointerup', onUp);
    bubble.removeEventListener('pointercancel', onUp);
    try { if (pid != null && bubble.releasePointerCapture) bubble.releasePointerCapture(pid); } catch (_) {}
    pid = null;
    if (!moved) { VIP.ui._bubbleWasDragged = false; return; }
    // Imán al borde horizontal más cercano; el alto queda donde lo soltó.
    const r = bubble.getBoundingClientRect();
    const side = (r.left + r.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
    const topPx = Math.max(6, Math.min(window.innerHeight - r.height - 6, r.top));
    VIP.ui._bubbleSide = side;
    VIP.ui._bubbleTop = topPx;
    try {
      localStorage.setItem('casinoBubbleSide', side);
      localStorage.setItem('casinoBubbleTop', String(Math.round(topPx)));
    } catch (_) {}
    VIP.ui._applyBubblePosition();
    // Limpiar el flag DESPUÉS del click sintético que dispara el pointerup.
    setTimeout(function() { VIP.ui._bubbleWasDragged = false; }, 400);
  }

  bubble.addEventListener('pointerdown', onDown);
};

/** Aplica a la burbuja el lado (imán) y alto guardados; si nunca la movió, deja
 *  el default (abajo a la derecha, del CSS inline). Clampa el alto al viewport. */
VIP.ui._applyBubblePosition = function() {
  const bubble = document.getElementById('casinoSupportBubble');
  if (!bubble) return;
  let side = VIP.ui._bubbleSide, top = VIP.ui._bubbleTop;
  try {
    if (side == null) side = localStorage.getItem('casinoBubbleSide') || null;
    if (top == null) { const t = localStorage.getItem('casinoBubbleTop'); if (t != null && t !== '') top = parseInt(t, 10); }
  } catch (_) {}
  if (!side) return; // nunca la movió → queda en su posición default
  VIP.ui._bubbleSide = side;
  const bh = bubble.offsetHeight || 84;
  if (top == null || isNaN(top)) top = window.innerHeight - bh - 24;
  top = Math.max(6, Math.min(window.innerHeight - bh - 6, top));
  VIP.ui._bubbleTop = top;
  bubble.style.top = top + 'px';
  bubble.style.bottom = 'auto';
  if (side === 'left') { bubble.style.left = '16px'; bubble.style.right = 'auto'; }
  else { bubble.style.right = '16px'; bubble.style.left = 'auto'; }
};

/**
 * Pista de arrastre (una vez por dispositivo): al PRIMER cierre del widget se
 * muestra un globito junto a la burbuja avisando que se puede arrastrar — sin
 * esto nadie descubre que se mueve. El guard con localStorage va ANTES de crear
 * nada; si localStorage no está (modo privado raro), no se muestra y listo.
 */
VIP.ui._showBubbleDragHintOnce = function() {
  try {
    if (localStorage.getItem('casinoBubbleDragHint')) return;
    localStorage.setItem('casinoBubbleDragHint', '1');
  } catch (e) { return; }
  const overlay = document.getElementById('casinoOverlay');
  const b = document.getElementById('casinoSupportBubble');
  if (!overlay || !b) return;
  const r = b.getBoundingClientRect();
  const hint = document.createElement('div');
  hint.textContent = '✋ ¿Te tapa el juego? Mantené apretado y arrastrá la burbuja a donde quieras';
  hint.style.cssText =
    'position:absolute;max-width:230px;background:rgba(13,13,26,0.95);color:#ffd700;' +
    'border:1px solid rgba(212,175,55,0.6);border-radius:12px;padding:9px 12px;' +
    'font-size:12px;font-weight:700;line-height:1.35;z-index:8;' +
    'box-shadow:0 8px 30px rgba(0,0,0,0.6);transition:opacity 0.6s;';
  // Del mismo lado que la burbuja; ARRIBA de ella si está en la mitad inferior,
  // ABAJO si está en la mitad superior (así no se va de pantalla).
  if ((r.left + r.width / 2) < window.innerWidth / 2) hint.style.left = '12px';
  else hint.style.right = '12px';
  if ((r.top + r.height / 2) >= window.innerHeight / 2) hint.style.bottom = (window.innerHeight - r.top + 8) + 'px';
  else hint.style.top = (r.bottom + 8) + 'px';
  overlay.appendChild(hint);
  setTimeout(function() { hint.style.opacity = '0'; }, 6000);
  setTimeout(function() { try { hint.remove(); } catch (e) {} }, 6800);
};

/** Abre el panel en modo asistente (o como estaba si el soporte quedó activo). */
VIP.ui.openCasinoChat = function() {
  const drawer = document.getElementById('casinoChatDrawer');
  if (!drawer) return;
  drawer.style.display = 'flex';
  // Anclar el panel al MISMO CUADRANTE que la burbuja (lado izq/der + mitad
  // arriba/abajo) para que abra "desde" donde está, y OCULTAR la burbuja mientras
  // el panel está abierto → el chat nunca la tapa (se cierra con la ✕). Se lee el
  // rect real: sirve arrastrada o en su lugar default (owner 2026-08-25).
  const _bubble = document.getElementById('casinoSupportBubble');
  let _side = VIP.ui._bubbleSide || 'right', _bottom = true;
  if (_bubble) {
    const br = _bubble.getBoundingClientRect();
    if (br.width || br.height) {
      _side = (br.left + br.width / 2) < window.innerWidth / 2 ? 'left' : 'right';
      _bottom = (br.top + br.height / 2) >= window.innerHeight / 2;
    }
    _bubble.style.visibility = 'hidden';
  }
  if (_side === 'left') { drawer.style.left = '16px'; drawer.style.right = 'auto'; }
  else { drawer.style.right = '16px'; drawer.style.left = 'auto'; }
  if (_bottom) { drawer.style.bottom = 'calc(16px + env(safe-area-inset-bottom,0px))'; drawer.style.top = 'auto'; }
  else { drawer.style.top = 'calc(16px + env(safe-area-inset-top,0px))'; drawer.style.bottom = 'auto'; }
  VIP.ui._casinoChatUnread = 0;
  const badge = document.getElementById('casinoChatBadge');
  if (badge) badge.style.display = 'none';
  VIP.ui._syncCasinoThemeBtn();
  // Primera apertura → home del bot. Si el chat vivo quedó montado (soporte),
  // se respeta; si no, se muestra el estado del bot tal como quedó.
  if (!VIP.ui._casinoChatPh && !VIP.ui._botStarted) {
    VIP.ui._botStarted = true;
    VIP.ui.casinoBotGo('home');
  }
};

VIP.ui.closeCasinoChat = function() {
  // Si el chat vivo estaba montado, devolver los nodos a la página SIEMPRE.
  if (VIP.ui._casinoChatPh) VIP.ui._casinoChatRestoreNodes();
  const drawer = document.getElementById('casinoChatDrawer');
  if (drawer) drawer.style.display = 'none';
  // La burbuja vuelve a aparecer (se ocultó al abrir el panel).
  const bubble = document.getElementById('casinoSupportBubble');
  if (bubble) bubble.style.visibility = 'visible';
};

/** Muda el chat REAL (cabecera+mensajes+barra de escribir) adentro del panel.
 *  Mover los nodos conserva ids, listeners y el socket: es EL MISMO chat, no
 *  una copia — por eso el agente lo ve en su bandeja de siempre. */
VIP.ui._casinoChatMount = function() {
  const drawer = document.getElementById('casinoChatDrawer');
  const body = document.getElementById('casinoChatDrawerBody');
  const cc = document.querySelector('.chat-container');
  const cic = document.querySelector('.chat-input-container');
  if (!drawer || !body || !cc || !cic) return;
  // Modo SOPORTE: se esconde el asistente (y su barra de mensaje de mentira —
  // el chat real trae la de verdad) y se muestra el chat real. El título del
  // header pasa a SOPORTE para diferenciarlo de las cargas automáticas.
  const botArea = document.getElementById('casinoBotArea');
  if (botArea) botArea.style.display = 'none';
  const fakeInput = document.getElementById('casinoBotFakeInput');
  if (fakeInput) fakeInput.style.display = 'none';
  const title = document.getElementById('casinoWidgetTitle');
  if (title) title.textContent = 'SOPORTE 1Girox';
  // Foto del logo 1G al lado del nombre (la misma del avatar del chat, que
  // chat.js pisa con el logo cargado en el panel; fallback al default 1G).
  const icon = document.getElementById('casinoWidgetIcon');
  if (icon) {
    let logoSrc = '/images/soporte-1girox.png';
    try {
      const av = document.getElementById('chatTopbarAvatar');
      if (av && av.src) logoSrc = av.src;
    } catch (e) {}
    icon.innerHTML = '<img src="' + logoSrc + '" alt="Soporte 1Girox" ' +
      'style="width:34px;height:34px;border-radius:50%;object-fit:cover;display:block;">';
  }
  body.style.display = 'flex';
  // Marcadores invisibles para devolver cada bloque EXACTAMENTE donde estaba.
  const ph1 = document.createElement('div'); ph1.style.display = 'none';
  const ph2 = document.createElement('div'); ph2.style.display = 'none';
  cc.parentNode.insertBefore(ph1, cc);
  cic.parentNode.insertBefore(ph2, cic);
  body.appendChild(cc);
  body.appendChild(cic);
  // Dentro del panel el chat se COMPACTA (owner 2026-08-15):
  // 1. Se oculta la cabecera "Cargas 1Girox" (avatar/en línea/🔥) — el panel ya
  //    tiene su propio título y así se ven más mensajes en el 50% de alto.
  // 2. min-height:0 pisa el piso de 170px de .chat-container: con el panel
  //    corto, ese piso empujaba la barra de escribir fuera de la vista y el
  //    chat "no bajaba del todo".
  const tb = cc.querySelector('.chat-topbar');
  if (tb) tb.style.display = 'none';
  const prevMinHeight = cc.style.minHeight;
  cc.style.minHeight = '0';
  VIP.ui._casinoChatPh = { ph1: ph1, ph2: ph2, cc: cc, cic: cic, tb: tb, prevMinHeight: prevMinHeight };
  drawer.style.display = 'flex';
  // Visto: badge a cero y mensajes al final (tras el reflow del layout nuevo).
  VIP.ui._casinoChatUnread = 0;
  const badge = document.getElementById('casinoChatBadge');
  if (badge) badge.style.display = 'none';
  requestAnimationFrame(function() {
    const msgs = document.getElementById('chatMessages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  });
};

/** Devuelve el chat real a su lugar de la página (sin tocar el panel) y
 *  vuelve a dejar visible el asistente. */
VIP.ui._casinoChatRestoreNodes = function() {
  const s = VIP.ui._casinoChatPh;
  if (s) {
    // Deshacer la compactación ANTES de devolverlo: en la página el chat
    // vuelve con su cabecera y su piso de altura de siempre.
    if (s.tb) s.tb.style.display = '';
    if (s.cc) s.cc.style.minHeight = s.prevMinHeight || '';
  }
  if (s && s.ph1 && s.ph1.parentNode) { s.ph1.parentNode.insertBefore(s.cc, s.ph1); s.ph1.remove(); }
  if (s && s.ph2 && s.ph2.parentNode) { s.ph2.parentNode.insertBefore(s.cic, s.ph2); s.ph2.remove(); }
  VIP.ui._casinoChatPh = null;
  const body = document.getElementById('casinoChatDrawerBody');
  if (body) body.style.display = 'none';
  const botArea = document.getElementById('casinoBotArea');
  if (botArea) botArea.style.display = 'flex';
  const fakeInput = document.getElementById('casinoBotFakeInput');
  if (fakeInput) fakeInput.style.display = 'flex';
  const title = document.getElementById('casinoWidgetTitle');
  if (title) title.textContent = 'Cargas Automáticas 1Girox';
  const icon = document.getElementById('casinoWidgetIcon');
  if (icon) icon.innerHTML = '<img src="/images/soporte-1girox.png" alt="" draggable="false" ' +
    'style="width:34px;height:34px;border-radius:50%;object-fit:cover;display:block;-webkit-user-drag:none;">';
};

/** Compat: devuelve el chat Y esconde el panel (lo usa closeCasinoFrame). */
VIP.ui._casinoChatUnmount = function() {
  VIP.ui._casinoChatRestoreNodes();
  const drawer = document.getElementById('casinoChatDrawer');
  if (drawer) drawer.style.display = 'none';
  const bubble = document.getElementById('casinoSupportBubble');
  if (bubble) bubble.style.visibility = 'visible';
};

// ============================================================
// ASISTENTE del casino (owner 2026-08-21, referencia Bet33): flujo GUIADO en
// vez de chat en vivo. Depósito: datos bancarios con Copiar → "Ya hice la
// transferencia" → subir comprobante → lo verifica la IA y la auto-carga
// acredita sola (pipeline existente). Retiro: formulario self-service
// existente. El chat humano queda SOLO en "Hablar con soporte" o si algo
// de la automatización falla.
// ============================================================

/** Hora corta para las burbujas (estilo WhatsApp). */
VIP.ui._botTime = function() {
  try {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  } catch (e) { return ''; }
};

/** Burbuja del bot (look WhatsApp; claro u oscuro según `body.wa-dark` — los
 *  colores viven en las clases cw* del <style> del widget). Devuelve el nodo. */
VIP.ui._botMsg = function(html) {
  const area = document.getElementById('casinoBotArea');
  if (!area) return null;
  const b = document.createElement('div');
  b.className = 'cwB';
  b.style.cssText = 'border-radius:10px;padding:10px 12px;font-size:13px;line-height:1.5;';
  b.innerHTML = html +
    '<div class="cwTime" style="text-align:right;font-size:10px;margin-top:4px;">' + VIP.ui._botTime() + '</div>';
  area.appendChild(b);
  area.scrollTop = area.scrollHeight;
  return b;
};

VIP.ui._botBtn = function(label, onclick, primary) {
  const cls = primary ? '' : ' class="cwSec"';
  const style = primary ? 'background:#128c4a;color:#fff;border:none;' : '';
  return '<button type="button"' + cls + ' onclick="' + onclick + '" style="' + style +
    'border-radius:10px;padding:11px 12px;font-size:13px;font-weight:800;cursor:pointer;flex:1;min-width:0;' +
    'box-shadow:0 1px 1px rgba(0,0,0,0.08);">' + label + '</button>';
};

VIP.ui._botRow = function(btnsHtml) {
  const area = document.getElementById('casinoBotArea');
  if (!area) return;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  row.innerHTML = btnsHtml;
  area.appendChild(row);
  area.scrollTop = area.scrollHeight;
};

/** Estados del asistente. */
VIP.ui.casinoBotGo = function(state) {
  const area = document.getElementById('casinoBotArea');
  if (!area) return;
  // Si el chat vivo estaba montado (soporte), volver los nodos a la página.
  if (VIP.ui._casinoChatPh) VIP.ui._casinoChatRestoreNodes();
  area.style.display = 'flex';
  const body = document.getElementById('casinoChatDrawerBody');
  if (body) body.style.display = 'none';
  VIP.ui._botStarted = true;

  if (state === 'home') {
    area.innerHTML = '';
    // Las opciones viven FIJAS arriba (fila anclada bajo el header) — acá solo
    // el saludo. Volver de cualquier flujo = las opciones siguen a la vista.
    VIP.ui._botMsg('👋 ¡Hola! Soy el <b>asistente de cargas automáticas</b>.<br>' +
      'Elegí una opción acá arriba: <b>depositar</b>, <b>retirar</b> o hablar con <b>soporte</b>.');
    // Identidad SIEMPRE visible + salida limpia (#252): así el cliente sabe con
    // qué usuario está chateando y puede cambiar de cuenta SIN hacerlo adentro
    // de 1girox (que dejaba chat y casino con usuarios distintos).
    try {
      const _u = (VIP.state.currentUser && VIP.state.currentUser.username) || '';
      if (_u) {
        VIP.ui._botMsg('<span style="font-size:12px;opacity:.85;">👤 Estás como <b>' + _wrEsc(_u) + '</b>. ' +
          '¿Es otra tu cuenta? Cerrá sesión acá y entrá con la correcta (no cambies de usuario dentro del casino).</span>');
        VIP.ui._botRow(VIP.ui._botBtn('🔄 Cambiar de cuenta / Salir', 'VIP.ui.casinoLogout()', false));
      }
    } catch (e) {}
    // Las ruletas y el cashback viven en el hub "🎁 PREMIOS" (#254) — ya no se
    // ofrecen en el hilo del chat (pedido owner: recuadro propio, no en el chat).
    return;
  }

  if (state === 'roulette') {
    VIP.ui._renderRoulette();
    return;
  }

  if (state === 'roulette-prize') {
    VIP.ui._renderRoulettePrize();
    return;
  }

  if (state === 'info') {
    area.innerHTML = '';
    VIP.ui._botMsg(
      'ℹ️ <b>¿Cómo funciona?</b> Es todo <b>automático</b> 👇' +
      '<div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">' +
      '<div class="cwBox" style="border-radius:9px;padding:9px 11px;"><b>💳 Depositar</b><br>' +
      'Tocá <b>Quiero Depositar</b>, transferí al CBU/alias que te damos y mandá el comprobante. ' +
      'Se acredita <b>solo en segundos</b> — sin esperar a nadie.</div>' +
      '<div class="cwBox" style="border-radius:9px;padding:9px 11px;"><b>💸 Retirar</b><br>' +
      'Tocá <b>Solicitar Retiro</b>, poné el monto y tu CBU/alias. El pago sale <b>automático</b> ' +
      'a tu cuenta tras la verificación.</div>' +
      '<div class="cwBox" style="border-radius:9px;padding:9px 11px;"><b>🎰 Jugar</b><br>' +
      'Ya estás adentro de 1Girox con tu sesión iniciada. Cargá y jugá al instante.</div>' +
      '<div class="cwBox" style="border-radius:9px;padding:9px 11px;"><b>🎧 Soporte</b><br>' +
      'Si algo no funciona, tocá <b>Soporte</b> y te atiende una persona.</div>' +
      '</div>');
    // Que se vea desde ARRIBA (owner 2026-08-22): _botMsg baja al fondo, y como
    // es un solo bloque largo quedaba mostrando el final. Se sube al inicio.
    area.scrollTop = 0;
    return;
  }

  if (state === 'deposit') {
    let card = document.getElementById('botDepositCard');
    // THROTTLE anti-spam: doble-tap en <2s no hace nada (evita apilar).
    if (card && (Date.now() - (VIP.ui._botDepositAt || 0) < 2000)) {
      area.scrollTop = area.scrollHeight;
      return;
    }
    const doRefresh = function(c, node) {
      const n = node.querySelector('#botCbuNumber'); if (n) n.textContent = c.number || '—';
      const a = node.querySelector('#botCbuAlias'); if (a) a.textContent = c.alias || '—';
      const t = node.querySelector('#botCbuTitular'); if (t) t.textContent = c.titular || c.bank || '—';
    };
    // Si la tarjeta ya existe Y sigue siendo lo ÚLTIMO del chat → solo refrescar.
    // Si hubo mensajes después (ej. "carga acreditada"), la tarjeta vieja quedó
    // arriba → se BORRA y se crea una NUEVA abajo (owner 2026-08-21: que el CBU
    // vuelva a aparecer abajo tras una carga).
    if (card) {
      const isLast = area.lastElementChild === card ||
        (area.lastElementChild && area.lastElementChild.previousElementSibling === card);
      if (isLast) {
        VIP.ui._botDepositAt = Date.now();
        area.scrollTop = area.scrollHeight;
        if (VIP.ui._botCbu && VIP.ui._botCbu.number) doRefresh(VIP.ui._botCbu, card);
        fetch(`${VIP.config.API_URL}/api/cbu/request`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
          if (d && d.cbu) { VIP.ui._botCbu = d.cbu; doRefresh(d.cbu, card); }
        }).catch(function() {});
        return;
      }
      // Quedó arriba → sacarle el id a la vieja para no chocar y crear una nueva.
      card.id = '';
    }
    VIP.ui._botDepositAt = Date.now();
    card = VIP.ui._botMsg('Para depositar, transferí a los siguientes datos:<br>' +
      '<span style="color:#8a8fa3;">⏳ Cargando datos…</span>');
    if (card) card.id = 'botDepositCard';
    const renderCard = function() {
        if (!card) return;
        // Valores por textContent (config del panel → nunca se inyecta HTML).
        card.innerHTML =
          'Para depositar, realizá una transferencia a los siguientes datos:' +
          '<div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">' +
            '<div class="cwBox" style="border-radius:9px;padding:8px 10px;">' +
              '<div class="cwLbl" style="font-size:10.5px;font-weight:700;letter-spacing:0.4px;">CBU</div>' +
              '<div style="display:flex;gap:6px;align-items:center;">' +
              '<b id="botCbuNumber" class="cwVal" style="flex:1;word-break:break-all;font-size:13px;"></b>' +
              '<button type="button" onclick="VIP.ui.casinoBotCopy(\'number\')" style="background:#128c4a;color:#fff;border:none;border-radius:8px;padding:7px 11px;font-size:11.5px;font-weight:800;cursor:pointer;flex:0 0 auto;">Copiar CBU</button></div></div>' +
            '<div class="cwBox" style="border-radius:9px;padding:8px 10px;">' +
              '<div class="cwLbl" style="font-size:10.5px;font-weight:700;letter-spacing:0.4px;">ALIAS</div>' +
              '<div style="display:flex;gap:6px;align-items:center;">' +
              '<b id="botCbuAlias" class="cwVal" style="flex:1;word-break:break-all;font-size:13px;"></b>' +
              '<button type="button" onclick="VIP.ui.casinoBotCopy(\'alias\')" style="background:#128c4a;color:#fff;border:none;border-radius:8px;padding:7px 11px;font-size:11.5px;font-weight:800;cursor:pointer;flex:0 0 auto;">Copiar Alias</button></div></div>' +
            '<div class="cwBox" style="border-radius:9px;padding:8px 10px;">' +
              '<div class="cwLbl" style="font-size:10.5px;font-weight:700;letter-spacing:0.4px;">TITULAR</div>' +
              '<b id="botCbuTitular" class="cwVal" style="font-size:13px;"></b></div>' +
            '<div class="cwWarn" style="border-radius:8px;padding:7px 9px;font-size:12px;font-weight:700;text-align:center;">Depósito mínimo: $2.000</div>' +
          '</div>';
        const c = VIP.ui._botCbu;
        card.querySelector('#botCbuNumber').textContent = c.number || '—';
        card.querySelector('#botCbuAlias').textContent = c.alias || '—';
        card.querySelector('#botCbuTitular').textContent = c.titular || c.bank || '—';
        VIP.ui._botRow(
          VIP.ui._botBtn('✅ Ya hice la transferencia', "VIP.ui.casinoBotGo('receipt')", true) +
          VIP.ui._botBtn('↩ Volver', "VIP.ui.casinoBotGo('home')")
        );
    };
    // Cache client-side: el endpoint tiene rate limit de 10s por usuario — un
    // ida-y-vuelta rápido por el bot no debe rebotar en 429.
    if (VIP.ui._botCbu && VIP.ui._botCbu.number) { renderCard(); return; }
    fetch(`${VIP.config.API_URL}/api/cbu/request`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
      .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('http ' + r.status)); })
      .then(function(data) {
        VIP.ui._botCbu = (data && data.cbu) || {};
        renderCard();
      })
      .catch(function() {
        // La automatización falló → fallback al chat humano (regla del owner).
        if (card) card.innerHTML = '⚠️ No pudimos traer los datos en este momento. Escribile a soporte y te los pasa al toque.';
        VIP.ui._botRow(VIP.ui._botBtn('🎧 Hablar con soporte', 'VIP.ui.casinoBotSupport()', true));
      });
    return;
  }

  if (state === 'receipt') {
    // Guard anti-duplicado (owner 2026-08-21: salía 2 veces al tocar "Ya hice
    // la transferencia" más de una vez). Si el bloque ya está, no se repite.
    const existing = document.getElementById('botReceiptBlock');
    if (existing) { area.scrollTop = area.scrollHeight; return; }
    VIP.ui._botMsg('📸 Envianos una <b>foto o captura de pantalla</b> del comprobante de la transferencia.');
    const box = VIP.ui._botMsg('');
    if (box) {
      box.id = 'botReceiptBlock';
      box.className = 'cwB cwUp';
      box.style.cssText += 'text-align:center;cursor:pointer;';
      box.innerHTML = '📎 <b>Tocá acá para seleccionar el comprobante</b><br><span style="font-size:11px;opacity:0.75;">Imagen o captura</span>';
      box.onclick = function() { VIP.ui.casinoBotPickReceipt(); };
    }
    VIP.ui._botRow(VIP.ui._botBtn('↩ Volver', "VIP.ui.casinoBotGo('deposit')"));
    return;
  }

  if (state === 'withdraw') {
    // RETIRO adentro del panel (owner 2026-08-21, calco de Bet33): disponible
    // para retirar + monto + CBU/CVU o alias + titular + Confirmar. El pedido
    // real va por /api/withdrawal/request (mismos guards de siempre: mínimo
    // $4.999, wagering.available, SMS obligatorio si el teléfono no está
    // verificado — en ese caso se deriva al formulario completo con OTP).
    area.innerHTML = '';
    const back = VIP.ui._botMsg('<span class="cwGrn" onclick="VIP.ui.casinoBotGo(\'home\')" style="font-weight:800;cursor:pointer;">← Volver al chat</span>');
    if (back) { back.className = ''; back.style.background = 'transparent'; back.style.boxShadow = 'none'; }
    const form = VIP.ui._botMsg('');
    if (!form) return;
    form.innerHTML =
      '<div class="cwVal" style="font-size:17px;font-weight:800;margin-bottom:8px;">Solicitar Retiro</div>' +
      '<div class="cwBox" style="border-radius:9px;padding:10px;text-align:center;margin-bottom:10px;">' +
        '<div class="cwLbl" style="font-size:11.5px;">Disponible para retirar</div>' +
        '<div id="botWdAvail" class="cwVal" style="font-size:22px;font-weight:900;">⏳</div></div>' +
      '<div class="cwLbl" style="font-size:12px;font-weight:700;margin-bottom:3px;">Monto a retirar</div>' +
      '<input id="botWdAmount" class="cwIn" type="number" inputmode="numeric" min="4999" placeholder="$0" ' +
        'style="width:100%;box-sizing:border-box;border-radius:9px;padding:10px;font-size:14px;margin-bottom:8px;">' +
      '<div class="cwLbl" style="font-size:12px;font-weight:700;margin-bottom:3px;">CBU o CVU (o alias)</div>' +
      '<input id="botWdCbu" class="cwIn" type="text" placeholder="Ingresá tu CBU/CVU de 22 dígitos o tu alias" ' +
        'style="width:100%;box-sizing:border-box;border-radius:9px;padding:10px;font-size:13.5px;margin-bottom:8px;">' +
      '<div class="cwLbl" style="font-size:12px;font-weight:700;margin-bottom:3px;">Titular de la cuenta</div>' +
      '<input id="botWdTitular" class="cwIn" type="text" placeholder="Nombre completo" ' +
        'style="width:100%;box-sizing:border-box;border-radius:9px;padding:10px;font-size:13.5px;margin-bottom:6px;">' +
      '<div id="botWdError" style="display:none;color:#e05a5a;font-size:12px;font-weight:700;margin-bottom:6px;"></div>' +
      '<button type="button" id="botWdSubmit" onclick="VIP.ui.casinoBotWithdrawSubmit()" ' +
        'style="width:100%;background:#128c4a;color:#fff;border:none;border-radius:10px;padding:13px;' +
        'font-size:14.5px;font-weight:800;cursor:pointer;">Confirmar Retiro</button>' +
      '<div class="cwMut" style="font-size:11px;text-align:center;margin-top:5px;">Retiro mínimo: $4.999</div>';
    // Disponible real (descuenta el rollover): /api/balance/live → available.
    fetch(`${VIP.config.API_URL}/api/balance/live`, {
      headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
    }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
      const el = document.getElementById('botWdAvail');
      if (!el) return;
      const avail = d && (d.available !== undefined && d.available !== null ? d.available : d.balance);
      el.textContent = (avail !== undefined && avail !== null)
        ? '$' + Number(avail).toLocaleString('es-AR') : '—';
    }).catch(function() {
      const el = document.getElementById('botWdAvail');
      if (el) el.textContent = '—';
    });
    // "Tus últimos retiros" (owner 2026-08-22): estado de los últimos retiros;
    // si uno salió RECHAZADO, muestra el motivo acá mismo + "Hablar con soporte".
    VIP.ui._renderMyWithdrawals();
    return;
  }

  if (state === 'receipt-sent') {
    VIP.ui._botMsg('✅ <b>¡Comprobante recibido!</b> Lo estamos verificando para acreditarte las fichas.');
    // CUENTA REGRESIVA de 15s (owner 2026-08-21): si la carga automática no
    // acreditó en ese tiempo, cartel pidiendo el comprobante legible. La
    // confirmación real (balance_updated → casinoBotDepositConfirmed) CORTA
    // el reloj y muestra el "¡Carga acreditada!".
    clearInterval(VIP.ui._botCdTimer);
    const cd = VIP.ui._botMsg('⏳ Acreditación automática en curso… <b id="botCdNum" style="color:#25d366;">15</b>s');
    VIP.ui._botCdNode = cd;
    let left = 15;
    VIP.ui._botCdTimer = setInterval(function() {
      left--;
      const n = document.getElementById('botCdNum');
      if (n) n.textContent = String(Math.max(0, left));
      if (left <= 0) {
        clearInterval(VIP.ui._botCdTimer);
        VIP.ui._botCdTimer = null;
        if (cd) cd.style.display = 'none';
        VIP.ui._botMsg('⚠️ <b>Todavía no pudimos acreditar tu carga automáticamente.</b><br>' +
          'Verificá que el comprobante esté COMPLETO y legible (monto, fecha, N° de operación y cuenta destino) ' +
          'y reenvialo. 📸<br><span style="color:#8a8fa3;font-size:12px;">Si ya se ve bien, quedate tranquilo: ' +
          'un agente lo está revisando y te acreditamos enseguida.</span>');
        VIP.ui._botRow(
          VIP.ui._botBtn('📸 Reenviar comprobante', "VIP.ui.casinoBotGo('receipt')", true) +
          VIP.ui._botBtn('🎧 Hablar con soporte', 'VIP.ui.casinoBotSupport()')
        );
      }
    }, 1000);
    VIP.ui._botRow(VIP.ui._botBtn('🎰 Volver al juego', 'VIP.ui.closeCasinoChat()'));
    return;
  }
};

/** Copiar CBU/alias al portapapeles (con fallback para navegadores viejos). */
VIP.ui.casinoBotCopy = function(kind) {
  const c = VIP.ui._botCbu || {};
  const val = kind === 'alias' ? c.alias : c.number;
  if (!val) return;
  const ok = function() { VIP.ui.showToast('✅ Copiado: ' + val, 'success'); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(String(val)).then(ok, function() { window.prompt('Copialo manualmente:', val); });
      return;
    }
  } catch (e) {}
  window.prompt('Copialo manualmente:', val);
};

/** Abre el selector de archivo del chat (el envío usa el flujo REAL: la imagen
 *  entra al chat, la IA la verifica y la auto-carga acredita — todo existente). */
VIP.ui.casinoBotPickReceipt = function() {
  const fi = document.getElementById('fileInput');
  if (!fi) { VIP.ui.casinoBotSupport(); return; }
  VIP.ui._botAwaitingReceipt = true;
  if (!VIP.ui._botFileHook) {
    VIP.ui._botFileHook = true;
    fi.addEventListener('change', function() {
      if (!VIP.ui._botAwaitingReceipt) return;
      if (!fi.files || !fi.files.length) return;
      VIP.ui._botAwaitingReceipt = false;
      // El envío real lo maneja chat.js con este mismo change; acá solo se
      // avanza la conversación del bot (pequeño delay para el procesamiento).
      setTimeout(function() { VIP.ui.casinoBotGo('receipt-sent'); }, 600);
    });
  }
  fi.click();
};

// (owner 2026-08-25) Removido VIP.ui.casinoBotWithdraw: wrapper sin callers
// (el flujo usa casinoBotGo('withdraw') directo). Ver WORKLOG #234.

/** "Tus últimos retiros" dentro de la sección de Retiro: estado de cada uno y,
 *  si salió RECHAZADO, el motivo + botón "Hablar con soporte" (owner
 *  2026-08-22). Reemplaza al mensaje de rechazo en el chat (que quedaba tapado
 *  por la bienvenida de soporte). */
VIP.ui._renderMyWithdrawals = function() {
  const area = document.getElementById('casinoBotArea');
  if (!area) return;
  fetch(`${VIP.config.API_URL}/api/withdrawal/mine`, {
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
    const list = (d && d.payouts) || [];
    if (!list.length) return;
    // Si el estado 'withdraw' ya cambió (el usuario navegó), no pintar.
    if (!document.getElementById('botWdSubmit')) return;
    const STATUS = {
      pending_review: { t: '⏳ Pendiente', c: '#e3bd48' },
      paying:         { t: '⏳ Procesando', c: '#e3bd48' },
      paid:           { t: '✅ Pagado', c: '#25d366' },
      failed:         { t: '⚠️ Con problema', c: '#e0a05a' },
      cancelled:      { t: '❌ Rechazado', c: '#e05a5a' }
    };
    let html = '<div class="cwVal" style="font-size:14px;font-weight:800;margin-bottom:8px;">📋 Tus últimos retiros</div>';
    list.forEach(function(p) {
      const st = STATUS[p.status] || { t: p.status, c: '#8a939b' };
      const monto = '$' + (Number(p.amount) || 0).toLocaleString('es-AR');
      let fecha = '';
      try { fecha = new Date(p.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }); } catch (e) {}
      html += '<div class="cwBox" style="border-radius:9px;padding:9px 11px;margin-bottom:6px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<b class="cwVal" style="font-size:14px;">' + monto + '</b>' +
          '<span style="color:' + st.c + ';font-size:12px;font-weight:800;">' + st.t + '</span></div>' +
        (fecha ? '<div class="cwMut" style="font-size:10.5px;">' + fecha + '</div>' : '');
      if (p.status === 'cancelled') {
        html += '<div style="margin-top:6px;background:rgba(224,90,90,0.12);border-radius:8px;padding:7px 9px;">' +
          '<div style="color:#e05a5a;font-size:11.5px;font-weight:700;">Motivo del rechazo:</div>' +
          '<div class="cwVal" style="font-size:12.5px;">' + _wrEsc(p.rejectReason || 'No especificado. Consultá con soporte.') + '</div>' +
          '<button type="button" onclick="VIP.ui.casinoBotSupport()" style="margin-top:7px;width:100%;' +
          'background:#128c4a;color:#fff;border:none;border-radius:9px;padding:9px;font-size:12.5px;font-weight:800;cursor:pointer;">' +
          '¿Creés que es un error? Hablá con soporte 🎧</button></div>';
      }
      // Comprobante del pago confirmado por hgcash (owner 2026-08-22).
      if (p.status === 'paid' && p.receiptUrl) {
        html += '<a href="' + _wrEsc(p.receiptUrl) + '" target="_blank" rel="noopener" ' +
          'style="display:block;margin-top:6px;text-align:center;background:rgba(37,211,102,0.14);' +
          'color:#25d366;border-radius:8px;padding:8px;font-size:12.5px;font-weight:800;text-decoration:none;">' +
          '📄 Ver comprobante del pago</a>';
      }
      html += '</div>';
    });
    const box = VIP.ui._botMsg(html);
    if (box) area.scrollTop = area.scrollHeight;
  }).catch(function() {});
};

/** Envía la solicitud de retiro del form del panel. */
VIP.ui.casinoBotWithdrawSubmit = async function() {
  const err = document.getElementById('botWdError');
  const showErr = function(msg) { if (err) { err.textContent = msg; err.style.display = 'block'; } };
  if (err) err.style.display = 'none';

  const amount = parseFloat((document.getElementById('botWdAmount') || {}).value || '');
  const dest = String((document.getElementById('botWdCbu') || {}).value || '').trim();
  const titular = String((document.getElementById('botWdTitular') || {}).value || '').trim();
  if (!Number.isFinite(amount) || amount < 4999) return showErr('El retiro mínimo es de $4.999.');
  if (!dest) return showErr('Ingresá tu CBU/CVU de 22 dígitos o tu alias.');
  const destDigits = dest.replace(/\D/g, '');
  const isCbu = destDigits.length === 22 && /^\d+$/.test(dest.replace(/[\s-]/g, ''));
  if (!isCbu && dest.length < 6) return showErr('El alias es muy corto (o el CBU no tiene 22 dígitos).');
  if (!titular || titular.length < 5) return showErr('Ingresá el nombre completo del titular.');

  const btn = document.getElementById('botWdSubmit');
  if (btn) { btn.disabled = true; btn.textContent = 'Procesando…'; }
  try {
    const metaEventId = (VIP.pixel && VIP.pixel.enabled) ? VIP.pixel.newEventId() : null;
    const res = await fetch(`${VIP.config.API_URL}/api/withdrawal/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VIP.state.currentToken}` },
      body: JSON.stringify({
        titular,
        cbu: isCbu ? destDigits : null,
        alias: isCbu ? null : dest,
        amount,
        metaEventId
      })
    });
    const data = await res.json().catch(function() { return {}; });
    if (res.ok && data.success) {
      if (VIP.pixel && metaEventId) {
        VIP.pixel.trackWithId(metaEventId, 'WithdrawRequest', { value: amount, currency: 'ARS' });
      }
      const area = document.getElementById('casinoBotArea');
      if (area) area.innerHTML = '';
      VIP.ui._botMsg('✅ <b>¡Retiro solicitado por $' + amount.toLocaleString('es-AR') + '!</b><br>' +
        'Lo estamos verificando y el pago sale automático a tu cuenta. Te avisamos acá cuando esté transferido 🔔');
      VIP.ui._botRow(VIP.ui._botBtn('🎰 Volver al juego', 'VIP.ui.closeCasinoChat()', true));
      try { if (VIP.ui.syncBalance) setTimeout(VIP.ui.syncBalance, 1500); } catch (e) {}
      return;
    }
    if (data.code === 'PHONE_VERIFICATION_REQUIRED') {
      // Seguridad: primera vez necesita verificar el teléfono por SMS → se
      // deriva al formulario completo (tiene el paso de OTP integrado).
      VIP.ui._botMsg('🔐 Por tu seguridad, para el <b>primer retiro</b> tenés que verificar tu teléfono por SMS. ' +
        'Te abrimos el formulario completo para hacerlo en un paso.');
      const modal = document.getElementById('withdrawModal');
      if (modal) modal.style.zIndex = '100001'; // sobre el overlay del casino
      if (VIP.withdraw && VIP.withdraw.openWithdrawModal) VIP.withdraw.openWithdrawModal();
      else VIP.ui.casinoBotSupport();
    } else {
      showErr(data.error || 'No se pudo procesar el retiro. Probá de nuevo.');
    }
  } catch (e) {
    showErr('Error de conexión. Probá de nuevo.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar Retiro'; }
  }
};

/** Aviso claro de que respondió SOPORTE (owner 2026-08-22): badge rojo en el
 *  botón "🎧 Soporte" + toast, para que el usuario sepa que el sonido vino de
 *  soporte y dónde tocar. Solo cuando NO está viendo el chat de soporte. */
VIP.ui._supportUnread = 0;
VIP.ui._notifySupportReply = function(n) {
  VIP.ui._supportUnread = (VIP.ui._supportUnread || 0) + (n || 1);
  const badge = document.getElementById('casinoSoporteBadge');
  if (badge) {
    badge.textContent = VIP.ui._supportUnread > 9 ? '9+' : String(VIP.ui._supportUnread);
    badge.style.display = 'inline-block';
  }
  // Toast (throttle 4s para no repetir con cada mensaje de una ráfaga).
  const now = Date.now();
  if (now - (VIP.ui._supportToastAt || 0) > 4000) {
    VIP.ui._supportToastAt = now;
    if (VIP.ui.showToast) VIP.ui.showToast('💬 Soporte te respondió — tocá 🎧 Soporte', 'info');
  }
};

VIP.ui._clearSupportUnread = function() {
  VIP.ui._supportUnread = 0;
  const badge = document.getElementById('casinoSoporteBadge');
  if (badge) badge.style.display = 'none';
};

/** FALLBACK humano: muda el chat real adentro del panel (modo soporte). */
VIP.ui.casinoBotSupport = function() {
  VIP.ui._clearSupportUnread(); // el usuario entra a ver soporte → sin pendientes
  VIP.ui._casinoChatMount();
  // Bienvenida automática del soporte (server-side, editable en COMANDOS como
  // /sys_soporte_bienvenida, con throttle para no spamear al agente). El
  // mensaje llega por socket y aparece en el chat recién montado.
  try {
    fetch(`${VIP.config.API_URL}/api/support/hello`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).catch(function() {});
  } catch (e) {}
  // Que SIEMPRE se vea el último mensaje: además del scroll del mount (rAF),
  // un segundo scroll cuando el historial ya terminó de renderizar.
  setTimeout(function() {
    try {
      const msgs = document.getElementById('chatMessages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    } catch (e) {}
  }, 600);
};

// ============================================================
// RULETA DE BIENVENIDA (2026-08-21) — se gira una vez; el premio lo decide el
// SERVER (spin), el cliente solo ve la animación caer en el segmento premiado.
// ============================================================
VIP.ui._maybeOfferWelcomeRoulette = function() {
  // El status se pide UNA vez por sesión de widget y se cachea; cada vez que se
  // vuelve al inicio se re-muestra lo que corresponda: la oferta de girar, o
  // el acceso a "Mi premio" si ya giró (owner 2026-08-28: poder volver a verlo).
  const show = function(d) {
    if (!d) return;
    if (d.canSpin) {
      VIP.ui._botMsg('🎁 <b>¡Tenés una RULETA DE BIENVENIDA!</b><br>Girá y ganá tu premio 🎡');
      VIP.ui._botRow(VIP.ui._botBtn('🎡 ¡GIRAR LA RULETA!', 'VIP.ui.casinoBotGo(\'roulette\')', true));
    } else if (d.alreadySpun && d.prize) {
      VIP.ui._botRow(VIP.ui._botBtn('🎡 Mi premio de la ruleta', 'VIP.ui.casinoBotGo(\'roulette-prize\')', false));
    }
  };
  if (VIP.ui._wrOffered) { show(VIP.ui._wrStatus); return; }
  fetch(`${VIP.config.API_URL}/api/welcome-roulette/status`, {
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
    if (!d) return;
    VIP.ui._wrOffered = true;
    VIP.ui._wrStatus = d;
    VIP.ui._wrSegments = (d.segments || []).map(function(s) { return s.label; });
    show(d);
  }).catch(function() {});
};

/** Pantalla "Mi premio": qué le salió, en qué estado está, y desde cuándo.
 *  Queda accesible siempre (para verlo de nuevo o sacar captura). */
VIP.ui._renderRoulettePrize = function() {
  const area = document.getElementById('casinoBotArea');
  if (!area) return;
  area.innerHTML = '';
  VIP.ui._botMsg('⏳ Buscando tu premio…');
  fetch(`${VIP.config.API_URL}/api/welcome-roulette/status`, {
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
    area.innerHTML = '';
    const p = d && d.prize;
    if (!p) {
      VIP.ui._botMsg('🎡 Todavía no giraste la ruleta.');
      if (d && d.canSpin) VIP.ui._botRow(VIP.ui._botBtn('🎡 ¡GIRAR LA RULETA!', 'VIP.ui.casinoBotGo(\'roulette\')', true));
      return;
    }
    VIP.ui._wrStatus = d;
    const fmt = function(x) { try { return new Date(x).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
    let estado = '';
    if (p.type === 'cash') {
      estado = '💰 <b>Acreditado en tu saldo</b>' + (p.rolloverX > 0 ? ' — para retirarlo tenés que apostar ' + p.rolloverX + ' veces el premio.' : '.');
    } else if (p.status === 'pending') {
      estado = '⏳ <b>Pendiente</b> — se te suma automáticamente en tu <b>próxima carga</b> (' + _wrEsc(String(p.value)) + '% extra).';
    } else {
      estado = '✅ <b>Ya aplicado</b>' + (p.usedAt ? ' el ' + fmt(p.usedAt) : '') + ' en una carga.';
    }
    VIP.ui._botMsg(
      '<div style="text-align:center;padding:6px 0;">' +
        '<div style="font-size:13px;opacity:.85;">🎡 Tu premio de la ruleta</div>' +
        '<div style="font-size:26px;font-weight:900;color:#ffd700;margin:6px 0;text-shadow:0 1px 3px rgba(0,0,0,.6);">' + _wrEsc(p.label || '') + '</div>' +
        '<div style="font-size:13px;line-height:1.35;">' + estado + '</div>' +
        (p.spunAt ? '<div style="font-size:11px;opacity:.7;margin-top:8px;">Giraste el ' + fmt(p.spunAt) + '</div>' : '') +
        '<div style="font-size:11px;opacity:.7;margin-top:4px;">📸 Podés sacar captura de esta pantalla cuando quieras.</div>' +
      '</div>');
    if (p.type === 'percent' && p.status === 'pending') {
      VIP.ui._botRow(VIP.ui._botBtn('💳 Cargar ahora y usarlo', "VIP.ui.casinoBotGo('deposit')", true));
    }
    VIP.ui._botRow(VIP.ui._botBtn('↩️ Volver', "VIP.ui.casinoBotGo('home')", false));
  }).catch(function() {
    area.innerHTML = '';
    VIP.ui._botMsg('No pude cargar tu premio. Probá de nuevo.');
    VIP.ui._botRow(VIP.ui._botBtn('↩️ Volver', "VIP.ui.casinoBotGo('home')", false));
  });
};

/** Dibuja la ruleta en un OVERLAY a pantalla completa (owner 2026-08-28: que
 *  tape toda la pantalla, no solo el chat). Por encima del casino y del widget.
 *  El resultado se muestra en el mismo overlay; al cerrar vuelve al inicio del
 *  asistente (donde queda "🎡 Mi premio de la ruleta"). */
VIP.ui._renderRoulette = function() {
  VIP.ui.casinoRouletteClose(true);
  const segs = VIP.ui._wrSegments || [];
  const n = Math.max(1, segs.length);
  const S = Math.max(240, Math.min(Math.floor(Math.min(window.innerWidth * 0.86, window.innerHeight * 0.46)), 360));
  const R = S / 2, rr = S * 0.29, lw = Math.round(S * 0.36);
  const fs = S >= 320 ? 16 : (S >= 280 ? 14 : 12);
  const colors = ['#128c4a', '#0f7a3d', '#1aa356', '#0c6234'];
  let stops = '';
  for (let i = 0; i < n; i++) {
    const a0 = (360 / n) * i, a1 = (360 / n) * (i + 1);
    stops += colors[i % colors.length] + ' ' + a0 + 'deg ' + a1 + 'deg' + (i < n - 1 ? ',' : '');
  }
  let labels = '';
  for (let i = 0; i < n; i++) {
    const ang = (360 / n) * i + (360 / n) / 2;
    const rad = ang * Math.PI / 180;
    const x = R + rr * Math.sin(rad), y = R - rr * Math.cos(rad);
    labels += '<div class="wrLbl" style="position:absolute;left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;' +
      'transform:translate(-50%,-50%);width:' + lw + 'px;text-align:center;font-size:' + fs + 'px;line-height:1.15;font-weight:900;' +
      'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.85);transition:transform 4.2s cubic-bezier(.17,.67,.2,1);">' +
      _wrEsc(segs[i] || '') + '</div>';
  }
  const ov = document.createElement('div');
  ov.id = 'wrOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.9);display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;padding:18px 16px;box-sizing:border-box;font-family:inherit;overflow:auto;';
  ov.innerHTML =
    '<button type="button" onclick="VIP.ui.casinoRouletteClose()" aria-label="Cerrar" ' +
      'style="position:absolute;top:12px;right:12px;width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.14);' +
      'color:#fff;font-size:20px;font-weight:900;cursor:pointer;">✕</button>' +
    '<div style="color:#ffd700;font-size:22px;font-weight:900;text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.6);">🎡 RULETA DE BIENVENIDA</div>' +
    '<div style="color:#fff;opacity:.85;font-size:14px;margin:4px 0 16px;text-align:center;">Girás una sola vez. ¡Suerte!</div>' +
    '<div style="position:relative;width:' + S + 'px;height:' + S + 'px;margin-bottom:18px;flex:none;">' +
      '<div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);z-index:3;width:0;height:0;' +
        'border-left:14px solid transparent;border-right:14px solid transparent;border-top:24px solid #ffd700;' +
        'filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));"></div>' +
      '<div id="wrWheel" style="width:' + S + 'px;height:' + S + 'px;border-radius:50%;position:relative;' +
        'background:conic-gradient(' + stops + ');box-shadow:0 10px 34px rgba(0,0,0,.7),inset 0 0 0 5px #ffd700aa;' +
        'transition:transform 4.2s cubic-bezier(.17,.67,.2,1);">' + labels + '</div>' +
    '</div>' +
    '<div id="wrResult" style="color:#fff;text-align:center;font-size:15px;line-height:1.35;max-width:360px;"></div>' +
    '<div id="wrActions" style="width:100%;max-width:360px;display:flex;flex-direction:column;gap:10px;margin-top:6px;">' +
      '<button type="button" id="wrSpinBtn" onclick="VIP.ui.casinoRouletteSpin()" ' +
        'style="width:100%;background:#ffd700;color:#3a2c00;border:none;border-radius:16px;padding:16px;' +
        'font-size:19px;font-weight:900;cursor:pointer;box-shadow:0 6px 18px rgba(255,215,0,.35);">🎡 GIRAR</button>' +
    '</div>';
  document.body.appendChild(ov);
  VIP.ui._wrOverlayOpen = true;
};

/** Cierra el overlay de la ruleta. Si no es un cierre "silencioso", vuelve al
 *  inicio del asistente (donde está "🎡 Mi premio de la ruleta"). */
VIP.ui.casinoRouletteClose = function(silent) {
  const ov = document.getElementById('wrOverlay');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  VIP.ui._wrOverlayOpen = false;
  if (silent) return;
  if (VIP.ui._rwReturn) { VIP.ui._rwReturn = false; try { VIP.ui.openRewardsHub(); return; } catch (e) {} }
  try { VIP.ui.casinoBotGo('home'); } catch (e) {}
};

// ============================================================
// 🎁 HUB DE PREMIOS (#254) — ruleta de bienvenida + ruleta diaria + cashback
// instantáneo en un overlay propio, fuera del chat.
// ============================================================
VIP.ui._refreshRewards = function() {
  fetch(`${VIP.config.API_URL}/api/rewards/summary`, {
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
  }).then(function(r) { return r.ok ? r.json() : null; }).then(function(d) {
    if (!d) return;
    VIP.ui._rwSummary = d;
    if (d.welcome && d.welcome.segments) VIP.ui._wrSegments = d.welcome.segments.map(function(x) { return x.label; });
    const btn = document.getElementById('casinoRewardsBtn');
    if (btn) btn.style.display = 'flex'; // el hub siempre existe (muestra "muy pronto" si algo está apagado)
    const dot = document.getElementById('rwDot');
    const claimable =
      (d.welcome && d.welcome.canSpin) ||
      (d.daily && d.daily.canSpin) ||
      (d.cashback && d.cashback.reclamable >= (d.cashback.minArs || 1) && d.cashback.reclamable > 0);
    if (dot) dot.style.display = claimable ? 'block' : 'none';
    // Si el hub está abierto, re-pintarlo con los datos frescos.
    if (document.getElementById('rwHubOverlay')) VIP.ui.openRewardsHub();
  }).catch(function() {});
};

function _rwFmt(n) { try { return '$' + Number(n || 0).toLocaleString('es-AR'); } catch (e) { return '$' + n; } }
function _rwCountdown(iso) {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'ya mismo';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return (h > 0 ? h + ' h ' : '') + m + ' min';
  } catch (e) { return '—'; }
}
function _rwCard(opts) {
  // Tarjeta del hub: ícono + título + estado + CTA. Diseño oscuro con acento.
  const acc = opts.accent || '#ffd700';
  return '<div style="background:linear-gradient(160deg,rgba(255,255,255,0.055),rgba(255,255,255,0.015));' +
      'border:1px solid ' + acc + '55;border-radius:18px;padding:16px 16px 14px;position:relative;overflow:hidden;">' +
    '<div style="position:absolute;top:-30px;right:-30px;width:110px;height:110px;border-radius:50%;background:' + acc + '14;"></div>' +
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">' +
      '<div style="width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;' +
        'font-size:24px;background:' + acc + '1f;border:1px solid ' + acc + '44;flex:none;">' + opts.icon + '</div>' +
      '<div style="min-width:0;">' +
        '<div style="font-size:15px;font-weight:900;color:#fff;letter-spacing:0.2px;">' + opts.title + '</div>' +
        '<div style="font-size:11.5px;color:#9aa4b0;">' + (opts.subtitle || '') + '</div>' +
      '</div>' +
    '</div>' +
    (opts.body || '') +
    (opts.cta || '') +
  '</div>';
}
function _rwCta(label, onclick, enabled, accent) {
  const acc = accent || '#ffd700';
  if (enabled) {
    return '<button type="button" onclick="' + onclick + '" style="width:100%;margin-top:10px;border:none;cursor:pointer;' +
      'background:linear-gradient(135deg,' + acc + ',#ff9800);color:#231a00;border-radius:13px;padding:13px;' +
      'font-size:15px;font-weight:900;letter-spacing:0.3px;box-shadow:0 6px 18px ' + acc + '40;">' + label + '</button>';
  }
  return '<div style="width:100%;margin-top:10px;text-align:center;background:rgba(255,255,255,0.06);color:#8b95a1;' +
    'border-radius:13px;padding:12px;font-size:13px;font-weight:700;">' + label + '</div>';
}

VIP.ui.openRewardsHub = function() {
  VIP.ui.closeRewardsHub(true);
  const d = VIP.ui._rwSummary || {};
  const w = d.welcome || {}, dy = d.daily || {}, cb = d.cashback || {};
  let cards = '';

  // --- Ruleta de BIENVENIDA (siempre visible; apagada = "muy pronto") ---
  {
    let body = '', cta = '';
    if (w.canSpin) {
      body = '<div style="font-size:13px;color:#cfd6de;line-height:1.4;">Tenés <b style="color:#ffd700;">1 giro GRATIS</b> de bienvenida. Se gira una sola vez. ¡Suerte!</div>';
      cta = _rwCta('🎡 GIRAR AHORA', "VIP.ui._rwSpinWelcome()", true);
    } else if (w.prize) {
      const p = w.prize;
      let st = p.type === 'cash'
        ? '💰 Acreditado en tu saldo' + (p.rolloverX > 0 ? ' · rollover x' + p.rolloverX : '')
        : (p.status === 'pending' ? '⏳ ' + _wrEsc(String(p.value)) + '% EXTRA pendiente — se suma en tu próxima carga' : '✅ Ya aplicado en una carga');
      body = '<div style="font-size:13px;color:#cfd6de;">Tu premio: <b style="color:#ffd700;font-size:16px;">' + _wrEsc(p.label || '') + '</b><br>' +
        '<span style="font-size:12px;">' + st + '</span></div>';
      if (p.type === 'percent' && p.status === 'pending') cta = _rwCta('💳 Cargar y usarlo', "VIP.ui.closeRewardsHub();VIP.ui.casinoBotGo('deposit')", true);
    }
    if (!body && !cta) {
      body = '<div style="font-size:13px;color:#9aa4b0;">Un giro gratis al crear tu cuenta. 🔒 Disponible muy pronto.</div>';
      cta = _rwCta('🔒 Muy pronto', '', false);
    }
    cards += _rwCard({ icon: '🎡', accent: '#ffd700', title: 'Ruleta de Bienvenida', subtitle: 'Un giro único por cuenta', body: body, cta: cta });
  }

  // --- Ruleta DIARIA (siempre visible; apagada = "muy pronto") ---
  {
    let body = '', cta = '';
    if (!dy.enabled) {
      body = '<div style="font-size:13px;color:#9aa4b0;">Un giro gratis TODOS los días con premios en % extra y saldo. 🔒 Disponible muy pronto.</div>';
      cta = _rwCta('🔒 Muy pronto', '', false, '#26e07f');
    } else if (dy.canSpin) {
      body = '<div style="font-size:13px;color:#cfd6de;line-height:1.4;">Tu giro <b style="color:#26e07f;">GRATIS de HOY</b> está disponible. Premios en % extra y saldo directo.</div>';
      cta = _rwCta('🎰 GIRAR LA RULETA DE HOY', 'VIP.ui._rwSpinDaily()', true, '#26e07f');
    } else if (dy.needsDeposit) {
      body = '<div style="font-size:13px;color:#cfd6de;line-height:1.4;">Hacé tu <b>primera carga</b> y desbloqueás un giro gratis <b>todos los días</b>.</div>';
      cta = _rwCta('💳 Hacer mi primera carga', "VIP.ui.closeRewardsHub();VIP.ui.casinoBotGo('deposit')", true, '#26e07f');
    } else if (dy.alreadySpun) {
      const tp = dy.todayPrize || {};
      let st = tp.type === 'percent' ? ('Hoy ganaste <b style="color:#26e07f;">' + _wrEsc(tp.label || '') + '</b>' + (dy.pendingPct > 0 ? ' — se aplica en tu próxima carga' : ' — ya aplicado'))
        : tp.type === 'cash' && tp.prizeARS > 0 ? ('Hoy ganaste <b style="color:#26e07f;">' + _rwFmt(tp.prizeARS) + '</b> — acreditado 💰')
        : 'Hoy no hubo suerte 😅';
      body = '<div style="font-size:13px;color:#cfd6de;line-height:1.45;">' + st + '<br>' +
        '<span style="font-size:12px;color:#9aa4b0;">⏰ Próximo giro en <b>' + _rwCountdown(dy.nextResetAt) + '</b></span></div>';
      cta = _rwCta('⏰ Volvé mañana por otro giro', '', false);
    } else {
      body = '<div style="font-size:13px;color:#cfd6de;">La ruleta diaria no está disponible para tu cuenta todavía.</div>';
    }
    cards += _rwCard({ icon: '🎰', accent: '#26e07f', title: 'Ruleta Diaria', subtitle: 'Un giro gratis por día', body: body, cta: cta });
  }

  // --- CASHBACK instantáneo (siempre visible; apagado = "muy pronto") ---
  {
    let body = '', cta = '';
    // "En vivo" (#254): sello de frescura + refresco manual. El auto-refresh
    // corre cada 60s mientras el hub está abierto (_rwStartPolling).
    const _cbAgo = VIP.ui._rwCbAt ? Math.max(0, Math.round((Date.now() - VIP.ui._rwCbAt) / 1000)) : null;
    const _cbLive = cb.enabled && !cb.unavailable
      ? '<div style="display:flex;align-items:center;justify-content:space-between;margin:-2px 0 6px;">' +
          '<span style="font-size:10.5px;color:#6f7a86;">' +
            '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#26e07f;box-shadow:0 0 6px #26e07f;margin-right:4px;"></span>' +
            'EN VIVO' + (_cbAgo != null ? ' · actualizado hace ' + (_cbAgo < 5 ? 'instantes' : _cbAgo + ' s') : '') + '</span>' +
          '<button type="button" onclick="VIP.ui._rwPollCashback(true)" style="background:rgba(255,255,255,0.10);border:none;color:#cfd6de;' +
            'border-radius:8px;padding:4px 10px;font-size:11px;font-weight:800;cursor:pointer;">🔄 Actualizar</button>' +
        '</div>'
      : '';
    if (!cb.enabled) {
      body = '<div style="font-size:13px;color:#9aa4b0;">Recuperá al instante un % de lo que perdés en el día. 🔒 Disponible muy pronto.</div>';
      cta = _rwCta('🔒 Muy pronto', '', false, '#4dd0ff');
    } else if (cb.unavailable) {
      body = '<div style="font-size:13px;color:#cfd6de;">No pudimos calcular tu pérdida de hoy. Probá en unos minutos.</div>';
    } else if (cb.reclamable > 0 && cb.reclamable >= (cb.minArs || 0)) {
      body = '<div style="text-align:center;padding:4px 0 2px;">' +
        '<div style="font-size:11.5px;color:#9aa4b0;">Perdiste hoy ' + _rwFmt(cb.netwinToday) + ' → recuperá</div>' +
        '<div style="font-size:30px;font-weight:900;color:#4dd0ff;text-shadow:0 2px 8px rgba(77,208,255,0.35);margin:2px 0;">' + _rwFmt(cb.reclamable) + '</div>' +
        '<div style="font-size:11px;color:#9aa4b0;">Se acredita YA como bonus' + (cb.rolloverX > 0 ? ' · para retirarlo apostalo x' + cb.rolloverX : '') + '</div></div>';
      cta = _rwCta('📉 RECLAMAR ' + _rwFmt(cb.reclamable), 'VIP.ui.casinoCashbackClaim()', true, '#4dd0ff');
    } else if (cb.netwinToday > 0) {
      body = '<div style="font-size:13px;color:#cfd6de;line-height:1.45;">Perdiste hoy ' + _rwFmt(cb.netwinToday) +
        (cb.paidToday > 0 ? ' y ya recuperaste ' + _rwFmt(cb.paidToday) + '.' : '.') +
        '<br><span style="font-size:12px;color:#9aa4b0;">Reclamás el ' + (cb.pct || 0) + '% de tu pérdida (mínimo ' + _rwFmt(cb.minArs) + ').</span></div>';
      cta = _rwCta('Todavía no llegás al mínimo', '', false);
    } else {
      body = '<div style="font-size:13px;color:#cfd6de;line-height:1.45;">Si hoy perdés jugando, acá recuperás el <b style="color:#4dd0ff;">' + (cb.pct || 0) + '%</b> al instante. Sin esperar al lunes.</div>';
    }
    body = _cbLive + body;
    cards += _rwCard({ icon: '📉', accent: '#4dd0ff', title: 'Cashback en Vivo', subtitle: cb.enabled ? ('Recuperá el ' + (cb.pct || 0) + '% de lo que perdés hoy') : 'Recuperá parte de lo que perdés', body: body, cta: cta });
  }

  // --- ℹ️ Qué es el ROLLOVER (owner 2026-09-01: explicado acá adentro) ---
  cards += '<div style="background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:14px 16px;">' +
    '<div style="font-size:13px;font-weight:900;color:#fff;margin-bottom:6px;">ℹ️ ¿Qué es el ROLLOVER?</div>' +
    '<div style="font-size:12px;color:#b7c0ca;line-height:1.55;">' +
      'Varios premios y reembolsos se acreditan como <b style="color:#fff;">BONUS con rollover</b>: la plata entra YA a tu saldo y podés jugarla, ' +
      'pero para <b style="color:#fff;">retirarla</b> primero tenés que apostarla la cantidad de veces que indica ' +
      '(ej. <b style="color:#ffd700;">x2</b> = apostar 2 veces ese monto).<br>' +
      '⚠️ El rollover se completa jugando <b style="color:#26e07f;">SLOTS y RULETA</b> — las apuestas en <b style="color:#ff8a80;">DEPORTES NO suman</b> para el rollover.' +
    '</div></div>';

  if (!cards) cards = '<div style="color:#9aa4b0;text-align:center;padding:30px 10px;font-size:14px;">Por ahora no hay premios activos. ¡Volvé pronto! 🎁</div>';

  const ov = document.createElement('div');
  ov.id = 'rwHubOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147482900;display:flex;flex-direction:column;align-items:center;' +
    'background:radial-gradient(120% 90% at 50% 0%,#141b2e 0%,#0a0e1a 55%,#070a12 100%);overflow:auto;' +
    'padding:calc(16px + env(safe-area-inset-top,0px)) 16px calc(24px + env(safe-area-inset-bottom,0px));box-sizing:border-box;';
  ov.innerHTML =
    '<button type="button" onclick="VIP.ui.closeRewardsHub()" aria-label="Cerrar" ' +
      'style="position:absolute;top:calc(12px + env(safe-area-inset-top,0px));right:12px;width:38px;height:38px;border-radius:50%;' +
      'border:none;background:rgba(255,255,255,.12);color:#fff;font-size:19px;font-weight:900;cursor:pointer;">✕</button>' +
    '<div style="width:100%;max-width:420px;">' +
      '<div style="text-align:center;margin:6px 0 18px;">' +
        '<div style="font-size:34px;line-height:1;">🎁</div>' +
        '<div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:0.5px;margin-top:4px;">TUS PREMIOS</div>' +
        '<div style="font-size:12px;color:#9aa4b0;margin-top:2px;">Ruletas, bonos y cashback — todo acá</div>' +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:14px;">' + cards + '</div>' +
    '</div>';
  document.body.appendChild(ov);
  // Arrancar el polling solo si no está corriendo (el re-render del propio
  // polling vuelve a pasar por acá y no debe reiniciar el timer ni re-pedir).
  if (!VIP.ui._rwPollTimer) VIP.ui._rwStartPolling();
};
VIP.ui.closeRewardsHub = function(silent) {
  const ov = document.getElementById('rwHubOverlay');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  VIP.ui._rwStopPolling();
  if (!silent) { try { VIP.ui._refreshRewards(); } catch (e) {} }
};

// ---- CASHBACK "EN VIVO" (#254): auto-refresh SOLO mientras el hub está
// abierto y la pestaña visible. Cada 60s pide /api/cashback/status; el server
// cachea el netwin 90s → como mucho UNA consulta real a la plataforma por
// cliente cada minuto y medio (no come el rate limit de 60/min). ----
VIP.ui._rwStartPolling = function() {
  VIP.ui._rwStopPolling();
  VIP.ui._rwPollCashback();
  VIP.ui._rwPollTimer = setInterval(function() {
    if (document.hidden) return;
    if (!document.getElementById('rwHubOverlay')) { VIP.ui._rwStopPolling(); return; }
    VIP.ui._rwPollCashback();
  }, 60000);
};
VIP.ui._rwStopPolling = function() {
  if (VIP.ui._rwPollTimer) { clearInterval(VIP.ui._rwPollTimer); VIP.ui._rwPollTimer = null; }
};
VIP.ui._rwPollCashback = function(manual) {
  if (VIP.ui._rwPollBusy) return;
  VIP.ui._rwPollBusy = true;
  // El botón 🔄 pide con fresh=1 → el server lee el netwin SIN cache (una vez
  // cada 30s por usuario; si insiste antes, contesta 429 con cuántos segundos
  // le faltan). El auto-refresh de 60s va por el cache normal.
  const url = `${VIP.config.API_URL}/api/cashback/status` + (manual ? '?fresh=1' : '');
  fetch(url, {
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
  }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
    .then(function(res) {
      VIP.ui._rwPollBusy = false;
      if (!res.ok) {
        if (manual) VIP.ui.showToast((res.j && res.j.error) || 'Esperá unos segundos y probá de nuevo.', 'error');
        return;
      }
      const d = res.j;
      if (!d) return;
      if (!VIP.ui._rwSummary) VIP.ui._rwSummary = {};
      VIP.ui._rwSummary.cashback = d;
      VIP.ui._rwCbAt = Date.now();
      // Re-pintar el hub conservando el scroll (la lista es corta, no molesta).
      const ov = document.getElementById('rwHubOverlay');
      if (ov) {
        const st = ov.scrollTop;
        VIP.ui.openRewardsHub();
        const ov2 = document.getElementById('rwHubOverlay');
        if (ov2) ov2.scrollTop = st;
      }
      if (manual) VIP.ui.showToast('Actualizado ✔', 'success');
    })
    .catch(function() { VIP.ui._rwPollBusy = false; });
};

// Girar la de BIENVENIDA desde el hub (cierra el hub, abre la rueda; al cerrar vuelve).
VIP.ui._rwSpinWelcome = function() {
  VIP.ui.closeRewardsHub(true);
  VIP.ui._rwReturn = true;
  VIP.ui.casinoBotGo('roulette');
};

// ---- RULETA DIARIA: overlay propio (misma rueda, endpoint /api/roulette) ----
VIP.ui._rwSpinDaily = function() {
  VIP.ui.closeRewardsHub(true);
  VIP.ui._rwReturn = true;
  const d = (VIP.ui._rwSummary && VIP.ui._rwSummary.daily) || {};
  VIP.ui._drSegments = (d.segments || []).map(function(x) { return x.label; });
  VIP.ui._renderDailyRoulette();
};
VIP.ui._renderDailyRoulette = function() {
  VIP.ui.casinoRouletteClose(true);
  const segs = VIP.ui._drSegments || [];
  const n = Math.max(1, segs.length);
  const S = Math.max(240, Math.min(Math.floor(Math.min(window.innerWidth * 0.86, window.innerHeight * 0.46)), 360));
  const R = S / 2, rr = S * 0.29, lw = Math.round(S * 0.36);
  const fs = S >= 320 ? (n > 5 ? 13 : 16) : 12;
  const colors = ['#0e7a5c', '#0b5d47', '#12996f', '#0a4d3b'];
  let stops = '';
  for (let i = 0; i < n; i++) {
    const a0 = (360 / n) * i, a1 = (360 / n) * (i + 1);
    stops += colors[i % colors.length] + ' ' + a0 + 'deg ' + a1 + 'deg' + (i < n - 1 ? ',' : '');
  }
  let labels = '';
  for (let i = 0; i < n; i++) {
    const ang = (360 / n) * i + (360 / n) / 2;
    const rad = ang * Math.PI / 180;
    const x = R + rr * Math.sin(rad), y = R - rr * Math.cos(rad);
    labels += '<div class="wrLbl" style="position:absolute;left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;' +
      'transform:translate(-50%,-50%);width:' + lw + 'px;text-align:center;font-size:' + fs + 'px;line-height:1.15;font-weight:900;' +
      'color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.85);transition:transform 4.2s cubic-bezier(.17,.67,.2,1);">' +
      _wrEsc(segs[i] || '') + '</div>';
  }
  const ov = document.createElement('div');
  ov.id = 'wrOverlay';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.9);display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;padding:18px 16px;box-sizing:border-box;font-family:inherit;overflow:auto;';
  ov.innerHTML =
    '<button type="button" onclick="VIP.ui.casinoRouletteClose()" aria-label="Cerrar" ' +
      'style="position:absolute;top:12px;right:12px;width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.14);' +
      'color:#fff;font-size:20px;font-weight:900;cursor:pointer;">✕</button>' +
    '<div style="color:#26e07f;font-size:22px;font-weight:900;text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.6);">🎰 RULETA DIARIA</div>' +
    '<div style="color:#fff;opacity:.85;font-size:14px;margin:4px 0 16px;text-align:center;">Un giro gratis por día. ¡Suerte!</div>' +
    '<div style="position:relative;width:' + S + 'px;height:' + S + 'px;margin-bottom:18px;flex:none;">' +
      '<div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);z-index:3;width:0;height:0;' +
        'border-left:14px solid transparent;border-right:14px solid transparent;border-top:24px solid #26e07f;' +
        'filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));"></div>' +
      '<div id="wrWheel" style="width:' + S + 'px;height:' + S + 'px;border-radius:50%;position:relative;' +
        'background:conic-gradient(' + stops + ');box-shadow:0 10px 34px rgba(0,0,0,.7),inset 0 0 0 5px #26e07faa;' +
        'transition:transform 4.2s cubic-bezier(.17,.67,.2,1);">' + labels + '</div>' +
    '</div>' +
    '<div id="wrResult" style="color:#fff;text-align:center;font-size:15px;line-height:1.35;max-width:360px;"></div>' +
    '<div id="wrActions" style="width:100%;max-width:360px;display:flex;flex-direction:column;gap:10px;margin-top:6px;">' +
      '<button type="button" id="wrSpinBtn" onclick="VIP.ui.casinoDailySpin()" ' +
        'style="width:100%;background:#26e07f;color:#00301a;border:none;border-radius:16px;padding:16px;' +
        'font-size:19px;font-weight:900;cursor:pointer;box-shadow:0 6px 18px rgba(38,224,127,.35);">🎰 GIRAR</button>' +
    '</div>';
  document.body.appendChild(ov);
  VIP.ui._wrOverlayOpen = true;
};
VIP.ui.casinoDailySpin = function() {
  const btn = document.getElementById('wrSpinBtn');
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Girando…'; }
  fetch(`${VIP.config.API_URL}/api/roulette/spin`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
      if (!res.ok || !res.d || !res.d.success) {
        if (btn) { btn.disabled = false; btn.textContent = '🎰 GIRAR'; }
        VIP.ui.showToast((res.d && res.d.error) || 'No se pudo girar. Probá de nuevo.', 'error');
        return;
      }
      const n = Math.max(1, (VIP.ui._drSegments || []).length);
      const idx = Math.max(0, Math.min(n - 1, res.d.prizeIndex || 0));
      const wheel = document.getElementById('wrWheel');
      const segMid = (360 / n) * idx + (360 / n) / 2;
      const target = 360 * 5 + (360 - segMid);
      if (wheel) wheel.style.transform = 'rotate(' + target + 'deg)';
      try {
        document.querySelectorAll('#wrWheel .wrLbl').forEach(function(el) {
          el.style.transform = 'translate(-50%,-50%) rotate(' + (-target) + 'deg)';
        });
      } catch (e) {}
      setTimeout(function() {
        const p = res.d.prize || {};
        VIP.ui._playChime();
        let titulo, detalle;
        if (p.type === 'cash' && p.prizeARS > 0) {
          titulo = '🎉 ¡Ganaste ' + _wrEsc(p.prizeLabel) + '!';
          detalle = '💰 Ya está <b>ACREDITADO</b> en tu saldo.' + (p.rolloverX > 0 ? '<br><span style="font-size:12px;opacity:.8;">Para retirarlo, apostá ' + p.rolloverX + ' veces el premio.</span>' : '');
        } else if (p.type === 'percent') {
          titulo = '🎉 ¡Ganaste ' + _wrEsc(p.prizeLabel) + '!';
          detalle = 'Se suma automático en tu <b>PRÓXIMA CARGA</b>. 💪';
        } else {
          titulo = '😅 Hoy no hubo suerte';
          detalle = 'Mañana tenés <b>otro giro gratis</b>. ¡Volvé a intentar!';
        }
        const rEl = document.getElementById('wrResult');
        if (rEl) {
          rEl.innerHTML = '<div style="font-size:26px;font-weight:900;color:#26e07f;margin:4px 0 8px;text-shadow:0 2px 6px rgba(0,0,0,.6);">' + titulo + '</div><div>' + detalle + '</div>';
        }
        const aEl = document.getElementById('wrActions');
        if (aEl) {
          aEl.innerHTML =
            (p.type === 'percent'
              ? '<button type="button" onclick="VIP.ui.casinoRouletteClose(true);VIP.ui._rwReturn=false;VIP.ui.casinoBotGo(\'deposit\')" style="width:100%;background:#26e07f;color:#00301a;border:none;border-radius:16px;padding:15px;font-size:17px;font-weight:900;cursor:pointer;">💳 Cargar ahora y usarlo</button>'
              : '') +
            '<button type="button" onclick="VIP.ui.casinoRouletteClose()" style="width:100%;background:rgba(255,255,255,.14);color:#fff;border:none;border-radius:16px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;">Cerrar</button>';
        }
        try { VIP.ui._refreshRewards(); } catch (e) {}
        if (p.type === 'cash' && p.prizeARS > 0 && VIP.ui.syncBalance) { try { VIP.ui.syncBalance(); } catch (e) {} }
      }, 4400);
    })
    .catch(function() {
      if (btn) { btn.disabled = false; btn.textContent = '🎰 GIRAR'; }
      VIP.ui.showToast('Error de conexión. Probá de nuevo.', 'error');
    });
};

// ---- CASHBACK: reclamo desde el hub ----
VIP.ui.casinoCashbackClaim = function() {
  const d = (VIP.ui._rwSummary && VIP.ui._rwSummary.cashback) || {};
  if (!confirm('¿Reclamar ' + _rwFmt(d.reclamable) + ' de cashback ahora?' + (d.rolloverX > 0 ? '\n(Se acredita como bonus: para retirarlo apostalo x' + d.rolloverX + ')' : ''))) return;
  fetch(`${VIP.config.API_URL}/api/cashback/claim`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
    .then(function(res) {
      if (!res.ok || !res.j || !res.j.success) {
        VIP.ui.showToast((res.j && res.j.error) || 'No se pudo reclamar. Probá de nuevo.', 'error');
        VIP.ui._refreshRewards();
        return;
      }
      VIP.ui._playChime();
      VIP.ui.showToast('💸 ¡' + _rwFmt(res.j.amount) + ' acreditados en tu saldo!', 'success');
      if (VIP.ui.syncBalance) { try { VIP.ui.syncBalance(); } catch (e) {} }
      VIP.ui._refreshRewards();
    })
    .catch(function() { VIP.ui.showToast('Error de conexión. Probá de nuevo.', 'error'); });
};

function _wrEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

/** Pide el spin al server, anima la rueda hasta el segmento premiado y muestra
 *  el resultado. El premio SIEMPRE lo decide el server (prizeIndex). */
VIP.ui.casinoRouletteSpin = function() {
  const btn = document.getElementById('wrSpinBtn');
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Girando…'; }
  fetch(`${VIP.config.API_URL}/api/welcome-roulette/spin`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
    .then(function(res) {
      if (!res.ok || !res.d || !res.d.success) {
        if (btn) { btn.disabled = false; btn.textContent = '🎡 GIRAR'; }
        VIP.ui.showToast((res.d && res.d.error) || 'No se pudo girar. Probá de nuevo.', 'error');
        return;
      }
      const n = Math.max(1, (VIP.ui._wrSegments || []).length);
      const idx = Math.max(0, Math.min(n - 1, res.d.prizeIndex || 0));
      const wheel = document.getElementById('wrWheel');
      // Rotar para que el CENTRO del segmento premiado quede bajo el puntero
      // (arriba). +5 vueltas para el efecto. El puntero está arriba (0deg).
      const segMid = (360 / n) * idx + (360 / n) / 2;
      const target = 360 * 5 + (360 - segMid);
      if (wheel) wheel.style.transform = 'rotate(' + target + 'deg)';
      // Las etiquetas contra-rotan lo mismo → quedan derechas al parar.
      try {
        document.querySelectorAll('#wrWheel .wrLbl').forEach(function(el) {
          el.style.transform = 'translate(-50%,-50%) rotate(' + (-target) + 'deg)';
        });
      } catch (e) {}
      setTimeout(function() {
        const p = res.d.prize || {};
        VIP.ui._playChime();
        // Guardar el resultado para "Mi premio" (se puede volver a ver siempre).
        VIP.ui._wrStatus = { enabled: true, canSpin: false, alreadySpun: true, prize: {
          label: p.label, type: p.type, value: p.value, rolloverX: p.rolloverX || 0,
          status: p.type === 'cash' ? 'credited' : 'pending', spunAt: new Date().toISOString(), usedAt: null
        } };
        const isCash = p.type === 'cash' && p.credited;
        const detalle = isCash
          ? '💰 Ya está <b>ACREDITADO</b> en tu saldo. ¡A jugar! 🎰' +
            (p.rolloverX > 0 ? '<br><span style="font-size:12px;opacity:.8;">Para retirarlo, apostá ' + p.rolloverX + ' veces el premio.</span>' : '')
          : 'Se te aplica en tu <b>PRÓXIMA CARGA</b> — cargá y lo sumamos automáticamente. 💪';
        // Resultado en el overlay (pantalla completa).
        const rEl = document.getElementById('wrResult');
        if (rEl) {
          rEl.innerHTML = '<div style="font-size:14px;opacity:.85;">🎉 ¡Ganaste!</div>' +
            '<div style="font-size:30px;font-weight:900;color:#ffd700;margin:4px 0 8px;text-shadow:0 2px 6px rgba(0,0,0,.6);">' + _wrEsc(p.label) + '</div>' +
            '<div>' + detalle + '</div>' +
            '<div style="font-size:12px;opacity:.75;margin-top:10px;">📸 Sacá captura si querés. Lo podés volver a ver desde <b>🎡 Mi premio</b> en el asistente.</div>';
        }
        const aEl = document.getElementById('wrActions');
        if (aEl) {
          aEl.innerHTML =
            '<button type="button" onclick="VIP.ui.casinoRouletteClose(true);VIP.ui.casinoBotGo(\'deposit\')" ' +
              'style="width:100%;background:#ffd700;color:#3a2c00;border:none;border-radius:16px;padding:15px;font-size:18px;font-weight:900;cursor:pointer;">💳 Cargar ahora</button>' +
            '<button type="button" onclick="VIP.ui.casinoRouletteClose()" ' +
              'style="width:100%;background:rgba(255,255,255,.14);color:#fff;border:none;border-radius:16px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;">Cerrar</button>';
        }
        // Copia en el hilo del asistente (queda en el historial del widget).
        VIP.ui._botMsg('🎉 <b>¡Ganaste ' + _wrEsc(p.label) + '!</b><br>' + detalle);
        try { VIP.ui._refreshRewards(); } catch (e) {}
      }, 4400);
    })
    .catch(function() {
      if (btn) { btn.disabled = false; btn.textContent = '🎡 GIRAR'; }
      VIP.ui.showToast('Error de conexión. Probá de nuevo.', 'error');
    });
};

/** Toggle claro/oscuro del widget = el MISMO modo del chat de soporte
 *  (body.wa-dark, persistido en localStorage 'waDark' como el switch de
 *  Configuración) — así asistente y soporte siempre coinciden. */
VIP.ui.casinoToggleTheme = function() {
  const dark = !document.body.classList.contains('wa-dark');
  document.body.classList.toggle('wa-dark', dark);
  try { localStorage.setItem('waDark', dark ? '1' : '0'); } catch (e) {}
  // Sincronizar el switch del modal de Configuración (si está en el DOM).
  const chk = document.getElementById('waDarkToggle');
  if (chk) chk.checked = dark;
  VIP.ui._syncCasinoThemeBtn();
};

/** El ícono del header muestra a qué modo se CAMBIA (como el 🌙/☀️ del chat). */
VIP.ui._syncCasinoThemeBtn = function() {
  const b = document.getElementById('casinoThemeBtn');
  if (b) b.textContent = document.body.classList.contains('wa-dark') ? '☀️' : '🌙';
};

/** Sonido de notificación (WebAudio, sin archivo — dos tonos ascendentes). */
VIP.ui._playChime = function() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!VIP.ui._audioCtx) VIP.ui._audioCtx = new AC();
    const ctx = VIP.ui._audioCtx;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    [ [880, 0], [1320, 0.14] ].forEach(function(p) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = p[0];
      const t = ctx.currentTime + p[1];
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.36);
    });
  } catch (e) {}
};

/** La carga ACREDITÓ (balance_updated con saldo en alza): CARTEL GRANDE
 *  centrado + sonido para que el cliente se dé cuenta (owner 2026-08-21),
 *  y confirmación en el asistente. Sirve para carga automática Y manual del
 *  admin (ambas emiten balance_updated). */
VIP.ui.casinoBotDepositConfirmed = function(newBalance) {
  // Cortar la cuenta regresiva del comprobante: la carga LLEGÓ.
  clearInterval(VIP.ui._botCdTimer);
  VIP.ui._botCdTimer = null;
  if (VIP.ui._botCdNode) { VIP.ui._botCdNode.style.display = 'none'; VIP.ui._botCdNode = null; }

  // CARTEL GRANDE sobre el casino + sonido.
  VIP.ui._playChime();
  let ov = document.getElementById('casinoDepositToast');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'casinoDepositToast';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100002;display:none;align-items:center;' +
      'justify-content:center;background:rgba(0,0,0,0.6);';
    document.body.appendChild(ov);
  }
  const amt = (Number(newBalance) || 0).toLocaleString('es-AR');
  ov.innerHTML =
    '<div style="width:min(90vw,360px);background:linear-gradient(155deg,#0d3b23,#0a2e1b);' +
    'border:2px solid #25d366;border-radius:22px;padding:26px 22px;text-align:center;' +
    'box-shadow:0 18px 60px rgba(37,211,102,0.45);">' +
      '<div style="font-size:52px;line-height:1;">✅</div>' +
      '<div style="color:#25d366;font-weight:900;font-size:24px;margin:8px 0 2px;">¡Carga acreditada!</div>' +
      '<div style="color:#cfe9d8;font-size:14px;">Tu saldo ahora es</div>' +
      '<div style="color:#fff;font-weight:900;font-size:34px;margin:4px 0 16px;">$' + amt + '</div>' +
      '<button type="button" onclick="VIP.ui._hideCasinoDepositToast()" ' +
        'style="width:100%;background:#25d366;color:#04310f;border:none;border-radius:14px;padding:14px;' +
        'font-size:16px;font-weight:900;cursor:pointer;">🎰 ¡A JUGAR!</button>' +
    '</div>';
  ov.style.display = 'flex';
  clearTimeout(VIP.ui._depositToastTimer);
  VIP.ui._depositToastTimer = setTimeout(VIP.ui._hideCasinoDepositToast, 8000);

  // Confirmación también en el hilo del asistente (si no está en soporte).
  const drawer = document.getElementById('casinoChatDrawer');
  if (drawer && (drawer.style.display === 'none' || !drawer.style.display)) VIP.ui.openCasinoChat();
  if (VIP.ui._casinoChatPh) return; // en modo soporte no se pisa el chat real
  VIP.ui._botStarted = true;
  VIP.ui._botMsg('💰 <b>¡Carga acreditada!</b> Tu saldo ahora es <b>$' + amt + '</b> 🎰');
};

VIP.ui._hideCasinoDepositToast = function() {
  clearTimeout(VIP.ui._depositToastTimer);
  const ov = document.getElementById('casinoDepositToast');
  if (ov) ov.style.display = 'none';
};

/** Cierra el recuadro y vuelve a VIPCARGAS. */
VIP.ui.closeCasinoFrame = function() {
  clearTimeout(VIP.ui._casinoWatchdog);
  clearTimeout(VIP.ui._casinoEscapeTimer);
  VIP.ui._hideCasinoEscapeBar();
  // Si el chat estaba mudado al panel del casino, SIEMPRE devolverlo a la
  // página antes de cerrar (si no, la pantalla principal queda sin chat).
  VIP.ui._casinoChatUnmount();
  const overlay = document.getElementById('casinoOverlay');
  if (!overlay) return;
  // Se vacía el src para que el casino deje de correr en segundo plano (si no, sigue
  // sonando y consumiendo datos aunque el recuadro esté oculto).
  const frame = overlay.querySelector('#casinoFrame');
  if (frame) frame.src = '';
  overlay.style.display = 'none';
  document.body.style.overflow = '';
  VIP.ui._casinoOpen = false;

  // Al volver, refrescar el saldo: es muy probable que haya cambiado jugando.
  if (VIP.ui.syncBalance) { try { VIP.ui.syncBalance(); } catch (e) {} }
};

/** Muestra un error dentro del recuadro, con la opción de reintentar o salir. */
VIP.ui._casinoFrameError = function(msg) {
  const status = document.getElementById('casinoFrameStatus');
  if (!status) {
    VIP.ui.showToast(msg, 'error');
    return;
  }
  status.style.display = 'flex';
  status.style.flexDirection = 'column';
  status.style.gap = '14px';
  status.innerHTML =
    '<div style="color:#ff8080;font-weight:700;max-width:420px;line-height:1.45;">' + msg + '</div>' +
    '<button type="button" onclick="VIP.ui.enterCasino()" ' +
      'style="background:linear-gradient(135deg,#6a0dad,#9b30ff);color:#fff;border:none;' +
      'padding:12px 26px;border-radius:24px;font-weight:800;font-size:15px;cursor:pointer;">' +
      '🔄 Reintentar</button>' +
    '<button type="button" onclick="VIP.ui.closeCasinoFrame()" ' +
      'style="background:none;color:#aaa;border:none;font-size:14px;cursor:pointer;">' +
      'Volver a 1GIROX</button>';
};

// El botón "atrás" del celular cierra el recuadro en vez de salir de la app.
window.addEventListener('popstate', function() {
  if (VIP.ui._casinoOpen) VIP.ui.closeCasinoFrame();
});

// Botón "Abrir Casino" DENTRO del modal (que ahora es el camino de respaldo, cuando
// el SSO falló). Abre el casino a secas para que el usuario entre a mano con los
// datos que el modal le muestra.
VIP.ui.goToPlatform = function() {
  window.open(VIP.config.PLATFORM_URL, '_blank');
  VIP.ui.closePlatformModal();
};


VIP.ui.togglePlatformPasswordVisibility = function() {
  const pwdEl = document.getElementById('platformModalPassword');
  const toggle = document.getElementById('platformPasswordToggle');
  if (!pwdEl) return;
  const plain = VIP.state.sessionPassword || '';
  if (!plain) return;
  VIP.ui._platformPasswordVisible = !VIP.ui._platformPasswordVisible;
  if (VIP.ui._platformPasswordVisible) {
    pwdEl.textContent = plain;
    if (toggle) toggle.textContent = '🙈';
  } else {
    pwdEl.textContent = '••••••••';
    if (toggle) toggle.textContent = '👁';
  }
};

VIP.ui.savePlatformPassword = function() {
  const input = document.getElementById('platformPasswordManualInput');
  if (!input || !input.value.trim()) return;
  const pwd = input.value.trim();
  VIP.state.sessionPassword = pwd;
  VIP.ui._platformPasswordVisible = false;
  const pwdEl = document.getElementById('platformModalPassword');
  const pwdInputSection = document.getElementById('platformPasswordInputSection');
  const pwdToggle = document.getElementById('platformPasswordToggle');
  if (pwdEl) {
    pwdEl.textContent = '••••••••';
    if (pwdToggle) pwdToggle.textContent = '👁';
  }
  if (pwdInputSection) pwdInputSection.style.display = 'none';
  input.value = '';
  VIP.ui.showToast('✅ Contraseña guardada para esta sesión', 'success');
};

VIP.ui.showPlatformPasswordChange = function() {
  // Cerrar el modal de plataforma
  VIP.ui.closePlatformModal();
  // Asegurarse de que el cambio sea voluntario (no obligatorio)
  VIP.state.passwordChangePending = false;
  // Preparar y abrir el modal de cambio de contraseña
  if (typeof VIP.auth.prepareChangePasswordModal === 'function') {
    VIP.auth.prepareChangePasswordModal();
  } else if (typeof window.prepareChangePasswordModal === 'function') {
    window.prepareChangePasswordModal();
  }
  const modal = document.getElementById('changePasswordModal');
  if (modal) modal.classList.remove('hidden');
};
