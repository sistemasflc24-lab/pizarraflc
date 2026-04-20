const firebaseConfig = {
    apiKey: "AIzaSyD0j20ZXdcfVioRAfkJn6Uyn_Q2A6blYkI",
    authDomain: "pizarraflc.appspot.com",
    projectId: "pizarraflc",
    storageBucket: "pizarraflc.firebasestorage.app",
    messagingSenderId: "108471728011",
    appId: "1:108471728011:web:c0a83b710b37d72c21e18e",
    measurementId: "G-SJZW3G2P79"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();
const auth = firebase.auth();

const AppState = {
    currentUser: null,
    currentProfile: null,
    currentRole: "",
    reports: [],
    filteredReports: [],
    selectedReportId: "",
    activeView: "detail",
    unsubscribeReports: null,
    charts: {}
};

const ALLOWED_MAPPED_ROLES = new Set(["AUDITOR", "SUPERVISOR"]);

document.addEventListener("DOMContentLoaded", () => {
    bindUI();

    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            window.location.href = "reporte de operaciones diario.html";
            return;
        }

        AppState.currentUser = user;

        try {
            const profileSnap = await db.collection("usuarios").doc(user.uid).get();
            const profile = profileSnap.exists ? profileSnap.data() || {} : {};
            const mappedRole = mapUserRole(profile.role || "operaciones");

            if (!ALLOWED_MAPPED_ROLES.has(mappedRole)) {
                alert("Este dashboard esta disponible solo para Auditor y Supervisor.");
                window.location.href = "reporte de operaciones diario.html";
                return;
            }

            AppState.currentProfile = profile;
            AppState.currentRole = mappedRole;
            document.getElementById("dashboard-user-display").textContent = `${mappedRole} · ${(profile.name || user.displayName || user.email || "Usuario").toUpperCase()}`;
            subscribeToAuditWeeklyReports();
        } catch (error) {
            console.error("Error validando acceso al dashboard:", error);
            alert("No se pudo validar el acceso al dashboard.");
            window.location.href = "reporte de operaciones diario.html";
        }
    });
});

function mapUserRole(rawRole) {
    const role = String(rawRole || "").trim().toLowerCase();
    if (role === "admin") return "SUPERVISOR";
    if (["auditor", "tesoreria", "financiero", "administracion"].includes(role)) return "AUDITOR";
    return "EJECUTIVO";
}

function bindUI() {
    document.getElementById("tab-detail").addEventListener("click", () => setActiveView("detail"));
    document.getElementById("tab-general").addEventListener("click", () => setActiveView("general"));
    document.getElementById("btn-reset-filters").addEventListener("click", resetFilters);
    document.getElementById("btn-export-detail").addEventListener("click", exportDetailExcel);
    document.getElementById("btn-export-general").addEventListener("click", exportGeneralExcel);

    ["filter-year", "filter-week", "filter-executive", "filter-auditor", "filter-date-start", "filter-date-end"]
        .forEach((id) => {
            document.getElementById(id).addEventListener("change", renderDashboard);
        });
}

function setActiveView(view) {
    AppState.activeView = view === "general" ? "general" : "detail";
    document.getElementById("tab-detail").classList.toggle("is-active", AppState.activeView === "detail");
    document.getElementById("tab-general").classList.toggle("is-active", AppState.activeView === "general");
    document.getElementById("view-detail").classList.toggle("hidden", AppState.activeView !== "detail");
    document.getElementById("view-general").classList.toggle("hidden", AppState.activeView !== "general");
}

function resetFilters() {
    document.getElementById("filter-year").value = "";
    document.getElementById("filter-week").value = "";
    document.getElementById("filter-executive").value = "";
    document.getElementById("filter-auditor").value = "";
    document.getElementById("filter-date-start").value = "";
    document.getElementById("filter-date-end").value = "";
    renderDashboard();
}

