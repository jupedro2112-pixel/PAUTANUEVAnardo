// ========================================
// INSTALL BONUS - Bono one-time por instalar la app
// ========================================
// Muestra un cartel en el chat con un botón para reclamar el 100% en la próxima
// carga. NO acredita plata: deja el bono pendiente para que el agente lo aplique. Solo
// se acredita estando dentro de la app instalada (display-mode: standalone).
// Si el usuario no está en la app instalada, se le explica cómo instalarla;
// si insiste y sigue fallando, se le explica borrar caché y reinstalar.

window.VIP = window.VIP || {};

VIP.installBonus = (function () {

    let _claimed = true; // por defecto no mostramos el cartel hasta confirmar con el server

    function _el(id) { return document.getElementById(id); }

    // NEUTRALIZADO (owner 2026-08-25). El bono "por instalar la app" quedó como
    // código heredado del repo viejo: en el formato nuevo (entrada ÚNICA al
    // casino, overlay a pantalla completa z-index 99999) el banner queda tapado
    // y es INALCANZABLE. Además pisaba al 100% AUTOMÁTICO de primera carga
    // (riesgo de doble 100%). init() ahora SIEMPRE oculta el cartel y no consulta
    // nada; claim() es un no-op. El único bono de bienvenida es el 100% de
    // primera carga (automático). No borramos el archivo para no tocar los
    // listeners de app.js; sólo lo dejamos inerte.
    async function init() {
        const banner = _el('installBonusBanner');
        if (banner) banner.style.display = 'none';
        const notice = _el('installBonusDirectNotice');
        if (notice) notice.style.display = 'none';
    }

    // NEUTRALIZADO (owner 2026-08-25): no-op. Ver nota en init(). Se conserva la
    // firma porque app.js le engancha un listener al botón (que ya no se ve).
    async function claim() {
        const banner = _el('installBonusBanner');
        if (banner) banner.style.display = 'none';
    }

    // Cuenta los intentos fallidos: el 1ro explica cómo instalar bien;
    // del 2do en adelante, además explica borrar caché y reinstalar.
    function _showHelp() {
        let fails = parseInt(localStorage.getItem('installBonusFailedAttempts') || '0', 10);
        fails += 1;
        localStorage.setItem('installBonusFailedAttempts', String(fails));
        _renderHelpModal(fails >= 2);
    }

    function _renderHelpModal(showReinstall) {
        const ua = navigator.userAgent;
        const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;

        const installSteps = isIOS
            ? [
                'Abrí esta página en <strong>Safari</strong> (no en otro navegador).',
                'Tocá el botón <strong>Compartir</strong> ⬆️ en la barra de abajo.',
                'Deslizá y elegí <strong>"Agregar a pantalla de inicio"</strong>, después <strong>"Agregar"</strong>.',
                'Abrí la app desde el ícono nuevo en tu pantalla de inicio.'
              ]
            : [
                'Abrí esta página en <strong>Google Chrome</strong>.',
                'Tocá el menú <strong>⋮</strong> (arriba a la derecha).',
                'Elegí <strong>"Instalar app"</strong> o <strong>"Agregar a pantalla de inicio"</strong>.',
                'Abrí la app desde el ícono nuevo en tu pantalla de inicio.'
              ];

        const reinstallHtml = showReinstall ? `
            <div style="background: rgba(255,68,68,0.12); border: 1px solid rgba(255,68,68,0.5); border-radius: 10px; padding: 12px 14px; margin-top: 14px; text-align: left;">
                <p style="margin: 0 0 6px; color: #ff6b6b; font-weight: 700; font-size: 13px;">¿Seguís sin poder reclamarlo? Reinstalá la app:</p>
                <ol style="margin: 0; padding-left: 18px; color: #ddd; font-size: 12px; line-height: 1.65;">
                    <li>Borrá / desinstalá la app de tu pantalla de inicio.</li>
                    <li>En el navegador, borrá el <strong>caché</strong> y los datos del sitio.</li>
                    <li>Volvé a abrir la página y reinstalá la app con los pasos de arriba.</li>
                    <li>Abrí la app instalada y tocá de nuevo <strong>"🎁 Reclamar mi 100%"</strong>.</li>
                </ol>
            </div>` : '';

        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';
        modal.innerHTML = `
            <div class="ios-install-content">
                <h3>🎁 Reclamá tu 100% de bono</h3>
                <p style="color:#f7931e;margin-bottom:10px;">El bono se reclama <strong>desde la app instalada</strong>. Parece que todavía no la estás usando instalada.</p>
                <p style="color:#fff;font-size:13px;margin-bottom:8px;text-align:left;">Hacé estos pasos:</p>
                <ol style="text-align:left;">${installSteps.map(s => `<li>${s}</li>`).join('')}</ol>
                <p style="color:#00ff88;font-size:13px;margin-top:10px;">Ya dentro de la app instalada, tocá <strong>"🎁 Reclamar mi 100%"</strong> y el bono se acredita al instante.</p>
                ${reinstallHtml}
                <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
            </div>
        `;
        document.body.appendChild(modal);
    }

    return { init, claim };

})();
