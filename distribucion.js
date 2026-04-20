// distribucion.js
// Lógica de distribución del retorno: suma todas las partidas
// y las compara contra monto_retorno (calculado en excelLogic.js)

(function (window) {
  // Campos que participan en la distribución
  const CAMPOS_DISTRIBUCION = [
    // Retornos directos
    "ret_efectivo_fiscal",
    "ret_efectivo_excedente",
    "ret_dispersion_fiscal",
    "ret_dispersion_excedente",
    "ret_cheque_fiscal",
    "ret_cheque_excedente",

    // Categorías de clasificación
    "cat_excedente",
    "cat_asimilado",
    "cat_remanente",
    "cat_dividendo",
    "cat_no_retornada",
    "cat_financiamiento",
    "cat_resguardo",
    "cat_devoluciones",
    "cat_estado_cuenta",
    "cat_pagos_duplicados",
  ];

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

  function setEstadoDistribucion(texto, tipo) {
    const box = document.getElementById("distrib_estado");
    if (!box) return;

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

    box.textContent = texto;
  }

  function recalcularDistribucion() {
    const montoRetorno = getNum("monto_retorno"); // viene de excelLogic
    let sumaDistribucion = 0;

    CAMPOS_DISTRIBUCION.forEach((id) => {
      sumaDistribucion += getNum(id);
    });

    // Mostrar la suma total de la distribución
    setNum("distrib_total", sumaDistribucion);

    if (!montoRetorno && !sumaDistribucion) {
      setNum("distrib_diferencia", 0);
      setEstadoDistribucion("Sin distribución registrada", "neutral");
      return;
    }

    const diferencia = sumaDistribucion - montoRetorno;
    setNum("distrib_diferencia", diferencia);

    const absDif = Math.abs(diferencia);

    if (absDif < 0.5) {
      setEstadoDistribucion("Distribución correcta (cuadra con el retorno).", "ok");
    } else if (absDif < 50) {
      setEstadoDistribucion(
        "Diferencia menor: revisar redondeos o partidas pequeñas.",
        "warn"
      );
    } else {
      setEstadoDistribucion(
        "Diferencia importante: revisar distribución vs monto de retorno.",
        "error"
      );
    }
  }

  function initDistribucion() {
    // Enganchar eventos a todos los campos de distribución
    CAMPOS_DISTRIBUCION.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", recalcularDistribucion);
      el.addEventListener("change", recalcularDistribucion);
    });

    // Cada vez que se recalcule la lógica de Excel, volvemos a validar distribución
    if (
      window.ExcelLogic &&
      typeof window.ExcelLogic.recalcularExcelLogic === "function"
    ) {
      const original = window.ExcelLogic.recalcularExcelLogic;
      window.ExcelLogic.recalcularExcelLogic = function () {
        // primero hace todo lo que ya hacía (IVA, comisión, conciliación si ya está envuelta)
        original();
        // luego recalculamos la distribución con el nuevo monto_retorno
        recalcularDistribucion();
      };
    }

    // Cálculo inicial por si hay datos precargados
    recalcularDistribucion();
  }

  window.Distribucion = {
    initDistribucion,
    recalcularDistribucion,
  };
})(window);