function subscribeToAuditWeeklyReports() {
    if (AppState.unsubscribeReports) AppState.unsubscribeReports();

    AppState.unsubscribeReports = db.collection("audit_weekly_reports").onSnapshot((snapshot) => {
        AppState.reports = snapshot.docs
            .map((docSnap) => normalizeReportDoc(docSnap))
            .sort((a, b) => {
                const timeA = a.auditClosedAt ? a.auditClosedAt.getTime() : 0;
                const timeB = b.auditClosedAt ? b.auditClosedAt.getTime() : 0;
                if (timeA !== timeB) return timeB - timeA;
                return (b.closureVersion || 0) - (a.closureVersion || 0);
            });

        populateFilters();
        renderDashboard();
    }, (error) => {
        console.error("Error leyendo audit_weekly_reports:", error);
    });
}

function normalizeReportDoc(docSnap) {
    const data = docSnap.data() || {};
    return {
        id: docSnap.id,
        reportType: String(data.report_type || "").trim(),
        supervisionDocId: String(data.supervision_doc_id || "").trim(),
        supervisionKey: String(data.supervision_key || "").trim(),
        week: parseInt(data.week, 10) || 0,
        year: parseInt(data.year, 10) || 0,
        executiveName: String(data.executive_name || "").trim(),
        executiveUid: String(data.executive_uid || "").trim(),
        auditorName: String(data.auditor_name || "").trim(),
        auditorUid: String(data.auditor_uid || "").trim(),
        supervisorName: String(data.supervisor_name || "").trim(),
        supervisorUid: String(data.supervisor_uid || "").trim(),
        releasedAt: parseDateLike(data.released_at),
        auditorSeenAt: parseDateLike(data.auditor_seen_at),
        auditClosedAt: parseDateLike(data.audit_closed_at),
        auditClosedNote: String(data.audit_closed_note || "").trim(),
        closureVersion: parseInt(data.closure_version, 10) || 1,
        closureStatusAtSnapshot: String(data.closure_status_at_snapshot || "").trim() || "closed",
        wasReopenedBeforeClose: Boolean(data.was_reopened_before_close),
        operationCount: parseInt(data.operation_count, 10) || 0,
        pendingCount: parseInt(data.pending_count, 10) || 0,
        approvedCount: parseInt(data.approved_count, 10) || 0,
        rejectedCount: parseInt(data.rejected_count, 10) || 0,
        otherCount: parseInt(data.other_count, 10) || 0,
        latestModifiedAt: parseDateLike(data.latest_modified_at),
        totalImporte: parseFloat(data.total_importe) || 0,
        totalRetorno: parseFloat(data.total_retorno) || 0,
        walletOperationCount: parseInt(data.wallet_operation_count, 10) || 0,
        caseOperationCount: parseInt(data.case_operation_count, 10) || 0,
        reportOperationCount: parseInt(data.report_operation_count, 10) || 0,
        productionOperationCount: parseInt(data.production_operation_count, 10) || 0,
        operationsSnapshot: Array.isArray(data.operations_snapshot) ? data.operations_snapshot.map((item) => ({
            idDb: String(item.id_db || "").trim(),
            fecha: String(item.fecha || "").trim(),
            operadora: String(item.operadora || "").trim(),
            familia: String(item.familia || "").trim(),
            origen: String(item.origen || "").trim(),
            importe: parseFloat(item.importe) || 0,
            retornoNeto: parseFloat(item.retorno_neto) || 0,
            status: String(item.status || "").trim().toLowerCase() || "pending",
            sourceType: String(item.source_type || "").trim() || "production",
            captureMode: String(item.capture_mode || "").trim() || "general",
            walletMode: String(item.wallet_mode || "").trim() || "normal",
            groupRole: String(item.group_role || "").trim(),
            lastModifiedAt: parseDateLike(item.last_modified_at),
            lastModifiedBy: String(item.last_modified_by || "").trim()
        })) : []
    };
}

function populateFilters() {
    populateSelect("filter-year", buildOptionList(AppState.reports.map((r) => String(r.year || ""))), "Todos los anos");
    populateSelect("filter-week", buildOptionList(AppState.reports.map((r) => String(r.week || ""))), "Todas las semanas", (a, b) => Number(a) - Number(b), (val) => `Sem ${val}`);
    populateSelect("filter-executive", buildOptionList(AppState.reports.map((r) => r.executiveName)), "Todos los ejecutivos");
    populateSelect("filter-auditor", buildOptionList(AppState.reports.map((r) => r.auditorName)), "Todos los auditores");
}

