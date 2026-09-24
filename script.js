/**
 * ================================================================
 * VcM Gestionale Web - Google Sheets Edition
 * ================================================================
 */

// ================================================================
// CONFIGURAZIONE
// ================================================================
const CONFIG = {
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwpFR9DhRKKrDSt8TKoRq4jdLKbeJ-hV28f8oSGcFbLTnGbf4oEosRoy9aN8wkuzN2WKw/exec',
    LABEL_CLIENTI: 'Clienti',
    LABEL_FORNITORI: 'Fornitori e servizi',
    CACHE_EXPIRATION_HOURS: 0.0125,  // 45 secondi
    CACHE_VERSION: '3.1.0',
    STATI_RICERCA: [
        'Tutti', 'Contattato', 'Venduto', 'In trattativa',
        'Nessuna risposta', 'occupato', 'Da contattare',
        'Follow up', 'Terminata', 'Stand-by'
    ],
    APPALTO_OPZIONI: ['', 'Si', 'No', 'FORSE'],
    DAELIMINARE_OPZIONI: ['No', 'Si']
};

// ================================================================
// CACHE MANAGER
// ================================================================
class CacheManager {
    constructor() {
        this.prefix = 'vcm_';
        this.version = CONFIG.CACHE_VERSION;
    }

    getKey(type) { return `${this.prefix}${type}`; }

    save(type, data) {
        try {
            const entry = {
                timestamp: Date.now(),
                version: this.version,
                count: data.length,
                records: data
            };
            localStorage.setItem(this.getKey(type), JSON.stringify(entry));
            this.updateStats(type);
        } catch (e) {
            console.warn('⚠️ Errore salvataggio cache:', e);
        }
    }

    load(type) {
        try {
            const raw = localStorage.getItem(this.getKey(type));
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (entry.version !== this.version) {
                console.log(`🔄 Cache ${type} obsoleta`);
                return null;
            }
            const age = (Date.now() - entry.timestamp) / 3600000;
            if (age >= CONFIG.CACHE_EXPIRATION_HOURS) {
                console.log(`⏰ Cache ${type} scaduta`);
                return null;
            }
            console.log(`✅ Cache ${type} valida (${entry.count} record)`);
            return entry.records;
        } catch (e) {
            console.warn('⚠️ Errore caricamento cache:', e);
            return null;
        }
    }

    getAge(type) {
        try {
            const raw = localStorage.getItem(this.getKey(type));
            if (!raw) return null;
            const entry = JSON.parse(raw);
            return (Date.now() - entry.timestamp) / 3600000;
        } catch { return null; }
    }

    clear(type) {
        localStorage.removeItem(this.getKey(type));
        if (type) this.updateStats(type);
    }

    clearAll() {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(this.prefix));
        keys.forEach(k => localStorage.removeItem(k));
        this.updateStats('clienti');
        this.updateStats('fornitori');
        this.updateStats('cestino');
    }

    updateStats(type) {
        if (type === 'cestino') {
            const data = window.tuttiClienti || [];
            const count = data.filter(r => r.DaEliminare === 'Si').length;
            const badge = document.getElementById('badgeCestino');
            if (badge) {
                badge.textContent = count;
                badge.className = count === 0
                    ? 'ml-auto text-[10px] px-2 py-0.5 rounded-full badge-cestino-vuoto'
                    : 'ml-auto text-[10px] px-2 py-0.5 rounded-full badge-cestino-pieno';
            }
            return;
        }

        const data = this.load(type);
        const badgeMap = { 'clienti': 'badgeClienti', 'fornitori': 'badgeFornitori' };
        const badgeId = badgeMap[type];
        if (badgeId) {
            const badge = document.getElementById(badgeId);
            if (badge) {
                badge.textContent = data ? data.length : 0;
                badge.classList.remove('hidden');
            }
        }
        this.updateStatusDisplay();
    }

    updateStatusDisplay() {
        const clientiAge = this.getAge('clienti');
        const fornitoriAge = this.getAge('fornitori');
        const statusEl = document.getElementById('cacheStatus');
        const ageEl = document.getElementById('cacheAge');
        if (!statusEl || !ageEl) return;

        if (clientiAge !== null || fornitoriAge !== null) {
            const ages = [clientiAge, fornitoriAge].filter(a => a !== null);
            const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
            let status = '';
            if (avgAge < 1) {
                status = 'Aggiornata';
                statusEl.className = 'cache-badge fresh';
            } else if (avgAge < CONFIG.CACHE_EXPIRATION_HOURS * 0.7) {
                status = 'Valida';
                statusEl.className = 'cache-badge fresh';
            } else {
                status = 'Vecchia';
                statusEl.className = 'cache-badge stale';
            }
            statusEl.textContent = status;
            const maxAge = Math.max(...ages);
            ageEl.textContent = `Ultimo aggiornamento: ${Math.round(maxAge)} ore fa`;
        } else {
            statusEl.className = 'cache-badge missing';
            statusEl.textContent = 'Nessuna';
            ageEl.textContent = '';
        }
    }
}

// ================================================================
// STATO APPLICAZIONE
// ================================================================
const cache = new CacheManager();
let sezioneAttuale = 'clienti';
let tuttiClienti = [];
let tuttiFornitori = [];
let isDataLoading = false;
window.tuttiClienti = tuttiClienti;

// ================================================================
// STATO STATISTICHE E FILTRI
// ================================================================
let statsOpen = false;
let statsData = null;
let chartInstance = null;
let currentPopupType = '';

const statoFiltri = {
    ricerca: { attivo: false, valore: '' },
    stato: { attivo: false, valore: 'Tutti' },
    appuntamento: { attivo: false, valore: false, tipo: null },
    meta: { attivo: false, valore: '' }
};

let filtroDaStatistica = null;
let meteUniche = [];

