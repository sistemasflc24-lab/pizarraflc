// ==========================================
// 1. CONFIGURACIÓN FIREBASE (Copiado de AuditPro)
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

// ==========================================
// 2. ESTADO GLOBAL (AppState Local)
// ==========================================
const AppState = {
    currentUser: null,
    operadoras: [],
    currentOperadoraId: null, // ej: "JARO_MXN"
    currentFamiliaQuery: "",
    libroMayorBase: null,
    movimientos: [],
    unsubscribeMovimientos: null
};

// ==========================================
// 3. INICIALIZACIÓN
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    console.log("🚀 LedgerPro Initializing...");

    auth.onAuthStateChanged(user => {
        if (user) {
            AppState.currentUser = user;

            // Buscar más datos del usuario si queremos, por ahora solo mostramos el email
            document.getElementById('user-display').textContent = user.email || "Usuario Autenticado";

            // Cargar Catálogos (Operadoras)
            cargarListas();
        } else {
            console.warn("⚠️ No hay sesión activa. Redirigiendo a MiPizarra...");
            window.location.href = 'index.html';
        }
    });
});

async function cargarListas() {
    try {
        const docRef = db.collection('catalogos').doc('listas');
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const data = docSnap.data();
            AppState.operadoras = data.operadora || [];
            if (AppState.operadoras.length === 0) {
                // Fallback si listas viene vacia por error de lectura
                AppState.operadoras = ["JARO", "ESCALFARO", "ANGRIGATH", "ARICARIA"];
            }
        } else {
            AppState.operadoras = ["JARO", "ESCALFARO", "ANGRIGATH", "ARICARIA"];
        }
        poblarSelectorOperadoras();
    } catch (error) {
        console.error("Error cargando listas:", error);
    }
}

function poblarSelectorOperadoras() {
    const selector = document.getElementById('select-operadora');
    selector.innerHTML = '<option value="">-- Elija Operadora --</option>';

    // Suponiendo Moneda Base MXN para la Fase 1
    AppState.operadoras.forEach(op => {
        const opt = document.createElement('option');
        opt.value = `${op}_MXN`;
        opt.textContent = `${op} (MXN)`;
        selector.appendChild(opt);
    });
}

// ==========================================
// 4. LÓGICA DE CARGA DE DATOS (LECTURA)
// ==========================================

window.loadLibroMayor = async function () {
    const selector = document.getElementById('select-operadora');
    const docId = selector.value;

    if (!docId) {
        document.getElementById('ledger-dashboard').classList.add('hidden');
        AppState.currentOperadoraId = null;
        return;
    }

    try {
        mostrarCarga(true, `Cargando caja de ${docId}...`);
        AppState.currentOperadoraId = docId;

        // Cargar Libro Mayor Raíz
        const docRef = db.collection('libros_mayor').doc(docId);
        const docSnap = await docRef.get();

        if (docSnap.exists) {
            AppState.libroMayorBase = docSnap.data();
        } else {
            // Documento no existe aún, inicializar temporal en local
            AppState.libroMayorBase = {
                operadora: docId.replace('_MXN', ''),
                moneda: 'MXN',
                saldo_disponible: 0,
                saldo_resguardo: 0,
                saldo_financiamiento: 0
            };
        }

        renderDashboardMaestro();

        // Si había una familia buscada, relanzamos la búsqueda
        if (AppState.currentFamiliaQuery) {
            window.filterFamilia();
        }

    } catch (error) {
        console.error("Error cargando Libro Mayor:", error);
        alert("Error cargando los datos de la operadora.");
    } finally {
        mostrarCarga(false);
    }
}