function buildOptionList(items = []) {
    return Array.from(new Set((items || []).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), "es"));
}

function populateSelect(id, items, allLabel, sortFn = null, labelFn = null) {
    const select = document.getElementById(id);
    const currentValue = select.value;
    const list = [...(items || [])];
    if (sortFn) list.sort(sortFn);

    select.innerHTML = `<option value="">${allLabel}</option>`;
    list.forEach((item) => {
        const option = document.createElement("option");
        option.value = item;
        option.textContent = labelFn ? labelFn(item) : item;
        select.appendChild(option);
    });

    if (list.includes(currentValue)) select.value = currentValue;
}

function getFilteredReports() {
    const selectedYear = document.getElementById("filter-year").value;
    const selectedWeek = document.getElementById("filter-week").value;
    const selectedExecutive = normalizeText(document.getElementById("filter-executive").value);
    const selectedAuditor = normalizeText(document.getElementById("filter-auditor").value);
    const startDate = document.getElementById("filter-date-start").value;
    const endDate = document.getElementById("filter-date-end").value;

    return AppState.reports.filter((report) => {
        if (selectedYear && String(report.year) !== selectedYear) return false;
        if (selectedWeek && String(report.week) !== selectedWeek) return false;
        if (selectedExecutive && normalizeText(report.executiveName) !== selectedExecutive) return false;
        if (selectedAuditor && normalizeText(report.auditorName) !== selectedAuditor) return false;

        const closeDate = report.auditClosedAt;
        if (startDate) {
            const start = new Date(`${startDate}T00:00:00`);
            if (!closeDate || closeDate.getTime() < start.getTime()) return false;
        }
        if (endDate) {
            const end = new Date(`${endDate}T23:59:59`);
            if (!closeDate || closeDate.getTime() > end.getTime()) return false;
        }
        return true;
    }).sort((a, b) => {
        const timeA = a.auditClosedAt ? a.auditClosedAt.getTime() : 0;
        const timeB = b.auditClosedAt ? b.auditClosedAt.getTime() : 0;
        if (timeA !== timeB) return timeB - timeA;
        return (b.closureVersion || 0) - (a.closureVersion || 0);
    });
}

function renderDashboard() {
    AppState.filteredReports = getFilteredReports();

    const hasAnyReports = AppState.reports.length > 0;
    const emptyState = document.getElementById("empty-state");
    emptyState.classList.toggle("hidden", hasAnyReports);

    if (!hasAnyReports) {
        clearDetailView();
        clearGeneralView();
        return;
    }

    renderDetailView();
    renderGeneralView();
}

function renderDetailView() {
    const reports = AppState.filteredReports;
    document.getElementById("detail-report-count").textContent = `${reports.length} cierres`;

    if (!reports.length) {
        clearDetailView("No hay cierres que coincidan con el filtro actual.");
        return;
    }

    const selected = reports.find((report) => report.id === AppState.selectedReportId) || reports[0];
    AppState.selectedReportId = selected.id;

    renderDetailSelectedSummary(selected);
    renderDetailReportsTable(reports, selected.id);
    renderDetailOperationsTable(selected.operationsSnapshot);
}