// Traccia modifiche nel modale cliente
let modaleClienteAperto = null;
let valoriOriginaliModale = null;
// ================================================================
// TOAST NOTIFICATIONS
// ================================================================
function showToast(type, title, message, duration = 4000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-triangle-exclamation',
        info: 'fa-info-circle'
    };

    toast.innerHTML = `
        <div class="toast-icon"><i class="fas ${icons[type] || icons.info}"></i></div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.closest('.toast').remove()">
            <i class="fas fa-times"></i>
        </button>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.add('removing');
            setTimeout(() => {
                if (toast.parentNode) toast.remove();
            }, 300);
        }
    }, duration);
}

// ================================================================
// UTILITY
// ================================================================
function formataDataIT(dataISO) {
    if (!dataISO || dataISO === "null" || dataISO === "") return "---";
    const d = new Date(dataISO);
    if (isNaN(d.getTime())) return dataISO;
    return d.toLocaleDateString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

function showLoading(show) {
    const loadingEl = document.getElementById('loadingState');
    if (!loadingEl) return;
    loadingEl.style.display = show ? 'flex' : 'none';
}

function handleApiError(error, context) {
    console.error(`❌ Errore ${context}:`, error);
    const infoEl = document.getElementById('info-cache');
    if (infoEl) {
        infoEl.textContent = `❌ Errore: ${error.message || context}`;
    }
    showLoading(false);
    showToast('error', 'Errore', error.message || context);
}

// ================================================================
// Pulisce il numero di telefono
// ================================================================
function pulisciTelefono(tel) {
    if (!tel) return '';
    let pulito = String(tel).trim();
    // Rimuovi prefissi tipici di Meta
    pulito = pulito.replace(/^p:/i, '').replace(/^tel:/i, '');
    // Rimuovi spazi, trattini, parentesi
    pulito = pulito.replace(/[\s\-\(\)\.]/g, '');
    // Mantieni solo cifre e un eventuale + all'inizio
    pulito = pulito.replace(/[^\d+]/g, '');
    return pulito;
}

// ================================================================
// NORMALIZZAZIONE STATO
// ================================================================
function normalizzaStato(stato) {
    if (!stato || String(stato).trim() === '') return 'da contattare';
    const normalized = String(stato).trim().toLowerCase();
    if (normalized === 'occupato') return 'occupato';
    return normalized;
}

function capitalizzaStato(stato) {
    if (!stato || String(stato).trim() === '') return 'Da contattare';
    if (String(stato).toLowerCase() === 'occupato') return 'Occupato';
    const s = String(stato);
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ================================================================
// FUNZIONI PER CLIENTI
// ================================================================
function getClientiAttivi() {
    return tuttiClienti.filter(c => c.DaEliminare !== 'Si');
}

function getClientiCestino() {
    return tuttiClienti.filter(c => c.DaEliminare === 'Si');
}

function contaStati(attivi) {
    const statiMap = {};
    attivi.forEach(c => {
        const rawStatus = c.Status && String(c.Status).trim() !== "" ? String(c.Status).trim() : '';
        const statusNormalizzato = normalizzaStato(rawStatus);
        if (!statiMap[statusNormalizzato]) {
            statiMap[statusNormalizzato] = { count: 0, label: capitalizzaStato(statusNormalizzato) };
        }
        statiMap[statusNormalizzato].count++;
    });
    return statiMap;
}

// ================================================================
// FUNZIONI PER LE METE
// ================================================================
function estraiMeteUniche() {
    const meteSet = new Set();
    getClientiAttivi().forEach(c => {
        const meta = c['Dove vuoi andare?'];
        if (meta && String(meta).trim()) {
            const parti = String(meta).split(',').map(p => p.trim().toLowerCase());
            parti.forEach(p => {
                if (p && p.length > 0) meteSet.add(p);
            });
        }
    });
    return Array.from(meteSet).sort();
}

function popolaDropdownMete() {
    const select = document.getElementById('filtroMetaSelect');
    if (!select) return;
    select.innerHTML = '<option value="">Tutte le mete</option>';
    meteUniche.forEach(meta => {
        const option = document.createElement('option');
        option.value = meta;
        option.textContent = meta.charAt(0).toUpperCase() + meta.slice(1);
        select.appendChild(option);
    });
}

// ================================================================
// STATISTICHE
// ================================================================
function calcolaStatisticheTotali() {
    // ★ Performance e Stati: solo clienti in lavorazione ★
    const clientiInLavorazione = tuttiClienti.filter(c => c._inLavorazione && c.DaEliminare !== 'Si');
    const totaleInLavorazione = clientiInLavorazione.length;

    // ★ Mete: tutti i clienti attivi (come prima) ★
    const attivi = getClientiAttivi();

    // ---- 1. PERFORMANCE sui clienti IN LAVORAZIONE ----
    const conAppuntamento = clientiInLavorazione.filter(c =>
        c.DataAppuntamento &&
        c.DataAppuntamento !== "" &&
        c.DataAppuntamento !== "null"
    );
    const appuntamenti = conAppuntamento.length;
    const richieste = totaleInLavorazione - appuntamenti;

    // ---- 2. STATI sui clienti IN LAVORAZIONE ----
    const statiMap = contaStati(clientiInLavorazione);
    const stati = Object.entries(statiMap)
        .map(([key, data]) => ({ nome: data.label, conteggio: data.count }))
        .sort((a, b) => b.conteggio - a.conteggio);

    // ---- 3. METE su TUTTI i clienti attivi ----
    const meteMap = {};
    attivi.forEach(c => {
        const meta = c['Dove vuoi andare?'];
        if (meta && String(meta).trim()) {
            const parti = String(meta).split(',').map(p => p.trim().toLowerCase());
            parti.forEach(p => {
                if (p && p.length > 0) {
                    const nomeDisplay = p.charAt(0).toUpperCase() + p.slice(1);
                    meteMap[nomeDisplay] = (meteMap[nomeDisplay] || 0) + 1;
                }
            });
        }
    });
    const mete = Object.entries(meteMap)
        .map(([nome, conteggio]) => ({ nome, conteggio }))
        .sort((a, b) => b.conteggio - a.conteggio);

    let clientiConMeta = 0;
    attivi.forEach(c => {
        const meta = c['Dove vuoi andare?'];
        if (meta && String(meta).trim()) clientiConMeta++;
    });

    return {
        totaleAttivi: attivi.length,               // totale per la card "Clienti"
        totaleInLavorazione: totaleInLavorazione,  // totale per Performance/Stati
        performance: { appuntamenti, richieste, clientiConMeta, clientiSenzaMeta: attivi.length - clientiConMeta },
        stati,
        mete,
        totaleMete: mete.length,
        clientiCestino: getClientiCestino().length
    };
}

function aggiornaStatisticheUI() {
    const data = calcolaStatisticheTotali();
    statsData = data;

    const badgePerf = document.getElementById('statBadgePerformance');
    if (badgePerf) badgePerf.textContent = data.totaleAttivi;
    const badgeStati = document.getElementById('statBadgeStati');
    if (badgeStati) badgeStati.textContent = data.stati.length;
    const badgeMete = document.getElementById('statBadgeMete');
    if (badgeMete) badgeMete.textContent = data.totaleMete;

    aggiornaKPI(data);
}

/**
 * Aggiorna i badge della sidebar (Clienti, Fornitori, Cestino).
 * Va chiamata ogni volta che i dati cambiano.
 */
function aggiornaBadgeSidebar() {
    const badgeClienti = document.getElementById('badgeClienti');
    if (badgeClienti) badgeClienti.textContent = tuttiClienti.length;

    const badgeFornitori = document.getElementById('badgeFornitori');
    if (badgeFornitori) badgeFornitori.textContent = tuttiFornitori.length;

    const badgeCestino = document.getElementById('badgeCestino');
    if (badgeCestino) {
        const countCestino = tuttiClienti.filter(c => c.DaEliminare === 'Si').length;
        badgeCestino.textContent = countCestino;
        badgeCestino.className = countCestino === 0
            ? 'ml-auto text-[10px] px-2 py-0.5 rounded-full badge-cestino-vuoto'
            : 'ml-auto text-[10px] px-2 py-0.5 rounded-full badge-cestino-pieno';
    }
}

// ================================================================
// KPI CARDS
// ================================================================
function aggiornaKPI(data) {
    const container = document.getElementById('kpiContainer');
    if (!container) return;

    const daContattare = data.stati.find(s => s.nome === 'Da contattare');
    const daContattareCount = daContattare ? daContattare.conteggio : 0;

    const kpis = [
        { icon: 'fa-users', iconClass: 'blue', value: data.totaleAttivi, label: 'Clienti', onClick: 'filtraTuttiClienti()' },
        { icon: 'fa-calendar-check', iconClass: 'green', value: data.performance.appuntamenti, label: 'Appuntamenti', onClick: "filtraPerAppuntamento(true)" },
        { icon: 'fa-clock', iconClass: 'amber', value: daContattareCount, label: 'Da contattare', onClick: 'filtraPerDaContattare()' },
        { icon: 'fa-rotate-right', iconClass: 'purple', value: data.stati.find(s => s.nome === 'Follow up')?.conteggio || 0, label: 'Follow-up', onClick: 'filtraPerFollowUp()' },
        { icon: 'fa-handshake', iconClass: 'cyan', value: data.stati.find(s => s.nome === 'In trattativa')?.conteggio || 0, label: 'In trattativa', onClick: 'filtraPerTrattativa()' },
        { icon: 'fa-pause-circle', iconClass: 'gray', value: data.stati.find(s => s.nome === 'Stand-by')?.conteggio || 0, label: 'Stand-by', onClick: 'filtraPerStandBy()' },
        { icon: 'fa-trash-can', iconClass: 'red', value: data.clientiCestino || 0, label: 'Cestino', onClick: 'filtraPerCestino()' }
    ];

    container.innerHTML = kpis.map(kpi => `
        <div class="kpi-card fade-in border-${kpi.iconClass}" onclick="${kpi.onClick}" style="cursor:pointer;">
            <div class="kpi-icon-label">
                <i class="fas ${kpi.icon} ${kpi.iconClass}"></i>
                <span class="kpi-value ${kpi.iconClass}">${kpi.value}</span>
            </div>
            <div class="kpi-label">${kpi.label}</div>
        </div>
    `).join('');
}
// ================================================================
// LOGICA FILTRI
// ================================================================
function azzeraTuttiIFiltri() {
    document.getElementById('inputRicerca').value = '';
    document.getElementById('filtroStato').value = 'Tutti';
    document.getElementById('checkAppuntamenti').checked = false;
    document.getElementById('filtroMetaSelect').value = '';

    statoFiltri.ricerca.attivo = false;
    statoFiltri.ricerca.valore = '';
    statoFiltri.stato.attivo = false;
    statoFiltri.stato.valore = 'Tutti';
    statoFiltri.appuntamento.attivo = false;
    statoFiltri.appuntamento.valore = false;
    statoFiltri.appuntamento.tipo = null;
    statoFiltri.meta.attivo = false;
    statoFiltri.meta.valore = '';

    filtroDaStatistica = null;
    document.getElementById('statoFiltri').classList.add('hidden');
}

function azzeraFiltri() {
    azzeraTuttiIFiltri();
    eseguiFiltro();
}

function applicaFiltroSingolo(tipo, valore) {
    azzeraTuttiIFiltri();

    if (tipo === 'stato') {
        document.getElementById('filtroStato').value = valore;
        statoFiltri.stato.attivo = true;
        statoFiltri.stato.valore = normalizzaStato(valore);
    } else if (tipo === 'meta') {
        document.getElementById('filtroMetaSelect').value = valore;
        statoFiltri.meta.attivo = true;
        statoFiltri.meta.valore = valore;
    } else if (tipo === 'appuntamento') {
        const isCon = (valore === 'con');
        document.getElementById('checkAppuntamenti').checked = isCon;
        statoFiltri.appuntamento.attivo = true;
        statoFiltri.appuntamento.tipo = valore;
        statoFiltri.appuntamento.valore = isCon;
    } else if (tipo === 'ricerca') {
        document.getElementById('inputRicerca').value = valore;
        statoFiltri.ricerca.attivo = true;
        statoFiltri.ricerca.valore = valore;
    }

    filtroDaStatistica = { tipo, valore };
    eseguiFiltro();
}

function pulisciRicerca() {
    if (statoFiltri.ricerca.attivo) {
        document.getElementById('inputRicerca').value = '';
        statoFiltri.ricerca.attivo = false;
        statoFiltri.ricerca.valore = '';
        filtroDaStatistica = null;
        eseguiFiltro();
    }
}

function pulisciMeta() {
    if (statoFiltri.meta.attivo) {
        document.getElementById('filtroMetaSelect').value = '';
        statoFiltri.meta.attivo = false;
        statoFiltri.meta.valore = '';
        filtroDaStatistica = null;
        eseguiFiltro();
    }
}

function getFiltroAttivo() {
    if (filtroDaStatistica) {
        let valore = filtroDaStatistica.valore;
        if (filtroDaStatistica.tipo === 'appuntamento') {
            valore = filtroDaStatistica.valore === 'con' ? 'Con appuntamento' : 'Senza appuntamento';
        }
        return { tipo: filtroDaStatistica.tipo, valore };
    }
    if (statoFiltri.stato.attivo && statoFiltri.stato.valore !== 'Tutti') {
        return { tipo: 'stato', valore: capitalizzaStato(statoFiltri.stato.valore) };
    }
    if (statoFiltri.meta.attivo && statoFiltri.meta.valore) {
        return { tipo: 'meta', valore: statoFiltri.meta.valore };
    }
    if (statoFiltri.appuntamento.attivo) {
        const label = statoFiltri.appuntamento.tipo === 'con' ? 'Con appuntamento' : 'Senza appuntamento';
        return { tipo: 'appuntamento', valore: label };
    }
    if (statoFiltri.ricerca.attivo && statoFiltri.ricerca.valore) {
        return { tipo: 'ricerca', valore: statoFiltri.ricerca.valore };
    }
    return null;
}

function aggiornaBarraStatoFiltri(recordsFiltrati, totali, filtroAttivo) {
    const container = document.getElementById('statoFiltri');
    const filtriContainer = document.getElementById('filtriAttiviContainer');
    const contatore = document.getElementById('contatoreFiltrati');

    if (!filtroAttivo) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    filtriContainer.innerHTML = `
        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mr-1">
            <i class="fas fa-filter mr-1"></i> Filtro attivo:
        </span>
    `;

    const badge = document.createElement('span');
    let classeTipo = 'filtro-badge';
    let icona = '';
    let label = '';

    switch (filtroAttivo.tipo) {
        case 'stato':
            classeTipo += ' stato-badge';
            icona = '<i class="fas fa-tag mr-1"></i>';
            label = `Stato: ${filtroAttivo.valore}`;
            break;
        case 'meta':
            classeTipo += ' meta-badge';
            icona = '<i class="fas fa-globe-europe mr-1"></i>';
            label = `Meta: ${filtroAttivo.valore}`;
            break;
        case 'appuntamento':
            classeTipo += ' app-badge';
            icona = '<i class="fas fa-calendar-check mr-1"></i>';
            label = filtroAttivo.valore;
            break;
        case 'ricerca':
            classeTipo += ' ricerca-badge';
            icona = '<i class="fas fa-search mr-1"></i>';
            label = `Ricerca: "${filtroAttivo.valore}"`;
            break;
    }

    badge.className = classeTipo;
    badge.innerHTML = `${icona}${label}
        <span class="remove-btn" onclick="azzeraFiltri()"><i class="fas fa-times-circle"></i></span>`;
    filtriContainer.appendChild(badge);

    const totaliLabel = totali !== undefined ? ` su ${totali}` : '';
    contatore.textContent = `📊 ${recordsFiltrati} record trovati${totaliLabel}`;
    contatore.className = recordsFiltrati === 0 ? 'contatore-filtrati zero' : 'contatore-filtrati ok';
}

// ================================================================
// CARICAMENTO DATI DA GOOGLE SHEETS
// ================================================================
async function caricaTuttiIDati(forza = false) {
    if (isDataLoading) return;
    isDataLoading = true;
    showLoading(true);

    try {
        let clientiData = forza ? null : cache.load('clienti');
        let fornitoriData = forza ? null : cache.load('fornitori');

        if (!clientiData || !fornitoriData) {
            console.log('🔄 Lettura da Google Sheets...');
            const risposta = await leggiDaSheets('leggiTutto');
            clientiData = risposta.clienti || [];
            fornitoriData = risposta.fornitori || [];
            cache.save('clienti', clientiData);
            cache.save('fornitori', fornitoriData);
        }

        tuttiClienti = clientiData;
        window.tuttiClienti = tuttiClienti;
        tuttiFornitori = fornitoriData;

        meteUniche = estraiMeteUniche();
        popolaDropdownMete();

        cache.updateStats('clienti');
        cache.updateStats('fornitori');
        cache.updateStats('cestino');
        cache.updateStatusDisplay();
        aggiornaStatisticheUI();
        aggiornaBadgeSidebar();  // ★ NUOVA RIGA ★

        const infoEl = document.getElementById('info-cache');
        if (infoEl) {
            infoEl.innerHTML = `✅ ${tuttiClienti.length} clienti, ${tuttiFornitori.length} fornitori ` +
                `- In lavorazione: ${tuttiClienti.filter(c => c._inLavorazione).length} ` +
                `- Mete uniche: ${meteUniche.length}`;
        }

        aggiornaVistaCorrente();

    } catch (error) {
        handleApiError(error, 'caricamento dati');
        const fallbackData = cache.load('clienti');
        if (fallbackData) {
            tuttiClienti = fallbackData;
            window.tuttiClienti = tuttiClienti;
            meteUniche = estraiMeteUniche();
            popolaDropdownMete();
            const fallbackFornitori = cache.load('fornitori');
            if (fallbackFornitori) tuttiFornitori = fallbackFornitori;
            cache.updateStats('cestino');
            aggiornaStatisticheUI();
            aggiornaVistaCorrente();
        }
    } finally {
        isDataLoading = false;
        showLoading(false);
    }
}
// ================================================================
// Ricarica i dati in background senza mostrare lo spinner.  Usata per il refresh automatico (focus, periodico, apertura).
// =========handleApiError=======================================================

async function ricaricaInBackground() {
    if (isDataLoading) {
        console.log('⏳ Ricarica già in corso, salto');
        return;
    }

    // Mostra l'indicatore di ricarica
    mostraIndicatoreRic();

    try {
        console.log('🔄 Ricarica in background...');
        const risposta = await leggiDaSheets('leggiTutto');
        const clientiData = risposta.clienti || [];
        const fornitoriData = risposta.fornitori || [];

        // Aggiorna la cache e lo stato
        cache.save('clienti', clientiData);
        cache.save('fornitori', fornitoriData);
        tuttiClienti = clientiData;
        window.tuttiClienti = tuttiClienti;
        tuttiFornitori = fornitoriData;

        meteUniche = estraiMeteUniche();
        popolaDropdownMete();

cache.updateStats('clienti');
cache.updateStats('fornitori');
cache.updateStats('cestino');
cache.updateStatusDisplay();
aggiornaStatisticheUI();
aggiornaBadgeSidebar();  // ★ NUOVA RIGA ★

        const infoEl = document.getElementById('info-cache');
        if (infoEl) {
            infoEl.innerHTML = `✅ ${tuttiClienti.length} clienti, ${tuttiFornitori.length} fornitori ` +
                `- In lavorazione: ${tuttiClienti.filter(c => c._inLavorazione).length} ` +
                `- Ultimo refresh: ${new Date().toLocaleTimeString('it-IT')}`;
        }

        // Aggiorna la vista solo se non c'è un modale aperto
        if (!modaleClienteAperto) {
            aggiornaVistaCorrente();
        }

        console.log('✅ Ricarica completata');
    } catch (error) {
        console.warn('⚠️ Ricarica in background fallita:', error.message);
        // Silenzioso: non mostra toast all'utente
    } finally {
        nascondiIndicatoreRic();
    }
}




// ================================================================
// CHIAMATE A APPS SCRIPT
// ================================================================
async function leggiDaSheets(azione) {
    const url = `${CONFIG.APPS_SCRIPT_URL}?azione=${azione}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.errore || 'Errore sconosciuto');
    return json.dati;
}