function renderDashboardMaestro() {
    const base = AppState.libroMayorBase;
    document.getElementById('ledger-dashboard').classList.remove('hidden');
    document.getElementById('lbl-operadora-name').textContent = AppState.currentOperadoraId;

    document.getElementById('val-resguardo').textContent = `$${(base.saldo_resguardo || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    document.getElementById('val-financiamiento').textContent = `$${(base.saldo_financiamiento || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    document.getElementById('val-disponible').textContent = `$${(base.saldo_disponible || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

window.filterFamilia = async function () {
    const input = document.getElementById('search-familia');
    // FIX Bug#2: El reporte diario normaliza familia reemplazando espacios con '_'.
    // Esta búsqueda debe hacer lo mismo para que el where('familia','==',query) haga match.
    const query = input.value.trim().toUpperCase().replace(/\s+/g, '_');

    if (!AppState.currentOperadoraId) {
        alert("Primero selecciona una Operadora arriba.");
        input.value = "";
        return;
    }

    if (!query) {
        document.getElementById('family-view').classList.add('hidden');
        AppState.currentFamiliaQuery = "";
        if (AppState.unsubscribeMovimientos) AppState.unsubscribeMovimientos();
        return;
    }

    AppState.currentFamiliaQuery = query;
    document.getElementById('family-view').classList.remove('hidden');
    document.getElementById('lbl-familia-name').textContent = query;
    document.getElementById('table-movimientos').innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400"><i class="fas fa-circle-notch fa-spin mr-2"></i> Cargando movimientos de ${query}...</td></tr>`;

    // Limpiar suscripción previa
    if (AppState.unsubscribeMovimientos) AppState.unsubscribeMovimientos();

    // Consultar Subcolección atada a la Operadora actual filtrando por familia
    const subColRef = db.collection('libros_mayor').doc(AppState.currentOperadoraId).collection('movimientos');
    const q = subColRef.where('familia', '==', query).orderBy('fecha', 'desc').limit(100);

    AppState.unsubscribeMovimientos = q.onSnapshot(snapshot => {
        AppState.movimientos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderMovimientosTabla();
    }, error => {
        console.error("Error cargando historial de familia:", error);
        // Podría fallar por falta de índice en Firebase al combinar where y orderBy
        document.getElementById('table-movimientos').innerHTML = `<tr><td colspan="5" class="p-4 text-center text-red-400">Error leyendo Firebase. ¿Falta el Índice (Índice Compuesto)? Verifica consola.</td></tr>`;
    });
}

function renderMovimientosTabla() {
    const tb = document.getElementById('table-movimientos');
    const countLbl = document.getElementById('lbl-mov-count');

    // Obtener valores de fecha
    const strStart = document.getElementById('filter-date-start')?.value;
    const strEnd = document.getElementById('filter-date-end')?.value;

    let tsStart = 0;
    let tsEnd = Number.MAX_SAFE_INTEGER;

    if (strStart) {
        // Asumiendo hora local 00:00:00
        tsStart = new Date(strStart + "T00:00:00").getTime();
    }
    if (strEnd) {
        // Asumiendo hora local 23:59:59
        tsEnd = new Date(strEnd + "T23:59:59").getTime();
    }

    // Filtrar in-memory para no lidiar con índices compuestos extra en Firestore
    const movsFiltrados = AppState.movimientos.filter(mov => {
        return mov.fecha >= tsStart && mov.fecha <= tsEnd;
    });

    // Guardar los filtrados para que exportToExcel pueda usarlos
    AppState.movimientosFiltrados = movsFiltrados;

    countLbl.textContent = `${movsFiltrados.length} movimientos de ${AppState.movimientos.length} en total`;

    if (movsFiltrados.length === 0) {
        tb.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-500"><i class="fas fa-folder-open text-3xl mb-3 opacity-50 block"></i>Esta familia no tiene historial de operaciones registrado en la caja de ${AppState.currentOperadoraId}.</td></tr>`;
        return;
    }

    tb.innerHTML = '';
    movsFiltrados.forEach(mov => {
        // Determinar si es Cargo o Abono al Saldo del Cliente
        let cssCargo = "-";
        let cssAbono = "-";

        // Si el cliente pagó deuda o depositó a favor, su bolsillo creció (Abono a Resguardo)
        if (mov.afecta_resguardo > 0) {
            cssAbono = `<span class="text-emerald-400 font-bold">+$${mov.afecta_resguardo.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>`;
        } else if (mov.afecta_resguardo < 0) {
            cssCargo = `<span class="text-rose-400 font-bold">-$${Math.abs(mov.afecta_resguardo).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>`;
        }

        // Si fue un préstamo, es un cargo a su deuda (técnicamente, sacó dinero)
        let conceptoText = mov.tipo;
        if (mov.es_ajuste_manual) conceptoText += " <span class='bg-slate-700 text-[10px] px-1 rounded text-slate-300 ml-1'>AJUSTE</span>";
        if (mov.origen_fondos) conceptoText += `<br><span class="text-xs text-slate-500">Origen: ${mov.origen_fondos}</span>`;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-slate-700/50 transition-colors";
        tr.innerHTML = `
            <td class="p-4 text-slate-300">
                <div class="font-medium">${new Date(mov.fecha).toLocaleDateString('es-MX')}</div>
                <div class="text-xs text-slate-500 mt-1 font-mono">${mov.id.substring(0, 8)}...</div>
            </td>
            <td class="p-4 text-slate-300">${conceptoText}</td>
            <td class="p-4 text-right">${cssCargo}</td>
            <td class="p-4 text-right">${cssAbono}</td>
            <td class="p-4 text-right font-bold text-white">$${(mov.saldo_posterior || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
        `;
        tb.appendChild(tr);
    });
}

// ==========================================
// EXPORTACIÓN A EXCEL
// ==========================================
window.exportToExcel = () => {
    if (!AppState.movimientosFiltrados || AppState.movimientosFiltrados.length === 0) {
        alert("No hay movimientos para exportar.");
        return;
    }

    const operadora = AppState.currentOperadoraId || "NA";
    const familia = (document.getElementById('search-familia').value || "Familia").trim().toUpperCase();

    // Transformar datos para Excel
    const dataForExport = AppState.movimientosFiltrados.map(mov => {
        const fecha = new Date(mov.fecha).toLocaleDateString('es-MX');
        const cargo = mov.afecta_resguardo < 0 ? Math.abs(mov.afecta_resguardo) : 0;
        const abono = mov.afecta_resguardo > 0 ? mov.afecta_resguardo : 0;

        let conceptoStr = mov.tipo;
        if (mov.es_ajuste_manual) conceptoStr += " (AJUSTE MANUAL)";
        if (mov.origen_fondos) conceptoStr += ` - Origen: ${mov.origen_fondos}`;

        return {
            "Fecha": fecha,
            "ID Movimiento": mov.id,
            "Concepto / Origen": conceptoStr,
            "Cargo (Salida)": cargo,
            "Abono (Entrada)": abono,
            "Saldo Histórico": mov.saldo_posterior || 0
        };
    });

    const worksheet = XLSX.utils.json_to_sheet(dataForExport);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Estado_Cuenta");

    // Auto-ajustar columnas
    const colWidths = [
        { wch: 12 }, // Fecha
        { wch: 22 }, // ID 
        { wch: 45 }, // Concepto
        { wch: 15 }, // Cargo
        { wch: 15 }, // Abono
        { wch: 20 }  // Saldo
    ];
    worksheet['!cols'] = colWidths;

    XLSX.writeFile(workbook, `EdoCta_${familia}_${operadora}.xlsx`);
};

// ==========================================
// 5. LÓGICA DE ESCRITURA BATCH (AJUSTE MANUAL)
// ==========================================

window.openAjusteModal = function () {
    if (!AppState.currentOperadoraId) {
        alert("Primero selecciona una Operadora para ajustar su caja.");
        return;
    }
    document.getElementById('lbl-modal-operadora').textContent = AppState.currentOperadoraId;

    // Si ya buscó familia, autocompletarla
    if (AppState.currentFamiliaQuery) {
        document.getElementById('input-ajuste-familia').value = AppState.currentFamiliaQuery;
    }

    document.getElementById('input-ajuste-monto').value = "";
    document.getElementById('input-ajuste-concepto').value = "";
    document.getElementById('ajuste-modal').classList.remove('hidden');
}

window.closeAjusteModal = function () {
    document.getElementById('ajuste-modal').classList.add('hidden');
}

window.submitAjusteCaja = async function () {
    const familia = document.getElementById('input-ajuste-familia').value.trim().toUpperCase();
    const tipo = document.getElementById('input-ajuste-tipo').value; // ABONO_RESGUARDO, RETIRO_RESGUARDO, etc
    const montoRaw = parseFloat(document.getElementById('input-ajuste-monto').value);
    const concepto = document.getElementById('input-ajuste-concepto').value.trim();

    if (!familia || isNaN(montoRaw) || montoRaw <= 0) {
        alert("Por favor completa el nombre de familia y un monto válido (mayor a 0).");
        return;
    }

    if (!confirm(`¿Estás seguro de registrar este movimiento de $${montoRaw} a nombre de ${familia} en ${AppState.currentOperadoraId}?`)) {
        return;
    }

    try {
        mostrarCarga(true, "Ejecutando ajuste en caja (Batch Write)...");

        // --- 1. PREPARACIÓN FIREBASE BATCH ---
        const batch = db.batch();
        const docId = AppState.currentOperadoraId;
        const libroRef = db.collection('libros_mayor').doc(docId);

        // Asegurarnos que tenemos la versión más reciente en read 
        // (En producción severa se usaría una Transaction en lugar de Batch para leer y escribir al mismo destiempo,
        //  pero para ajustes manuales el batch es aceptable si confiamos en el Snapshot más reciente).
        const snap = await libroRef.get();
        let sResguardo = 0;
        let sFinanciamiento = 0;
        let sDisponible = 0;

        if (snap.exists) {
            sResguardo = parseFloat(snap.data().saldo_resguardo || 0);
            sFinanciamiento = parseFloat(snap.data().saldo_financiamiento || 0);
            sDisponible = parseFloat(snap.data().saldo_disponible || 0);
        } else {
            // Si no existía, inicializar la raíz en este commit
            batch.set(libroRef, {
                operadora: docId.replace('_MXN', ''),
                moneda: 'MXN',
                saldo_disponible: 0,
                saldo_resguardo: 0,
                saldo_financiamiento: 0,
                fecha_inicializacion: new Date().toISOString()
            });
        }

        // --- 2. LÓGICA DE CONTABILIDAD ---
        let deltaResguardo = 0;
        let deltaFinanciamiento = 0;
        let deltaDisponible = 0; // Dinero real en caja (si el resguardo entra dinero, la olla sube. Si se retira, baja)

        // Nota: Estas formulas deben alinearse al diseño de Trazabilidad.
        if (tipo === 'ABONO_RESGUARDO') {
            deltaResguardo = montoRaw; // Sube resguardo cliente
            deltaDisponible = montoRaw; // Entró dinero físico a la caja Operadora
        } else if (tipo === 'RETIRO_RESGUARDO') {
            if (sResguardo < montoRaw) {
                alert("La caja de resguardo no tiene fondos suficientes para retirar esa cantidad.");
                return;
            }
            deltaResguardo = -montoRaw;
            deltaDisponible = -montoRaw;
        } else if (tipo === 'FINANCIAMIENTO_OTORGADO') {
            deltaFinanciamiento = montoRaw; // Aumenta deuda cliente
            deltaDisponible = -montoRaw;    // Salió dinero de la caja
        } else if (tipo === 'PAGO_FINANCIAMIENTO') {
            if (sFinanciamiento < montoRaw) {
                if (!confirm(`⚠️ El cliente deba menos de $${montoRaw}. Si continúas, la deuda quedará en negativo (a su favor). ¿Proceder?`)) return;
            }
            deltaFinanciamiento = -montoRaw; // Reduce deuda cliente
            deltaDisponible = montoRaw;      // Entró dinero a la caja
        }

        // 3. Crear Registro de Movimiento en Subcolección
        const movId = db.collection('libros_mayor').doc(docId).collection('movimientos').doc().id;
        const movRef = db.collection('libros_mayor').doc(docId).collection('movimientos').doc(movId);

        const nuevoMovimiento = {
            familia: familia,
            tipo: tipo,
            origen_fondos: 'AJUSTE_MANUAL',
            monto_bruto: montoRaw,
            // FIX Bug#4: El ternario anterior ponía montoRaw en afecta_resguardo para PAGO_FINANCIAMIENTO,
            // contaminando la columna de resguardo con pagos de deuda. deltaResguardo ya es 0 para ese tipo,
            // lo cual es correcto — un pago de financiamiento no toca el resguardo del cliente.
            afecta_resguardo: deltaResguardo,
            saldo_posterior: sResguardo + deltaResguardo, // Ojo: Esta foto es solo para control de resguardo primario
            fecha: new Date().toISOString(),
            concepto: concepto || "Ajuste sin concepto",
            es_ajuste_manual: true,
            realizado_por: AppState.currentUser ? AppState.currentUser.email : 'unknown'
        };
        batch.set(movRef, nuevoMovimiento);

        // 4. Actualizar Libro Mayor Raíz
        batch.update(libroRef, {
            saldo_resguardo: firebase.firestore.FieldValue.increment(deltaResguardo),
            saldo_financiamiento: firebase.firestore.FieldValue.increment(deltaFinanciamiento),
            saldo_disponible: firebase.firestore.FieldValue.increment(deltaDisponible),
            ultima_actualizacion: new Date().toISOString()
        });

        // 5. COMMIT
        await batch.commit();

        // 6. Refrescar Vista
        window.closeAjusteModal();
        await window.loadLibroMayor(); // Recargar caja root

        // Si estábamos viendo a esa misma familia, forzar update visual
        if (AppState.currentFamiliaQuery && AppState.currentFamiliaQuery === familia) {
            window.filterFamilia();
        }

        mostrarNotificacion(`✅ Movimiento guardado correctamente.`, false);

    } catch (error) {
        console.error("Error ejecutando Batch Write:", error);
        mostrarNotificacion(`❌ Error: ${error.message}`, true);
    } finally {
        mostrarCarga(false);
    }
}

// ==========================================
// UI Helpers
// ==========================================
function mostrarCarga(mostrar, texto = "Cargando...") {
    const el = document.getElementById('loading-overlay');
    if (mostrar) {
        document.getElementById('loading-text').textContent = texto;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

function mostrarNotificacion(mensaje, isError = false) {
    // Alerta rápida por ahora, puedes inyectar el sistema toast de MiPizarra
    alert(mensaje);
}