function renderDetailSelectedSummary(report) {
    if (!report) {
        clearDetailView("Selecciona un cierre para ver el detalle.");
        return;
    }

    document.getElementById("detail-title").textContent = `Semana ${report.week} · ${report.year}`;
    document.getElementById("detail-subtitle").textContent = `Cierre v${report.closureVersion} de ${report.executiveName || "Sin ejecutivo"} · ${formatDateTime(report.auditClosedAt)}`;
    document.getElementById("detail-closure-pill").className = `pill ${report.wasReopenedBeforeClose ? "pill-amber" : "pill-emerald"}`;
    document.getElementById("detail-closure-pill").textContent = report.wasReopenedBeforeClose ? `Reabierta antes de cerrar · v${report.closureVersion}` : `Cerrada · v${report.closureVersion}`;

    document.getElementById("detail-executive").textContent = report.executiveName || "-";
    document.getElementById("detail-weekline").textContent = `Liberada: ${formatDateTime(report.releasedAt)} · Cerrada: ${formatDateTime(report.auditClosedAt)}`;
    document.getElementById("detail-auditor").textContent = report.auditorName || "-";
    document.getElementById("detail-supervisor").textContent = `Supervisor ${report.supervisorName || "-"}`;
    document.getElementById("detail-note").textContent = report.auditClosedNote || "Sin nota de cierre.";

    document.getElementById("detail-kpi-ops").textContent = report.operationCount;
    document.getElementById("detail-kpi-approved").textContent = report.approvedCount;
    document.getElementById("detail-kpi-rejected").textContent = report.rejectedCount;
    document.getElementById("detail-kpi-pending").textContent = report.pendingCount;
    document.getElementById("detail-kpi-amount").textContent = formatMoney(report.totalImporte);
    document.getElementById("detail-kpi-return").textContent = formatMoney(report.totalRetorno);
    document.getElementById("detail-kpi-wallet").textContent = `${report.walletOperationCount}`;
    document.getElementById("detail-kpi-case").textContent = `${report.caseOperationCount}`;
    document.getElementById("detail-kpi-time").textContent = formatDurationHours(getClosureHours(report));
}

function renderDetailReportsTable(reports, selectedId) {
    const tbody = document.getElementById("detail-report-table");
    tbody.innerHTML = "";

    reports.forEach((report) => {
        const row = document.createElement("tr");
        row.className = `report-row cursor-pointer ${report.id === selectedId ? "is-active" : ""}`;
        row.onclick = () => {
            AppState.selectedReportId = report.id;
            renderDetailView();
        };
        row.innerHTML = `
            <td class="px-4 py-3 font-black text-slate-800">Sem ${report.week} / ${report.year}</td>
            <td class="px-4 py-3 font-bold text-slate-700">${escapeHtml(report.executiveName || "-")}</td>
            <td class="px-4 py-3 text-slate-500 font-semibold">${escapeHtml(report.auditorName || "-")}</td>
            <td class="px-4 py-3 text-right font-black text-slate-700">${report.operationCount}</td>
            <td class="px-4 py-3 text-right font-black text-slate-800">${formatMoney(report.totalImporte)}</td>
            <td class="px-4 py-3 text-right text-slate-500 font-bold">${formatDateTime(report.auditClosedAt)}</td>
            <td class="px-4 py-3 text-center"><span class="pill ${report.wasReopenedBeforeClose ? "pill-amber" : "pill-indigo"}">v${report.closureVersion}</span></td>
        `;
        tbody.appendChild(row);
    });
}

function renderDetailOperationsTable(operations = []) {
    const tbody = document.getElementById("detail-ops-table");
    const countEl = document.getElementById("detail-ops-count");
    countEl.textContent = `${operations.length} operaciones`;
    tbody.innerHTML = "";

    if (!operations.length) {
        tbody.innerHTML = `<tr><td colspan="12" class="px-4 py-8 text-center text-sm font-bold text-slate-400">No hay operaciones guardadas en este snapshot.</td></tr>`;
        return;
    }

    operations.forEach((op) => {
        const modelLabel = op.sourceType === "report" ? "Reporte" : "Productiva";
        const walletLabel = op.walletMode === "wallet_direct" ? `Wallet ${escapeHtml(op.captureMode || "")}` : "Normal";
        const caseLabel = op.groupRole ? escapeHtml(op.groupRole) : "-";
        const statusClass = op.status === "approved"
            ? "pill-emerald"
            : (op.status === "rejected" ? "pill-rose" : "pill-amber");
        const row = document.createElement("tr");
        row.className = "report-row";
        row.innerHTML = `
            <td class="px-4 py-3 font-black text-slate-800">${escapeHtml(op.idDb || "-")}</td>
            <td class="px-4 py-3 font-bold text-slate-500">${escapeHtml(op.fecha || "-")}</td>
            <td class="px-4 py-3 font-bold text-slate-700">${escapeHtml(op.operadora || "-")}</td>
            <td class="px-4 py-3 text-slate-600 font-semibold">${escapeHtml(op.familia || "-")}</td>
            <td class="px-4 py-3"><span class="pill pill-slate">${escapeHtml(op.origen || "-")}</span></td>
            <td class="px-4 py-3 text-right font-black text-slate-800">${formatMoney(op.importe)}</td>
            <td class="px-4 py-3 text-right font-black text-indigo-700">${formatMoney(op.retornoNeto)}</td>
            <td class="px-4 py-3 text-slate-600 font-bold">${modelLabel}</td>
            <td class="px-4 py-3 text-slate-600 font-bold">${walletLabel}</td>
            <td class="px-4 py-3 text-slate-600 font-bold">${caseLabel}</td>
            <td class="px-4 py-3"><span class="pill ${statusClass}">${escapeHtml(op.status || "pending")}</span></td>
            <td class="px-4 py-3 text-xs font-bold text-slate-400">${escapeHtml(formatLastModifiedInline(op.lastModifiedAt, op.lastModifiedBy))}</td>
        `;
        tbody.appendChild(row);
    });
}