async function scriviSuSheets(azione, dati) {
    const resp = await fetch(CONFIG.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ azione, dati })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.errore || 'Errore sconosciuto');
    return json.dati;
}

// ================================================================
// POPOLAMENTO FILTRI
// ================================================================
function popolaFiltri() {
    const statoSelect = document.getElementById('filtroStato');
    if (statoSelect) {
        statoSelect.innerHTML = '';
        CONFIG.STATI_RICERCA.forEach(stato => {
            const option = document.createElement('option');
            option.value = stato;
            option.textContent = stato === 'occupato' ? 'Occupato' : stato;
            statoSelect.appendChild(option);
        });
    }
}

// ================================================================
// NAVIGAZIONE
// ================================================================
function cambiaSezione(nome) {
    sezioneAttuale = nome;

    const titoli = {
        'clienti': CONFIG.LABEL_CLIENTI,
        'fornitori': CONFIG.LABEL_FORNITORI,
        'cestino': '🗑️ Cestino'
    };
    document.getElementById('titolo-sezione').innerText = titoli[nome] || nome;
    document.getElementById('barFiltri').style.display = 'flex';

    const isClienti = (nome === 'clienti');
    const isCestino = (nome === 'cestino');

    const containerStato = document.getElementById('containerFiltroStato');
    if (containerStato) {
        containerStato.style.display = isClienti ? 'flex' : 'none';
        if (!isClienti) document.getElementById('filtroStato').value = 'Tutti';
    }

    const containerMeta = document.getElementById('containerFiltroMeta');
    if (containerMeta) {
        containerMeta.style.display = isClienti ? 'flex' : 'none';
        if (!isClienti) document.getElementById('filtroMetaSelect').value = '';
    }

    const containerApp = document.getElementById('containerFiltroApp');
    if (containerApp) {
        containerApp.style.display = isClienti ? 'flex' : 'none';
        if (!isClienti) document.getElementById('checkAppuntamenti').checked = false;
    }

    document.getElementById('btnNuovo').style.display = (nome === 'fornitori') ? 'block' : 'none';

    const btnSvuota = document.getElementById('btnSvuotaCestino');
    if (btnSvuota) {
        btnSvuota.style.display = isCestino ? 'inline-flex' : 'none';
        if (isCestino) aggiornaPulsanteSvuotaCestino();
    }

    if (!isClienti) azzeraTuttiIFiltri();
    aggiornaVistaCorrente();
    cache.updateStats('cestino');
}

function aggiornaPulsanteSvuotaCestino() {
    const btnSvuota = document.getElementById('btnSvuotaCestino');
    if (!btnSvuota) return;
    const count = getClientiCestino().length;
    if (count === 0) {
        btnSvuota.disabled = true;
        btnSvuota.innerHTML = '<i class="fas fa-trash-alt"></i> Svuota cestino (vuoto)';
    } else {
        btnSvuota.disabled = false;
        btnSvuota.innerHTML = `<i class="fas fa-trash-alt"></i> Svuota cestino (${count})`;
    }
}

function aggiornaVistaCorrente() {
    if (sezioneAttuale === 'clienti') eseguiFiltroClienti();
    else if (sezioneAttuale === 'cestino') { eseguiFiltroCestino(); aggiornaPulsanteSvuotaCestino(); }
    else if (sezioneAttuale === 'fornitori') eseguiFiltroFornitori();
}

