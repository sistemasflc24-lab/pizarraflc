// auditoria.js
// Reglas de auditoría, validaciones y candado de guardado

(function (window) {
  let errores = [];
  let advertencias = [];

  function text(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }

  function num(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    const v = el.value.replace(/,/g, "").trim();
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function addError(msg) {
    errores.push(msg);
  }

  function addWarn(msg) {
    advertencias.push(msg);
  }

  function pintarAuditoria() {
    const box = document.getElementById("debug_excel_logic");
    if (!box) return;

    const data = {
      errores,
      advertencias
    };

    box.textContent += "\n\n[Auditoría]\n" + JSON.stringify(data, null, 2);
  }

  function evaluarAuditoria() {
    errores = [];
    advertencias = [];

    const operador = text("operador");
    const solicitante = text("solicitante");
    const origen = text("origen");
    const totalFactura = num("total_factura");
    const retorno = num("monto_retorno");
    const difConcil = num("concil_diferencia");
    const difDistrib = num("distrib_diferencia");

    // ======== VALIDACIONES BÁSICAS ========
    if (!operador) addError("Falta seleccionar operador");
    if (!solicitante) addError("Falta registrar solicitante / beneficiario");
    if (!origen) addError("Debe seleccionarse un origen de operación");

    if (totalFactura <= 0) addWarn("La operación no tiene total facturado");

    // ======== BANCARIA ========
    if (Math.abs(difConcil) > 50) {
      addError("Conciliación bancaria NO cuadra (diferencia alta)");
    } else if (Math.abs(difConcil) > 1) {
      addWarn("Conciliación bancaria con diferencia pequeña");
    }

    // ======== DISTRIBUCIÓN ========
    if (retorno > 0) {
      if (Math.abs(difDistrib) > 50)
        addError("La distribución del retorno no cuadra con el monto retorno");

      if (Math.abs(difDistrib) > 1 && Math.abs(difDistrib) <= 50)
        addWarn("Pequeña diferencia en distribución del retorno");
    }

    pintarAuditoria();
    controlarBotonGuardar();
  }

  function controlarBotonGuardar() {
    const btn = document.getElementById("btn_guardar_operacion");
    if (!btn) return;

    if (errores.length > 0) {
      btn.disabled = true;
      btn.className =
        "px-4 py-2 rounded-lg bg-rose-200 text-rose-800 font-semibold cursor-not-allowed";
      btn.textContent = "Errores en auditoría";
    } else {
      btn.disabled = false;
      btn.className =
        "px-4 py-2 rounded-lg bg-emerald-600 text-white font-semibold";
      btn.textContent = "Guardar operación";
    }
  }

  function engancharEventos() {
    const camposCriticos = [
      "operador",
      "solicitante",
      "origen",
      "total_factura",
      "concil_deposito"
    ];

    camposCriticos.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;

      el.addEventListener("input", evaluarAuditoria);
      el.addEventListener("change", evaluarAuditoria);
    });

    // Integraciones automáticas
    if (window.ExcelLogic) {
      const original = window.ExcelLogic.recalcularExcelLogic;
      window.ExcelLogic.recalcularExcelLogic = function () {
        original();
        evaluarAuditoria();
      };
    }

    if (window.Conciliacion) {
      const original = window.Conciliacion.recalcularConciliacion;
      window.Conciliacion.recalcularConciliacion = function () {
        original();
        evaluarAuditoria();
      };
    }

    if (window.Distribucion) {
      const original = window.Distribucion.recalcularDistribucion;
      window.Distribucion.recalcularDistribucion = function () {
        original();
        evaluarAuditoria();
      };
    }

    evaluarAuditoria();
  }

  function initAuditoria() {
    engancharEventos();
  }

  window.Auditoria = {
    initAuditoria,
    evaluarAuditoria,
  };
})(window);