function clearDetailView(message = "No hay cierres en este filtro.") {
    document.getElementById("detail-title").textContent = "Sin cierre seleccionado";
    document.getElementById("detail-subtitle").textContent = message;
    document.getElementById("detail-closure-pill").className = "pill pill-slate";
    document.getElementById("detail-closure-pill").textContent = "Sin cierre";
    document.getElementById("detail-executive").textContent = "-";
    document.getElementById("detail-weekline").textContent = "-";
    document.getElementById("detail-auditor").textContent = "-";
    document.getElementById("detail-supervisor").textContent = "-";
    document.getElementById("detail-note").textContent = "Sin informacion.";
    ["detail-kpi-ops", "detail-kpi-approved", "detail-kpi-rejected", "detail-kpi-pending", "detail-kpi-wallet", "detail-kpi-case"]
        .forEach((id) => { document.getElementById(id).textContent = "0"; });
    document.getElementById("detail-kpi-amount").textContent = "$0.00";
    document.getElementById("detail-kpi-return").textContent = "$0.00";
    document.getElementById("detail-kpi-time").textContent = "-";
    document.getElementById("detail-report-table").innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-sm font-bold text-slate-400">${escapeHtml(message)}</td></tr>`;
    document.getElementById("detail-ops-table").innerHTML = `<tr><td colspan="12" class="px-4 py-8 text-center text-sm font-bold text-slate-400">Sin operaciones para mostrar.</td></tr>`;
    document.getElementById("detail-report-count").textContent = "0 cierres";
    document.getElementById("detail-ops-count").textContent = "0 operaciones";
}

function renderGeneralView() {
    const reports = AppState.filteredReports;
    document.getElementById("general-report-count").textContent = `${reports.length} registros`;

    if (!reports.length) {
        clearGeneralView();
        return;
    }

    const totals = buildGeneralAggregates(reports);
    document.getElementById("general-kpi-weeks").textContent = `${totals.weeksClosed}`;
    document.getElementById("general-kpi-reopened").textContent = `${totals.reopenedCount}`;
    document.getElementById("general-kpi-ops").textContent = `${totals.operationCount}`;
    document.getElementById("general-kpi-amount").textContent = formatMoney(totals.totalAmount);
    document.getElementById("general-kpi-return").textContent = formatMoney(totals.totalReturn);
    document.getElementById("general-kpi-time").textContent = formatDurationHours(totals.averageCloseHours);

    renderGeneralReportTable(reports);
    renderGeneralCharts(reports, totals);
}

function clearGeneralView() {
    document.getElementById("general-kpi-weeks").textContent = "0";
    document.getElementById("general-kpi-reopened").textContent = "0";
    document.getElementById("general-kpi-ops").textContent = "0";
    document.getElementById("general-kpi-amount").textContent = "$0.00";
    document.getElementById("general-kpi-return").textContent = "$0.00";
    document.getElementById("general-kpi-time").textContent = "-";
    document.getElementById("general-report-table").innerHTML = `<tr><td colspan="10" class="px-4 py-8 text-center text-sm font-bold text-slate-400">No hay semanas cerradas en este filtro.</td></tr>`;
    destroyAllCharts();
}