function eseguiFiltro() {
    if (sezioneAttuale === 'clienti') eseguiFiltroClienti();
    else if (sezioneAttuale === 'cestino') { eseguiFiltroCestino(); aggiornaPulsanteSvuotaCestino(); }
    else if (sezioneAttuale === 'fornitori') eseguiFiltroFornitori();
}
// ================================================================
// ESEGUI FILTRI
// ================================================================
function eseguiFiltroClienti() {
    const query = document.getElementById('inputRicerca')?.value.toLowerCase().trim() || '';
    const statoUI = document.getElementById('filtroStato')?.value || 'Tutti';
    const soloApp = document.getElementById('checkAppuntamenti')?.checked || false;
    const metaUI = document.getElementById('filtroMetaSelect')?.value || '';
    const stato = statoUI === 'Tutti' ? 'Tutti' : normalizzaStato(statoUI);

    if (!filtroDaStatistica) {
        statoFiltri.ricerca.attivo = query.length > 0;
        statoFiltri.ricerca.valore = query;
        statoFiltri.stato.attivo = stato !== 'Tutti';
        statoFiltri.stato.valore = stato;
        statoFiltri.appuntamento.attivo = soloApp;
        statoFiltri.appuntamento.valore = soloApp;
        statoFiltri.appuntamento.tipo = soloApp ? 'con' : null;
        statoFiltri.meta.attivo = metaUI.length > 0;
        statoFiltri.meta.valore = metaUI;
    }

    const totali = getClientiAttivi();
    const filtroAttivo = getFiltroAttivo();
    let filtrati = totali;

    if (filtroAttivo) {
        switch (filtroAttivo.tipo) {
            case 'ricerca': {
                const q = statoFiltri.ricerca.valore.toLowerCase().trim();
                filtrati = totali.filter(r => {
                    const nome = `${r.Nome || ''} ${r.Cognome || ''}`.toLowerCase();
                    return nome.includes(q);
                });
                break;
            }
            case 'stato': {
                const target = normalizzaStato(statoFiltri.stato.valore);
                filtrati = totali.filter(r => normalizzaStato(r.Status) === target);
                break;
            }
            case 'appuntamento': {
                const tipoApp = statoFiltri.appuntamento.tipo;
                filtrati = totali.filter(r => {
                    const haApp = r.DataAppuntamento && r.DataAppuntamento !== "" && r.DataAppuntamento !== "null";
                    if (tipoApp === 'con') return haApp;
                    if (tipoApp === 'senza') return !haApp;
                    return true;
                });
                break;
            }
            case 'meta': {
                const mv = statoFiltri.meta.valore.toLowerCase().trim();
                filtrati = totali.filter(r => (r['Dove vuoi andare?'] || "").toLowerCase().trim().includes(mv));
                break;
            }
        }
    }

    aggiornaBarraStatoFiltri(filtrati.length, totali.length, filtroAttivo);
    const mostraApp = statoFiltri.appuntamento.attivo && statoFiltri.appuntamento.tipo === 'con';
    mostraTabellaClienti(filtrati, mostraApp);
}

function eseguiFiltroCestino() {
    const query = document.getElementById('inputRicerca')?.value.toLowerCase().trim() || '';
    const filtrati = getClientiCestino().filter(r => {
        const nome = `${r.Nome || ''} ${r.Cognome || ''}`.toLowerCase();
        return !query || nome.includes(query);
    });
    mostraTabellaCestino(filtrati);
}

function eseguiFiltroFornitori() {
    const query = document.getElementById('inputRicerca')?.value.toLowerCase().trim() || '';
    const filtrati = tuttiFornitori.filter(r => {
        return !query || (r.Fornitore || "").toLowerCase().includes(query);
    });
    mostraTabellaFornitori(filtrati);
}

// ================================================================
// FUNZIONI DI FILTRO PER STATISTICHE
// ================================================================
function filtraPerStato(stato) {
    chiudiPopupStatistiche();
    cambiaSezione('clienti');
    applicaFiltroSingolo('stato', normalizzaStato(stato));
}

function filtraPerMeta(meta) {
    chiudiPopupStatistiche();
    cambiaSezione('clienti');
    applicaFiltroSingolo('meta', meta);
}

function filtraPerAppuntamento(conAppuntamento) {
    chiudiPopupStatistiche();
    cambiaSezione('clienti');
    applicaFiltroSingolo('appuntamento', conAppuntamento ? 'con' : 'senza');
}

function filtraTuttiClienti() {
    chiudiPopupStatistiche();
    azzeraFiltri();
}

function filtraPerFollowUp() {
    chiudiPopupStatistiche();
    cambiaSezione('clienti');
    applicaFiltroSingolo('stato', 'follow up');
}

function filtraPerTrattativa() {
    chiudiPopupStatistiche();
    cambiaSezione('clienti');
    applicaFiltroSingolo('stato', 'in trattativa');
}

function filtraPerDaContattare() {
    chiudiPopupStatistiche();
    cambiaSezione('clienti');
    applicaFiltroSingolo('stato', 'da contattare');
}

function filtraPerStandBy() {
    chiudiPopupStatistiche();
    cambiaSezione('clienti');
    applicaFiltroSingolo('stato', 'stand-by');
}

function filtraPerCestino() {
    chiudiPopupStatistiche();
    cambiaSezione('cestino');
}

// ================================================================
// INIZIA A LAVORARE (nuovo)
// ================================================================
async function iniziaALavorare(idCliente) {
    const cliente = tuttiClienti.find(c => c.id === idCliente);
    if (!cliente) {
        showToast('error', 'Errore', 'Cliente non trovato');
        return;
    }
    if (cliente._inLavorazione) {
        showToast('info', 'Già in lavorazione', 'Questo cliente è già nel foglio privato');
        return;
    }

    // ★ Toast rassicurante che resta visibile fino alla fine ★
    showToast('info', 'Preparazione scheda', 'Sto preparando la scheda, attendi qualche istante...', 10000);

    // ★ Blocca eventuali click multipli ★
    const bottoneCliccato = event?.target?.closest('button');
    if (bottoneCliccato) {
        bottoneCliccato.disabled = true;
        bottoneCliccato.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Preparazione...';
    }

    try {
        await scriviSuSheets('salvaCliente', {
            id: cliente.id,
            Status: 'Da contattare',
            Aeroporto: '',
            DataAppuntamento: '',
            NoteAppuntamento: '',
            'Note 1 Chiamata': '',
            Appalto: '',
            DaEliminare: 'No'
        });
        cache.clear('clienti');
        cache.clear('fornitori');
        await caricaTuttiIDati(true);
        showToast('success', 'Scheda pronta', `${cliente.Nome || ''} ${cliente.Cognome || ''} è ora in lavorazione`);
        // ★ Apri il modale dopo un breve delay per far sparire il toast di preparazione ★
        setTimeout(() => apriDettaglioCliente(idCliente), 300);
    } catch (error) {
        console.error('Errore iniziaALavorare:', error);
        showToast('error', 'Errore', error.message);
        // ★ Riabilita il bottone in caso di errore ★
        if (bottoneCliccato) {
            bottoneCliccato.disabled = false;
            bottoneCliccato.innerHTML = '<i class="fas fa-play mr-1"></i> Inizia a lavorare';
        }
    }
}

// ================================================================
// RENDER TABELLA CLIENTI
// ================================================================
function mostraTabellaClienti(records, mostraAppuntamento) {
    records.sort((a, b) => {
        const dateA = new Date(a['Data contatto'] || 0);
        const dateB = new Date(b['Data contatto'] || 0);
        return dateB - dateA;
    });

    let html = `
        <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
            <thead>
                <tr class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b">
                    <th class="p-4">Anagrafica</th>
                    <th class="p-4">Meta</th>
                    <th class="p-4">Data Inserimento</th>`;

    if (mostraAppuntamento) html += `<th class="p-4">Appuntamento</th>`;

    html += `<th class="p-4">Stato</th>
                    <th class="p-4 text-center">Azioni</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">`;

    if (records.length === 0) {
        const colspan = mostraAppuntamento ? 6 : 5;
        html += `
            <tr><td colspan="${colspan}" class="p-8 text-center text-slate-400 text-sm">
                <i class="fas fa-inbox text-2xl block mb-2 text-slate-300"></i>
                Nessun cliente trovato con il filtro selezionato
                <div class="text-xs mt-2 text-slate-300">
                    <button onclick="azzeraFiltri()" class="text-vcm hover:underline">
                        <i class="fas fa-undo-alt mr-1"></i> Rimuovi filtro
                    </button>
                </div>
            </td></tr>`;
    } else {
        records.forEach((r, index) => {
            const statusVisuale = r.Status ? capitalizzaStato(r.Status) : 'Non definito';
            const badgeClass = getStatusBadgeClass(statusVisuale);
            const delay = Math.min(index * 20, 300);
            const metaValue = r['Dove vuoi andare?'] || "---";

            // Azioni: pulsante "Inizia a lavorare" se non in lavorazione, etichetta altrimenti
            let azioniHtml = '';
            if (!r._inLavorazione) {
                azioniHtml = `<button onclick="event.stopPropagation();iniziaALavorare('${r.id}')"
                    class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-all">
                    <i class="fas fa-play mr-1"></i> Inizia a lavorare
                </button>`;
            } else if (r.DaEliminare === 'Si') {
                azioniHtml = `<span class="bg-red-100 text-red-700 px-2.5 py-1 rounded text-[10px] font-bold uppercase">
                    <i class="fas fa-trash-alt mr-1"></i> Nel cestino
                </span>`;
            } else {
                azioniHtml = `<span class="bg-amber-100 text-amber-700 px-2.5 py-1 rounded text-[10px] font-bold uppercase">
                    <i class="fas fa-spinner mr-1"></i> In lavorazione
                </span>`;
            }

            html += `
                <tr class="table-row fade-in" style="animation-delay: ${delay}ms" onclick="apriDettaglioCliente('${r.id}')">
                    <td class="p-4 font-bold text-vcm">${r.Nome || ''} ${r.Cognome || ''}</td>
                    <td class="p-4 text-sm text-slate-600 meta-cell" title="${metaValue}">
                        ${metaValue !== "---"
                            ? `<span class="bg-blue-50 text-blue-700 px-2 py-1 rounded text-xs font-medium">${metaValue}</span>`
                            : `<span class="text-slate-400 text-xs">---</span>`}
                    </td>
                    <td class="p-4 text-[11px] text-slate-500">${formataDataIT(r['Data contatto'])}</td>`;

            if (mostraAppuntamento) {
                html += `<td class="p-4 text-[11px] text-slate-500">
                    ${r.DataAppuntamento ? `<span class="text-xs text-amber-600"><i class="fas fa-calendar-check"></i> ${formataDataIT(r.DataAppuntamento)}</span>` : ''}
                </td>`;
            }

            html += `
                    <td class="p-4">
                        <span class="status-badge ${badgeClass}">
                            <span class="dot"></span>${statusVisuale}
                        </span>
                        ${r.Appalto === 'Si' ? `<span class="ml-1 text-[8px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">APPALTO</span>` : ''}
                        ${r.Appalto === 'FORSE' ? `<span class="ml-1 text-[8px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-bold">FORSE</span>` : ''}
                    </td>
                    <td class="p-4 text-center">${azioniHtml}</td>
                </tr>`;
        });
    }

    html += `</tbody></table></div>`;
    const contentEl = document.getElementById('content');
    if (contentEl) contentEl.innerHTML = html;
    showLoading(false);
}

