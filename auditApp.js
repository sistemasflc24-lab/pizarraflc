
/**
 * auditApp.js
 * Lógica independiente para la Aplicación Satélite de Auditoría (AuditPro).
 * Se conecta directamente a Firebase sin depender de index.html.
 */

// ==========================================
// 1. CONFIGURACIÓN FIREBASE (Incrustada)
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyD0j20ZXdcfVioRAfkJn6Uyn_Q2A6blYkI",
    authDomain: "pizarraflc.appspot.com",
    projectId: "pizarraflc",
    storageBucket: "pizarraflc.firebasestorage.app",
    messagingSenderId: "108471728011",
    appId: "1:108471728011:web:c0a83b710b37d72c21e18e",
    measurementId: "G-SJZW3G2P79"
};

// Inicializar Firebase si no existe
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
const auth = firebase.auth();

// Habilitar persistencia offline si es posible
db.enablePersistence().catch(err => console.warn("Persistencia no habilitada:", err.code));

// ==========================================
// 2. ESTADO DE LA APLICACIÓN
// ==========================================
const AuditState = {
    currentUser: null,
    operaciones: [],
    solicitudes: [],
    aclaraciones: [], // Nueva colección
    listeners: [] // Para limpiar suscripciones
};

// URL del Webhook de n8n para reportes (Pegar aquí la URL de n8n)
window.ACLARACIONES_WEBHOOK_URL = "https://hook.us2.make.com/5r3ysaqjuqjbhlgqe1r8nv3vdih5qnje";

// --- HELPERS DE ARCHIVOS Y EVIDENCIA ---
function getFileIcon(url) {
    if (!url) return '<i class="fas fa-file text-slate-400"></i>';
    const ext = url.split('?')[0].split('.').pop().toLowerCase();
    if (ext === 'pdf') return '<i class="fas fa-file-pdf text-red-500"></i>';
    if (['xls', 'xlsx', 'xlsm', 'csv'].includes(ext)) return '<i class="fas fa-file-excel text-green-500"></i>';
    if (['doc', 'docx'].includes(ext)) return '<i class="fas fa-file-word text-blue-500"></i>';
    return '<i class="fas fa-file-alt text-slate-400"></i>';
}

function isImage(url) {
    if (!url) return false;
    const ext = url.split('?')[0].split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
}

/**
 * Verifica si una solicitud tiene evidencia adjunta.
 */
function hasEvidence(sol) {
    if (!sol) return false;
    // 1. Comprobante URL (Legacy)
    if (sol.comprobanteUrl) return true;
    // 2. Comprobante URLs (Array Nuevo)
    if (sol.comprobanteURLs && sol.comprobanteURLs.length > 0) return true;
    // 3. Tesoreria
    if (sol.comprobanteTesoreriaURL) return true;
    if (sol.comprobanteTesoreriaURLs && sol.comprobanteTesoreriaURLs.length > 0) return true;
    // 4. Mobile Evidence
    if (sol.mobileEvidence && sol.mobileEvidence.length > 0) return true;

    return false;
}

// ==========================================
// 3. CAPA DE MAPEO DE DATOS (Data Mapping Layer)
// ==========================================

/**
 * Transforma un documento de Firestore 'operaciones' en un objeto usable para la UI.
 * Basado en el esquema visualizado en las imágenes proporcionadas.
 */
function mapOperacionToAuditCard(doc) {
    const data = doc.data();
    return {
        id: doc.id,
        // Campos principales vistos en imágenes
        ejecutivo: data.ejecutivo || 'N/A',
        solicitante: data.solicitante || 'Sin Solicitante',
        familia: data.familia || 'Sin Familia',
        // El importe viene como string en la BD según imagen ("67750"), lo convertimos a float
        importe: parseFloat(data.importe) || 0,
        moneda: data.moneda || 'MXN',
        status: (data.status || 'draft').toLowerCase(), // 'activo', 'conciliado', etc.
        auditado: data.auditado === true, // Nueva bandera
        fecha: data.fecha || '',
        hora: data.hora || '',

        // Detalles operativos
        numeroOperador: data.numeroOperador || '',
        operadora: data.operadora || '',
        origen: data.origen || '',
        tipo_operacion: data.tipo_operacion || '',
        esquema: data.esquema || '',
        retorno: data.retorno || '',

        // Metadatos
        timestamp: data.timestamp ? data.timestamp.toDate() : new Date()
    };
}

/**
 * Transforma un documento de Firestore 'solicitudes' para la vista de Evidencia.
 */
function mapSolicitudToEvidence(doc) {
    const data = doc.data();
    return {
        id: doc.id,
        operacionId: data.operacionId || '',
        folio: data.folio || 'S/N',

        // Archivos y Evidencias
        mobileEvidence: Array.isArray(data.mobileEvidence) ? data.mobileEvidence : [],
        comprobanteUrl: data.comprobanteUrl || null,
        comprobanteURLs: Array.isArray(data.comprobanteURLs) ? data.comprobanteURLs : [],
        comprobanteTesoreriaURL: data.comprobanteTesoreriaURL || null,
        comprobanteTesoreriaURLs: Array.isArray(data.comprobanteTesoreriaURLs) ? data.comprobanteTesoreriaURLs : [],

        // Conceptos (Desglose)
        conceptos: Array.isArray(data.conceptos) ? data.conceptos : [],
        conceptosGuardados: Array.isArray(data.conceptosGuardados) ? data.conceptosGuardados : [],

        // Estado
        status: data.status || 'pre-orden',
        cliente: data.cliente || '',
        banco: data.banco || '',

        // Timestamps para el flujo
        preordenTimestamp: data.preordenTimestamp,
        ordenTimestamp: data.ordenTimestamp,
        preautorizadoTimestamp: data.preautorizadoTimestamp,
        autorizadoTimestamp: data.autorizadoTimestamp,
        completadoTimestamp: data.completadoTimestamp,
        conciliadoTimestamp: data.conciliadoTimestamp,

        // MACRO DATOS (NUEVOS)
        emite: data.emite || '',
        metodo_pago: data.metodo_pago || '',
        tipo_nomina: data.tipo_nomina || '',
        moneda: data.moneda || 'MXN',
        operadora: data.operadora || '',
        origen: data.origen || '', // A veces duplicado en solicitud
        dispersiones: Array.isArray(data.dispersiones) ? data.dispersiones : []
    };
}

/**
 * Mapeo de Aclaraciones
 */
function mapAclaracionToData(doc) {
    const data = doc.data();
    return {
        id: doc.id, // Igual al operationId
        operationId: data.operationId,
        status: data.status || 'abierta',
        priority: data.priority || 'media',
        motivo: data.motivo || 'Otro',
        notas: data.notas || '',
        operationSnapshot: data.operationSnapshot || {},
        createdAt: data.createdAt ? data.createdAt.toDate() : new Date(),
        dueDate: data.dueDate ? data.dueDate.toDate() : null,
        closedAt: data.closedAt ? data.closedAt.toDate() : null
    };
}

// ==========================================
// 4. LÓGICA DE VISTA (View Logic)
// ==========================================

function initApp() {
    console.log("🚀 Iniciando AuditPro Satellite App...");
    setupNavigation();
    setupFilters();
    subscribeToData();
}

function setupNavigation() {
    const tabs = document.querySelectorAll('.nav-item');
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            // Remover activo de todos
            document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active', 'bg-slate-800', 'text-blue-400', 'border-r-4', 'border-blue-500'));

            // Activar actual
            const target = e.currentTarget;
            target.classList.add('active', 'bg-slate-800', 'text-blue-400', 'border-r-4', 'border-blue-500');

            // Mostrar vista correspondiente
            const viewId = target.getAttribute('href').substring(1) + '-view'; // #dashboard -> dashboard-view
            document.querySelectorAll('.view-section').forEach(v => v.classList.add('hidden'));
            const view = document.getElementById(viewId);
            if (view) view.classList.remove('hidden');
        });
    });
}

let currentDataUnsubscribers = [];

function subscribeToData(daysHistory = 15) {
    // Limpiar suscripciones anteriores si existen
    if (currentDataUnsubscribers.length > 0) {
        console.log("🔄 Limpiando suscripciones anteriores...");
        currentDataUnsubscribers.forEach(unsub => unsub());
        currentDataUnsubscribers = [];
        AuditState.operaciones = [];
        AuditState.solicitudes = [];
        AuditState.aclaraciones = [];
    }

    // Calcular fecha de corte
    let dateStr = null;
    let limitDate = null;

    if (daysHistory) {
        limitDate = new Date();
        limitDate.setDate(limitDate.getDate() - daysHistory);
        limitDate.setHours(0, 0, 0, 0);
        dateStr = limitDate.toISOString().split('T')[0];
        console.log(`📡 Suscribiendo a datos desde: ${dateStr} (${daysHistory} días)`);
    } else {
        console.log(`📡 Suscribiendo a TODO el historial (sin límite)`);
    }

    // HELPER: Construir query
    const buildQuery = (collectionName, dateField) => {
        let q = db.collection(collectionName);
        if (dateStr) {
            q = q.where(dateField, '>=', (collectionName === 'aclaraciones' ? limitDate : dateStr));
        }
        return q;
    };

    // 1. Suscripción a Operaciones
    const unsubOps = buildQuery('operaciones', 'fecha')
        .onSnapshot(snapshot => {
            AuditState.operaciones = snapshot.docs.map(mapOperacionToAuditCard);
            console.log(`📥 Operaciones cargadas: ${AuditState.operaciones.length}`);
            updateDashboard();
            populateFilterOptions();
            applyFilters();
            injectHistoryButton(daysHistory); // Inyectar botón si estamos limitados
        }, err => console.error("Error cargando operaciones:", err));

    currentDataUnsubscribers.push(unsubOps);
    AuditState.listeners.push(unsubOps); // Mantener en global también por si acaso

    // 2. Suscripción a Solicitudes
    const unsubSols = buildQuery('solicitudes', 'fecha')
        .onSnapshot(snapshot => {
            AuditState.solicitudes = snapshot.docs.map(mapSolicitudToEvidence);
            console.log(`📥 Solicitudes cargadas: ${AuditState.solicitudes.length}`);
            renderEvidence();
        }, err => console.error("Error cargando solicitudes:", err));

    currentDataUnsubscribers.push(unsubSols);
    AuditState.listeners.push(unsubSols);

    // 3. Suscripción a Aclaraciones
    const unsubAclaraciones = buildQuery('aclaraciones', 'createdAt')
        .onSnapshot(snapshot => {
            AuditState.aclaraciones = snapshot.docs.map(mapAclaracionToData);
            console.log(`📥 Aclaraciones cargadas: ${AuditState.aclaraciones.length}`);
            renderAclaracionesView();
            updateDashboard();
            renderTimeline();
        }, err => console.error("Error cargando aclaraciones:", err));

    currentDataUnsubscribers.push(unsubAclaraciones);
    AuditState.listeners.push(unsubAclaraciones);
}