function buildGeneralAggregates(reports = []) {
    const closureHours = reports.map(getClosureHours).filter((value) => Number.isFinite(value));
    return {
        weeksClosed: reports.length,
        reopenedCount: reports.filter((report) => report.wasReopenedBeforeClose).length,
        operationCount: reports.reduce((sum, report) => sum + report.operationCount, 0),
        totalAmount: reports.reduce((sum, report) => sum + report.totalImporte, 0),
        totalReturn: reports.reduce((sum, report) => sum + report.totalRetorno, 0),
        averageCloseHours: closureHours.length ? (closureHours.reduce((sum, value) => sum + value, 0) / closureHours.length) : 0
    };
}

function renderGeneralReportTable(reports = []) {
    const tbody = document.getElementById("general-report-table");
    tbody.innerHTML = "";

    reports.forEach((report) => {
        const row = document.createElement("tr");
        row.className = "report-row";
        row.innerHTML = `
            <td class="px-4 py-3 font-black text-slate-800">Sem ${report.week} / ${report.year}</td>
            <td class="px-4 py-3 font-bold text-slate-700">${escapeHtml(report.executiveName || "-")}</td>
            <td class="px-4 py-3 text-slate-500 font-semibold">${escapeHtml(report.auditorName || "-")}</td>
            <td class="px-4 py-3 text-right font-black text-slate-700">${report.operationCount}</td>
            <td class="px-4 py-3 text-right font-black text-slate-800">${formatMoney(report.totalImporte)}</td>
            <td class="px-4 py-3 text-right font-black text-emerald-600">${report.approvedCount}</td>
            <td class="px-4 py-3 text-right font-black text-rose-600">${report.rejectedCount}</td>
            <td class="px-4 py-3 text-right font-black text-amber-600">${report.pendingCount}</td>
            <td class="px-4 py-3 text-right font-bold text-slate-500">${formatDateTime(report.auditClosedAt)}</td>
            <td class="px-4 py-3 text-center"><span class="pill ${report.wasReopenedBeforeClose ? "pill-amber" : "pill-indigo"}">v${report.closureVersion}</span></td>
        `;
        tbody.appendChild(row);
    });
}

function renderGeneralCharts(reports, totals) {
    const closuresByWeek = groupCountsByWeek(reports);
    renderChart("chart-closures-by-week", "bar", {
        labels: Object.keys(closuresByWeek),
        datasets: [{
            label: "Cierres",
            data: Object.values(closuresByWeek),
            backgroundColor: "#4f46e5",
            borderRadius: 12
        }]
    }, defaultChartOptions(false));

    renderChart("chart-status-breakdown", "doughnut", {
        labels: ["Aprobadas", "Rechazadas", "Pendientes"],
        datasets: [{
            data: [
                reports.reduce((sum, report) => sum + report.approvedCount, 0),
                reports.reduce((sum, report) => sum + report.rejectedCount, 0),
                reports.reduce((sum, report) => sum + report.pendingCount, 0)
            ],
            backgroundColor: ["#10b981", "#f43f5e", "#f59e0b"],
            borderWidth: 0
        }]
    }, defaultChartOptions(true));

    const amountByExecutive = groupAmountByExecutive(reports);
    renderChart("chart-amount-by-executive", "bar", {
        labels: Object.keys(amountByExecutive),
        datasets: [{
            label: "Monto auditado",
            data: Object.values(amountByExecutive),
            backgroundColor: "#0ea5e9",
            borderRadius: 12
        }]
    }, defaultChartOptions(false));

    const avgTimeByExecutive = groupAverageTimeByExecutive(reports);
    renderChart("chart-time-by-executive", "bar", {
        labels: Object.keys(avgTimeByExecutive),
        datasets: [{
            label: "Horas promedio",
            data: Object.values(avgTimeByExecutive),
            backgroundColor: "#8b5cf6",
            borderRadius: 12
        }]
    }, defaultChartOptions(false, " hrs"));

    renderChart("chart-wallet-share", "doughnut", {
        labels: ["Wallet", "No wallet"],
        datasets: [{
            data: [
                reports.reduce((sum, report) => sum + report.walletOperationCount, 0),
                Math.max(0, totals.operationCount - reports.reduce((sum, report) => sum + report.walletOperationCount, 0))
            ],
            backgroundColor: ["#06b6d4", "#cbd5e1"],
            borderWidth: 0
        }]
    }, defaultChartOptions(true));
}