function getStatusBadgeClass(status) {
    const map = {
        'Contattato': 'contattato', 'Venduto': 'venduto', 'In trattativa': 'trattativa',
        'Occupato': 'occupato', 'Da contattare': 'da-contattare', 'Follow up': 'followup',
        'Nessuna risposta': 'nessuna-risposta', 'Terminata': 'terminata',
        'Stand-by': 'standby', 'Non definito': 'non-definito'
    };
    return map[status] || 'non-definito';
}

function mostraTabellaCestino(records) {
    records.sort((a, b) => new Date(b['Data contatto'] || 0) - new Date(a['Data contatto'] || 0));

    let html = `
        <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
            <thead><tr class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b">
                <th class="p-4">Anagrafica</th>
                <th class="p-4">Meta</th>
                <th class="p-4">Data Inserimento</th>
                <th class="p-4">Stato</th>
                <th class="p-4 text-center">Azioni</th>
            </tr></thead>
            <tbody class="divide-y divide-slate-100">`;

    if (records.length === 0) {
        html += `<tr><td colspan="5" class="p-8 text-center text-slate-400 text-sm">
            <i class="fas fa-inbox text-2xl block mb-2 text-slate-300"></i>
            Nessun record nel cestino
        </td></tr>`;
    } else {
        records.forEach((r, index) => {
            const statusVisuale = r.Status ? capitalizzaStato(r.Status) : 'Non definito';
            const badgeClass = getStatusBadgeClass(statusVisuale);
            const delay = Math.min(index * 20, 300);
            const metaValue = r['Dove vuoi andare?'] || "---";

            html += `
                <tr class="table-row fade-in" style="animation-delay: ${delay}ms" onclick="apriDettaglioCliente('${r.id}')">
                    <td class="p-4 font-bold text-vcm">${r.Nome || ''} ${r.Cognome || ''}</td>
                    <td class="p-4 text-sm text-slate-600 meta-cell" title="${metaValue}">
                        ${metaValue !== "---"
                            ? `<span class="bg-blue-50 text-blue-700 px-2 py-1 rounded text-xs font-medium">${metaValue}</span>`
                            : `<span class="text-slate-400 text-xs">---</span>`}
                    </td>
                    <td class="p-4 text-[11px] text-slate-500">${formataDataIT(r['Data contatto'])}</td>
                    <td class="p-4">
                        <span class="status-badge ${badgeClass}">
                            <span class="dot"></span>${statusVisuale}
                        </span>
                    </td>
                    <td class="p-4 text-center">
                        <button onclick="event.stopPropagation();apriDettaglioCliente('${r.id}')"
                            class="text-slate-300 hover:text-vcm transition-colors">
                            <i class="fas fa-external-link-alt"></i>
                        </button>
                    </td>
                </tr>`;
        });
    }

    html += `</tbody></table></div>`;
    const contentEl = document.getElementById('content');
    if (contentEl) contentEl.innerHTML = html;
    showLoading(false);
}

function mostraTabellaFornitori(records) {
    records.sort((a, b) => (a.Prog || 999) - (b.Prog || 999));

    let html = `
        <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
            <thead><tr class="bg-slate-50 text-[10px] uppercase font-bold text-slate-400 border-b">
                <th class="p-4">Prog</th>
                <th class="p-4">Fornitore</th>
                <th class="p-4">Destinazioni</th>
                <th class="p-4">Tipo</th>
                <th class="p-4 text-center">Azioni</th>
            </tr></thead>
            <tbody class="divide-y divide-slate-100">`;

    if (records.length === 0) {
        html += `<tr><td colspan="5" class="p-8 text-center text-slate-400 text-sm">
            <i class="fas fa-truck text-2xl block mb-2 text-slate-300"></i>
            Nessun fornitore trovato
        </td></tr>`;
    } else {
        records.forEach((r, index) => {
            const delay = Math.min(index * 15, 200);
            html += `
                <tr class="table-row fade-in" style="animation-delay: ${delay}ms">
                    <td class="p-4 text-xs text-slate-500">${r.Prog || ''}</td>
                    <td class="p-4 font-bold text-vcm cursor-pointer" onclick="apriModalFornitore('${r.Prog}')">${r.Fornitore || '---'}</td>
                    <td class="p-4 text-xs text-slate-500">${r.Destinazioni || ''}</td>
                    <td class="p-4 text-xs text-slate-500">${r.TipoTDG || ''}</td>
                    <td class="p-4 text-center">
                        <a href="${r.LinkFornitore || '#'}" target="_blank"
                           class="text-emerald-500 hover:text-emerald-700 transition-colors">
                            <i class="fas fa-external-link-alt text-base"></i>
                        </a>
                    </td>
                </tr>`;
        });
    }

    html += `</tbody></table></div>`;
    const contentEl = document.getElementById('content');
    if (contentEl) contentEl.innerHTML = html;
    showLoading(false);
}

// ================================================================
// STATISTICHE SIDEBAR - TOGGLE
// ================================================================
function toggleStats() {
    statsOpen = !statsOpen;
    const body = document.getElementById('statsBody');
    const icon = document.getElementById('statsToggleIcon');
    if (body) body.classList.toggle('open', statsOpen);
    if (icon) icon.classList.toggle('fa-rotate-180', statsOpen);
    if (statsOpen) aggiornaStatisticheUI();
}
// ================================================================
// POPUP STATISTICHE
// ================================================================
function apriPopupStatistiche(tipo) {
    chiudiPopupStatistiche();
    currentPopupType = tipo;
    azzeraTuttiIFiltri();

    const data = calcolaStatisticheTotali();
    if (data.totaleAttivi === 0) {
        document.getElementById('popupInner').innerHTML = `
            <div class="text-center text-slate-400 py-12">
                <i class="fas fa-users-slash text-4xl mb-4"></i>
                <p>Nessun cliente attivo</p>
            </div>`;
        document.getElementById('modalStatPopup').classList.remove('hidden');
        return;
    }

    let html = '', titolo = '', icona = '';
    switch (tipo) {
        case 'performance': titolo = 'Performance'; icona = 'fa-chart-line'; html = generaPopupPerformance(data); break;
        case 'stati': titolo = 'Stati Richiesta'; icona = 'fa-tag'; html = generaPopupStati(data); break;
        case 'mete': titolo = 'Mete Preferite'; icona = 'fa-globe-europe'; html = generaPopupMete(data); break;
    }

    document.getElementById('popupTitolo').textContent = titolo;
    document.getElementById('popupIcon').className = `fas ${icona} text-lg`;
    document.getElementById('popupInner').innerHTML = html;

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    document.getElementById('modalStatPopup').classList.remove('hidden');
    setTimeout(() => { if (document.getElementById('chartCanvas')) inizializzaGrafico(tipo); }, 100);
}

function generaPopupPerformance(data) {
    const { totaleInLavorazione, performance } = data;
    const pctApp = totaleInLavorazione > 0 ? (performance.appuntamenti / totaleInLavorazione * 100).toFixed(2) : 0;
    const pctRic = totaleInLavorazione > 0 ? (performance.richieste / totaleInLavorazione * 100).toFixed(2) : 0;

    return `
        <div class="colonna-statistiche">
            <div class="mb-4"><div class="text-sm text-slate-500">
                Clienti in lavorazione: <span class="font-bold text-slate-800">${totaleInLavorazione}</span>
            </div></div>
            <div class="space-y-3">
                <div class="stat-popup-row" onclick="filtraPerAppuntamento(true)">
                    <div class="flex justify-between items-center">
                        <span class="text-sm font-medium text-slate-700"><i class="fas fa-calendar-check text-blue-500 mr-2"></i>Appuntamenti fissati</span>
                        <span><span class="font-bold text-slate-800">${performance.appuntamenti}</span><span class="text-xs text-slate-400 ml-1">(${pctApp}%)</span></span>
                    </div>
                    <div class="stat-popup-bar-wrapper"><div class="stat-popup-bar" style="width:${Math.max(pctApp,0)}%"></div></div>
                </div>
                <div class="stat-popup-row" onclick="filtraPerAppuntamento(false)">
                    <div class="flex justify-between items-center">
                        <span class="text-sm font-medium text-slate-700"><i class="fas fa-inbox text-amber-500 mr-2"></i>Richieste ricevute</span>
                        <span><span class="font-bold text-slate-800">${performance.richieste}</span><span class="text-xs text-slate-400 ml-1">(${pctRic}%)</span></span>
                    </div>
                    <div class="stat-popup-bar-wrapper"><div class="stat-popup-bar" style="width:${Math.max(pctRic,0)}%"></div></div>
                </div>
                <div class="stat-popup-row" onclick="filtraTuttiClienti()" style="background:#f8fafc;border-radius:4px;">
                    <div class="flex justify-between items-center">
                        <span class="text-sm font-medium text-slate-700"><i class="fas fa-users text-vcm mr-2"></i>Totale clienti (tutti)</span>
                        <span class="font-bold text-slate-800">${data.totaleAttivi}</span>
                    </div>
                </div>
            </div>
        </div>
        <div class="colonna-grafico"><div class="chart-container"><canvas id="chartCanvas"></canvas></div></div>
        <div class="stat-popup-footer"><i class="fas fa-mouse-pointer mr-1"></i> Clicca su una riga per filtrare</div>`;
}

