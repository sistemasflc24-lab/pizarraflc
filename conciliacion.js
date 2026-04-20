// conciliacion.js
// Lógica de conciliación bancaria: compara depósito vs total facturado.

(function (window) {
  function getNum(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    const v = el.value.replace(/,/g, "").trim();
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function setNum(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value === null || value === undefined || isNaN(value)) {
      el.value = "";
      return;
    }
    el.value = Number(value.toFixed(2));
  }

  function setEstadoConciliacion(texto, tipo) {
    const box = document.getElementById("concil_estado");
    if (!box) return;

    box.textContent = texto;

    // Estilos básicos según tipo
    const base = "mt-1 px-3 py-2 rounded-lg text-xs font-semibold ";
    if (tipo === "ok") {
      box.className = base + "bg-emerald-100 text-emerald-700";
    } else if (tipo === "warn") {
      box.className = base + "bg-amber-100 text-amber-700";
    } else if (tipo === "error") {
      box.className = base + "bg-rose-100 text-rose-700";
    } else {
      box.className = base + "bg-slate-100 text-slate-700";
    }
  }

  function recalcularConciliacion() {
    const totalFactura = getNum("total_factura");
    const deposito = getNum("concil_deposito");

    // Reflejamos el total facturado en el campo de referencia
    setNum("concil_total_factura", totalFactura);

    if (!totalFactura && !deposito) {
      setNum("concil_diferencia", 0);
      setEstadoConciliacion("Sin conciliar", "neutral");
      return;
    }

    const diferencia = deposito - totalFactura;
    setNum("concil_diferencia", diferencia);

    const absDif = Math.abs(diferencia);

    if (absDif < 0.5) {
      setEstadoConciliacion("Conciliación perfecta", "ok");
    } else if (absDif < 50) {
      setEstadoConciliacion(
        "Diferencia menor: revisar redondeos, comisiones bancarias, etc.",
        "warn"
      );
    } else {
      setEstadoConciliacion(
        "Diferencia importante: revisar montos de factura y depósito.",
        "error"
      );
    }
  }

  function initConciliacion() {
    const deposito = document.getElementById("concil_deposito");
    if (deposito) {
      deposito.addEventListener("input", recalcularConciliacion);
      deposito.addEventListener("change", recalcularConciliacion);
    }

    // Cada vez que se recalcule la lógica de Excel, volvemos a conciliar
    if (window.ExcelLogic && typeof window.ExcelLogic.recalcularExcelLogic === "function") {
      const original = window.ExcelLogic.recalcularExcelLogic;
      window.ExcelLogic.recalcularExcelLogic = function () {
        original();
        recalcularConciliacion();
      };
    }

    // Conciliamos una vez al inicio
    recalcularConciliacion();
  }

  window.Conciliacion = {
    initConciliacion,
    recalcularConciliacion,
  };
})(window);