function groupCountsByWeek(reports = []) {
    const map = {};
    reports.forEach((report) => {
        const key = `Sem ${report.week} / ${report.year}`;
        map[key] = (map[key] || 0) + 1;
    });
    return map;
}

function groupAmountByExecutive(reports = []) {
    const map = {};
    reports.forEach((report) => {
        const key = report.executiveName || "Sin ejecutivo";
        map[key] = (map[key] || 0) + report.totalImporte;
    });
    return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 8));
}

function groupAverageTimeByExecutive(reports = []) {
    const grouped = {};
    reports.forEach((report) => {
        const key = report.executiveName || "Sin ejecutivo";
        const hours = getClosureHours(report);
        if (!Number.isFinite(hours)) return;
        if (!grouped[key]) grouped[key] = { total: 0, count: 0 };
        grouped[key].total += hours;
        grouped[key].count += 1;
    });

    return Object.fromEntries(
        Object.entries(grouped)
            .map(([key, value]) => [key, value.count ? (value.total / value.count) : 0])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
    );
}

function renderChart(canvasId, type, data, options) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (AppState.charts[canvasId]) {
        AppState.charts[canvasId].destroy();
    }
    AppState.charts[canvasId] = new Chart(canvas, { type, data, options });
}

function destroyAllCharts() {
    Object.values(AppState.charts).forEach((chart) => {
        try { chart.destroy(); } catch (_) { }
    });
    AppState.charts = {};
}

function defaultChartOptions(isCircular, suffix = "") {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: true,
                position: isCircular ? "bottom" : "top",
                labels: {
                    color: "#475569",
                    font: { family: "Inter", weight: "700" }
                }
            },
            tooltip: {
                callbacks: {
                    label: (ctx) => {
                        const raw = ctx.parsed?.y ?? ctx.parsed;
                        if (typeof raw === "number") {
                            return suffix ? `${ctx.label}: ${raw.toFixed(1)}${suffix}` : `${ctx.label}: ${raw.toLocaleString("en-US")}`;
                        }
                        return `${ctx.label}: ${raw}`;
                    }
                }
            }
        },
        scales: isCircular ? {} : {
            x: {
                ticks: { color: "#64748b", font: { family: "Inter", weight: "700" } },
                grid: { display: false }
            },
            y: {
                beginAtZero: true,
                ticks: {
                    color: "#64748b",
                    font: { family: "Inter", weight: "700" },
                    callback: (value) => suffix ? `${value}${suffix}` : value
                },
                grid: { color: "rgba(148,163,184,0.15)" }
            }
        }
    };
}