function generaPopupStati(data) {
    const { totaleInLavorazione, stati } = data;
    if (stati.length === 0) return `<div class="text-center text-slate-400 py-8">Nessuno stato registrato nei clienti in lavorazione</div>`;

    let html = `<div class="colonna-statistiche"><div class="mb-4"><div class="text-sm text-slate-500">
        Clienti in lavorazione: <span class="font-bold text-slate-800">${totaleInLavorazione}</span> | Stati: <span class="font-bold text-slate-800">${stati.length}</span>
    </div></div><div class="space-y-2">`;

    stati.forEach(s => {
        const pct = totaleInLavorazione > 0 ? (s.conteggio / totaleInLavorazione * 100).toFixed(2) : 0;
        let barClass = 'status-altri';
        if (s.nome === 'Contattato') barClass = 'status-contattato';
        else if (s.nome === 'Venduto') barClass = 'status-venduto';
        else if (s.nome === 'In trattativa') barClass = 'status-trattativa';
        else if (s.nome === 'Da contattare') barClass = 'status-da-contattare';
        else if (s.nome === 'Follow up') barClass = 'status-followup';
        else if (s.nome === 'Nessuna risposta') barClass = 'status-nessuna-risposta';

        html += `<div class="stat-popup-row" onclick="filtraPerStato('${s.nome}')">
            <div class="flex justify-between items-center">
                <span class="text-sm font-medium text-slate-700">${s.nome}</span>
                <span><span class="font-bold text-slate-800">${s.conteggio}</span><span class="text-xs text-slate-400 ml-1">(${pct}%)</span></span>
            </div>
            <div class="stat-popup-bar-wrapper"><div class="stat-popup-bar ${barClass}" style="width:${Math.max(pct,0)}%"></div></div>
        </div>`;
    });

    html += `</div></div>
        <div class="colonna-grafico"><div class="chart-container"><canvas id="chartCanvas"></canvas></div></div>
        <div class="stat-popup-footer"><i class="fas fa-mouse-pointer mr-1"></i> Clicca su una riga per filtrare</div>`;
    return html;
}

function generaPopupMete(data) {
    const { totaleAttivi, mete, performance } = data;
    if (mete.length === 0) return `<div class="text-center text-slate-400 py-8">Nessuna meta</div>`;

    let html = `<div class="colonna-statistiche"><div class="mb-4"><div class="text-sm text-slate-500">
        Totale: <span class="font-bold text-slate-800">${totaleAttivi}</span> | Mete: <span class="font-bold text-slate-800">${mete.length}</span> | Con meta: <span class="font-bold text-slate-800">${performance.clientiConMeta}</span>
    </div></div><div class="space-y-2 max-h-[300px] overflow-y-auto pr-2">`;

    mete.forEach((m, i) => {
        const pct = totaleAttivi > 0 ? (m.conteggio / totaleAttivi * 100).toFixed(2) : 0;
        const metaClass = `meta-${(i % 5) + 1}`;
        html += `<div class="stat-popup-row" onclick="filtraPerMeta('${m.nome.toLowerCase()}')">
            <div class="flex justify-between items-center">
                <span class="text-sm font-medium text-slate-700">${m.nome}</span>
                <span class="conteggio-allineato"><span class="font-bold">${m.conteggio}</span><span class="text-xs text-slate-400 ml-1">(${pct}%)</span></span>
            </div>
            <div class="stat-popup-bar-wrapper"><div class="stat-popup-bar ${metaClass}" style="width:${Math.max(pct,0)}%"></div></div>
        </div>`;
    });

    html += `</div></div>
        <div class="colonna-grafico"><div class="chart-container"><canvas id="chartCanvas"></canvas></div></div>
        <div class="stat-popup-footer"><i class="fas fa-mouse-pointer mr-1"></i> Clicca su una riga per filtrare</div>`;
    return html;
}

function inizializzaGrafico(tipo) {
    const canvas = document.getElementById('chartCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const data = calcolaStatisticheTotali();
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    let labels = [], values = [], colors = [];
    switch (tipo) {
        case 'performance':
            labels = ['Appuntamenti', 'Richieste'];
            values = [data.performance.appuntamenti, data.performance.richieste];
            colors = ['#4F46E5', '#F59E0B'];
            break;
        case 'stati':
            labels = data.stati.map(s => s.nome);
            values = data.stati.map(s => s.conteggio);
            colors = data.stati.map((s, i) => {
                const m = { 'Contattato':'#3B82F6','Venduto':'#10B981','In trattativa':'#F59E0B','Da contattare':'#7C3AED','Follow up':'#06B6D4','Nessuna risposta':'#EF4444' };
                return m[s.nome] || `hsl(${i*40},70%,50%)`;
            });
            break;
        case 'mete':
            const mm = data.mete.slice(0, 12);
            labels = mm.map(m => m.nome);
            values = mm.map(m => m.conteggio);
            colors = mm.map((_, i) => `hsl(${i*360/mm.length},70%,55%)`);
            break;
    }

    if (values.length === 0 || values.every(v => v === 0)) return;

    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 2, hoverOffset: 10 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12, boxWidth: 12, boxHeight: 12 } },
                tooltip: { callbacks: { label: c => {
                    const tot = c.dataset.data.reduce((a, b) => a + b, 0);
                    return `${c.label}: ${c.parsed} (${((c.parsed/tot)*100).toFixed(2)}%)`;
                }}}
            },
            onClick: (evt, els) => {
                if (els.length > 0) {
                    const lbl = chartInstance.data.labels[els[0].index];
                    if (tipo === 'performance') filtraPerAppuntamento(lbl === 'Appuntamenti');
                    else if (tipo === 'stati') filtraPerStato(lbl);
                    else if (tipo === 'mete') filtraPerMeta(lbl);
                    chiudiPopupStatistiche();
                }
            }
        }
    });
}

function chiudiPopupStatistiche() {
    document.getElementById('modalStatPopup').classList.add('hidden');
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    currentPopupType = '';
}