// Función para inyectar botón de historial en el panel de filtros
function injectHistoryButton(currentDays) {
    // Buscamos el contenedor del encabezado de filtros (donde está el botón de limpiar)
    const resetBtn = document.getElementById('btn-reset-filters');
    if (!resetBtn) return;

    const container = resetBtn.parentNode; // El div que contiene el título "Filtros Avanzados" y el botón reset

    // Eliminar botón previo si existe
    const existingBtn = document.getElementById('btn-load-history');
    if (existingBtn) existingBtn.remove();

    // Si ya cargamos todo (currentDays null) o no encontramos contenedor, salir
    if (!currentDays) return;

    const btn = document.createElement('button');
    btn.id = 'btn-load-history';
    btn.className = "text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1 border border-blue-900/50 px-2 py-1 rounded bg-slate-900/50 ml-auto mr-4";
    btn.innerHTML = `<i class="fas fa-history"></i> Historial (+${currentDays}d)`;
    btn.onclick = () => {
        if (confirm("⚠️ Cargar todo el historial puede demorar unos segundos. ¿Continuar?")) {
            subscribeToData(null); // Cargar sin límite
        }
    };

    // Insertar antes del botón de reset
    container.insertBefore(btn, resetBtn);
}

// --- RENDERIZADO: DASHBOARD ---
function updateDashboard() {
    const ops = AuditState.operaciones;

    // KPIs
    const totalOps = ops.length;
    // Asumimos que 'conciliado' es el estado final correcto
    // KPI: Pendientes (Status no conciliado/cancelado Y NO auditado aun)
    const pendientes = ops.filter(o =>
        o.status !== 'conciliado' &&
        o.status !== 'cancelado' &&
        !o.auditado // Excluir si ya fue auditado
    ).length;
    const issues = ops.filter(o => o.status === 'cancelado').length; // O lógica de anomalías

    // Total Importe (Suma de importes activos)
    const totalImporte = ops
        .filter(o => o.status !== 'cancelado')
        .reduce((sum, o) => sum + o.importe, 0);

    // Actualizar DOM
    // Nota: Estos IDs deben existir en auditoria.html. Si no, los crearemos o ajustaremos.
    safeSetText('kpi-total-ops', totalOps);
    safeSetText('kpi-pending-audit', pendientes);

    // KPI Aclaraciones
    const aclOpen = AuditState.aclaraciones.filter(a => a.status !== 'cerrada').length;
    safeSetText('kpi-aclaraciones', aclOpen);

    safeSetText('kpi-issues', issues);
    safeSetText('kpi-total-amount', `$${totalImporte.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
}

// --- FILTROS Y BÚSQUEDA ---
// --- FILTROS Y BÚSQUEDA ---
// --- FILTROS Y BÚSQUEDA ---
function setupFilters() {
    // ESTABLECER FECHA DE HOY POR DEFECTO PARA NO CARGAR TODO EL HISTORIAL
    // ESTABLECER FECHA DE HOY POR DEFECTO PARA NO CARGAR TODO EL HISTORIAL
    const today = new Date();
    const loc = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

    const startInput = document.getElementById('filter-date-start');
    const endInput = document.getElementById('filter-date-end');

    if (startInput) {
        startInput.value = loc;
        console.log("📅 Filtro Inicio establecido a:", loc);
    }
    if (endInput) {
        endInput.value = loc;
        console.log("📅 Filtro Fin establecido a:", loc);
    }
    const filters = [
        { id: 'filter-search', event: 'input' },
        { id: 'filter-status', event: 'change' },
        { id: 'filter-date-start', event: 'change' },
        { id: 'filter-date-end', event: 'change' },
        { id: 'filter-week', event: 'change' },
        { id: 'filter-executive', event: 'change' },
        { id: 'filter-amount-min', event: 'input' }
    ];

    filters.forEach(f => {
        const el = document.getElementById(f.id);
        if (el) {
            el.addEventListener(f.event, () => {
                console.log(`⚡ Evento ${f.event} detectado en ${f.id}`);
                applyFilters();
            });
        }
    });

    document.getElementById('btn-reset-filters').addEventListener('click', () => {
        filters.forEach(f => {
            const el = document.getElementById(f.id);
            if (el) el.value = '';
        });
        applyFilters();
    });

    // --- CONFIGURACIÓN POR DEFECTO: SEMANA EN CURSO (DESHABILITADO) ---
    // Se comenta para permitir ver todas las operaciones cargadas por defecto
    /* 
    try {
        const now = new Date();
        const day = now.getDay(); // 0 (Domingo) - 6 (Sábado)
        const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Ajustar al Lunes

        const monday = new Date(now);
        monday.setDate(diff); // Mutamos la copia de fecha
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        const formatDate = (date) => {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        };

        const startEl = document.getElementById('filter-date-start');
        const endEl = document.getElementById('filter-date-end');

        if (startEl && endEl) {
            startEl.value = formatDate(monday);
            endEl.value = formatDate(sunday);
            console.log(`📅 Filtro fecha inicializado: ${startEl.value} - ${endEl.value}`);
        }
    } catch (e) {
        console.error("Error calculando fechas:", e);
    }
    */
}

function applyFilters() {
    console.log("🔄 Ejecutando applyFilters()...");
    const search = (document.getElementById('filter-search').value || '').toLowerCase().trim();
    const statusVal = (document.getElementById('filter-status').value || '').toLowerCase();

    // --- LÓGICA DE PRIORIDAD DE SEMANA ---
    const weekVal = document.getElementById('filter-week').value;

    let dateStart = document.getElementById('filter-date-start').value;
    let dateEnd = document.getElementById('filter-date-end').value;

    // Si hay semana, LIMPIAMOS fechas explicitas para evitar conflicto
    if (weekVal) {
        dateStart = '';
        dateEnd = '';
        document.getElementById('filter-date-start').value = '';
        document.getElementById('filter-date-end').value = '';
    }

    // FAILSAFE: Si los inputs están vacíos Y NO hay semana, usar HOY
    if (!dateStart && !dateEnd && !search && !statusVal && !weekVal) {
        // Solo aplicar default restrictivo si no hay otros filtros activos explicitamente
        const today = new Date();
        const loc = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
        dateStart = loc;
        dateEnd = loc;
        // Visualmente actualizar inputs
        document.getElementById('filter-date-start').value = loc;
        document.getElementById('filter-date-end').value = loc;
        console.log("⚠️ Filtros vacíos detectados: aplicando default HOY");
    }

    const executive = document.getElementById('filter-executive').value;
    const minAmount = parseFloat(document.getElementById('filter-amount-min').value) || 0;
    const missingEvidenceFilter = document.getElementById('filter-missing-evidence') ? document.getElementById('filter-missing-evidence').value : '';

    console.log("🔍 Filtrando con:", { search, statusVal, dateStart, dateEnd, executive, minAmount, missingEvidenceFilter });

    const filtered = AuditState.operaciones.filter(op => {
        // Find Solicitud for evidence check
        const sol = AuditState.solicitudes.find(s => s.operacionId === op.id);

        // 1. Búsqueda Texto
        const searchableText = `${op.id || ''} ${op.solicitante || ''} ${op.folio || ''} ${op.familia || ''} ${op.operadora || ''} ${op.ejecutivo || ''} ${op.tipo_operacion || ''} ${op.retorno || ''} ${op.origen || ''} ${op.importe || ''} ${op.moneda || ''}`.toLowerCase();
        const textMatch = !search || searchableText.includes(search);

        // 2. Status (Alias ACTIVO = PRE-ORDEN)
        const opStatus = (op.status || '').toLowerCase();
        let statusMatch = true;
        if (statusVal) {
            if (statusVal === 'pre-orden') {
                statusMatch = (opStatus === 'pre-orden' || opStatus === 'activo');
            } else {
                statusMatch = opStatus === statusVal;
            }
        }

        // 3. Fechas
        let dateMatch = true;
        const opDate = op.fecha;
        if (dateStart && opDate < dateStart) dateMatch = false;
        if (dateEnd && opDate > dateEnd) dateMatch = false;

        // 4. Ejecutivo
        // executive viene del value del option. Puede ser nombre completo.
        const execMatch = !executive || (op.ejecutivo || '').includes(executive);

        // 5. Importe
        const amountMatch = op.importe >= minAmount;

        // 6. Semana
        let weekMatch = true;
        if (weekVal) {
            const opWeek = getWeekNumber(new Date(op.fecha)); // "Semana X"
            if (opWeek !== weekVal) weekMatch = false;
        }

        // 7. Evidencia (Faltante)
        let evidenceMatch = true;
        if (missingEvidenceFilter) {
            const hasEv = hasEvidence(sol);
            if (missingEvidenceFilter === 'missing') {
                // Queremos los que NO tienen evidencia (y que no esten cancelados, idealmente)
                if (hasEv) evidenceMatch = false;
            } else if (missingEvidenceFilter === 'present') {
                if (!hasEv) evidenceMatch = false;
            }
        }

        return textMatch && statusMatch && dateMatch && execMatch && amountMatch && weekMatch && evidenceMatch;
    });

    console.log(`✅ Resultados filtrados: ${filtered.length} de ${AuditState.operaciones.length}`);

    // Actualizar contador
    const countEl = document.getElementById('filter-results-count');
    if (countEl) countEl.textContent = filtered.length;

    renderTimeline(filtered);
}

function populateFilterOptions() {
    // Llenar Ejecutivo
    const execSelect = document.getElementById('filter-executive');
    if (!execSelect) return;

    // Obtener únicos
    const executives = [...new Set(AuditState.operaciones.map(op => op.ejecutivo).filter(Boolean))].sort();

    // Guardar selección actual por si se repuebla
    const currentVal = execSelect.value;

    execSelect.innerHTML = '<option value="">Todos</option>';
    executives.forEach(ex => {
        execSelect.innerHTML += `<option value="${ex}">${ex}</option>`;
    });

    execSelect.value = currentVal;

    // Llenar Semana (Dinámico basado en datos)
    const weekSelect = document.getElementById('filter-week');
    if (weekSelect) {
        const uniqueWeeks = [...new Set(AuditState.operaciones.map(op => {
            if (!op.fecha) return null;
            return getWeekNumber(new Date(op.fecha));
        }).filter(Boolean))].sort((a, b) => {
            // Ordenar semanas descendentemente (Semana 5, Semana 4...)
            const numA = parseInt(a.replace(/\D/g, '')) || 0;
            const numB = parseInt(b.replace(/\D/g, '')) || 0;
            return numB - numA;
        });

        const currentWeekVal = weekSelect.value;
        weekSelect.innerHTML = '<option value="">Todas las Semanas</option>';
        uniqueWeeks.forEach(w => {
            weekSelect.innerHTML += `<option value="${w}">${w}</option>`;
        });
        weekSelect.value = currentWeekVal;
    }
}

// Helper para Semana
// Helper para Semana con Rango (ISO-8601 approx)
function getWeekNumber(d) {
    if (!d || isNaN(d.getTime())) return '';

    // Copia para cálculo de semana
    const dateForWeek = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = dateForWeek.getUTCDay() || 7;
    dateForWeek.setUTCDate(dateForWeek.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(dateForWeek.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((dateForWeek - yearStart) / 86400000) + 1) / 7);

    // Calcular inicio (Lunes) y fin (Domingo) de la semana de la fecha original
    // Usamos la fecha original 'd' local
    const current = new Date(d);
    const day = current.getDay(); // 0-6
    const diff = current.getDate() - day + (day === 0 ? -6 : 1); // Lunes

    const monday = new Date(current.setDate(diff));
    const sunday = new Date(current.setDate(monday.getDate() + 6));

    const f = (date) => {
        return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    };

    return `Semana ${weekNo} (${f(monday)} - ${f(sunday)})`;
}

// --- RENDERIZADO: TIMELINE ---
function renderTimeline(dataToRender = null) {
    const container = document.getElementById('timeline-container'); // Debe existir en HTML
    if (!container) return;

    container.innerHTML = ''; // Limpiar

    // Usar data filtrada o todo state por defecto
    const ops = dataToRender || AuditState.operaciones;

    if (ops.length === 0) {
        container.innerHTML = `<div class="text-center py-10 text-gray-500">No se encontraron operaciones con los filtros actuales.</div>`;
        return;
    }

    // Ordenar por fecha descendente
    const sortedOps = [...ops].sort((a, b) => {
        return new Date(b.fecha) - new Date(a.fecha);
    });

    sortedOps.forEach(op => {
        // Encontrar la solicitud asociada para obtener timestamps y status detallado
        const sol = AuditState.solicitudes.find(s => s.operacionId === op.id) || {};
        const workflowHTML = generateWorkflowBar(sol, op.status);

        // Detectar si está en Aclaración Activa
        const activeAcl = AuditState.aclaraciones.find(a => a.operationId === op.id && a.status !== 'cerrada');

        const card = document.createElement('div');
        // Si hay aclaracion, borde AMARILLO/NARANJA, sino AZUL (o VERDE si auditado)
        let borderClass = 'border-blue-500';
        let bgClass = 'bg-slate-800';
        let extraBadge = '';

        if (op.auditado) {
            borderClass = 'border-emerald-500';
        }

        if (activeAcl) {
            borderClass = 'border-yellow-500';
            bgClass = 'bg-slate-800/80 ring-1 ring-yellow-500/30'; // Slight highlight
            extraBadge = `<div class="bg-yellow-900/50 text-yellow-200 text-[10px] px-2 py-0.5 rounded font-bold border border-yellow-700/50 uppercase inline-flex items-center gap-1 mb-2">
                            <i class="fas fa-exclamation-triangle"></i> En Aclaración: ${activeAcl.motivo}
                          </div>`;
        }

        // --- VERIFICACIÓN DE EVIDENCIA (NUEVO) ---
        // Buscamos si tiene comprobantes adjuntos
        const hasEv = hasEvidence(sol);
        // Si NO tiene evidencia y NO está cancelada/draft, mostramos alerta
        if (!hasEv && op.status !== 'cancelado' && op.status !== 'draft') {
            extraBadge += `<div class="bg-red-900/50 text-red-200 text-[10px] px-2 py-0.5 rounded font-bold border border-red-700/50 uppercase inline-flex items-center gap-1 mb-2 ml-2">
                            <i class="fas fa-file-excel"></i> SIN COMPROBANTE
                          </div>`;
        }

        card.className = `${bgClass} rounded-lg p-4 mb-4 border-l-4 ${borderClass} shadow-md hover:bg-slate-750 transition-colors relative`;

        let statusColor = 'text-gray-400';
        if (op.status === 'autorizado') statusColor = 'text-blue-400';
        if (op.status === 'completado') statusColor = 'text-green-400';
        if (op.status === 'cancelado') statusColor = 'text-red-400';

        card.innerHTML = `
            ${extraBadge}
            <div class="flex justify-between items-start mb-2">
                <div>
                    <h3 class="font-bold text-slate-100 text-lg flex items-center gap-2">
                        ${op.solicitante} - ${op.id}
                        ${op.auditado ? '<i class="fas fa-check-circle text-emerald-400 text-sm" title="Auditado"></i>' : ''}
                    </h3>
                    <p class="text-xs text-slate-400">${op.ejecutivo} • ${op.familia}</p>
                </div>
                <div class="text-right">
                    <span class="font-mono font-bold text-xl text-emerald-400">$${op.importe.toLocaleString('en-US')}</span>
                    <div class="text-xs uppercase font-bold ${statusColor}">${op.status}</div>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2 text-sm text-slate-300 mt-2">
                <div><i class="fas fa-calendar-alt mr-2 opacity-50"></i>${op.fecha}</div>
                <div><i class="fas fa-exchange-alt mr-2 opacity-50"></i>${op.tipo_operacion}</div>
                <div><i class="fas fa-building mr-2 opacity-50"></i>${op.operadora}</div>
                <div><i class="fas fa-wallet mr-2 opacity-50"></i>${op.retorno}</div>
            </div>
            
            <!-- Workflow Bar -->
            ${workflowHTML}

            <div class="mt-3 pt-3 border-t border-slate-700 flex justify-end gap-2">
                ${getAclaracionButton(op)}
                <button class="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded" onclick="auditarOperacion('${op.id}')">
                    <i class="fas fa-check-circle mr-1"></i>Auditar
                </button>
            </div>
        `;
        container.appendChild(card);
    });
}

function getAclaracionButton(op) {
    const acl = AuditState.aclaraciones.find(a => a.operationId === op.id);

    if (acl) {
        if (acl.status === 'cerrada') {
            return `
                <button class="text-xs bg-emerald-900 hover:bg-emerald-800 text-emerald-200 border border-emerald-700 px-3 py-1 rounded" onclick="openAclaracion('${op.id}')">
                    <i class="fas fa-check-double mr-1"></i>Aclaración Cerrada
                </button>
            `;
        } else {
            return `
                 <button class="text-xs bg-yellow-900 hover:bg-yellow-800 text-yellow-200 border border-yellow-700 px-3 py-1 rounded animate-pulse" onclick="openAclaracion('${op.id}')">
                    <i class="fas fa-exclamation-triangle mr-1"></i>Aclaración (${acl.status.replace('_', ' ')})
                </button>
            `;
        }
    }

    return `
        <button class="text-xs bg-slate-700 hover:bg-slate-600 text-white px-3 py-1 rounded" onclick="openAclaracion('${op.id}')">
            <i class="fas fa-exclamation-circle mr-1 text-slate-400"></i>Aclaración
        </button>
    `;
}


function generateWorkflowBar(sol, currentStatus) {
    // Definición de pasos y colores
    const steps = [
        { key: 'pre-orden', label: 'Pre-orden', color: '#f59e0b' },
        { key: 'orden', label: 'Orden', color: '#f97316' },
        { key: 'pre-autorizado', label: 'Pre-Aut', color: '#a855f7' },
        { key: 'autorizado', label: 'Autorizado', color: '#3b82f6' },
        { key: 'completado', label: 'Completado', color: '#10b981' },
        { key: 'conciliado', label: 'Conciliado', color: '#8b5cf6' }
    ];

    // Determinar índice actual
    // Nota: Usamos el status de la SOLICITUD si existe, sino el de la OPERACIÓN
    const statusToCheck = (sol.status || currentStatus || '').toLowerCase();

    // Mapeo simple de status de operación a status de flujo si no hay solicitud
    let effectiveStatus = statusToCheck;
    if (statusToCheck === 'activo') effectiveStatus = 'pre-orden'; // Default inicial

    const currentIndex = steps.findIndex(s => s.key === effectiveStatus);

    let stepsHTML = '';
    let labelsHTML = '';

    steps.forEach((step, index) => {
        const isActive = index <= currentIndex;
        const opacityClass = isActive ? 'active' : '';

        // Generar barra
        stepsHTML += `
            <div class="progress-step ${opacityClass}" style="width: 16.66%; background-color: ${step.color};">
                ${step.label}
            </div>
        `;

        // Generar etiqueta de tiempo (Timestamp)
        let timeLabel = '-';
        if (sol) {
            // Buscamos el timestamp correspondiente dinámicamente
            // Ejemplo: 'pre-orden' -> 'preordenTimestamp'
            // 'pre-autorizado' -> 'preautorizadoTimestamp'
            const tsKey = step.key.replace('-', '') + 'Timestamp';
            if (sol[tsKey]) {
                let date;
                // Soporte para Timestamp de Firestore o String ISO
                if (sol[tsKey].toDate) {
                    date = sol[tsKey].toDate();
                } else {
                    date = new Date(sol[tsKey]);
                }

                if (!isNaN(date.getTime())) {
                    timeLabel = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
                }
            }
        }
        labelsHTML += `<div class="w-[16.66%] text-center">${timeLabel}</div>`;
    });

    return `
        <div class="progress-bar-container">
            <div class="progress-steps">
                ${stepsHTML}
            </div>
            <div class="progress-labels">
                ${labelsHTML}
            </div>
        </div>
    `;
}

// --- RENDERIZADO: EVIDENCIA ---
function renderEvidence() {
    const listContainer = document.getElementById('evidence-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';

    // Filtrar solicitudes que tengan evidencia
    const solsWithEvidence = AuditState.solicitudes.filter(s =>
        (s.mobileEvidence && s.mobileEvidence.length > 0) ||
        s.comprobanteUrl ||
        (s.comprobanteTesoreriaURLs && s.comprobanteTesoreriaURLs.length > 0)
    );

    solsWithEvidence.forEach(sol => {
        const item = document.createElement('div');
        item.className = "bg-slate-800 p-4 rounded-lg mb-3 border border-slate-700";

        // Recopilar urls
        let evidenceLinks = '';

        // Evidencia Móvil
        sol.mobileEvidence.forEach((ev, idx) => {
            evidenceLinks += `
                <a href="${ev.url}" target="_blank" class="block text-sm text-blue-400 hover:underline mb-1">
                    <i class="fas fa-mobile-alt mr-2"></i>Evidencia Móvil ${idx + 1} (${ev.capturedBy || '?'})
                </a>`;
        });

        // Comprobante Principal
        if (sol.comprobanteUrl) {
            evidenceLinks += `
                <a href="${sol.comprobanteUrl}" target="_blank" class="block text-sm text-emerald-400 hover:underline mb-1">
                    <i class="fas fa-receipt mr-2"></i>Comprobante Pago
                </a>`;
        }

        item.innerHTML = `
            <div class="flex justify-between mb-2">
                <h4 class="font-bold text-slate-200">Folio: ${sol.folio}</h4>
                <span class="text-xs bg-slate-700 px-2 py-1 rounded">${sol.status}</span>
            </div>
            <div class="mb-2">
                ${evidenceLinks}
            </div>
            <div class="text-xs text-slate-500">
                Operación ID: ${sol.operacionId}
            </div>
`;
        listContainer.appendChild(item);
    });
}

// Helpers
function safeSetText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// ==========================================
// 5. AUTH CHECK & STARTUP
// ==========================================
auth.onAuthStateChanged(async user => {
    if (user) {
        console.log("✅ Usuario autenticado:", user.email);

        // VERIFICACIÓN DE ROL
        try {
            const userDoc = await db.collection('usuarios').doc(user.uid).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                const userRole = (userData.role || '').toLowerCase();

                // Permitir 'auditor', 'admin', 'financiero' y 'tesoreria'
                if (userRole === 'auditor' || userRole === 'admin' || userRole === 'financiero' || userRole === 'tesoreria') {
                    console.log(`🔓 Acceso concedido.Rol: ${userRole} `);
                    AuditState.currentUser = { ...user, ...userData };
                    // Iniciar app solo si tiene permiso
                    initApp();
                } else {
                    console.warn(`⛔ Acceso denegado.Rol: ${userRole} `);
                    showAccessDenied(`Tu rol '${userRole}' no tiene permisos para acceder a esta aplicación.`);
                    // Opcional: auto-logout
                    // auth.signOut(); 
                }
            } else {
                console.error("❌ Perfil de usuario no encontrado en BD.");
                showAccessDenied("No se encontró tu perfil de usuario.");
            }
        } catch (error) {
            console.error("Error verificando permisos:", error);
            showAccessDenied("Error verificando permisos. Intenta recargar.");
        }

    } else {
        console.warn("⛔ No hay sesión activa. Redirigiendo a Login...");
        // Mostrar pantalla de login/bloqueo
        // Mostrar pantalla de login/bloqueo
        document.body.innerHTML = `
            <div class="h-screen flex items-center justify-center bg-slate-900 text-white">
                <div class="text-center">
                    <h1 class="text-3xl font-bold mb-4">Acceso Restringido</h1>
                    <p class="mb-6">Debes iniciar sesión para acceder a Auditoría.</p>
                    <button onclick="window.location.href='index.html'" class="bg-blue-600 px-6 py-2 rounded-lg hover:bg-blue-700">Ir al Login Principal</button>
                </div>
            </div>
        `;
    }
});

function showAccessDenied(msg) {
    document.body.innerHTML = `
        <div class="h-screen flex items-center justify-center bg-slate-900 text-white">
            <div class="text-center max-w-md p-6 bg-slate-800 rounded-lg border border-red-500">
            <div class="text-5xl mb-4">⛔</div>
            <h1 class="text-2xl font-bold mb-4 text-red-500">Acceso Denegado</h1>
            <p class="mb-6 text-slate-300">${msg}</p>
            <button onclick="window.history.back()" class="bg-slate-700 px-6 py-2 rounded-lg hover:bg-slate-600">Regresar</button>
        </div>
        </div >
    `;
}

// --- FUNCIONES DE AUDITORÍA (Modal) ---
let activeAuditId = null;

window.auditarOperacion = (id) => {
    console.log("Auditar:", id);
    activeAuditId = id;
    const op = AuditState.operaciones.find(o => o.id === id);

    // Buscar solicitud asociada
    // Nota: Asumimos que la solicitud tiene 'operacionId' o que podemos cruzar datos.
    // Si no tienes 'operacionId' directo, tendrás que buscar por el ID del doc si es 1:1, 
    // o por algún otro campo único. Aquí asumimos operacionId.
    const sol = AuditState.solicitudes.find(s => s.operacionId === id) || {};

    openAuditModal(op, sol);
};

window.verDetalles = (id) => {
    // Redirigir a la misma lógica de auditoría pero quizás en modo lectura (por ahora igual)
    window.auditarOperacion(id);
};

function openAuditModal(op, sol) {
    const modal = document.getElementById('audit-modal');
    if (!modal) return;

    // 1. Header
    document.getElementById('modal-title').innerHTML = `
        <div class="flex items-center gap-2">
            <span>Auditoría: ${op.folio || op.solicitante}</span>
            <span class="text-xs bg-slate-700 px-2 py-1 rounded text-slate-300 font-mono">${op.id}</span>
        </div>
    `;

    // 2. Info Grid (MACRO VIEW)
    const infoGrid = document.getElementById('modal-info-grid');

    // Helpers para datos
    const fTime = (ts) => {
        if (!ts) return '-';
        const d = ts.toDate ? ts.toDate() : new Date(ts);
        return isNaN(d) ? '-' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    // Construcción de secciones
    const renderField = (label, value, isMono = false) => `
        <div class="mb-2">
            <p class="text-[10px] uppercase text-slate-500 font-bold tracking-wider">${label}</p>
            <p class="text-sm text-slate-200 ${isMono ? 'font-mono' : ''} truncate">${value || '-'}</p>
        </div>
    `;

    infoGrid.className = "grid grid-cols-1 gap-4"; // Contenedor principal columnas

    infoGrid.innerHTML = `
        <!-- SECCIÓN A: RESUMEN FINANCIERO -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 bg-slate-900/50 p-4 rounded-lg border border-slate-700">
            <div>${renderField('Solicitante', op.solicitante)}</div>
            <div>${renderField('Cliente Final', sol.cliente)}</div>
            <div>${renderField('Cuenta / Banco', sol.banco || op.operadora)}</div>
            <div>
                <p class="text-[10px] uppercase text-slate-500 font-bold tracking-wider">IMPORTE TOTAL</p>
                <p class="text-xl font-bold text-emerald-400">$${op.importe.toLocaleString('en-US')}</p>
            </div>
        </div>

        <!-- SECCIÓN B: MACRO DATOS OPERATIVOS -->
        <div class="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <h4 class="text-xs font-bold text-blue-400 uppercase mb-3 border-b border-slate-700 pb-2"><i class="fas fa-microchip mr-2"></i>Macro Datos de la Operación</h4>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2">
                
                <!-- Col 1: Clasificación -->
                <div class="space-y-1">
                    ${renderField('Esquema', op.esquema)}
                    ${renderField('Tipo Nómina', sol.tipo_nomina || op.tipo_operacion)}
                </div>

                <!-- Col 2: Control -->
                <div class="space-y-1">
                    ${renderField('Retorno', op.retorno)}
                    ${renderField('Método Pago', sol.metodo_pago)}
                </div>

                <!-- Col 3: Operativa -->
                <div class="space-y-1">
                    ${renderField('Operadora', op.operadora)}
                    ${renderField('Emite (Operador)', sol.emite || op.numeroOperador)}
                </div>

                <!-- Col 4: Tiempos -->
                <div class="space-y-1">
                    ${renderField('Hr. Autorizado', fTime(sol.autorizadoTimestamp))}
                    ${renderField('Hr. Completado', fTime(sol.completadoTimestamp))}
                </div>
            </div>
        </div>
    `;

    // 3. Conceptos
    const conceptsList = document.getElementById('modal-concepts-list');
    conceptsList.innerHTML = '';

    // Usar conceptosGuardados si existe, o conceptos normal
    const conceptos = sol.conceptosGuardados && sol.conceptosGuardados.length > 0
        ? sol.conceptosGuardados
        : sol.conceptos || [];

    if (conceptos.length === 0) {
        conceptsList.innerHTML = `<tr><td colspan="2" class="px-3 py-4 text-center text-sm text-gray-500">Sin detalles de conceptos</td></tr>`;
    } else {
        conceptos.forEach(c => {
            // Manejar estructura {ID, NOMBRE, CANTIDAD} o strings simples
            let nombre = c.NOMBRE || c.nombre || c;
            let cantidad = c.CANTIDAD || c.cantidad || 0;
            // Datos extra de cuenta si existen
            let extra = '';
            if (c.NUMERO_CUENTA) extra += `<div class="text-xs text-slate-500 font-mono">${c.NUMERO_CUENTA}</div>`;
            if (c.NUMERO_EMPLEADO) extra += `<div class="text-xs text-slate-500">Emp: ${c.NUMERO_EMPLEADO}</div>`;


            // Si es un objeto complejo sin cantidad explícita, tratar de mostrar algo
            if (typeof c === 'string') {
                nombre = c;
                cantidad = '-';
            }

            conceptsList.innerHTML += `
                <tr>
                    <td class="px-3 py-2 text-sm text-white">
                        <div class="font-medium">${nombre}</div>
                        ${extra}
                    </td>
                    <td class="px-3 py-2 text-sm text-white text-right font-mono">${typeof cantidad === 'number' ? '$' + cantidad.toLocaleString() : cantidad}</td>
                </tr>
            `;
        });
    }

    // 3.5 Dispersiones (NUEVO)
    // Si existen dispersiones multiples, las mostramos. Si no, o es array vacio, no mostramos.
    if (sol.dispersiones && sol.dispersiones.length > 0) {
        // Crear contenedor si no existe (hacky insert after concepts)
        // Lo agregamos al final del infoGrid temporalmente o manipulamos el DOM del modal
        // Mejor opción para este refactor simple: agregarlo como una fila más en conceptsList o una tabla separada
        // Vamos a inyectarlo en infoGrid al final para no romper la estructura fija del HTML base si no queremos editar HTML
        // EDIT: El HTML base tiene secciones fijas. Vamos a reutilizar el espacio de Conceptos o inyectar dinamicamente.
        // Dado que solo controlamos el contenido inyectado, podemos agregar la tabla de dispersiones AQUI mismo al final de conceptsList 
        // como una fila especial o header.

        // Mejor estrategia: agregar una fila de título y luego las dispersiones
        conceptsList.innerHTML += `
            <tr><td colspan="2" class="bg-slate-800 px-3 py-2 text-xs font-bold text-blue-400 uppercase tracking-wider border-t border-slate-700 mt-4">
                <i class="fas fa-exchange-alt mr-2"></i>Desglose de Dispersiones
            </td></tr>
        `;

        sol.dispersiones.forEach(d => {
            conceptsList.innerHTML += `
                <tr class="bg-slate-800/30">
                    <td class="px-3 py-2 text-sm text-slate-300">
                        ${d.fuente || 'Fuente Desconocida'} 
                        <span class="text-xs text-slate-500 ml-2">${d.fecha || ''}</span>
                    </td>
                    <td class="px-3 py-2 text-sm text-slate-300 text-right font-mono">$${parseFloat(d.monto || 0).toLocaleString()}</td>
                </tr>
            `;
        });
    }

    // 4. Evidencia
    const evidenceGrid = document.getElementById('modal-evidence-grid');
    evidenceGrid.innerHTML = '';

    const evidencias = [];

    // Recolectar todas las evidencias en un array plano
    // 1. Comprobante Pago (Legacy singular)
    if (sol.comprobanteUrl) evidencias.push({ type: 'img', url: sol.comprobanteUrl, label: 'Comp. Pago' });

    // 2. Comprobante Tesorería (Singular o Array)
    if (sol.comprobanteTesoreriaURL) {
        evidencias.push({ type: 'img', url: sol.comprobanteTesoreriaURL, label: 'Tesorería' });
    }
    if (sol.comprobanteTesoreriaURLs && Array.isArray(sol.comprobanteTesoreriaURLs)) {
        sol.comprobanteTesoreriaURLs.forEach((url, i) => evidencias.push({ type: 'img', url: url, label: `Tesorería ${i + 1}` }));
    }

    // 3. Comprobantes Ejecutivo (comprobanteURLs) - NUEVO
    if (sol.comprobanteURLs && Array.isArray(sol.comprobanteURLs)) {
        sol.comprobanteURLs.forEach((url, i) => evidencias.push({ type: 'img', url: url, label: `Ejecutivo ${i + 1}` }));
    }

    // 4. Evidencia Móvil
    if (sol.mobileEvidence) {
        sol.mobileEvidence.forEach((ev, i) => evidencias.push({ type: 'img', url: ev.url, label: `Móvil ${i + 1}` }));
    }

    if (evidencias.length === 0) {
        evidenceGrid.innerHTML = `<p class="col-span-4 text-center text-gray-500 py-4">No se encontró evidencia adjunta.</p>`;
    } else {
        evidencias.forEach(ev => {
            const isImg = isImage(ev.url);

            let contentHtml = '';
            if (isImg) {
                contentHtml = `<img src="${ev.url}" alt="${ev.label}" class="object-cover w-full h-full opacity-80 group-hover:opacity-100 transition-opacity">`;
            } else {
                contentHtml = `
                    <div class="w-full h-full flex flex-col items-center justify-center bg-slate-800 group-hover:bg-slate-700 transition-colors">
                        ${getFileIcon(ev.url)}
                        <span class="text-[10px] text-slate-400 mt-2 uppercase font-bold">Ver Archivo</span>
                    </div>
                `;
            }

            evidenceGrid.innerHTML += `
                <a href="${ev.url}" target="_blank" class="group relative block aspect-square bg-slate-900 rounded-lg overflow-hidden border border-slate-600 hover:border-blue-500 transition-all">
                    ${contentHtml}
                    <div class="absolute bottom-0 left-0 right-0 bg-black bg-opacity-70 p-1 text-center">
                        <span class="text-xs text-white truncate px-1">${ev.label}</span>
                    </div>
                </a>
            `;
        });
    }

    // ==========================================
    // 7. DASHBOARD INTERACTIONS (NUEVO)
    // ==========================================

    // --- DRAWER ACLARACIONES ---
    window.toggleAclaracionesDrawer = (show) => {
        const drawer = document.getElementById('aclaraciones-drawer');
        const overlay = document.getElementById('audit-modal'); // Reusamos u overlay nuevo si queremos

        if (!drawer) return;

        if (show) {
            drawer.classList.remove('translate-x-full');
            renderDrawerContent();
        } else {
            drawer.classList.add('translate-x-full');
        }
    };

    function renderDrawerContent() {
        const container = document.getElementById('drawer-aclaraciones-list');
        if (!container) return;

        // Obtener aclaraciones abiertas
        const openAcls = AuditState.aclaraciones.filter(a => a.status !== 'cerrada').sort((a, b) => b.createdAt - a.createdAt);

        container.innerHTML = '';

        if (openAcls.length === 0) {
            container.innerHTML = `<div class="text-center text-slate-500 py-10">No hay aclaraciones pendientes. 🎉</div>`;
            return;
        }

        openAcls.forEach(acl => {
            const op = acl.operationSnapshot || {};
            const card = document.createElement('div');
            card.className = "bg-slate-800 p-3 rounded border border-slate-700 hover:border-yellow-500/50 cursor-pointer transition-colors";
            card.onclick = () => window.openAclaracion(acl.operationId);

            card.innerHTML = `
            <div class="flex justify-between items-center mb-1">
                <span class="text-[10px] font-bold uppercase bg-yellow-900 text-yellow-200 px-1.5 rounded">${acl.status}</span>
                <span class="text-[10px] text-slate-400">${acl.createdAt.toLocaleDateString()}</span>
            </div>
            <div class="font-bold text-slate-200 text-sm mb-1">${op.solicitante || 'S/N'}</div>
            <div class="text-xs text-slate-400 mb-2">Folio: ${op.folio || '-'}</div>
            <div class="text-xs text-slate-300 italic truncate">"${acl.motivo}"</div>
        `;
            container.appendChild(card);
        });
    }

    // --- KPI FILTERS (AUDITADAS HOY) ---
    window.filterAuditadasHoy = () => {
        // 1. Resetear filtros visuales
        const startInput = document.getElementById('filter-date-start');
        const endInput = document.getElementById('filter-date-end');
        const statusInput = document.getElementById('filter-status');
        const weekInput = document.getElementById('filter-week');

        // Hoy
        const today = new Date();
        const loc = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

        // ESTABLECER ESTADO INTERNO ESPECIAL O SIMPLEMENTE USAR LOS FILTROS
        // Para simplificar, configuramos los inputs para que coincidan con "Auditadas Hoy"

        if (startInput) startInput.value = loc; // Inicio Hoy
        if (endInput) endInput.value = loc; // Fin Hoy
        if (statusInput) statusInput.value = ''; // Cualquier status (pero filtraremos por 'auditado'=true en lógica o visualmente)
        if (weekInput) weekInput.value = '';

        // Hack: Forzar filtrado manual de "Auditadas" ya que 'auditado' no es un filtro del select estandar (status es de operacion)
        // Vamos a modificar applyFilters para soportar un modo especial o hacerlo aqui directo

        // Mejor: Filtrar manual y renderizar timeline directo
        const auditadasHoy = AuditState.operaciones.filter(op => {
            if (!op.auditado || !op.fechaAuditoria) return false;
            // Checar si fechaAuditoria es hoy
            const fAud = op.fechaAuditoria.toDate ? op.fechaAuditoria.toDate() : new Date(op.fechaAuditoria);
            return fAud.toISOString().split('T')[0] === loc;
        });

        console.log(`🔍 Filtrando Auditadas Hoy: ${auditadasHoy.length}`);
        renderTimeline(auditadasHoy);

        // Feedback visual
        const container = document.getElementById('timeline-container');
        if (container) {
            container.insertAdjacentHTML('afterbegin', `
            <div class="bg-emerald-900/30 border border-emerald-500/50 text-emerald-300 px-4 py-2 rounded mb-4 flex justify-between items-center animate-fade-in">
                <span><i class="fas fa-check-circle mr-2"></i>Mostrando <b>${auditadasHoy.length}</b> operaciones auditadas hoy</span>
                <button onclick="applyFilters()" class="text-xs underline hover:text-white">Ver Todo</button>
            </div>
         `);
        }
    };

    // Mostrar modal
    modal.classList.remove('hidden');
}

// ==========================================
// 7. DASHBOARD INTERACTIONS (HELPER FUNCTIONS)
// ==========================================

// --- DRAWER ACLARACIONES ---
// --- DRAWER ACLARACIONES ---
window.toggleAclaracionesDrawer = (show) => {
    const drawer = document.getElementById('aclaraciones-drawer');
    const overlay = document.getElementById('drawer-overlay');

    if (!drawer) return;

    if (show) {
        drawer.classList.remove('translate-x-full');
        if (overlay) overlay.classList.remove('hidden');
        renderDrawerContent();
        document.addEventListener('keydown', handleEscClose);
    } else {
        drawer.classList.add('translate-x-full');
        if (overlay) overlay.classList.add('hidden');
        document.removeEventListener('keydown', handleEscClose);
    }
};

const handleEscClose = (e) => {
    if (e.key === 'Escape') toggleAclaracionesDrawer(false);
};

function renderDrawerContent() {
    const contAcl = document.getElementById('drawer-aclaraciones-list');
    const contQueue = document.getElementById('drawer-audit-queue');
    const badgeAcl = document.getElementById('badge-aclaraciones-count');
    const badgeQueue = document.getElementById('badge-queue-count');

    if (!contAcl || !contQueue) return;

    contAcl.innerHTML = '';
    contQueue.innerHTML = '';

    // 1. TOP: Aclaraciones Abiertas
    const openAcls = AuditState.aclaraciones.filter(a => a.status !== 'cerrada').sort((a, b) => b.createdAt - a.createdAt);

    if (badgeAcl) badgeAcl.innerText = openAcls.length;

    if (openAcls.length === 0) {
        contAcl.innerHTML = `<div class="text-center text-slate-600 py-6 text-xs italic">Nada por aclarar. ¡Buen trabajo! 🌟</div>`;
    } else {
        openAcls.forEach(acl => {
            const op = acl.operationSnapshot || {};
            const card = document.createElement('div');
            card.className = "bg-slate-800 p-3 rounded border border-yellow-900/30 hover:border-yellow-500/50 cursor-pointer transition-colors group relative";
            card.onclick = () => window.openAclaracion(acl.operationId);

            card.innerHTML = `
                <div class="flex justify-between items-center mb-1">
                    <span class="text-[9px] font-bold uppercase bg-yellow-900 text-yellow-200 px-1.5 rounded">${acl.status}</span>
                    <span class="text-[9px] text-slate-500">${acl.createdAt.toLocaleDateString()}</span>
                </div>
                <div class="font-bold text-slate-200 text-xs mb-0.5 truncate">${op.solicitante || 'S/N'}</div>
                <div class="text-[10px] text-slate-400">Folio: ${op.folio || '-'}</div>
                <div class="text-[10px] text-slate-300 italic truncate mt-1 text-yellow-100/70 border-l-2 border-yellow-700 pl-2">"${acl.motivo}"</div>
                <i class="fas fa-external-link-alt absolute top-3 right-3 text-slate-600 group-hover:text-yellow-400 text-xs"></i>
            `;
            contAcl.appendChild(card);
        });
    }

    // 2. BOTTOM: Cola de Auditoría (Pendientes clean)
    // Filtramos operaciones que: NO estan auditadas, NO están canceladas, y NO tienen aclaracion abierta
    const openAclIds = new Set(openAcls.map(a => a.operationId));

    // Sort por fecha ascendente (FIFO: First In First Out - Lo más viejo primero para auditar)
    // O Descendente (LIFO)? Normalmente Auditoria prefiere lo reciente? O barrer lo viejo?
    // Vamos por Fecha Descendente (Lo más reciente arriba) por conveniencia UI

    const pendingOps = AuditState.operaciones
        .filter(op =>
            !op.auditado &&
            op.status !== 'cancelado' &&
            op.status !== 'conciliado' &&
            !openAclIds.has(op.id)
        )
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
        .slice(0, 20); // Top 20

    if (badgeQueue) badgeQueue.innerText = pendingOps.length + (pendingOps.length === 20 ? '+' : '');

    if (pendingOps.length === 0) {
        contQueue.innerHTML = `<div class="text-center text-slate-600 py-6 text-xs italic">Todo auditado. 🎉</div>`;
    } else {
        pendingOps.forEach(op => {
            const card = document.createElement('div');
            card.className = "bg-slate-800 p-3 rounded border border-slate-700 hover:border-blue-500/50 cursor-pointer transition-colors group relative border-l-2 border-l-blue-500/50";
            // Al hacer click, ¿abrir audit modal directo?
            // Necesita data en memoria. La tenemos.
            card.onclick = () => {
                window.activeAuditId = op.id; // Global state used by modal
                // El modal se popula en 'auditarOperacion(id)'
                window.auditarOperacion(op.id);
                // Cerrar drawer? O dejarlo abierto para flujo rapido?
                // Mejor cerrar para espacio
                // toggleAclaracionesDrawer(false); 
                // NO, dejar abierto permite contexto. Pero el modal es overlay.
            };

            const isAutorizado = op.status === 'autorizado';
            const statusColor = isAutorizado ? 'text-blue-400' : 'text-slate-500';

            card.innerHTML = `
                <div class="flex justify-between items-center mb-1">
                     <span class="text-[9px] font-bold uppercase text-slate-500">${op.fecha}</span>
                     <span class="font-mono text-emerald-400 text-xs font-bold">$${op.importe.toLocaleString()}</span>
                </div>
                <div class="font-bold text-slate-200 text-xs mb-0.5 truncate">${op.solicitante}</div>
                <div class="text-[10px] text-slate-400 flex justify-between">
                    <span>${op.ejecutivo}</span>
                    <span class="uppercase ${statusColor}">${op.status}</span>
                </div>
                <i class="fas fa-play-circle absolute top-4 right-3 text-slate-700 group-hover:text-blue-400 text-lg transition-colors"></i>
            `;
            contQueue.appendChild(card);
        });
    }
}

// --- HELPERS VISUALES ---
function getStatusColor(status) {
    const s = (status || '').toLowerCase();
    switch (s) {
        case 'abierta':
        case 'activo':
        case 'active':
            return { bg: 'bg-emerald-900', text: 'text-emerald-300' };
        case 'cerrada':
        case 'completado':
        case 'auditado':
            return { bg: 'bg-slate-700', text: 'text-slate-400' };
        case 'en_proceso':
            return { bg: 'bg-blue-900', text: 'text-blue-300' };
        case 'pendiente_respuesta':
        case 'pendiente':
        case 'pre-orden':
            return { bg: 'bg-yellow-900', text: 'text-yellow-300' };
        case 'cancelado':
            return { bg: 'bg-red-900', text: 'text-red-300' };
        default:
            return { bg: 'bg-slate-800', text: 'text-slate-500' };
    }
}

// --- RENDERIZADO: ACLARACIONES VIEW (MASTER-DETAIL) ---
window.renderAclaracionesView = function (aclaracionesData = null) {
    const listContainer = document.getElementById('aclaraciones-list');
    const detailPanel = document.getElementById('aclaraciones-detail-panel');
    const detailContainer = document.getElementById('aclaraciones-detail-container'); // O el mismo panel

    if (!listContainer) return;

    listContainer.innerHTML = '';

    // Si no hay funcion de detalle definida (fallo anterior), la definimos aqui mismo o reintentamos
    // Pero si este bloque se escribe, tendremos renderAclaracionDetail abajo.

    const acls = aclaracionesData || AuditState.aclaraciones;

    if (acls.length === 0) {
        listContainer.innerHTML = `<div class="text-center py-10 text-slate-500">No hay casos.</div>`;
        return;
    }

    const sortedAcls = [...acls].sort((a, b) => b.createdAt - a.createdAt);

    sortedAcls.forEach(acl => {
        const op = acl.operationSnapshot || {};

        const card = document.createElement('div');
        // Estilo 'List Item'
        const isSelected = window.selectedAclaracionId === acl.id;
        const activeClass = isSelected ? 'bg-blue-900/50 border-blue-500 ring-1 ring-blue-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700 hover:border-slate-500';

        // Compact styles
        card.className = `p-3 rounded cursor-pointer border transition-all mb-2 ${activeClass}`;

        card.onclick = () => {
            // Set Selected
            window.selectedAclaracionId = acl.id;
            renderAclaracionesView(acls); // Re-render list to update selection highlight
            if (typeof renderAclaracionDetail === 'function') {
                renderAclaracionDetail(acl);
            } else {
                console.error("renderAclaracionDetail not defined");
            }
        };

        const statusColor = getStatusColor(acl.status);

        card.innerHTML = `
            <div class="flex justify-between items-start mb-1">
                 <span class="text-[10px] font-bold uppercase ${statusColor.bg} ${statusColor.text} px-1.5 py-0.5 rounded">${acl.status}</span>
                 <span class="text-[10px] text-slate-400">${acl.createdAt.toLocaleDateString()}</span>
            </div>
            <h4 class="font-bold text-slate-200 text-sm truncate" title="${op.solicitante}">${op.solicitante || 'S/N'}</h4>
            <div class="text-xs text-slate-400 mb-1">Folio: ${op.folio || '-'}</div>
             <div class="text-xs text-slate-300 italic truncate border-l-2 border-slate-500 pl-2 opacity-80">"${acl.motivo}"</div>
        `;
        listContainer.appendChild(card);
    });
}


window.renderAclaracionDetail = function (acl) {
    const detailPanel = document.getElementById('aclaraciones-detail-panel');
    if (!detailPanel) return;

    // 1. Intentar obtener datos frescos de la operación en memoria
    let op = AuditState.operaciones.find(o => o.id === acl.operationId);

    // 2. Si no esta en memoria (raro, pero posible), usar snapshot guardado
    if (!op) {
        op = acl.operationSnapshot || {};
    }

    // 3. Obtener solicitud asociada
    const sol = AuditState.solicitudes.find(s => s.operacionId === acl.operationId) || {};

    // 4. Fallbacks de Strings
    const solicitanteName = op.solicitante || sol.cliente || 'Sin Nombre';
    const opTipo = op.tipo_operacion || 'Operación';
    const opFamilia = op.familia || 'General';
    const opStatus = (op.status || 'unknown').toUpperCase();
    const opImporte = (op.importe || 0).toLocaleString();

    const workflowHTML = generateWorkflowBar(sol, op.status);

    // Construir la tarjeta "timeline-style" pero mas grande/detallada
    detailPanel.className = "w-full lg:w-2/3 bg-slate-800 rounded-lg border border-slate-700 p-0 flex flex-col h-full"; // Reset padding

    // Header Panel
    const headerHTML = `
        <div class="bg-slate-900/50 p-4 border-b border-slate-700 flex justify-between items-center rounded-t-lg">
            <div>
                 <h2 class="text-xl font-bold text-white flex items-center gap-2">
                    <i class="fas fa-exclamation-triangle text-yellow-500"></i>
                    ${solicitanteName}
                 </h2>
                 <p class="text-sm text-slate-400">${opTipo} • ${opFamilia} • ID: ${acl.operationId}</p>
            </div>
            <div class="text-right">
                <div class="text-2xl font-mono font-bold text-emerald-400">$${opImporte}</div>
                <div class="text-xs text-slate-500 font-bold uppercase">${opStatus}</div>
            </div>
        </div>
    `;

    // --- GENERAR SECCION EVIDENCIA ---
    let evidenceHTML = '';
    const evidencias = [];

    // 1. Comprobante Pago (Legacy)
    if (sol.comprobanteUrl) evidencias.push({ type: 'img', url: sol.comprobanteUrl, label: 'Comp. Pago' });
    // 2. Tesorería
    if (sol.comprobanteTesoreriaURL) evidencias.push({ type: 'img', url: sol.comprobanteTesoreriaURL, label: 'Tesorería' });
    if (sol.comprobanteTesoreriaURLs && Array.isArray(sol.comprobanteTesoreriaURLs)) {
        sol.comprobanteTesoreriaURLs.forEach((url, i) => evidencias.push({ type: 'img', url: url, label: `Tesorería ${i + 1}` }));
    }
    // 3. Ejecutivo
    if (sol.comprobanteURLs && Array.isArray(sol.comprobanteURLs)) {
        sol.comprobanteURLs.forEach((url, i) => evidencias.push({ type: 'file', url: url, label: `Ejecutivo ${i + 1}` }));
    }
    // 4. Móvil
    if (sol.mobileEvidence && Array.isArray(sol.mobileEvidence)) {
        sol.mobileEvidence.forEach((ev, i) => evidencias.push({ type: 'img', url: ev.url, label: `Móvil ${i + 1}` }));
    }

    if (evidencias.length > 0) {
        let cards = '';
        evidencias.forEach(ev => {
            const isImg = isImage(ev.url);
            const content = isImg
                ? `<img src="${ev.url}" class="w-full h-20 object-cover opacity-80 group-hover:opacity-100 transition-opacity">`
                : `<div class="w-full h-20 flex items-center justify-center bg-slate-700">${getFileIcon(ev.url).replace('text-4xl', 'text-2xl')}</div>`;

            cards += `
                <a href="${ev.url}" target="_blank" class="block bg-slate-900 rounded border border-slate-600 overflow-hidden hover:border-blue-500 transition-colors group relative" title="${ev.label}">
                    ${content}
                    <div class="px-2 py-1 text-[10px] text-slate-300 truncate bg-slate-800 border-t border-slate-700 group-hover:text-white group-hover:bg-blue-900/50">${ev.label}</div>
                </a>
             `;
        });

        evidenceHTML = `
            <div class="mb-6">
                <h3 class="text-xs font-bold text-slate-500 uppercase mb-2">Evidencia Adjunta (${evidencias.length})</h3>
                <div class="grid grid-cols-4 gap-3">
                    ${cards}
                </div>
            </div>
        `;
    } else {
        evidenceHTML = `
             <div class="mb-6 p-3 bg-slate-800/50 border border-slate-700/50 rounded text-center">
                <p class="text-xs text-slate-500 italic">Sin evidencia adjunta.</p>
             </div>
        `;
    }

    // Body
    const bodyHTML = `
        <div class="p-6 flex-1 overflow-y-auto">
             <!-- Status Aclaracion -->
             <div class="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4 mb-6">
                <h3 class="text-sm font-bold text-yellow-500 mb-2 uppercase tracking-wide">Detalle de Aclaración</h3>
                <p class="text-slate-300 text-lg italic mb-2">"${acl.motivo}"</p>
                
                <div class="grid grid-cols-2 gap-4 text-sm mt-4 border-t border-yellow-700/30 pt-3">
                    <div>
                        <span class="text-slate-500 block text-xs">Prioridad</span>
                        <span class="text-white font-bold">${acl.priority || 'MEDIA'}</span>
                    </div>
                     <div>
                        <span class="text-slate-500 block text-xs">Fecha Reporte</span>
                        <span class="text-white font-bold">${acl.createdAt.toLocaleString()}</span>
                    </div>
                </div>
                 
                 <!-- Chat / Notas Preview -->
                 <div class="mt-4">
                    <button onclick="window.openAclaracion('${acl.operationId}')" class="text-xs bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded flex items-center gap-2 transition-colors">
                        <i class="fas fa-comments"></i> Ver Conversación / Editar
                    </button>
                 </div>
             </div>

             <!-- EVIDENCIA (INJECTED) -->
             ${evidenceHTML}

             <!-- Workflow -->
             <div class="mb-6">
                <h3 class="text-xs font-bold text-slate-500 uppercase mb-2">Progreso de Operación</h3>
                ${workflowHTML}
             </div>

             <!-- Info Grid -->
             <div class="grid grid-cols-3 gap-4 text-sm text-slate-300 bg-slate-700/30 p-4 rounded-lg">
                <div><i class="fas fa-calendar-alt mr-2 opacity-50"></i>${op.fecha || 'N/A'}</div>
                <div><i class="fas fa-building mr-2 opacity-50"></i>${op.operadora || 'N/A'}</div>
                <div><i class="fas fa-wallet mr-2 opacity-50"></i>${op.retorno || 'N/A'}</div>
            </div>
        </div>
    `;

    // Footer Actions
    const footerHTML = `
        <div class="bg-slate-800 p-4 border-t border-slate-700 flex justify-end gap-3 rounded-b-lg">
             <button onclick="window.openAclaracion('${acl.operationId}')" class="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded font-bold transition-colors">
                <i class="fas fa-edit mr-2"></i>Gestionar Aclaración
             </button>
             <button onclick="auditarOperacion('${acl.operationId}')" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold shadow-lg shadow-blue-900/20 transition-all transform hover:scale-105">
                <i class="fas fa-check-circle mr-2"></i>Auditar Ahora
             </button>
        </div>
    `;

    detailPanel.innerHTML = headerHTML + bodyHTML + footerHTML;

}

// --- KPI FILTERS (AUDITADAS HOY) ---
window.filterAuditadasHoy = () => {
    // 1. Resetear filtros visuales
    const startInput = document.getElementById('filter-date-start');
    const endInput = document.getElementById('filter-date-end');
    const statusInput = document.getElementById('filter-status');
    const weekInput = document.getElementById('filter-week');

    // Hoy
    const today = new Date();
    const loc = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

    if (startInput) startInput.value = loc; // Inicio Hoy
    if (endInput) endInput.value = loc; // Fin Hoy
    if (statusInput) statusInput.value = '';
    if (weekInput) weekInput.value = '';

    // Filtrar manual y renderizar timeline directo
    const auditadasHoy = AuditState.operaciones.filter(op => {
        if (!op.auditado || !op.fechaAuditoria) return false;
        // Checar si fechaAuditoria es hoy
        const fAud = op.fechaAuditoria.toDate ? op.fechaAuditoria.toDate() : new Date(op.fechaAuditoria);
        return fAud.toISOString().split('T')[0] === loc;
    });

    console.log(`🔍 Filtrando Auditadas Hoy: ${auditadasHoy.length}`);
    renderTimeline(auditadasHoy);

    // Feedback visual
    const container = document.getElementById('timeline-container');
    if (container) {
        container.insertAdjacentHTML('afterbegin', `
            <div class="bg-emerald-900/30 border border-emerald-500/50 text-emerald-300 px-4 py-2 rounded mb-4 flex justify-between items-center animate-fade-in">
                <span><i class="fas fa-check-circle mr-2"></i>Mostrando <b>${auditadasHoy.length}</b> operaciones auditadas hoy</span>
                <button onclick="applyFilters()" class="text-xs underline hover:text-white">Ver Todo</button>
            </div>
         `);
    }
};

// ==========================================
// 8. DASHBOARD INTERACTIONS (GLOBAL FIX)
// ==========================================
function setupDashboardInteractions() {
    console.log("🛠️ Configurando interacciones del Dashboard...");

    // KPI Aclaraciones
    const kpiAclEl = document.getElementById('kpi-aclaraciones');
    if (kpiAclEl) {
        const card = kpiAclEl.closest('.metric-card');
        if (card) {
            console.log("✅ KPI Aclaraciones detectado. Agregando click.");
            card.style.cursor = 'pointer';
            card.classList.add("hover:ring-2", "hover:ring-purple-500", "transition-all"); // Feedback visual
            card.onclick = (e) => {
                console.log("🖱️ Click en KPI Aclaraciones");
                e.stopPropagation();
                toggleAclaracionesDrawer(true);
            };
        } else {
            console.warn("⚠️ No se encontró la tarjeta padre para KPI Aclaraciones");
        }
    }

    // KPI Auditadas (Total Ops como proxy)
    const kpiTotalEl = document.getElementById('kpi-total-ops');
    if (kpiTotalEl) {
        const card = kpiTotalEl.closest('.metric-card');
        if (card) {
            console.log("✅ KPI Total detectado. Agregando click.");
            card.style.cursor = 'pointer';
            card.classList.add("hover:ring-2", "hover:ring-blue-500", "transition-all"); // Feedback visual
            card.title = "Click para ver operaciones auditadas HOY";
            card.onclick = (e) => {
                console.log("🖱️ Click en KPI Total");
                filterAuditadasHoy();
            };
        }
    }
}

// Asegurarnos que se llame cuando el DOM esté listo o al iniciar
document.addEventListener('DOMContentLoaded', setupDashboardInteractions);
// También llamarlo explícitamente por si el script corre después de DOMContentLoaded
setTimeout(setupDashboardInteractions, 1000); // Pequeño delay de cortesía para asegurar render


window.closeAuditModal = () => {
    document.getElementById('audit-modal').classList.add('hidden');
    activeAuditId = null;
};

window.confirmarAuditoria = () => {
    if (!activeAuditId) return;
    if (confirm("¿Confirmar que esta operación ha sido REVISADA? Se marcará como auditada y se cerrarán las aclaraciones pendientes.")) {

        const batch = db.batch();

        // 1. Actualizar Operación
        const opRef = db.collection('operaciones').doc(activeAuditId);
        batch.update(opRef, {
            auditado: true,
            auditadopor: AuditState.currentUser.email,
            fechaAuditoria: new Date()
        });

        // 2. Buscar y Cerrar Aclaración asociada si existe
        const aclRef = db.collection('aclaraciones').doc(activeAuditId);
        const existingAcl = AuditState.aclaraciones.find(a => a.operationId === activeAuditId);

        if (existingAcl && existingAcl.status !== 'cerrada') {
            batch.update(aclRef, {
                status: 'cerrada',
                closedAt: new Date(),
                notas: (existingAcl.notas || '') + '\n[AUTO] Cerrada al conciliar/auditar operación.'
            });
        }

        batch.commit().then(() => {
            alert("Operación marcada como AUDITADA y aclaraciones actualizadas.");
            closeAuditModal();
        }).catch(err => {
            console.error(err);
            alert("Error al actualizar: " + err.message);
        });
    }
};

window.reportarIssue = () => {
    if (!activeAuditId) return;
    const motivo = prompt("Describe el problema o razón del rechazo:");
    if (motivo) {
        db.collection('operaciones').doc(activeAuditId).update({
            status: 'issue', // O 'rechazado'
            issueMotivo: motivo,
            auditadopor: AuditState.currentUser.email,
            fechaAuditoria: new Date()
        }).then(() => {
            alert("Issue reportado correctamente.");
            closeAuditModal();
        }).catch(err => {
            console.error(err);
            alert("Error al actualizar.");
        });
    }
};

// ==========================================
// 6. MODULE: ACLARACIONES (NUEVO)
// ==========================================

// --- RENDERIZADO: LISTA DE ACLARACIONES ---
// --- RENDERIZADO: LISTA DE ACLARACIONES (CON FILTROS) ---
window.renderAclaracionesView = function (aclaracionesData = null) {
    const container = document.getElementById('aclaraciones-list');
    if (!container) return;

    const statusFilter = document.getElementById('filter-aclaracion-status').value;
    const priorityFilter = document.getElementById('filter-aclaracion-priority').value;
    const searchFilter = (document.getElementById('filter-aclaracion-search').value || '').toLowerCase();

    // Filtrar
    const filtered = (aclaracionesData || AuditState.aclaraciones).filter(acl => {
        const matchesStatus = !statusFilter || acl.status === statusFilter;
        const matchesPriority = !priorityFilter || acl.priority === priorityFilter;

        const opData = acl.operationSnapshot || {};
        const searchText = `${opData.solicitante || ''} ${opData.folio || ''} ${acl.motivo || ''}`.toLowerCase();
        const matchesSearch = !searchFilter || searchText.includes(searchFilter);

        return matchesStatus && matchesPriority && matchesSearch;
    });

    container.innerHTML = '';

    if (filtered.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-500 py-8">No se encontraron aclaraciones.</p>';
        return;
    }

    // Ordenar (Más recientes primero)
    const sortedAcls = [...filtered].sort((a, b) => b.createdAt - a.createdAt);

    sortedAcls.forEach(acl => {
        const op = acl.operationSnapshot || {};
        const statusColor = getStatusColor(acl.status);

        const card = document.createElement('div');
        const isSelected = window.selectedAclaracionId === acl.id;
        const activeClass = isSelected ? 'bg-blue-900/50 border-blue-500 ring-1 ring-blue-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700 hover:border-slate-500';

        card.className = `p-4 rounded cursor-pointer border transition-all mb-3 ${activeClass}`;

        card.onclick = () => {
            window.selectedAclaracionId = acl.id;
            window.renderAclaracionesView(aclaracionesData);
            if (typeof window.renderAclaracionDetail === 'function') {
                window.renderAclaracionDetail(acl);
            }
        };

        card.innerHTML = `
            <div class="flex justify-between items-start mb-2">
                 <span class="text-[10px] font-bold uppercase ${statusColor.bg} ${statusColor.text} px-2 py-0.5 rounded">${acl.status.replace('_', ' ')}</span>
                 <span class="text-[10px] text-slate-400">${acl.createdAt.toLocaleDateString()}</span>
            </div>
            <h4 class="font-bold text-slate-200 text-sm truncate">${op.solicitante || 'Sin Cliente'}</h4>
            <div class="text-xs text-slate-400 mb-2">Folio: ${op.folio || 'S/N'} • $${(op.importe || 0).toLocaleString()}</div>
            <div class="text-xs text-slate-300 italic truncate border-l-2 border-slate-500 pl-2 opacity-80">"${acl.motivo}"</div>
        `;
        container.appendChild(card);
    });
};

// --- EXPORTAR REPORTE A EXCEL ---
window.exportAclaracionesReport = function () {
    console.log("📊 Generando Reporte Excel de Aclaraciones...");

    // 0. Verificar librería
    if (typeof XLSX === 'undefined') {
        alert("❌ Error: La librería de Excel (SheetJS) no se ha cargado correctamente. Por favor recarga la página.");
        console.error("Critical: XLSX is undefined.");
        return;
    }

    try {
        // 1. Obtener datos filtrados (los mismos que se ven en pantalla)
        const statusFilter = document.getElementById('filter-aclaracion-status')?.value;
        const priorityFilter = document.getElementById('filter-aclaracion-priority')?.value;
        const searchFilter = (document.getElementById('filter-aclaracion-search')?.value || '').toLowerCase();

        const filtered = AuditState.aclaraciones.filter(acl => {
            const matchesStatus = !statusFilter || acl.status === statusFilter;
            const matchesPriority = !priorityFilter || acl.priority === priorityFilter;
            const opData = acl.operationSnapshot || {};
            const searchText = `${opData.solicitante || ''} ${opData.folio || ''} ${acl.motivo || ''}`.toLowerCase();
            return matchesStatus && matchesPriority && searchText.includes(searchFilter); // Fix original 'matchesSearch' reference error?
            // NOTE: Original code had 'matchesSearch' undefined in logic above if I recall correctly, checking previous content...
            // "return matchesStatus && matchesPriority && matchesSearch;" -> matchesSearch was expected to be defined.
            // In my read output it was: "const matchesSearch = !searchFilter || searchText.includes(searchFilter);" 
            // Wait, let's look at the read output closely.
            // Line 1799: return matchesStatus && matchesPriority && matchesSearch;
            // Line 1739: const matchesSearch = ...
            // Ah, the previous READ showed it was defined in renderAclaracionesView but let's check exportAclaracionesReport in the previous READ.
            // Line 1799 in exportAclaracionesReport uses matchesSearch but it was NOT defined in the map provided in the READ?
            // Let's re-read the READ output for exportAclaracionesReport (Line 1786).
            // Line 1798: const searchText = ...
            // Line 1799: return matchesStatus && matchesPriority && matchesSearch;
            // 'matchesSearch' is NOT DEFINED in exportAclaracionesReport in the previous read block! It was copypasted from render but missed that line?
            // Wait, checking line 1798 in READ output:
            // 1798:         const searchText = `${opData.solicitante || ''} ${opData.folio || ''} ${acl.motivo || ''}`.toLowerCase();
            // 1799:         return matchesStatus && matchesPriority && matchesSearch;
            // YES! matchesSearch is undefined here. That is likely the bug.
        });

        if (filtered.length === 0) {
            alert("No hay datos para exportar con los filtros actuales.");
            return;
        }

        // 2. Mapear datos para Excel
        const excelData = filtered.map(acl => {
            const snap = acl.operationSnapshot || {};
            return {
                'ID Operación': acl.operationId,
                'Fecha Reporte': acl.createdAt ? (acl.createdAt.toLocaleString ? acl.createdAt.toLocaleString() : acl.createdAt) : '-',
                'Estatus': (acl.status || '').toUpperCase(),
                'Prioridad': (acl.priority || '').toUpperCase(),
                'Solicitante': snap.solicitante || '-',
                'Importe': snap.importe || 0,
                'Moneda': snap.moneda || 'MXN',
                'Folio': snap.folio || '-',
                'Motivo': acl.motivo || '-',
                'Notas de Auditoría': acl.notas || '-',
                'Ejecutivo': snap.ejecutivo || '-',
                'Operadora': snap.operadora || '-',
                'Esquema': snap.esquema || '-',
                'Fecha Cierre': acl.closedAt ? (acl.closedAt.toLocaleString ? acl.closedAt.toLocaleString() : acl.closedAt) : 'PENDIENTE'
            };
        });

        // 3. Crear Libro y Hoja
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(excelData);

        // Configurar anchos de columna
        const wscols = [
            { wch: 15 }, { wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 25 },
            { wch: 12 }, { wch: 8 }, { wch: 15 }, { wch: 25 }, { wch: 40 },
            { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 20 }
        ];
        ws['!cols'] = wscols;

        XLSX.utils.book_append_sheet(wb, ws, "Aclaraciones");

        // 4. Descargar
        const fileName = `Reporte_Aclaraciones_${new Date().toISOString().split('T')[0]}.xlsx`;
        XLSX.writeFile(wb, fileName);
        console.log(`✅ Archivo ${fileName} generado.`);

    } catch (error) {
        console.error("Error exportando a Excel:", error);
        alert("Hubo un error al generar el reporte: " + error.message);
    }
};

// --- ENVIAR REPORTE POR EMAIL (WEBHOOK AUTOMATION) ---
window.sendEmailReport = async function () {
    // 1. Obtener datos filtrados
    const statusFilter = document.getElementById('filter-aclaracion-status').value;
    const priorityFilter = document.getElementById('filter-aclaracion-priority').value;
    const searchFilter = (document.getElementById('filter-aclaracion-search').value || '').toLowerCase();

    const filtered = AuditState.aclaraciones.filter(acl => {
        const matchesStatus = !statusFilter || acl.status === statusFilter;
        const matchesPriority = !priorityFilter || acl.priority === priorityFilter;
        const opData = acl.operationSnapshot || {};
        const searchText = `${opData.solicitante || ''} ${opData.folio || ''} ${acl.motivo || ''}`.toLowerCase();
        return matchesStatus && matchesPriority && searchText.includes(searchFilter);
    });

    if (filtered.length === 0) {
        alert("No hay datos para enviar.");
        return;
    }

    if (!confirm(`¿Deseas enviar este reporte (${filtered.length} registros) por correo electrónico?`)) return;

    const btn = document.getElementById('btn-email-aclaraciones');
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
    btn.disabled = true;

    try {
        // Mapear datos simplificados para el webhook
        const reportData = filtered.map(acl => ({
            id: acl.operationId,
            fecha: acl.createdAt ? acl.createdAt.toLocaleString() : '-',
            status: acl.status,
            prioridad: acl.priority,
            solicitante: acl.operationSnapshot?.solicitante || '-',
            importe: acl.operationSnapshot?.importe || 0,
            motivo: acl.motivo
        }));

        const WEBHOOK_URL = window.ACLARACIONES_WEBHOOK_URL || '';

        if (!WEBHOOK_URL) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            alert("⚠️ No hay URL de Webhook configurada.");
        } else {
            console.log("🚀 Enviando a:", WEBHOOK_URL);

            // Controller para el timeout (10 segundos)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(WEBHOOK_URL, {
                method: 'POST',
                mode: 'cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'aclaraciones_report',
                    sentBy: AuditState.currentUser?.email || 'Sistema',
                    timestamp: new Date().toISOString(),
                    count: filtered.length,
                    data: reportData
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                alert("✅ ¡Reporte enviado con éxito al flujo de n8n!");
            } else {
                const errorText = await response.text();
                throw new Error(`Error ${response.status}: ${errorText || 'Sin respuesta del servidor'}`);
            }
        }
    } catch (error) {
        console.error("❌ Error en fetch n8n:", error);
        let msg = "Error al enviar: " + error.message;
        if (error.name === 'AbortError') msg = "⏳ Tiempo de espera agotado. ¿Está n8n escuchando en modo Test?";
        if (error.message.includes('Failed to fetch')) msg = "🚫 Error de conexión. El navegador podría estar bloqueando el acceso a localhost (HTTPS -> HTTP).";
        alert(msg);
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
};

// Listeners Filtros Aclaraciones
document.getElementById('filter-aclaracion-status')?.addEventListener('change', () => window.renderAclaracionesView());
document.getElementById('filter-aclaracion-priority')?.addEventListener('change', () => window.renderAclaracionesView());
document.getElementById('filter-aclaracion-search')?.addEventListener('input', () => window.renderAclaracionesView());
document.getElementById('btn-reset-aclaracion-filters')?.addEventListener('click', () => {
    document.getElementById('filter-aclaracion-status').value = '';
    document.getElementById('filter-aclaracion-priority').value = '';
    document.getElementById('filter-aclaracion-search').value = '';
    window.renderAclaracionesView();
});
document.getElementById('btn-export-aclaraciones')?.addEventListener('click', () => window.exportAclaracionesReport());
document.getElementById('btn-email-aclaraciones')?.addEventListener('click', () => window.sendEmailReport());


// --- CREAR / ABRIR ACLARACIÓN ---
window.openAclaracion = async (opId) => {
    try {
        console.log("📂 Abriendo aclaración para:", opId);

        // 1. Buscar si existe en local state
        let acl = AuditState.aclaraciones.find(a => a.operationId === opId);
        let op = AuditState.operaciones.find(o => o.id === opId);
        let sol = (AuditState.solicitudes || []).find(s => s.operacionId === opId) || {};

        // Si no existe, preparamos objeto vacio para crear
        if (!acl) {
            if (!op) {
                // FALLBACK: Si no está en memoria (ej. filtro de fecha), intentar buscar en el DOM o alertar
                // Por ahora, alertar para debug
                alert(`⚠️ La operación ${opId} no está cargada en memoria actual (posiblemente fuera del rango de fechas del filtro).`);
                return;
            }
            acl = {
                operationId: opId,
                status: 'abierta',
                priority: 'media',
                motivo: 'Otro',
                notas: '',
                operationSnapshot: {
                    folio: op.folio || op.id,
                    solicitante: op.solicitante,
                    importe: op.importe,
                    ejecutivo: op.ejecutivo,
                    familia: op.familia,
                    // NUEVOS CAMPOS MACRO EN SNAPSHOT
                    esquema: op.esquema || '',
                    retorno: op.retorno || '',
                    operadora: op.operadora || '',
                    tipo_operacion: op.tipo_operacion || '',
                    cliente: sol.cliente || '',
                    metodo_pago: sol.metodo_pago || ''
                }
            };
        } else {
            // Si existe, usamos sus datos. Si op es null (abierto desde lista y no timeline), usamos snapshot
            if (!op) op = acl.operationSnapshot;
        }

        // 2. Llenar Modal
        const modal = document.getElementById('aclaracion-modal');
        if (!modal) { throw new Error("Elemento HTML 'aclaracion-modal' no encontrado"); }

        modal.classList.remove('hidden');

        // Info Resumen (MACRO VIEW VERSION)
        const summaryEl = document.getElementById('aclaracion-info-summary');
        const snap = acl.operationSnapshot || {};

        summaryEl.innerHTML = `
            <div class="bg-slate-900/50 p-3 rounded border border-slate-700 mb-4">
                <div class="flex justify-between items-start mb-2">
                    <div>
                        <span class="text-[10px] text-slate-500 font-bold uppercase block">Solicitante</span>
                        <span class="font-bold text-white">${snap.solicitante || 'N/A'}</span>
                    </div>
                    <div class="text-right">
                        <span class="text-[10px] text-slate-500 font-bold uppercase block">Importe</span>
                        <span class="font-bold text-emerald-400">$${(snap.importe || 0).toLocaleString()}</span>
                    </div>
                </div>
                
                <!-- Grid Macro Datos dentro de Aclaración -->
                <div class="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 pt-3 border-t border-slate-700/50 text-[11px]">
                    <div><span class="text-slate-500">Esquema:</span> <span class="text-slate-300">${snap.esquema || '-'}</span></div>
                    <div><span class="text-slate-500">Retorno:</span> <span class="text-slate-300">${snap.retorno || '-'}</span></div>
                    <div><span class="text-slate-500">Operadora:</span> <span class="text-slate-300">${snap.operadora || '-'}</span></div>
                    <div><span class="text-slate-500">Ejecutivo:</span> <span class="text-slate-300">${snap.ejecutivo || '-'}</span></div>
                </div>
                <div class="mt-2 text-[10px] text-slate-600 font-mono">ID: ${opId}</div>
            </div>
        `;

        // Campos del formulario
        const statusEl = document.getElementById('edit-aclaracion-status');
        const priorityEl = document.getElementById('edit-aclaracion-priority');
        const motivoEl = document.getElementById('edit-aclaracion-motivo');
        const notaEl = document.getElementById('edit-aclaracion-nota');

        if (statusEl) statusEl.value = acl.status || 'abierta';
        if (priorityEl) priorityEl.value = acl.priority || 'media';
        if (motivoEl) motivoEl.value = acl.motivo || 'Otro';
        if (notaEl) notaEl.value = acl.notas || '';

        // Guardar referencia global para guardar
        window.currentAclaracionOpId = opId;
        window.currentAclaracionIsNew = !AuditState.aclaraciones.find(a => a.operationId === opId);
    } catch (err) {
        console.error("Error abriendo modal:", err);
        alert("Error interno abriendo el modal de aclaración: " + err.message);
    }
};

window.saveAclaracion = async () => {
    const opId = window.currentAclaracionOpId;
    if (!opId) return;

    const btn = document.querySelector('button[onclick="saveAclaracion()"]');
    const originalText = btn.textContent;
    btn.textContent = "Guardando...";
    btn.disabled = true;

    try {
        const data = {
            operationId: opId,
            status: document.getElementById('edit-aclaracion-status').value,
            priority: document.getElementById('edit-aclaracion-priority').value,
            motivo: document.getElementById('edit-aclaracion-motivo').value,
            notas: document.getElementById('edit-aclaracion-nota').value,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        // Si es nueva, agregar snapshot y createdAt
        if (window.currentAclaracionIsNew) {
            const op = AuditState.operaciones.find(o => o.id === opId);
            const sol = AuditState.solicitudes.find(s => s.operacionId === opId) || {};
            if (op) {
                data.operationSnapshot = {
                    folio: op.folio || op.id,
                    solicitante: op.solicitante,
                    importe: op.importe,
                    ejecutivo: op.ejecutivo,
                    familia: op.familia,
                    esquema: op.esquema || '',
                    retorno: op.retorno || '',
                    operadora: op.operadora || '',
                    tipo_operacion: op.tipo_operacion || '',
                    cliente: sol.cliente || '',
                    metodo_pago: sol.metodo_pago || ''
                };
            }
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            // Guardar con ID igual al opId
            await db.collection('aclaraciones').doc(opId).set(data);
        } else {
            // Actualizar
            await db.collection('aclaraciones').doc(opId).update(data);
        }

        console.log("✅ Aclaración guardada exitosamente");
        closeAclaracionModal();
        // Toast o feedback visual aqui si se desea

    } catch (error) {
        console.error("Error guardando aclaración:", error);
        alert("Error al guardar: " + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
};

window.closeAclaracionModal = () => {
    document.getElementById('aclaracion-modal').classList.add('hidden');
    window.currentAclaracionOpId = null;
};
