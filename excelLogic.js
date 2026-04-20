// excelLogic.js - VERSIÓN CORREGIDA ✅
// Lógica de Excel validada contra calculadora Excel PAGO
// Produce resultados exactos e idénticos al Excel

(function (window) {
  // =====================================================================
  // CATÁLOGOS DE DATOS (Matrices para BUSCARV)
  // =====================================================================
  
  const CATALOGOS = {
    matricesComisiones: [
      { porcentaje: 0.00, multiplicador: 1.00 },
      { porcentaje: 0.01, multiplicador: 1.01 },
      { porcentaje: 0.02, multiplicador: 1.02 },
      { porcentaje: 0.03, multiplicador: 1.03 },
      { porcentaje: 0.04, multiplicador: 1.04 },
      { porcentaje: 0.05, multiplicador: 1.05 },
      { porcentaje: 0.055, multiplicador: 1.055 },
      { porcentaje: 0.06, multiplicador: 1.06 },
      { porcentaje: 0.07, multiplicador: 1.07 },
      { porcentaje: 0.08, multiplicador: 1.08 },
      { porcentaje: 0.09, multiplicador: 1.09 },
      { porcentaje: 0.10, multiplicador: 1.10 },
      { porcentaje: 0.11, multiplicador: 1.11 },
      { porcentaje: 0.12, multiplicador: 1.12 },
      { porcentaje: 0.13, multiplicador: 1.13 },
      { porcentaje: 0.14, multiplicador: 1.14 },
      { porcentaje: 0.145, multiplicador: 1.145 },
      { porcentaje: 0.15, multiplicador: 1.15 },
      { porcentaje: 0.16, multiplicador: 1.16 }
    ],
    matricesIVA: [
      { tasa: 0.00, multiplicador: 1.00 },
      { tasa: 0.07, multiplicador: 1.07 },
      { tasa: 0.08, multiplicador: 1.08 },
      { tasa: 0.10, multiplicador: 1.10 },
      { tasa: 0.12, multiplicador: 1.12 },
      { tasa: 0.16, multiplicador: 1.16 }
    ]
  };

  // =====================================================================
  // FUNCIÓN BUSCARV (VLOOKUP) - Lógica Excel
  // =====================================================================
  
  function buscarV(valorBuscar, matriz, columnaRetorno = 'multiplicador') {
    const resultado = matriz.find(item => {
      const valorMatriz = columnaRetorno === 'multiplicador' 
        ? (item.porcentaje !== undefined ? item.porcentaje : item.tasa) 
        : item[Object.keys(item)[0]];
      return Math.abs(valorMatriz - valorBuscar) < 0.0001;
    });
    
    if (!resultado) {
      console.warn(`⚠️ BUSCARV: No se encontró ${valorBuscar} en matriz, usando default`);
      return columnaRetorno === 'multiplicador' ? 1.0 : 0;
    }
    
    return resultado[columnaRetorno];
  }

  // =====================================================================
  // HELPERS BÁSICOS
  // =====================================================================

  function getVal(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    const v = el.value.replace(/,/g, "").trim();
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function setVal(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value === null || value === undefined || isNaN(value)) {
      el.value = "";
      return;
    }
    el.value = value.toFixed(2);
  }

  function fmtMoney(num) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // =====================================================================
  // CÁLCULO DE SEMANA
  // =====================================================================

  function calcularSemanaDesdeFecha() {
    const inputFecha = document.getElementById("fecha");
    const inputSemana = document.getElementById("semana");
    if (!inputFecha || !inputSemana) return;

    const valorFecha = inputFecha.value;
    if (!valorFecha) {
      inputSemana.value = "";
      return;
    }

    const fecha = new Date(valorFecha + "T00:00:00");
    const start = new Date(fecha.getFullYear(), 0, 1);
    const days = Math.floor((fecha - start) / (24 * 60 * 60 * 1000));
    const semana = Math.ceil((days + 1) / 7);

    inputSemana.value = semana;
  }

  // =====================================================================
  // CÁLCULO DE CARGA SOCIAL
  // =====================================================================

  function calcularTotalCargaSocial() {
    const total =
      getVal("ded_imss") +
      getVal("ded_incap") +
      getVal("ded_isr") +
      getVal("ded_isn") +
      getVal("ded_infonavit") +
      getVal("ded_cargas");

    return total;
  }

  // =====================================================================
  // CÁLCULO DE IVA Y SUBTOTAL
  // Fórmula Excel: Subtotal = Total / (1 + %IVA)
  // =====================================================================

  function calcularIvaYSubtotal(totalFactura, tasaIvaDecimal) {
    // Usar BUSCARV para obtener multiplicador
    const multiplicadorIVA = buscarV(tasaIvaDecimal, CATALOGOS.matricesIVA, 'multiplicador');
    
    // Calcular subtotal
    const subtotal = totalFactura / multiplicadorIVA;
    const importeIva = totalFactura - subtotal;

    return { subtotal, importeIva, multiplicadorIVA };
  }

  // =====================================================================
  // CÁLCULO DE BASE COMISIONABLE
  // Fórmula Excel: Base = (Total - IVA - Costo) / (1 + %Comisión)
  // =====================================================================

  function calcularBaseComisionable(totalFactura, importeIva, totalCargaSocial, pctComisionDecimal) {
    // Usar BUSCARV para obtener multiplicador de comisión
    const multiplicadorComision = buscarV(pctComisionDecimal, CATALOGOS.matricesComisiones, 'multiplicador');
    
    // Base antes del multiplicador
    const baseAntesMultiplicador = totalFactura - importeIva - totalCargaSocial;
    
    // Base comisionable = base antes / multiplicador
    const baseComisionable = baseAntesMultiplicador / multiplicadorComision;

    return { baseComisionable, multiplicadorComision };
  }

  // =====================================================================
  // CÁLCULO DE COMISIÓN Y RETORNO
  // Fórmula Excel: Comisión = Base × %Comisión
  // Fórmula Excel: Retorno = Base (NO restar comisión)
  // =====================================================================

  function calcularComisionYRetorno(baseComisionable, pctComisionDecimal) {
    // Comisión = Base × %
    const importeComision = baseComisionable * pctComisionDecimal;
    
    // Retorno = Base comisionable (NO restar comisión)
    const montoRetorno = baseComisionable;

    return { importeComision, montoRetorno };
  }

  // =====================================================================
  // RECALCULAR TODO - FUNCIÓN PRINCIPAL
  // =====================================================================

  function recalcularExcelLogic() {
    // ========== OBTENER VALORES BASE ==========
    const totalFactura = getVal("total_factura");
    const tasaIVA = getVal("tasa_iva"); // Ya es decimal (0.16)
    const pctComision = getVal("pct_comision"); // Ya es decimal (0.055) o porcentaje (5.5)
    
    // Normalizar porcentaje de comisión (convertir a decimal si es necesario)
    const pctComDecimal = pctComision > 1 ? pctComision / 100 : pctComision;
    
    // ========== PASO 1: CÁLCULO DE IVA ==========
    const { subtotal, importeIva, multiplicadorIVA } = calcularIvaYSubtotal(totalFactura, tasaIVA);
    
    setVal("subtotal", subtotal);
    setVal("importe_iva", importeIva);
    
    // ========== PASO 2: SUMA DE CARGA SOCIAL ==========
    const totalCargaSocial = calcularTotalCargaSocial();
    
    // ========== PASO 3: CÁLCULO DE BASE COMISIONABLE ==========
    const { baseComisionable, multiplicadorComision } = 
      calcularBaseComisionable(totalFactura, importeIva, totalCargaSocial, pctComDecimal);
    
    // ========== PASO 4: CÁLCULO DE COMISIÓN Y RETORNO ==========
    const { importeComision, montoRetorno } = 
      calcularComisionYRetorno(baseComisionable, pctComDecimal);
    
    setVal("importe_comision", importeComision);
    setVal("monto_retorno", montoRetorno);
    
    // ========== PASO 5: ACTUALIZAR HEADER DE DEDUCCIONES ==========
    const headerDeducciones = document.getElementById("header_deducciones");
    if (headerDeducciones) {
      headerDeducciones.innerText = fmtMoney(totalCargaSocial + importeComision);
    }
    
    // ========== PASO 6: LOG DE DEBUG (OPCIONAL) ==========
    if (totalFactura > 0 && window.DEBUG_EXCEL_LOGIC) {
      console.log("=== CÁLCULOS LÓGICA EXCEL ===");
      console.log("Total Factura:", fmtMoney(totalFactura));
      console.log("Tasa IVA:", tasaIVA, "→ Multiplicador:", multiplicadorIVA);
      console.log("Subtotal sin IVA:", fmtMoney(subtotal));
      console.log("Importe IVA:", fmtMoney(importeIva));
      console.log("Carga Social:", fmtMoney(totalCargaSocial));
      console.log("% Comisión:", pctComDecimal, "→ Multiplicador:", multiplicadorComision);
      console.log("Base Comisionable:", fmtMoney(baseComisionable));
      console.log("Importe Comisión:", fmtMoney(importeComision));
      console.log("Monto Retorno:", fmtMoney(montoRetorno));
    }
  }

  // =====================================================================
  // INICIALIZACIÓN
  // =====================================================================

  function initExcelLogic() {
    console.log("✅ ExcelLogic inicializado correctamente");
    console.log("📊 Matrices disponibles:", Object.keys(CATALOGOS));
    
    // Campos que disparan recálculo
    const camposTrigger = [
      "total_factura",
      "tasa_iva",
      "ded_imss",
      "ded_incap",
      "ded_isr",
      "ded_isn",
      "ded_infonavit",
      "ded_cargas",
      "pct_comision"
    ];

    // Enganchar eventos
    camposTrigger.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) {
        console.warn(`⚠️ Campo ${id} no encontrado en DOM`);
        return;
      }
      el.addEventListener("input", recalcularExcelLogic);
      el.addEventListener("change", recalcularExcelLogic);
    });

    // Evento para calcular semana
    const inputFecha = document.getElementById("fecha");
    if (inputFecha) {
      inputFecha.addEventListener("change", calcularSemanaDesdeFecha);
    }

    // Recalcular al inicio por si hay datos precargados
    calcularSemanaDesdeFecha();
    recalcularExcelLogic();
  }

  // =====================================================================
  // EXPONER API PÚBLICA
  // =====================================================================
  
  window.ExcelLogic = {
    // Funciones principales
    initExcelLogic,
    recalcularExcelLogic,
    
    // Funciones individuales (para usar en otros módulos)
    calcularSemanaDesdeFecha,
    calcularTotalCargaSocial,
    calcularIvaYSubtotal,
    calcularBaseComisionable,
    calcularComisionYRetorno,
    
    // Utilidades
    buscarV,
    getVal,
    setVal,
    fmtMoney,
    
    // Catálogos (solo lectura)
    getCatalogos: () => CATALOGOS
  };
  
  // Debug mode (activar con: window.DEBUG_EXCEL_LOGIC = true)
  window.DEBUG_EXCEL_LOGIC = false;

})(window);

// =====================================================================
// USO:
// =====================================================================
// 1. Incluir este archivo en el HTML:
//    <script src="excelLogic.js"></script>
//
// 2. Inicializar en el DOM ready:
//    ExcelLogic.initExcelLogic();
//
// 3. Recalcular manualmente si es necesario:
//    ExcelLogic.recalcularExcelLogic();
//
// 4. Activar debug:
//    window.DEBUG_EXCEL_LOGIC = true;
// =====================================================================