// ================================================================
// MODALE CLIENTE
// ================================================================
function apriDettaglioCliente(id) {
    const record = tuttiClienti.find(r => r.id === id);
    if (!record) { showToast('error', 'Errore', 'Record non trovato'); return; }

    modaleClienteAperto = record;
    valoriOriginaliModale = {
        Telefono: record.Telefono || '',
            Mail: record.Mail || '',
            Aeroporto: record.Aeroporto || '',
        DataAppuntamento: record.DataAppuntamento || '',
        NoteAppuntamento: record.NoteAppuntamento || '',
        Status: record.Status || '',
        Appalto: record.Appalto || '',
        DaEliminare: record.DaEliminare || 'No',
        'Note 1 Chiamata': record['Note 1 Chiamata'] || ''
    };

    const statoOptions = `<option value="">---</option>` +
        CONFIG.STATI_RICERCA.filter(s => s !== 'Tutti').map(s => {
            const label = s === 'occupato' ? 'Occupato' : s;
            return `<option value="${s}" ${record.Status === s ? 'selected' : ''}>${label}</option>`;
        }).join('');

    const appaltoOptions = CONFIG.APPALTO_OPZIONI.map(a =>
        `<option value="${a}" ${record.Appalto === a ? 'selected' : ''}>${a || '---'}</option>`
    ).join('');

    const daEliminareOptions = CONFIG.DAELIMINARE_OPZIONI.map(d =>
        `<option value="${d}" ${record.DaEliminare === d ? 'selected' : ''}>${d}</option>`
    ).join('');

    const modalContent = document.getElementById('modalContentFull');
    if (!modalContent) return;

    modalContent.innerHTML = `
        <div class="modal-header px-6 py-3 text-white flex items-center justify-between shadow-md sticky top-0 z-10">
            <button onclick="salvaCliente('${id}')"
                    class="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-1.5 rounded font-bold text-xs shadow-sm transition-all uppercase flex items-center gap-2">
                <i class="fas fa-save"></i> Salva
            </button>
            <h2 class="text-lg font-bold uppercase tracking-tight text-white/90 text-center flex-1 mx-4">
                ${record.Nome || ''} ${record.Cognome || ''}
            </h2>
            <button onclick="provaChiudiModale()"
                    class="text-white/60 hover:text-white text-xl transition-colors">
                <i class="fas fa-times"></i>
            </button>
        </div>

        <div class="bg-blue-600 px-6 py-2 text-white flex items-center justify-between border-t border-white/10 flex-wrap gap-2">
            <div class="flex items-center gap-2">
                <span class="vcm-label_a !bg-transparent !text-white/60 !mb-0 text-[10px]">📅 Inserito:</span>
                <span class="text-xs font-bold">${formataDataIT(record['Data contatto'])}</span>
            </div>
            <div class="flex items-center gap-2">
                <span class="vcm-label_a !bg-transparent !text-white/60 !mb-0 text-[10px]">📌 Stato:</span>
                <select id="det_status" class="modal-select">${statoOptions}</select>
            </div>
            <div class="flex items-center gap-2">
                <span class="vcm-label_a !bg-transparent !text-white/60 !mb-0 text-[10px]">🏷️ Appalto:</span>
                <select id="det_appalto" class="modal-select">${appaltoOptions}</select>
            </div>
            <div class="flex items-center gap-2">
                <span class="vcm-label_a !bg-transparent !text-red-300 !mb-0 text-[10px]">🗑️ Cestino:</span>
                <select id="det_daEliminare" class="modal-select">${daEliminareOptions}</select>
            </div>
        </div>

        <div class="bg-slate-50 px-6 py-2.5 border-b flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
                <span class="text-sm">📞</span>
                <input type="text" id="det_tel" value="${pulisciTelefono(record.Telefono)}"
                       class="bg-white border border-slate-200 px-3 py-1 rounded text-sm font-bold text-blue-600 w-36 outline-none focus:ring-2 focus:ring-blue-400"
                       placeholder="Telefono">
                <button onclick="window.open('tel:${pulisciTelefono(record.Telefono)}')"
                        class="bg-slate-200 hover:bg-slate-300 p-1.5 rounded text-slate-600">
                    <i class="fas fa-phone-alt"></i>
                </button>
            </div>
            <button onclick="apriWhatsApp('${pulisciTelefono(record.Telefono)}')" class="btn-whatsapp-web">
                <i class="fab fa-whatsapp text-lg"></i> WHATSAPP
            </button>
            <div class="flex items-center gap-2">
                <span class="text-sm">✉️</span>
                <input type="text" id="det_mail" value="${record.Mail || ''}"
                       class="bg-white border border-slate-200 px-3 py-1 rounded text-sm text-slate-700 w-56 outline-none focus:ring-2 focus:ring-blue-400"
                       placeholder="Email">
                <button onclick="window.open('mailto:${record.Mail || ''}')"
                        class="bg-slate-200 hover:bg-slate-300 p-1.5 rounded text-slate-600">
                    <i class="fas fa-at"></i>
                </button>
            </div>
        </div>

        <div class="px-6 py-2.5 border-b flex items-center gap-3 bg-slate-100/50 flex-wrap">
            <span class="vcm-label_a">📅 Appuntamento:</span>
            <input type="date" id="det_dataApp" value="${record.DataAppuntamento || ''}" class="vcm-input !w-40 !py-1 text-center">
            <span class="text-sm">📝</span>
            <input type="text" id="det_noteApp" value="${record.NoteAppuntamento || ''}"
                   class="vcm-input !py-1 flex-1 min-w-[200px]" placeholder="Nota appuntamento...">
        </div>

        <div class="px-6 py-3">
            <div class="section-title"><span>✈️</span> SCHEDA VIAGGIO</div>
            <div class="grid grid-cols-3 gap-3">
                <div class="viaggio-field"><span class="label">🌍 Meta</span><span class="value">${record['Dove vuoi andare?'] || "---"}</span></div>
                <div class="viaggio-field"><span class="label">📅 Periodo</span><span class="value">${record.Periodo || "---"}</span></div>
                <div class="viaggio-field"><span class="label">💰 Budget</span><span class="value">${record.Budget || "---"}</span></div>
                <div class="viaggio-field"><span class="label">👥 Con chi</span><span class="value">${record['Con chi parti?'] || "---"}</span></div>
                <div class="viaggio-field"><span class="label">📊 Stato Richiesta</span><span class="value" style="font-size:12px">${record['A che punto sei?'] || "---"}</span></div>
                <div class="viaggio-field"><span class="label">🛫 Aeroporto</span>
                    <input type="text" id="det_aeroporto" value="${record.Aeroporto || ''}"
                           class="vcm-input !py-1 !text-xs" placeholder="Aeroporto...">
                </div>
            </div>
        </div>

        <div class="px-6 pb-4">
            <div class="section-title"><span>📝</span> NOTE 1° CHIAMATA</div>
            <textarea id="det_note1" class="vcm-input !bg-slate-50 !font-medium !text-slate-800 !h-24 focus:!bg-white transition-colors"
                      placeholder="Inserisci qui le note della prima chiamata...">${record['Note 1 Chiamata'] || ""}</textarea>
        </div>
    `;

    document.getElementById('modalVcm').classList.remove('hidden');
}

function rilevaModificheModale() {
    if (!modaleClienteAperto || !valoriOriginaliModale) return false;
    const attuali = {
        Telefono: document.getElementById('det_tel')?.value || '',
            Aeroporto: document.getElementById('det_aeroporto')?.value || '',
        Mail: document.getElementById('det_mail')?.value || '',
        DataAppuntamento: document.getElementById('det_dataApp')?.value || '',
        NoteAppuntamento: document.getElementById('det_noteApp')?.value || '',
        Status: document.getElementById('det_status')?.value || '',
        Appalto: document.getElementById('det_appalto')?.value || '',
        DaEliminare: document.getElementById('det_daEliminare')?.value || 'No',
        'Note 1 Chiamata': document.getElementById('det_note1')?.value || ''
    };
    return Object.keys(attuali).some(k => String(attuali[k]) !== String(valoriOriginaliModale[k] || ''));
}

function provaChiudiModale() {
    if (rilevaModificheModale()) {
        if (confirm("Non hai salvato le modifiche. Uscire comunque?")) chiudiModale();
    } else {
        chiudiModale();
    }
}

function chiudiModale() {
    document.getElementById('modalVcm').classList.add('hidden');
    modaleClienteAperto = null;
    valoriOriginaliModale = null;
    modalFornitoreStato = 'lettura';
    fornitoreOriginale = null;
    isNuovoFornitore = false;
}

// ================================================================
// SALVATAGGIO CLIENTE
// ================================================================
async function salvaCliente(id) {
    const record = tuttiClienti.find(r => r.id === id);
    if (!record) { showToast('error', 'Errore', 'Cliente non trovato'); return; }

    const fields = {
        id: id,
        Status: document.getElementById('det_status')?.value || '',
        Aeroporto: document.getElementById('det_aeroporto')?.value || '',
        DataAppuntamento: document.getElementById('det_dataApp')?.value || '',
        NoteAppuntamento: document.getElementById('det_noteApp')?.value || '',
        'Note 1 Chiamata': document.getElementById('det_note1')?.value || '',
        Appalto: document.getElementById('det_appalto')?.value || '',
        DaEliminare: document.getElementById('det_daEliminare')?.value || 'No'
    };

    // Aggiungi anche telefono e mail se modificati
    const tel = document.getElementById('det_tel')?.value || '';
    const mail = document.getElementById('det_mail')?.value || '';
    // Nota: telefono e mail sono nel foglio condiviso, non nel privato.
    // VcM li aggiorna solo se in futuro vorremo scrivere anche sul condiviso.
    // Per ora li mostriamo ma non li salviamo nel privato.

    const btnSalva = document.querySelector('[onclick*="salvaCliente"]');
    const testoOrig = btnSalva?.innerHTML || 'Salva';
    if (btnSalva) {
        btnSalva.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Salvataggio...';
        btnSalva.disabled = true;
    }

    try {
        await scriviSuSheets('salvaCliente', fields);
        cache.clear('clienti');
        cache.clear('fornitori');
        chiudiModale();
        await caricaTuttiIDati(true);
        showToast('success', 'Salvato', 'Cliente aggiornato con successo');
    } catch (error) {
        console.error('Errore salvataggio:', error);
        showToast('error', 'Errore', error.message);
    } finally {
        if (btnSalva) { btnSalva.innerHTML = testoOrig; btnSalva.disabled = false; }
    }
}