function exportDetailExcel() {
    const report = AppState.filteredReports.find((item) => item.id === AppState.selectedReportId) || null;
    if (!report) {
        alert("No hay un cierre semanal seleccionado para exportar.");
        return;
    }

    const aoa = [
        ["REPORTE DE CIERRE SEMANAL POR EJECUTIVO"],
        [`Semana ${report.week} / ${report.year}`],
        [`Ejecutivo: ${report.executiveName}`],
        [`Auditor: ${report.auditorName}`],
        [`Supervisor: ${report.supervisorName}`],
        [`Liberada: ${formatDateTime(report.releasedAt)}`],
        [`Cerrada: ${formatDateTime(report.auditClosedAt)}`],
        [`Version: ${report.closureVersion}`],
        [`Nota: ${report.auditClosedNote || "Sin nota"}`],
        [],
        ["Ops", "Aprobadas", "Rechazadas", "Pendientes", "Otros", "Monto", "Retorno", "Wallet", "Casos", "Tiempo cierre (hrs)"],
        [
            report.operationCount,
            report.approvedCount,
            report.rejectedCount,
            report.pendingCount,
            report.otherCount || 0,
            report.totalImporte,
            report.totalRetorno,
            report.walletOperationCount,
            report.caseOperationCount,
            getClosureHours(report)
        ],
        [],
        ["ID", "Fecha", "Operadora", "Cliente", "Origen", "Importe", "Retorno", "Modelo", "Wallet", "Caso", "Estatus", "Ultima modificacion"]
    ];

    report.operationsSnapshot.forEach((op) => {
        aoa.push([
            op.idDb,
            op.fecha,
            op.operadora,
            op.familia,
            op.origen,
            op.importe,
            op.retornoNeto,
            op.sourceType === "report" ? "Reporte" : "Productiva",
            op.walletMode === "wallet_direct" ? `Wallet ${op.captureMode}` : "Normal",
            op.groupRole || "",
            op.status,
            formatLastModifiedInline(op.lastModifiedAt, op.lastModifiedBy)
        ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
        { wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 24 }, { wch: 16 }, { wch: 10 },
        { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 28 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Cierre Ejecutivo");
    XLSX.writeFile(wb, `Cierre_Semanal_${safeSlug(report.executiveName)}_S${report.week}_${report.year}.xlsx`);
}

function exportGeneralExcel() {
    const reports = AppState.filteredReports;
    if (!reports.length) {
        alert("No hay cierres filtrados para exportar.");
        return;
    }

    const aoa = [
        ["REPORTE SEMANAL GENERAL DE AUDITORIA"],
        [`Registros: ${reports.length}`],
        [`Semanas reabiertas: ${reports.filter((report) => report.wasReopenedBeforeClose).length}`],
        [`Ops auditadas: ${reports.reduce((sum, report) => sum + report.operationCount, 0)}`],
        [`Monto auditado: ${reports.reduce((sum, report) => sum + report.totalImporte, 0)}`],
        [`Retorno auditado: ${reports.reduce((sum, report) => sum + report.totalRetorno, 0)}`],
        [],
        ["Semana", "Ejecutivo", "Auditor", "Ops", "Aprobadas", "Rechazadas", "Pendientes", "Otros", "Monto", "Retorno", "Version", "Cerrada", "Reabierta antes del cierre"]
    ];

    reports.forEach((report) => {
        aoa.push([
            `Sem ${report.week} / ${report.year}`,
            report.executiveName,
            report.auditorName,
            report.operationCount,
            report.approvedCount,
            report.rejectedCount,
            report.pendingCount,
            report.otherCount || 0,
            report.totalImporte,
            report.totalRetorno,
            report.closureVersion,
            formatDateTime(report.auditClosedAt),
            report.wasReopenedBeforeClose ? "SI" : "NO"
        ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
        { wch: 16 }, { wch: 24 }, { wch: 24 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
        { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 20 }, { wch: 18 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Reporte General");
    XLSX.writeFile(wb, `Reporte_Auditoria_General_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function parseDateLike(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === "function") return value.toDate();
    if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value) {
    const date = parseDateLike(value);
    if (!date) return "Sin fecha";
    return date.toLocaleString("es-MX", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function formatMoney(value) {
    return `$${(parseFloat(value) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function normalizeText(value) {
    return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function getClosureHours(report) {
    const releasedAt = parseDateLike(report.releasedAt);
    const closedAt = parseDateLike(report.auditClosedAt);
    if (!releasedAt || !closedAt) return null;
    return Math.max(0, (closedAt.getTime() - releasedAt.getTime()) / 3600000);
}

function formatDurationHours(hours) {
    if (!Number.isFinite(hours)) return "-";
    if (hours < 24) return `${hours.toFixed(1)} hrs`;
    return `${(hours / 24).toFixed(1)} dias`;
}

function formatLastModifiedInline(dateValue, userName) {
    const stamp = formatDateTime(dateValue);
    const actor = String(userName || "").trim();
    return actor ? `${stamp} - ${actor}` : stamp;
}

function safeSlug(value) {
    return String(value || "reporte")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase();
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