// ================================================================
// SVUOTA CESTINO
// ================================================================
async function svuotaCestino() {
    const recordsDaEliminare = getClientiCestino();
    const count = recordsDaEliminare.length;
    if (count === 0) { showToast('info', 'Cestino vuoto', 'Non ci sono record da eliminare.'); return; }
    if (!confirm(`⚠️ ATTENZIONE!\n\nVerranno eliminati definitivamente ${count} record dal cestino.\n\nProcedere?`)) return;

    const btnSvuota = document.getElementById('btnSvuotaCestino');
    if (btnSvuota) { btnSvuota.disabled = true; btnSvuota.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Eliminazione...'; }

    try {
        const risultato = await scriviSuSheets('svuotaCestino', {});
        cache.clear('clienti');
        cache.clear('fornitori');
        await caricaTuttiIDati(true);
        showToast('success', 'Cestino svuotato', `${risultato.eliminati} record eliminati`);
    } catch (error) {
        console.error('Errore svuota cestino:', error);
        showToast('error', 'Errore', error.message);
    } finally {
        aggiornaPulsanteSvuotaCestino();
    }
}

// ================================================================
// REFRESH DATI
// ================================================================
async function refreshDati() {
    if (isDataLoading) { showToast('info', 'Attenzione', 'Caricamento già in corso...'); return; }
    if (!confirm('🔄 Questo aggiornerà tutti i dati da Google Sheets. Continuare?')) return;

    cache.clearAll();
    await caricaTuttiIDati(true);
    showToast('success', 'Aggiornato', 'Dati ricaricati da Google Sheets');
}

// ================================================================
// MODALE FORNITORE
// ================================================================
let modalFornitoreStato = 'lettura';
let fornitoreOriginale = null;
let isNuovoFornitore = false;

function apriModalFornitore(prog = null) {
    const record = prog ? tuttiFornitori.find(r => String(r.Prog) === String(prog)) : null;
    const f = record || {};
    const isModifica = prog !== null;
    // ★ Calcola il prossimo Prog disponibile per i nuovi fornitori ★
    const prossimoProg = isModifica ? prog : calcolaProssimoProg();
    isNuovoFornitore = !isModifica;
    modalFornitoreStato = isModifica ? 'lettura' : 'modifica';
    fornitoreOriginale = isModifica ? JSON.parse(JSON.stringify(f)) : null;

    const modalContent = document.getElementById('modalContentFull');
    if (!modalContent) return;
    const hasLink = f.LinkFornitore && f.LinkFornitore.trim() !== '';

    modalContent.innerHTML = `
        <div class="modal-header px-6 py-3 text-white flex items-center justify-between shadow-md sticky top-0 z-10">
            <div>
                ${isModifica ? `<button onclick="toggleFornitoreModifica()" class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-1.5 rounded font-bold text-xs uppercase"><i class="fas fa-edit"></i> Modifica</button>` : ''}
                <button onclick="salvaFornitore('${prog || ''}')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-1.5 rounded font-bold text-xs uppercase ${!isModifica ? 'inline-flex' : 'hidden'}"><i class="fas fa-save"></i> Salva</button>
            </div>
            <h2 class="text-lg font-bold uppercase text-white/90 text-center flex-1 mx-4">${isModifica ? 'SCHEDA FORNITORE' : 'NUOVO FORNITORE'}</h2>
            <div class="flex items-center gap-3">
                ${isModifica ? `<button onclick="eliminaFornitore('${prog}')" class="bg-red-600 hover:bg-red-700 text-white px-4 py-1.5 rounded font-bold text-xs uppercase"><i class="fas fa-trash-alt"></i> Elimina</button>` : ''}
                <button onclick="chiudiModale()" class="text-white/60 hover:text-white text-xl"><i class="fas fa-times"></i></button>
            </div>
        </div>
        <div class="p-6 space-y-4 bg-white overflow-y-auto">
            <div class="text-center py-2">
                <input type="text" id="f_nome_hidden" value="${f.Fornitore || ''}" class="nome-fornitore-input" placeholder="Nome fornitore..." ${isModifica ? 'readonly' : ''}>
            </div>
            <div><label class="label-fornitore">📋 Tipologia (TDG)</label>
                <input type="text" id="f_tipo" value="${f.TipoTDG || ''}" class="vcm-input" ${isModifica ? 'readonly' : ''}></div>
            <div><label class="label-fornitore">📍 Destinazioni</label>
                <input type="text" id="f_dest" value="${f.Destinazioni || ''}" class="vcm-input" ${isModifica ? 'readonly' : ''}></div>
            <div><label class="label-fornitore">🌐 Sito Web</label>
                <div class="flex gap-2">
                    <input type="url" id="f_link" value="${f.LinkFornitore || ''}" class="vcm-input flex-1" ${isModifica ? 'readonly' : ''}>
                    ${hasLink ? `<button onclick="window.open('${f.LinkFornitore}','_blank')" class="btn-sito"><i class="fas fa-external-link-alt"></i> Vai</button>` : ''}
                </div></div>
            <div><label class="label-fornitore">⭐ Prodotti Top</label>
                <textarea id="f_prod" class="vcm-input !h-20" ${isModifica ? 'readonly' : ''}>${f.ProdottiTop || ''}</textarea></div>
            <div><label class="label-fornitore">📝 Note Interne</label>
                <textarea id="f_note" class="vcm-input !h-24" ${isModifica ? 'readonly' : ''}>${f.Note || ''}</textarea></div>
<div><label class="label-fornitore">🔢 Prog</label>
    <input type="number" id="f_prog" value="${prossimoProg}" class="vcm-input" readonly style="background-color:#f1f5f9;cursor:not-allowed;"></div>
        </div>
    `;
    document.getElementById('modalVcm').classList.remove('hidden');
}

/**
 * Calcola il prossimo numero Prog disponibile.
 * Trova il valore massimo tra tutti i fornitori e aggiunge 1.
 */
function calcolaProssimoProg() {
    if (!tuttiFornitori || tuttiFornitori.length === 0) return 1;

    const progNumerici = tuttiFornitori
        .map(f => parseInt(f.Prog, 10))
        .filter(n => !isNaN(n));

    if (progNumerici.length === 0) return 1;

    return Math.max(...progNumerici) + 1;
}

function toggleFornitoreModifica() {
    // ★ Il Prog non si modifica mai, anche in modalità "Modifica" ★
    ['f_nome_hidden','f_tipo','f_dest','f_link','f_prod','f_note'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.readOnly = false;
    });
    modalFornitoreStato = 'modifica';
}

async function salvaFornitore(prog) {
    const fields = {
        Prog: document.getElementById('f_prog')?.value || prog || '',
        Fornitore: document.getElementById('f_nome_hidden')?.value || '',
        Destinazioni: document.getElementById('f_dest')?.value || '',
        TipoTDG: document.getElementById('f_tipo')?.value || '',
        LinkFornitore: document.getElementById('f_link')?.value || '',
        ProdottiTop: document.getElementById('f_prod')?.value || '',
        Note: document.getElementById('f_note')?.value || ''
    };

    if (!fields.Fornitore.trim()) { showToast('warning', 'Attenzione', 'Nome fornitore obbligatorio'); return; }

    try {
        await scriviSuSheets('salvaFornitore', fields);
        cache.clear('fornitori');
        chiudiModale();
        await caricaTuttiIDati(true);
        showToast('success', 'Salvato', 'Fornitore aggiornato');
    } catch (error) {
        console.error('Errore salvataggio fornitore:', error);
        showToast('error', 'Errore', error.message);
    }
}

async function eliminaFornitore(prog) {
    if (!confirm("⚠️ Eliminare definitivamente questo fornitore?")) return;
    try {
        await scriviSuSheets('eliminaFornitore', { Prog: prog });
        cache.clear('fornitori');
        chiudiModale();
        await caricaTuttiIDati(true);
        showToast('success', 'Eliminato', 'Fornitore eliminato');
    } catch (error) {
        console.error('Errore eliminazione:', error);
        showToast('error', 'Errore', error.message);
    }
}

function mostraIndicatoreRic() {
    const el = document.getElementById('indicatoreRic');
    if (el) el.classList.remove('hidden');
}

function nascondiIndicatoreRic() {
    const el = document.getElementById('indicatoreRic');
    if (el) el.classList.add('hidden');
}

// ================================================================
// UTILITY
// ================================================================
function apriWhatsApp(num) {
    if (!num) { showToast('warning', 'Attenzione', 'Nessun numero'); return; }
    const c = pulisciTelefono(num).replace(/\D/g, '');
    if (c.length < 10) { showToast('warning', 'Attenzione', 'Numero non valido'); return; }
    const numero = c.startsWith('39') ? c : '39' + c;
    window.open(`https://wa.me/${numero}`, '_blank');
}

// ================================================================
// INIT
// ================================================================
window.onload = async function() {
    console.log('🚀 Avvio VcM Gestionale Web (Google Sheets Edition)...');
    popolaFiltri();
    showLoading(true);
    await caricaTuttiIDati(false);
    cache.updateStats('cestino');
    aggiornaStatisticheUI();
    cambiaSezione('clienti');
    document.getElementById('modalStatPopup').classList.add('hidden');

    // ★★★ REFRESH AUTOMATICO ★★★

    // 1. Al focus della finestra (torni su VcM)
    let ultimoFocus = 0;
    window.addEventListener('focus', () => {
        const ora = Date.now();
        // Non ricaricare più spesso di 30 secondi
        if (ora - ultimoFocus < 30000) return;
        ultimoFocus = ora;

        const eta = cache.getAge('clienti');
        if (eta === null || eta > 0.0125) {
            console.log('🔍 Focus: cache vecchia, ricarico');
            ricaricaInBackground();
        } else {
            console.log('🔍 Focus: cache fresca, non ricarico');
        }
    });

    // 2. Refresh periodico ogni 5 minuti
    setInterval(() => {
        const eta = cache.getAge('clienti');
        if (eta === null || eta > 0.08) {
            console.log('⏰ Refresh periodico');
            ricaricaInBackground();
        }
    }, 5 * 60 * 1000); // 5 minuti

    // 3. Aggiorna lo stato cache ogni 30 sec
    setInterval(() => {
        cache.updateStatusDisplay();
    }, 30000);

    console.log('✅ VcM Gestionale avviato');
};
window.addEventListener('unhandledrejection', function(event) {
    console.error('❌ Errore non gestito:', event.reason);
    if (event.reason?.message) showToast('error', 'Errore imprevisto', event.reason.message);
});

window.addEventListener('offline', function() {
    showToast('warning', 'Connessione persa', 'I dati sono disponibili in cache');
});
// ================================================================
// MENU TABLET - Apertura e chiusura
// ================================================================

function apriMenuTablet() {
    const sidebar = document.querySelector('.fixed.left-0.top-0.h-full.w-60');
    const overlay = document.getElementById('overlayMenu');

    if (sidebar) sidebar.classList.add('menu-aperto');
    if (overlay) {
        overlay.classList.remove('hidden');
        // Forza il reflow per far partire la transizione
        setTimeout(() => overlay.classList.add('visible'), 10);
    }
}

function chiudiMenuTablet() {
    const sidebar = document.querySelector('.fixed.left-0.top-0.h-full.w-60');
    const overlay = document.getElementById('overlayMenu');

    if (sidebar) sidebar.classList.remove('menu-aperto');
    if (overlay) {
        overlay.classList.remove('visible');
        // Nasconde l'overlay dopo la transizione
        setTimeout(() => overlay.classList.add('hidden'), 300);
    }
}

// Chiude il menu quando si cambia sezione
const _originalCambiaSezione = cambiaSezione;
cambiaSezione = function(nome) {
    _originalCambiaSezione(nome);
    chiudiMenuTablet();
};

// Chiude il menu anche al resize della finestra (da tablet a desktop)
window.addEventListener('resize', function() {
    if (window.innerWidth >= 1024) {
        chiudiMenuTablet();
    }
});