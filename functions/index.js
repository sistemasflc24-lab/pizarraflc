"use strict";

const crypto = require("crypto");
const path = require("path");
const unzipper = require("unzipper");
const functionsV1 = require("firebase-functions/v1");
const admin = require("firebase-admin");
const vision = require("@google-cloud/vision");
const pdfParse = require("pdf-parse");
const { DocumentProcessorServiceClient } = require("@google-cloud/documentai").v1;
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const auth = admin.auth();
const storage = admin.storage();
const visionClient = new vision.ImageAnnotatorClient();
const documentAiClient = new DocumentProcessorServiceClient();

const GI_USERS_COLLECTION = "gi_usuarios";
const MAIN_USERS_COLLECTION = "usuarios";
const ACTIVE_STATUS = "active";
const ALLOWED_ROLES = new Set([
  "operaciones",
  "tesoreria",
  "admin",
  "administrativo",
]);
const REGION = "us-central1";
const OCR_ALLOWED_ROLES = new Set(["admin", "tesoreria", "efectivos"]);
const OCR_MAX_ZIP_FILES = 25;
const OCR_MAX_PDF_PAGES = 20;
const OCR_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const OCR_MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const OCR_AUTO_PROCESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const OCR_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const OCR_DIRECT_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf", ".zip"]);
const OCR_PDF_MIME_TYPES = new Set(["application/pdf"]);

const TELEGRAM_API = "https://api.telegram.org";
const SOLS_GI_COLLECTION = "solicitudes_gastos";
const TELEGRAM_NOTIFY_STATUSES = new Set(["orden", "pre-autorizado"]);
const TELEGRAM_APPROVER_ROLES = new Set(["admin", "administrativo"]);
const MOBILE_GI_URL = "https://pizarraflc.web.app/movil_gi.html";
const runtimeConfig = (() => {
  try {
    return process.env.CLOUD_RUNTIME_CONFIG ? JSON.parse(process.env.CLOUD_RUNTIME_CONFIG) : {};
  } catch (error) {
    console.warn("No se pudo leer CLOUD_RUNTIME_CONFIG:", error?.message || error);
    return {};
  }
})();
const ocrConfig = runtimeConfig.ocr || {};
const OCR_DOCUMENT_AI_PROJECT_ID =
  process.env.OCR_DOCUMENT_AI_PROJECT_ID ||
  ocrConfig.project_id ||
  ocrConfig.projectId ||
  ocrConfig.project ||
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  null;
const OCR_DOCUMENT_AI_LOCATION = process.env.OCR_DOCUMENT_AI_LOCATION || ocrConfig.location || "us";
const OCR_DOCUMENT_AI_PROCESSOR_ID =
  process.env.OCR_DOCUMENT_AI_PROCESSOR_ID ||
  ocrConfig.processor_id ||
  ocrConfig.processorId ||
  ocrConfig.processor ||
  null;
// Tolerancia máxima aceptada entre el monto del comprobante y el de la dispersión.
// $1.00 MXN cubre redondeos de centavos en nómina y variaciones mínimas de OCR.
// El resultado se marca "matched_approx" (no "matched") para distinguirlo en auditoría.
const AMOUNT_TOLERANCE_CENTS = 100; // $1.00 MXN

const OCR_BANK_ALIASES = {
  BBVA: ["BBVA", "BANCOMER"],
  SANTANDER: ["SANTANDER"],
  BANORTE: ["BANORTE"],
  HSBC: ["HSBC"],
  SCOTIABANK: ["SCOTIABANK", "SCOTIA"],
  BANAMEX: ["BANAMEX", "CITIBANAMEX", "CITI BANAMEX"],
  AZTECA: ["AZTECA", "BANCO AZTECA"],
  INBURSA: ["INBURSA"],
};

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase() === ACTIVE_STATUS
    ? ACTIVE_STATUS
    : "disabled";
}

function asTrimmedString(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new HttpsError("invalid-argument", `El campo ${fieldName} es obligatorio.`);
  }
  return normalized;
}

function normalizeUid(value) {
  return asTrimmedString(value, "uid");
}

function normalizeRole(value) {
  const role = asTrimmedString(value, "role").toLowerCase();
  if (!ALLOWED_ROLES.has(role)) {
    throw new HttpsError("invalid-argument", "El rol solicitado no es valido para Gastos Internos.");
  }
  return role;
}

function normalizeEmail(value) {
  const email = asTrimmedString(value, "email").toLowerCase();
  const simpleEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!simpleEmailPattern.test(email)) {
    throw new HttpsError("invalid-argument", "El email no tiene un formato valido.");
  }
  return email;
}

function normalizeOperatorId(value) {
  const numeroOperador = asTrimmedString(value, "numeroOperador");
  if (numeroOperador.length > 40) {
    throw new HttpsError("invalid-argument", "El ID de operador es demasiado largo.");
  }
  return numeroOperador;
}

function normalizePassword(value) {
  const password = String(value || "");
  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "La contrasena debe tener al menos 6 caracteres.");
  }
  return password;
}

function optionalPassword(value) {
  const raw = String(value || "");
  if (!raw.trim()) return null;
  return normalizePassword(raw);
}

async function assertGiAdmin(uid) {
  const callerSnap = await db.collection(GI_USERS_COLLECTION).doc(uid).get();
  if (!callerSnap.exists) {
    throw new HttpsError("permission-denied", "Tu cuenta no tiene permisos de administracion GI.");
  }

  const caller = callerSnap.data() || {};
  const callerRole = String(caller.role || "").trim().toLowerCase();
  const callerStatus = normalizeStatus(caller.status);
  if (callerRole !== "admin" || callerStatus !== ACTIVE_STATUS) {
    throw new HttpsError("permission-denied", "Solo un admin activo de Gastos Internos puede administrar usuarios.");
  }

  return caller;
}

async function assertMainAppAdmin(uid) {
  const callerSnap = await db.collection(MAIN_USERS_COLLECTION).doc(uid).get();
  if (!callerSnap.exists) {
    throw new HttpsError("permission-denied", "Tu cuenta no tiene permisos de administracion.");
  }

  const caller = callerSnap.data() || {};
  const callerRole = String(caller.role || "").trim().toLowerCase();
  const callerStatus = normalizeStatus(caller.status);
  if (callerRole !== "admin" || callerStatus !== ACTIVE_STATUS) {
    throw new HttpsError("permission-denied", "Solo un admin activo puede ejecutar esta accion.");
  }

  return caller;
}

async function getGiUserSnapshot(uid) {
  const snap = await db.collection(GI_USERS_COLLECTION).doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "El usuario GI solicitado no existe.");
  }
  return snap;
}

async function getAuthUser(uid) {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (String(error?.code || "") === "auth/user-not-found") {
      throw new HttpsError("not-found", "El usuario no existe en Firebase Authentication.");
    }
    throw mapAuthError(error, "No se pudo leer el usuario en Firebase Authentication.");
  }
}

async function collectConflictingGiDocs(fieldName, expectedValue, ignoreUid = null) {
  const snapshot = await db
    .collection(GI_USERS_COLLECTION)
    .where(fieldName, "==", expectedValue)
    .limit(10)
    .get();

  const tempRefs = new Map();
  for (const doc of snapshot.docs) {
    if (doc.id === ignoreUid) continue;

    if (doc.id.startsWith("user-temp-")) {
      tempRefs.set(doc.id, doc.ref);
      continue;
    }

    throw new HttpsError("already-exists", `Ya existe un usuario GI con ${fieldName} = ${expectedValue}.`);
  }

  return tempRefs;
}

async function assertGiIdentityIsUnique({ email, numeroOperador, ignoreUid = null }) {
  const tempRefs = new Map();

  for (const [id, ref] of await collectConflictingGiDocs("numeroOperador", numeroOperador, ignoreUid)) {
    tempRefs.set(id, ref);
  }
  for (const [id, ref] of await collectConflictingGiDocs("email", email, ignoreUid)) {
    tempRefs.set(id, ref);
  }

  return tempRefs;
}

function mapAuthError(error, fallbackMessage) {
  const code = String(error?.code || "");
  if (code === "auth/email-already-exists") {
    return new HttpsError("already-exists", "Ese email ya existe en Firebase Authentication.");
  }
  if (code === "auth/invalid-password") {
    return new HttpsError("invalid-argument", "La contrasena no cumple las reglas de Firebase Authentication.");
  }
  if (code === "auth/invalid-email") {
    return new HttpsError("invalid-argument", "El email no es valido para Firebase Authentication.");
  }
  if (code === "auth/user-not-found") {
    return new HttpsError("not-found", "El usuario no existe en Firebase Authentication.");
  }
  return new HttpsError("internal", error?.message || fallbackMessage);
}

async function restoreGiProfile(uid, previousProfile) {
  await db.collection(GI_USERS_COLLECTION).doc(uid).set(previousProfile, { merge: false });
}

function buildCreateProfilePayload({ uid, name, role, numeroOperador, status, email, actorUid }) {
  return {
    name,
    role,
    numeroOperador,
    status,
    email,
    authUid: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: actorUid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: actorUid,
  };
}

function buildUpdateProfilePayload(previousProfile, { uid, name, role, numeroOperador, status, email, actorUid }) {
  return {
    ...previousProfile,
    name,
    role,
    numeroOperador,
    status,
    email,
    authUid: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: actorUid,
  };
}

function normalizeBusinessText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function isDispersionValue(value) {
  return normalizeBusinessText(value) === "DISPERSION";
}

function getAttachmentDescriptor(objectName) {
  const normalizedPath = String(objectName || "").replace(/^\/+/, "");
  if (!normalizedPath) return null;

  if (normalizedPath.startsWith("comprobantes_tesoreria/")) {
    const parts = normalizedPath.split("/");
    if (parts.length < 3) return null;
    return {
      sourcePath: normalizedPath,
      solicitudId: parts[1],
      sourceType: "tesoreria",
    };
  }

  return null;
}

function isOcrAutoProcessFresh(objectTimeCreated) {
  const rawTime = String(objectTimeCreated || "").trim();
  if (!rawTime) return true;

  const createdAt = Date.parse(rawTime);
  if (!Number.isFinite(createdAt)) return true;

  return Date.now() - createdAt <= OCR_AUTO_PROCESS_MAX_AGE_MS;
}

function makeOcrResultId(sourcePath) {
  return crypto.createHash("sha1").update(String(sourcePath || "")).digest("hex").slice(0, 32);
}

function detectMimeType(filePath, metadataContentType = null) {
  if (metadataContentType) return metadataContentType;

  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".zip") return "application/zip";
  return "application/octet-stream";
}

function buildStorageDownloadUrl(bucketName, objectName, metadata = null) {
  const tokenValue = String(metadata?.metadata?.firebaseStorageDownloadTokens || "")
    .split(",")
    .map((token) => token.trim())
    .find(Boolean);

  if (!tokenValue) return null;

  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectName)}?alt=media&token=${tokenValue}`;
}

function countPdfPages(buffer) {
  const content = buffer.toString("latin1");
  const matches = content.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 1;
}

function truncateText(value, maxLength = 1000) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeAmount(value) {
  const parsed = Number.parseFloat(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(2));
}

function amountToCents(value) {
  const normalized = normalizeAmount(value);
  if (normalized === null) return null;
  return Math.round(normalized * 100);
}

function extractStoragePathFromUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const match = parsed.pathname.match(/\/o\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch (error) {
    return "";
  }
}

function extractAmountsFromText(rawText) {
  const text = String(rawText || "");
  // Grupo 1: con prefijo de moneda → captura todos los dígitos/comas seguidos de decimales opcionales
  //   ej: "$ 300000" → 300000 | "$300,000.00" → 300000.00 | "$ 300000 MXN" → 300000
  // Grupo 2: sin prefijo de moneda → requiere decimales para evitar capturar números de cuenta/clabe
  const regex = /(?:MXN|M\.?N\.?|USD|US\$|\$)\s*(\d[\d,]*(?:\.\d{2})?)|(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})/g;
  const found = new Set();
  const amounts = [];

  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1] ?? match[2];
    const amount = normalizeAmount(raw);
    if (amount === null || amount <= 0) continue;
    const key = amount.toFixed(2);
    if (found.has(key)) continue;
    found.add(key);
    amounts.push(amount);
  }

  return amounts;
}

function getCanonicalBankName(value) {
  const normalized = normalizeBusinessText(value);
  if (!normalized) return null;

  for (const [bank, aliases] of Object.entries(OCR_BANK_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return bank;
    }
  }

  return normalized;
}

function detectBanksInText(rawText) {
  const normalizedText = normalizeBusinessText(rawText);
  if (!normalizedText) return [];

  const banks = [];
  for (const [bank, aliases] of Object.entries(OCR_BANK_ALIASES)) {
    if (aliases.some((alias) => normalizedText.includes(alias))) {
      banks.push(bank);
    }
  }

  return [...new Set(banks)];
}

function normalizeDispersiones(dispersiones) {
  return Array.isArray(dispersiones)
    ? dispersiones.map((item, index) => ({
      index,
      bank: getCanonicalBankName(item?.fuente || item?.banco || ""),
      amount: normalizeAmount(item?.monto),
    }))
    : [];
}

function matchOcrAgainstDispersiones(solicitud, detectedBanks, detectedAmounts) {
  const dispersiones = normalizeDispersiones(solicitud?.dispersiones || []);
  const normalizedBanks = [...new Set((detectedBanks || []).map((bank) => getCanonicalBankName(bank)).filter(Boolean))];
  const normalizedAmounts = [...new Set((detectedAmounts || []).map((amount) => normalizeAmount(amount)).filter((amount) => amount !== null))];

  if (!dispersiones.length || !normalizedAmounts.length && !normalizedBanks.length) {
    return {
      matchedDispersionIndex: null,
      matchedBank: null,
      matchedAmount: null,
      result: "no_match",
      confidence: 0.15,
    };
  }

  const exactCandidates = [];
  const amountCandidates = [];
  const amountOnlyCandidates = [];
  const bankMismatchCandidates = [];

  dispersiones.forEach((dispersion) => {
    if (!dispersion.bank || dispersion.amount === null) return;

    const amountMatched = normalizedAmounts.some((amount) => Math.abs(amount - dispersion.amount) <= 0.01);
    const bankMatched = normalizedBanks.includes(dispersion.bank);

    if (amountMatched && bankMatched) {
      exactCandidates.push(dispersion);
    } else if (amountMatched && normalizedBanks.length === 0) {
      amountCandidates.push(dispersion);
    } else if (amountMatched) {
      amountOnlyCandidates.push(dispersion);
    } else if (bankMatched && !amountMatched) {
      bankMismatchCandidates.push(dispersion);
    }
  });

  if (exactCandidates.length === 1) {
    const match = exactCandidates[0];
    return {
      matchedDispersionIndex: match.index,
      matchedBank: match.bank,
      matchedAmount: match.amount,
      result: "exact_match",
      confidence: 0.96,
    };
  }

  if (exactCandidates.length > 1) {
    return {
      matchedDispersionIndex: null,
      matchedBank: null,
      matchedAmount: null,
      result: "ambiguous",
      confidence: 0.52,
    };
  }

  if (amountCandidates.length === 1) {
    const match = amountCandidates[0];
    return {
      matchedDispersionIndex: match.index,
      matchedBank: match.bank,
      matchedAmount: match.amount,
      result: "amount_match_bank_unknown",
      confidence: 0.82,
    };
  }

  if (amountCandidates.length > 1) {
    return {
      matchedDispersionIndex: null,
      matchedBank: null,
      matchedAmount: null,
      result: "ambiguous",
      confidence: 0.48,
    };
  }

  if (amountOnlyCandidates.length === 1) {
    const match = amountOnlyCandidates[0];
    return {
      matchedDispersionIndex: match.index,
      matchedBank: match.bank,
      matchedAmount: match.amount,
      result: "amount_only_match",
      confidence: 0.88,
    };
  }

  if (amountOnlyCandidates.length > 1) {
    return {
      matchedDispersionIndex: null,
      matchedBank: null,
      matchedAmount: null,
      result: "ambiguous",
      confidence: 0.46,
    };
  }

  if (bankMismatchCandidates.length === 1) {
    const match = bankMismatchCandidates[0];
    return {
      matchedDispersionIndex: match.index,
      matchedBank: match.bank,
      matchedAmount: match.amount,
      result: "bank_match_amount_mismatch",
      confidence: 0.72,
    };
  }

  if (bankMismatchCandidates.length > 1) {
    return {
      matchedDispersionIndex: null,
      matchedBank: null,
      matchedAmount: null,
      result: "ambiguous",
      confidence: 0.44,
    };
  }

  return {
    matchedDispersionIndex: null,
    matchedBank: null,
    matchedAmount: null,
    result: "no_match",
    confidence: 0.2,
  };
}

function getActiveTreasurySourcePaths(solicitud) {
  const urls = [];
  if (Array.isArray(solicitud?.comprobanteTesoreriaURLs)) {
    urls.push(...solicitud.comprobanteTesoreriaURLs);
  }
  if (solicitud?.comprobanteTesoreriaURL) {
    urls.push(solicitud.comprobanteTesoreriaURL);
  }

  return new Set(
    urls
      .map((url) => extractStoragePathFromUrl(url))
      .filter((value) => value.startsWith("comprobantes_tesoreria/"))
  );
}

function getTreasuryTopLevelResults(results, solicitud) {
  const activePaths = getActiveTreasurySourcePaths(solicitud);
  return results.filter((item) => {
    if (String(item?.sourceType || "") !== "tesoreria") return false;
    const sourcePath = String(item?.sourcePath || "");
    if (!sourcePath.startsWith("comprobantes_tesoreria/")) return false;
    return activePaths.size === 0 || activePaths.has(sourcePath);
  });
}

function getLeafTreasuryResults(results, solicitud) {
  const topLevelResults = getTreasuryTopLevelResults(results, solicitud);
  const topLevelPaths = new Set(topLevelResults.map((item) => String(item.sourcePath || "")).filter(Boolean));
  const zipEntries = results.filter((item) => {
    if (String(item?.sourceType || "") !== "zip_entry") return false;
    return topLevelPaths.has(String(item?.parentSourcePath || ""));
  });
  const parentPathsWithChildren = new Set(zipEntries.map((item) => String(item.parentSourcePath || "")).filter(Boolean));
  const standaloneTopLevel = topLevelResults.filter((item) => !parentPathsWithChildren.has(String(item.sourcePath || "")));
  return [...standaloneTopLevel, ...zipEntries];
}

function getResultAmountCandidates(result) {
  const values = Array.isArray(result?.amountsDetected) ? result.amountsDetected : [];
  const normalized = [...new Set(values
    .map((value) => amountToCents(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
  return normalized.sort((a, b) => b - a);
}

function findExactAmountCombinations(entries, targetCents, maxSolutions = 2, toleranceCents = AMOUNT_TOLERANCE_CENTS) {
  const orderedEntries = [...entries].sort((a, b) => {
    const aMax = a.amountsCents[0] || 0;
    const bMax = b.amountsCents[0] || 0;
    return bMax - aMax;
  });
  const solutions = [];

  function walk(index, sumCents, selected) {
    if (solutions.length >= maxSolutions) return;
    const diff = Math.abs(sumCents - targetCents);
    if (diff <= toleranceCents && sumCents > 0) {
      solutions.push(selected.map((item) => ({ ...item, isApprox: diff > 0 })));
      return;
    }
    if (sumCents > targetCents + toleranceCents || index >= orderedEntries.length) return;

    walk(index + 1, sumCents, selected);
    if (solutions.length >= maxSolutions) return;

    const entry = orderedEntries[index];
    for (const amountCents of entry.amountsCents) {
      if (sumCents + amountCents > targetCents + toleranceCents) continue;
      selected.push({
        sourcePath: entry.sourcePath,
        amount: Number((amountCents / 100).toFixed(2)),
        isApprox: false,
      });
      walk(index + 1, sumCents + amountCents, selected);
      selected.pop();
      if (solutions.length >= maxSolutions) return;
    }
  }

  walk(0, 0, []);
  return solutions;
}

function buildAggregateDispersionValidation(solicitud, results) {
  const normalizedDispersiones = normalizeDispersiones(solicitud?.dispersiones || []);
  const leafResults = getLeafTreasuryResults(results, solicitud);
  const resultCandidates = leafResults.map((item) => ({
    sourcePath: String(item?.sourcePath || ""),
    processingStatus: String(item?.processingStatus || "").toLowerCase(),
    result: String(item?.result || "").toLowerCase(),
    bank: getCanonicalBankName(item?.bankDetected || item?.matchedBank || ""),
    amountsCents: getResultAmountCandidates(item),
    matchedDispersionIndex: item?.matchedDispersionIndex ?? null,
  })).filter((item) => item.sourcePath);

  const usedPaths = new Set();
  const states = normalizedDispersiones.map((dispersion) => {
    const state = {
      index: dispersion.index,
      bank: dispersion.bank || null,
      amount: dispersion.amount,
      detectedTotal: 0,
      status: "pending",
      matchedPaths: [],
      candidatePaths: [],
    };

    if (!dispersion.bank || dispersion.amount === null) {
      state.status = "review";
      return state;
    }

    const bankEntries = resultCandidates.filter((item) => {
      if (usedPaths.has(item.sourcePath)) return false;
      if (item.bank === dispersion.bank) return true;
      // Respaldo: el OCR ya determinó de forma única que el monto pertenece a esta
      // dispersión (amount_only_match, amount_match_bank_unknown) sin importar si el
      // banco fue detectado o no — cubre falsos negativos de banco y banco incorrecto
      if (item.matchedDispersionIndex === dispersion.index && item.matchedDispersionIndex !== null) return true;
      // Respaldo 2: archivo sin banco detectado — no se puede descartar por banco, se
      // incluye como candidato para matching por suma de montos (ej: 2 comprobantes
      // sin banco que suman exactamente el total de la dispersión).
      // NOTA: getCanonicalBankName("") devuelve null (no ""), por eso se usa !item.bank
      if (!item.bank && item.result !== "skipped_non_dispersion") return true;
      return false;
    });
    const pendingEntries = bankEntries.filter((item) => item.processingStatus === "queued" || item.processingStatus === "processing");
    const finishedEntries = bankEntries.filter((item) => item.processingStatus === "done" && item.amountsCents.length > 0);
    const targetCents = amountToCents(dispersion.amount);
    const matches = Number.isInteger(targetCents) ? findExactAmountCombinations(finishedEntries, targetCents) : [];

    if (matches.length === 1) {
      const uniqueMatch = matches[0];
      uniqueMatch.forEach((item) => usedPaths.add(item.sourcePath));
      const isApprox = uniqueMatch.some((item) => item.isApprox);
      state.status = isApprox ? "matched_approx" : "matched";
      const actualSumCents = uniqueMatch.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
      state.detectedTotal = Number((actualSumCents / 100).toFixed(2));
      state.matchedPaths = uniqueMatch.map((item) => item.sourcePath);
      return state;
    }

    if (matches.length > 1) {
      state.status = "review";
      state.candidatePaths = [...new Set(matches.flat().map((item) => item.sourcePath))];
      return state;
    }

    if (pendingEntries.length > 0) {
      state.status = "pending";
      state.candidatePaths = pendingEntries.map((item) => item.sourcePath);
      return state;
    }

    if (bankEntries.length > 0) {
      state.status = "review";
      state.detectedTotal = Number((finishedEntries.reduce((sum, item) => sum + (item.amountsCents[0] || 0), 0) / 100).toFixed(2));
      state.candidatePaths = bankEntries.map((item) => item.sourcePath);
      return state;
    }

    // Respaldo final: matching solo por monto, sin validación de banco.
    // Se activa cuando el filtro de banco no encontró candidatos — cubre el caso
    // donde el OCR detecta el banco DESTINO del comprobante en lugar del banco ORIGEN
    // (ej: comprobante SPEI muestra "Banco:BANORTE" pero la dispersión es de ASP INTEGRA).
    const amountOnlyEntries = resultCandidates.filter((item) => {
      if (usedPaths.has(item.sourcePath)) return false;
      if (item.result === "skipped_non_dispersion") return false;
      return true;
    });
    const amountOnlyPending = amountOnlyEntries.filter((item) => item.processingStatus === "queued" || item.processingStatus === "processing");
    const amountOnlyFinished = amountOnlyEntries.filter((item) => item.processingStatus === "done" && item.amountsCents.length > 0);
    const amountOnlyMatches = Number.isInteger(targetCents) ? findExactAmountCombinations(amountOnlyFinished, targetCents) : [];

    if (amountOnlyMatches.length === 1) {
      const uniqueMatch = amountOnlyMatches[0];
      uniqueMatch.forEach((item) => usedPaths.add(item.sourcePath));
      const isApprox = uniqueMatch.some((item) => item.isApprox);
      state.status = isApprox ? "matched_approx" : "matched";
      const actualSumCents = uniqueMatch.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
      state.detectedTotal = Number((actualSumCents / 100).toFixed(2));
      state.matchedPaths = uniqueMatch.map((item) => item.sourcePath);
      return state;
    }

    if (amountOnlyMatches.length > 1) {
      state.status = "review";
      state.candidatePaths = [...new Set(amountOnlyMatches.flat().map((item) => item.sourcePath))];
      return state;
    }

    if (amountOnlyPending.length > 0) {
      state.status = "pending";
      state.candidatePaths = amountOnlyPending.map((item) => item.sourcePath);
      return state;
    }

    state.status = "unmatched";
    return state;
  });

  const matchedPaths = new Set(states.flatMap((item) => Array.isArray(item.matchedPaths) ? item.matchedPaths : []));
  const reviewAttachmentPaths = resultCandidates
    .filter((item) => !matchedPaths.has(item.sourcePath))
    .filter((item) => item.processingStatus === "error" || item.processingStatus === "done" && item.result !== "skipped_non_dispersion")
    .map((item) => item.sourcePath);

  return {
    states,
    matchedPaths: [...matchedPaths],
    reviewAttachmentPaths: [...new Set(reviewAttachmentPaths)],
  };
}

async function assertMainAppOcrAccess(uid) {
  const userSnap = await db.collection(MAIN_USERS_COLLECTION).doc(uid).get();
  if (!userSnap.exists) {
    throw new HttpsError("permission-denied", "Tu cuenta no tiene permisos para reintentar OCR.");
  }

  const userData = userSnap.data() || {};
  const role = normalizeBusinessText(userData.role).toLowerCase();
  const status = normalizeStatus(userData.status);

  if (!OCR_ALLOWED_ROLES.has(role) || status !== ACTIVE_STATUS) {
    throw new HttpsError("permission-denied", "No tienes permisos para reintentar OCR.");
  }

  return userData;
}

async function loadSolicitudAndOperacion(solicitudId) {
  const solicitudRef = db.collection("solicitudes").doc(solicitudId);
  const solicitudSnap = await solicitudRef.get();
  if (!solicitudSnap.exists) {
    return {
      solicitudRef,
      solicitudSnap,
      solicitud: null,
      operacion: null,
      eligible: false,
      reason: "Solicitud no encontrada.",
    };
  }

  const solicitud = solicitudSnap.data() || {};
  if (!solicitud.operacionId) {
    return {
      solicitudRef,
      solicitudSnap,
      solicitud,
      operacion: null,
      eligible: false,
      reason: "La solicitud no tiene operacion asociada.",
    };
  }

  const operacionSnap = await db.collection("operaciones").doc(solicitud.operacionId).get();
  const operacion = operacionSnap.exists ? operacionSnap.data() || {} : null;
  if (!operacion) {
    return {
      solicitudRef,
      solicitudSnap,
      solicitud,
      operacion: null,
      eligible: false,
      reason: "Operacion no encontrada.",
    };
  }

  const metodoPagoOk = isDispersionValue(solicitud.metodo_pago);
  const retornoOk = isDispersionValue(operacion.retorno);

  return {
    solicitudRef,
    solicitudSnap,
    solicitud,
    operacion,
    eligible: metodoPagoOk && retornoOk,
    reason: metodoPagoOk && retornoOk
      ? null
      : "La solicitud u operacion no corresponde a DISPERSION.",
  };
}

async function writeOcrResult(solicitudId, sourcePath, payload) {
  const resultRef = db
    .collection("solicitudes")
    .doc(solicitudId)
    .collection("ocrResults")
    .doc(makeOcrResultId(sourcePath));

  await resultRef.set({
    sourcePath,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...payload,
    createdAt: payload.createdAt || admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return resultRef;
}

async function deleteNestedZipResults(solicitudId, sourcePath) {
  const resultsSnap = await db
    .collection("solicitudes")
    .doc(solicitudId)
    .collection("ocrResults")
    .where("parentSourcePath", "==", sourcePath)
    .get();

  if (resultsSnap.empty) return;

  const batch = db.batch();
  resultsSnap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

function getSummaryStatusFromAggregate(topLevelResults, aggregateStates, pendingAttachments, reviewAttachmentPaths) {
  const allSkipped = topLevelResults.length > 0 && topLevelResults.every((item) => item.result === "skipped_non_dispersion");
  if (!topLevelResults.length || allSkipped) return "idle";
  if (pendingAttachments > 0) return "pending";
  if (topLevelResults.some((item) => String(item.processingStatus || "").toLowerCase() === "error")) return "error";

  const states = Array.isArray(aggregateStates) ? aggregateStates : [];
  const matchedCount = states.filter((item) => item.status === "matched" || item.status === "matched_approx").length;
  const hasApprox = states.some((item) => item.status === "matched_approx");
  const hasReview = states.some((item) => item.status === "review" || item.status === "unmatched") ||
    (Array.isArray(reviewAttachmentPaths) && reviewAttachmentPaths.length > 0);

  if (states.length > 0 && matchedCount === states.length && !hasReview) {
    return hasApprox ? "matched_approx" : "matched";
  }

  if (matchedCount > 0) {
    return hasReview ? "review" : "partial";
  }

  return hasReview ? "review" : "partial";
}

async function refreshOcrSummary(solicitudId, solicitudOverride = null) {
  const solicitudRef = db.collection("solicitudes").doc(solicitudId);
  const solicitud = solicitudOverride || (await solicitudRef.get()).data() || {};
  const resultsSnap = await solicitudRef.collection("ocrResults").get();
  const results = resultsSnap.docs.map((doc) => doc.data() || {});
  const topLevelResults = getTreasuryTopLevelResults(results, solicitud);
  const pendingAttachments = topLevelResults.filter((item) => item.processingStatus === "queued" || item.processingStatus === "processing").length;
  const aggregate = buildAggregateDispersionValidation(solicitud, results);
  const dispersionStates = aggregate.states || [];
  const matchedDispersions = dispersionStates.filter((item) => item.status === "matched" || item.status === "matched_approx").length;
  const unmatchedDispersions = dispersionStates.filter((item) => item.status === "unmatched").length;

  await solicitudRef.set({
    ocrValidationSummary: {
      status: getSummaryStatusFromAggregate(topLevelResults, dispersionStates, pendingAttachments, aggregate.reviewAttachmentPaths),
      lastProcessedAt: new Date().toISOString(),
      totalAttachments: topLevelResults.length,
      matchedDispersions,
      unmatchedDispersions,
      pendingAttachments,
      dispersionStates,
      matchedAttachmentPaths: aggregate.matchedPaths,
      reviewAttachmentPaths: aggregate.reviewAttachmentPaths,
    },
  }, { merge: true });
}

async function runVisionOcr(buffer) {
  const [response] = await visionClient.documentTextDetection({
    image: { content: buffer },
  });

  return response?.fullTextAnnotation?.text ||
    response?.textAnnotations?.[0]?.description ||
    "";
}

async function runPdfTextFallback(buffer) {
  const data = await pdfParse(buffer);
  return data?.text || "";
}

async function runDocumentAiOcr(buffer, mimeType) {
  if (!OCR_DOCUMENT_AI_PROJECT_ID || !OCR_DOCUMENT_AI_PROCESSOR_ID) {
    throw new Error("Falta configurar OCR_DOCUMENT_AI_PROJECT_ID u OCR_DOCUMENT_AI_PROCESSOR_ID.");
  }

  const processorName = documentAiClient.processorPath(
    OCR_DOCUMENT_AI_PROJECT_ID,
    OCR_DOCUMENT_AI_LOCATION,
    OCR_DOCUMENT_AI_PROCESSOR_ID
  );

  const [result] = await documentAiClient.processDocument({
    name: processorName,
    rawDocument: {
      content: buffer.toString("base64"),
      mimeType,
    },
  });

  return result?.document?.text || "";
}

async function processSingleAttachment({
  solicitudId,
  solicitud,
  sourcePath,
  sourceUrl,
  sourceType,
  mimeType,
  buffer,
  parentSourcePath = null,
  entryPath = null,
  skipSummaryUpdate = false,
}) {
  const effectivePath = entryPath ? `${sourcePath}#${entryPath}` : sourcePath;
  const effectiveSourceType = entryPath ? "zip_entry" : sourceType;

  await writeOcrResult(solicitudId, effectivePath, {
    sourceUrl,
    sourceType: effectiveSourceType,
    mimeType,
    parentSourcePath,
    entryPath,
    processingStatus: "processing",
    result: null,
    errorMessage: null,
  });

  try {
    if (buffer.length > OCR_MAX_FILE_SIZE_BYTES) {
      await writeOcrResult(solicitudId, effectivePath, {
        sourceUrl,
        sourceType: effectiveSourceType,
        mimeType,
        parentSourcePath,
        entryPath,
        processingStatus: "done",
        result: "unsupported_or_limited",
        confidence: 0,
        errorMessage: "Archivo fuera del limite de 50 MB para OCR.",
        rawTextPreview: "",
      });
      if (!skipSummaryUpdate) await refreshOcrSummary(solicitudId, solicitud);
      return;
    }

    const ext = path.extname(entryPath || sourcePath).toLowerCase();
    let text = "";

    if (OCR_IMAGE_EXTENSIONS.has(ext)) {
      text = await runVisionOcr(buffer);
    } else if (ext === ".pdf" || OCR_PDF_MIME_TYPES.has(mimeType)) {
      const pageCount = countPdfPages(buffer);
      if (pageCount > OCR_MAX_PDF_PAGES) {
        await writeOcrResult(solicitudId, effectivePath, {
          sourceUrl,
          sourceType: effectiveSourceType,
          mimeType,
          parentSourcePath,
          entryPath,
          processingStatus: "done",
          result: "unsupported_or_limited",
          confidence: 0,
          errorMessage: `PDF fuera del limite de ${OCR_MAX_PDF_PAGES} paginas.`,
          rawTextPreview: "",
        });
        if (!skipSummaryUpdate) await refreshOcrSummary(solicitudId, solicitud);
        return;
      }
      if (OCR_DOCUMENT_AI_PROJECT_ID && OCR_DOCUMENT_AI_PROCESSOR_ID) {
        try {
          text = await runDocumentAiOcr(buffer, "application/pdf");
        } catch (error) {
          console.warn("Document AI fallo, usando lectura PDF basica:", error?.message || error);
          text = await runPdfTextFallback(buffer);
        }
      } else {
        console.warn("Document AI no configurado, usando lectura PDF basica.");
        text = await runPdfTextFallback(buffer);
      }
    } else {
      await writeOcrResult(solicitudId, effectivePath, {
        sourceUrl,
        sourceType: effectiveSourceType,
        mimeType,
        parentSourcePath,
        entryPath,
        processingStatus: "done",
        result: "unsupported_or_limited",
        confidence: 0,
        errorMessage: "Tipo de archivo no soportado para OCR.",
        rawTextPreview: "",
      });
      if (!skipSummaryUpdate) await refreshOcrSummary(solicitudId, solicitud);
      return;
    }

    const bankAliasesDetected = detectBanksInText(text);
    const amountsDetected = extractAmountsFromText(text);
    const matchResult = matchOcrAgainstDispersiones(solicitud, bankAliasesDetected, amountsDetected);

    await writeOcrResult(solicitudId, effectivePath, {
      sourceUrl,
      sourceType: effectiveSourceType,
      mimeType,
      parentSourcePath,
      entryPath,
      processingStatus: "done",
      bankDetected: bankAliasesDetected[0] || null,
      bankAliasesDetected,
      amountsDetected,
      matchedDispersionIndex: matchResult.matchedDispersionIndex,
      matchedBank: matchResult.matchedBank,
      matchedAmount: matchResult.matchedAmount,
      result: matchResult.result,
      confidence: matchResult.confidence,
      rawTextPreview: truncateText(text),
      errorMessage: null,
    });
  } catch (error) {
    await writeOcrResult(solicitudId, effectivePath, {
      sourceUrl,
      sourceType: effectiveSourceType,
      mimeType,
      parentSourcePath,
      entryPath,
      processingStatus: "error",
      result: "error",
      confidence: 0,
      errorMessage: error?.message || "Fallo inesperado durante OCR.",
      rawTextPreview: "",
    });
  }

  if (!skipSummaryUpdate) {
    await refreshOcrSummary(solicitudId, solicitud);
  }
}

function aggregateZipResult(childResults) {
  if (!childResults.length) {
    return {
      processingStatus: "done",
      result: "unsupported_or_limited",
      confidence: 0,
      errorMessage: "El ZIP no contiene archivos validos para OCR.",
    };
  }

  if (childResults.some((item) => item.processingStatus === "error")) {
    return {
      processingStatus: "error",
      result: "error",
      confidence: 0,
      errorMessage: "Uno o mas archivos internos fallaron durante el OCR.",
    };
  }

  if (childResults.some((item) => ["ambiguous", "bank_match_amount_mismatch"].includes(item.result))) {
    return {
      processingStatus: "done",
      result: "ambiguous",
      confidence: 0.55,
      errorMessage: "Se detectaron coincidencias que requieren revision.",
    };
  }

  const exactChild = childResults.find((item) => ["exact_match", "amount_only_match"].includes(item.result));
  if (exactChild) {
    return {
      processingStatus: "done",
      result: "exact_match",
      confidence: exactChild.confidence || 0.9,
      matchedDispersionIndex: exactChild.matchedDispersionIndex ?? null,
      matchedBank: exactChild.matchedBank || null,
      matchedAmount: exactChild.matchedAmount ?? null,
      errorMessage: null,
    };
  }

  const amountChild = childResults.find((item) => item.result === "amount_match_bank_unknown");
  if (amountChild) {
    return {
      processingStatus: "done",
      result: "amount_match_bank_unknown",
      confidence: amountChild.confidence || 0.8,
      matchedDispersionIndex: amountChild.matchedDispersionIndex ?? null,
      matchedBank: amountChild.matchedBank || null,
      matchedAmount: amountChild.matchedAmount ?? null,
      errorMessage: null,
    };
  }

  if (childResults.some((item) => item.result === "no_match")) {
    return {
      processingStatus: "done",
      result: "no_match",
      confidence: 0.2,
      errorMessage: "No hubo coincidencias claras dentro del ZIP.",
    };
  }

  return {
    processingStatus: "done",
    result: "unsupported_or_limited",
    confidence: 0,
    errorMessage: "El ZIP no produjo evidencia util para OCR.",
  };
}

async function processZipAttachment({
  solicitudId,
  solicitud,
  sourcePath,
  sourceUrl,
  sourceType,
  mimeType,
  buffer,
}) {
  await writeOcrResult(solicitudId, sourcePath, {
    sourceUrl,
    sourceType,
    mimeType,
    processingStatus: "processing",
    result: null,
    errorMessage: null,
  });

  try {
    if (buffer.length > OCR_MAX_FILE_SIZE_BYTES) {
      await writeOcrResult(solicitudId, sourcePath, {
        sourceUrl,
        sourceType,
        mimeType,
        processingStatus: "done",
        result: "unsupported_or_limited",
        confidence: 0,
        errorMessage: "ZIP fuera del limite de 50 MB para OCR.",
      });
      await refreshOcrSummary(solicitudId, solicitud);
      return;
    }

    await deleteNestedZipResults(solicitudId, sourcePath);
    const directory = await unzipper.Open.buffer(buffer);
    const files = directory.files.filter((entry) => entry.type === "File");
    const supportedEntries = files.filter((entry) => {
      const ext = path.extname(entry.path).toLowerCase();
      return ext !== ".zip" && OCR_IMAGE_EXTENSIONS.has(ext) || ext === ".pdf";
    });

    if (supportedEntries.length > OCR_MAX_ZIP_FILES) {
      await writeOcrResult(solicitudId, sourcePath, {
        sourceUrl,
        sourceType,
        mimeType,
        processingStatus: "done",
        result: "unsupported_or_limited",
        confidence: 0,
        errorMessage: `El ZIP excede el limite de ${OCR_MAX_ZIP_FILES} archivos OCR.`,
      });
      await refreshOcrSummary(solicitudId, solicitud);
      return;
    }

    const totalUncompressedBytes = supportedEntries.reduce((sum, entry) => sum + Number(entry.uncompressedSize || 0), 0);
    if (totalUncompressedBytes > OCR_MAX_ZIP_UNCOMPRESSED_BYTES) {
      await writeOcrResult(solicitudId, sourcePath, {
        sourceUrl,
        sourceType,
        mimeType,
        processingStatus: "done",
        result: "unsupported_or_limited",
        confidence: 0,
        errorMessage: "El ZIP excede el limite total de 100 MB descomprimidos.",
      });
      await refreshOcrSummary(solicitudId, solicitud);
      return;
    }

    for (const entry of supportedEntries) {
      const entryBuffer = await entry.buffer();
      const entryMimeType = detectMimeType(entry.path);
      await processSingleAttachment({
        solicitudId,
        solicitud,
        sourcePath,
        sourceUrl,
        sourceType,
        mimeType: entryMimeType,
        buffer: entryBuffer,
        parentSourcePath: sourcePath,
        entryPath: entry.path,
        skipSummaryUpdate: true,
      });
    }

    const childResultsSnap = await db
      .collection("solicitudes")
      .doc(solicitudId)
      .collection("ocrResults")
      .where("parentSourcePath", "==", sourcePath)
      .get();

    const childResults = childResultsSnap.docs.map((doc) => doc.data() || {});
    const aggregate = aggregateZipResult(childResults);

    await writeOcrResult(solicitudId, sourcePath, {
      sourceUrl,
      sourceType,
      mimeType,
      processingStatus: aggregate.processingStatus,
      result: aggregate.result,
      confidence: aggregate.confidence,
      matchedDispersionIndex: aggregate.matchedDispersionIndex ?? null,
      matchedBank: aggregate.matchedBank || null,
      matchedAmount: aggregate.matchedAmount ?? null,
      errorMessage: aggregate.errorMessage || null,
    });
  } catch (error) {
    await writeOcrResult(solicitudId, sourcePath, {
      sourceUrl,
      sourceType,
      mimeType,
      processingStatus: "error",
      result: "error",
      confidence: 0,
      errorMessage: error?.message || "Fallo inesperado al procesar ZIP.",
    });
  }

  await refreshOcrSummary(solicitudId, solicitud);
}

async function processAttachmentPath({ bucketName, attachmentPath, metadata = null }) {
  const attachment = getAttachmentDescriptor(attachmentPath);
  if (!attachment) {
    return { skipped: true, reason: "Ruta no compatible con OCR." };
  }

  const context = await loadSolicitudAndOperacion(attachment.solicitudId);
  if (!context.solicitud) {
    return { skipped: true, reason: context.reason };
  }

  const bucket = storage.bucket(bucketName || storage.bucket().name);
  const file = bucket.file(attachment.sourcePath);
  const fileMetadata = metadata || (await file.getMetadata())[0];
  const mimeType = detectMimeType(attachment.sourcePath, fileMetadata.contentType);
  const sourceUrl = buildStorageDownloadUrl(bucket.name, attachment.sourcePath, fileMetadata);

  if (!context.eligible) {
    await writeOcrResult(context.solicitudRef.id, attachment.sourcePath, {
      sourceUrl,
      sourceType: attachment.sourceType,
      mimeType,
      processingStatus: "skipped",
      result: "skipped_non_dispersion",
      confidence: 0,
      errorMessage: context.reason,
      rawTextPreview: "",
    });
    await refreshOcrSummary(context.solicitudRef.id, context.solicitud);
    return { skipped: true, reason: context.reason };
  }

  await writeOcrResult(context.solicitudRef.id, attachment.sourcePath, {
    sourceUrl,
    sourceType: attachment.sourceType,
    mimeType,
    processingStatus: "queued",
    result: null,
    errorMessage: null,
  });
  await refreshOcrSummary(context.solicitudRef.id, context.solicitud);

  const [buffer] = await file.download();
  const ext = path.extname(attachment.sourcePath).toLowerCase();

  if (!OCR_DIRECT_EXTENSIONS.has(ext)) {
    await writeOcrResult(context.solicitudRef.id, attachment.sourcePath, {
      sourceUrl,
      sourceType: attachment.sourceType,
      mimeType,
      processingStatus: "done",
      result: "unsupported_or_limited",
      confidence: 0,
      errorMessage: "Tipo de archivo no soportado por OCR v1.",
      rawTextPreview: "",
    });
    await refreshOcrSummary(context.solicitudRef.id, context.solicitud);
    return { skipped: true, reason: "Archivo no soportado." };
  }

  if (ext === ".zip") {
    await processZipAttachment({
      solicitudId: context.solicitudRef.id,
      solicitud: context.solicitud,
      sourcePath: attachment.sourcePath,
      sourceUrl,
      sourceType: attachment.sourceType,
      mimeType,
      buffer,
    });
  } else {
    await processSingleAttachment({
      solicitudId: context.solicitudRef.id,
      solicitud: context.solicitud,
      sourcePath: attachment.sourcePath,
      sourceUrl,
      sourceType: attachment.sourceType,
      mimeType,
      buffer,
    });
  }

  return { skipped: false, solicitudId: context.solicitudRef.id };
}

exports.createGiUser = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion para crear usuarios.");
  }

  await assertGiAdmin(callerUid);

  const data = request.data || {};
  const name = asTrimmedString(data.name, "name");
  const role = normalizeRole(data.role);
  const numeroOperador = normalizeOperatorId(data.numeroOperador);
  const email = normalizeEmail(data.email);
  const password = normalizePassword(data.password);
  const status = normalizeStatus(data.status);

  const tempRefs = await assertGiIdentityIsUnique({ email, numeroOperador });

  let userRecord;
  try {
    userRecord = await auth.createUser({
      email,
      password,
      displayName: name,
      disabled: status !== ACTIVE_STATUS,
    });
  } catch (error) {
    throw mapAuthError(error, "No se pudo crear el usuario en Firebase Authentication.");
  }

  try {
    const payload = buildCreateProfilePayload({
      uid: userRecord.uid,
      name,
      role,
      numeroOperador,
      status,
      email,
      actorUid: callerUid,
    });
    await db.collection(GI_USERS_COLLECTION).doc(userRecord.uid).set(payload, { merge: true });

    for (const ref of tempRefs.values()) {
      await ref.delete();
    }
  } catch (error) {
    try {
      await auth.deleteUser(userRecord.uid);
    } catch (cleanupError) {
      console.error("No se pudo revertir el usuario de Authentication tras un fallo:", cleanupError);
    }
    throw new HttpsError("internal", error?.message || "No se pudo guardar el perfil en gi_usuarios.");
  }

  return {
    uid: userRecord.uid,
    email,
    numeroOperador,
    role,
    status,
    created: true,
  };
});

exports.updateGiUser = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion para actualizar usuarios.");
  }

  await assertGiAdmin(callerUid);

  const data = request.data || {};
  const uid = normalizeUid(data.uid);
  const name = asTrimmedString(data.name, "name");
  const role = normalizeRole(data.role);
  const numeroOperador = normalizeOperatorId(data.numeroOperador);
  const email = normalizeEmail(data.email);
  const status = normalizeStatus(data.status);
  const password = optionalPassword(data.password);

  const profileSnap = await getGiUserSnapshot(uid);
  const previousProfile = profileSnap.data() || {};
  await getAuthUser(uid);

  const tempRefs = await assertGiIdentityIsUnique({ email, numeroOperador, ignoreUid: uid });
  const nextProfile = buildUpdateProfilePayload(previousProfile, {
    uid,
    name,
    role,
    numeroOperador,
    status,
    email,
    actorUid: callerUid,
  });

  await profileSnap.ref.set(nextProfile, { merge: false });

  try {
    const authPatch = {
      email,
      displayName: name,
      disabled: status !== ACTIVE_STATUS,
    };
    if (password) {
      authPatch.password = password;
    }
    await auth.updateUser(uid, authPatch);

    for (const ref of tempRefs.values()) {
      await ref.delete();
    }
  } catch (error) {
    try {
      await restoreGiProfile(uid, previousProfile);
    } catch (cleanupError) {
      console.error("No se pudo revertir gi_usuarios tras fallo de updateGiUser:", cleanupError);
    }
    throw mapAuthError(error, "No se pudo actualizar el usuario en Firebase Authentication.");
  }

  return {
    uid,
    email,
    numeroOperador,
    role,
    status,
    updated: true,
  };
});

exports.setGiUserStatus = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion para cambiar el estado del usuario.");
  }

  await assertGiAdmin(callerUid);

  const data = request.data || {};
  const uid = normalizeUid(data.uid);
  const active = Boolean(data.active);

  if (uid === callerUid && !active) {
    throw new HttpsError("permission-denied", "No puedes deshabilitar tu propia cuenta.");
  }

  const profileSnap = await getGiUserSnapshot(uid);
  const previousProfile = profileSnap.data() || {};
  const authRecord = await getAuthUser(uid);
  const nextStatus = active ? ACTIVE_STATUS : "disabled";

  try {
    await auth.updateUser(uid, { disabled: !active });
  } catch (error) {
    throw mapAuthError(error, "No se pudo actualizar el estado en Firebase Authentication.");
  }

  try {
    await profileSnap.ref.set({
      status: nextStatus,
      authUid: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: callerUid,
    }, { merge: true });
  } catch (error) {
    try {
      await auth.updateUser(uid, { disabled: authRecord.disabled });
    } catch (cleanupError) {
      console.error("No se pudo revertir el estado de Authentication tras fallo de setGiUserStatus:", cleanupError);
    }
    throw new HttpsError("internal", error?.message || "No se pudo guardar el estado en gi_usuarios.");
  }

  if (previousProfile.status && previousProfile.status !== nextStatus) {
    console.log(`Estado GI cambiado para ${uid}: ${previousProfile.status} -> ${nextStatus}`);
  }

  return {
    uid,
    status: nextStatus,
  };
});

exports.adminUpdatePassword = functionsV1.region(REGION).https.onCall(async (data, context) => {
  const callerUid = context.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion para actualizar contrasenas.");
  }

  await assertMainAppAdmin(callerUid);

  const targetEmail = normalizeEmail(data?.targetEmail);
  const newPassword = normalizePassword(data?.newPassword);

  let targetUser;
  try {
    targetUser = await auth.getUserByEmail(targetEmail);
  } catch (error) {
    throw mapAuthError(error, "No se pudo localizar el usuario en Firebase Authentication.");
  }

  try {
    await auth.updateUser(targetUser.uid, { password: newPassword });
  } catch (error) {
    throw mapAuthError(error, "No se pudo actualizar la contrasena en Firebase Authentication.");
  }

  return {
    ok: true,
    uid: targetUser.uid,
    email: targetEmail,
  };
});

exports.processComprobanteOcr = functionsV1.region(REGION).runWith({ timeoutSeconds: 300, memory: "512MB" }).storage.object().onFinalize(async (object) => {
  const bucketName = object.bucket;
  const objectName = object.name;

  if (!bucketName || !objectName) {
    return;
  }

  if (!isOcrAutoProcessFresh(object.timeCreated || object.updated || object.metadata?.timeCreated)) {
    console.log(`OCR omitido por antiguedad: ${objectName}`);
    return;
  }

  try {
    await processAttachmentPath({
      bucketName,
      attachmentPath: objectName,
      metadata: object.metadata ? object : object,
    });
  } catch (error) {
    console.error("OCR trigger error:", error);
  }
});

exports.reprocessOcrValidation = onCall({
  region: REGION,
  timeoutSeconds: 540,
  memory: "1GiB",
}, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion para reintentar OCR.");
  }

  await assertMainAppOcrAccess(callerUid);

  const solicitudId = asTrimmedString(request.data?.solicitudId, "solicitudId");
  const attachmentPath = asTrimmedString(request.data?.attachmentPath, "attachmentPath");
  const attachment = getAttachmentDescriptor(attachmentPath);

  if (!attachment || attachment.solicitudId !== solicitudId) {
    throw new HttpsError("invalid-argument", "La ruta del archivo no coincide con la solicitud indicada.");
  }

  const bucketName = storage.bucket().name;
  await processAttachmentPath({
    bucketName,
    attachmentPath,
  });

  return {
    ok: true,
    solicitudId,
    attachmentPath,
  };
});

exports.analyzeReceipt = functionsV1.region(REGION).https.onRequest(async (req, res) => {
  res.status(200).json({ ok: true, legacy: true });
});

exports.enviarAlertaRH = functionsV1.region(REGION).https.onCall(async () => {
  return { ok: true, legacy: true };
});

// ============================================================
// TELEGRAM — Notificaciones GI
// ============================================================
function getTelegramToken() {
  try {
    const cfg = functionsV1.config();
    if (cfg && cfg.telegram && cfg.telegram.token) return cfg.telegram.token;
  } catch (_) { /* v1 config no disponible */ }
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

function escapeHtmlTg(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(chatId, text, extra = {}) {
  const token = getTelegramToken();
  if (!token) {
    console.warn("TELEGRAM_BOT_TOKEN no configurado — skip envío");
    return { ok: false, reason: "no_token" };
  }
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  };
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) console.warn("Telegram sendMessage error:", json);
    return json;
  } catch (err) {
    console.error("Telegram fetch error:", err);
    return { ok: false, error: String(err) };
  }
}

exports.telegramWebhook = functionsV1.region(REGION).https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(200).json({ ok: true });
  try {
    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message || !message.chat || !message.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = String(message.text).trim();
    const fromName = message.from && message.from.first_name ? message.from.first_name : "Usuario";
    const cmd = text.toLowerCase();

    if (cmd === "/start") {
      await sendTelegram(
        chatId,
        `👋 Hola <b>${escapeHtmlTg(fromName)}</b>.\n\n` +
        `Este es el bot de notificaciones de <b>Pizarra GI</b>.\n\n` +
        `Para activar tus alertas de solicitudes por pre-autorizar o autorizar, ` +
        `envíame tu <b>correo registrado</b> en Pizarra GI.`
      );
      return res.status(200).json({ ok: true });
    }

    if (cmd === "/test") {
      const snap = await db
        .collection(GI_USERS_COLLECTION)
        .where("telegramChatId", "==", chatId)
        .get();
      if (snap.empty) {
        await sendTelegram(chatId, "⚠️ Aún no estás vinculado. Envíame tu correo registrado para activar.");
      } else {
        const u = snap.docs[0].data();
        await sendTelegram(
          chatId,
          `✅ Vinculado como <b>${escapeHtmlTg(u.name || u.email)}</b>\n` +
          `Rol: <code>${escapeHtmlTg(u.role || "N/D")}</code>\n\n` +
          `Listo para recibir notificaciones.`
        );
      }
      return res.status(200).json({ ok: true });
    }

    if (cmd === "/unlink") {
      const snap = await db
        .collection(GI_USERS_COLLECTION)
        .where("telegramChatId", "==", chatId)
        .get();
      if (snap.empty) {
        await sendTelegram(chatId, "No hay vínculo que desvincular.");
      } else {
        await Promise.all(
          snap.docs.map((doc) =>
            doc.ref.update({
              telegramChatId: admin.firestore.FieldValue.delete(),
              telegramLinkedAt: admin.firestore.FieldValue.delete(),
            })
          )
        );
        await sendTelegram(chatId, "✅ Desvinculado. Ya no recibirás notificaciones.");
      }
      return res.status(200).json({ ok: true });
    }

    // Vincular por email
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    if (isEmail) {
      const email = text.toLowerCase();
      const snap = await db.collection(GI_USERS_COLLECTION).where("email", "==", email).get();
      if (snap.empty) {
        await sendTelegram(
          chatId,
          `❌ No encontré <code>${escapeHtmlTg(email)}</code> en Pizarra GI.\n` +
          `Pide a un administrador que te registre primero.`
        );
        return res.status(200).json({ ok: true });
      }
      const userDoc = snap.docs[0];
      const userData = userDoc.data();
      const role = String(userData.role || "").toLowerCase();
      if (!TELEGRAM_APPROVER_ROLES.has(role)) {
        await sendTelegram(
          chatId,
          `⚠️ Tu rol es <b>${escapeHtmlTg(role || "N/D")}</b>.\n` +
          `Por ahora las notificaciones son sólo para roles <b>admin / administrativo</b>.`
        );
        return res.status(200).json({ ok: true });
      }
      await userDoc.ref.update({
        telegramChatId: chatId,
        telegramLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await sendTelegram(
        chatId,
        `✅ <b>Vinculado</b> como ${escapeHtmlTg(userData.name || email)}.\n\n` +
        `Recibirás alertas cuando haya solicitudes por pre-autorizar o autorizar.\n\n` +
        `Comandos disponibles:\n` +
        `<code>/test</code> — verificar vínculo\n` +
        `<code>/unlink</code> — desvincular`
      );
      return res.status(200).json({ ok: true });
    }

    await sendTelegram(
      chatId,
      "No entendí ese mensaje. Envíame tu <b>correo registrado</b>, o usa <code>/start</code>, <code>/test</code>, <code>/unlink</code>."
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("telegramWebhook error:", err);
    return res.status(200).json({ ok: false });
  }
});

exports.onSolicitudGiStatusChange = functionsV1
  .region(REGION)
  .firestore.document(`${SOLS_GI_COLLECTION}/{solicitudId}`)
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after) return null; // documento eliminado

    const before = change.before.exists ? change.before.data() : null;
    const beforeStatus = before ? String(before.status || "").toLowerCase() : null;
    const afterStatus = String(after.status || "").toLowerCase();

    if (beforeStatus === afterStatus) return null;
    if (!TELEGRAM_NOTIFY_STATUSES.has(afterStatus)) return null;

    const usersSnap = await db
      .collection(GI_USERS_COLLECTION)
      .where("role", "in", Array.from(TELEGRAM_APPROVER_ROLES))
      .get();

    const targets = [];
    usersSnap.forEach((doc) => {
      const d = doc.data();
      const chatId = d.telegramChatId;
      const userStatus = String(d.status || "").toLowerCase();
      if (chatId && userStatus !== "inactive") {
        targets.push({ chatId, name: d.name || d.email });
      }
    });

    if (targets.length === 0) {
      console.log("onSolicitudGiStatusChange: sin aprobadores con Telegram vinculado");
      return null;
    }

    const folio = after.folio || context.params.solicitudId;
    const importeNum = parseFloat(
      after.importe != null
        ? after.importe
        : (after.contableSnapshot && after.contableSnapshot.importeTotal) || 0
    ) || 0;
    const importeStr = importeNum.toLocaleString("es-MX", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const solicitante = after.solicitante_apoyo || after.solicitante || "N/D";
    const cuenta = after.cliente || "Sin Cuenta Mayor";
    const operadora = after.operadora || "";

    const header = afterStatus === "orden"
      ? "🟠 <b>NUEVA ORDEN</b> — pendiente pre-autorizar"
      : "🟣 <b>PRE-AUTORIZADA</b> — lista para autorizar";
    const actionLabel = afterStatus === "orden" ? "Pre-autorizar" : "Autorizar";

    const lines = [
      header,
      "",
      `<b>${escapeHtmlTg(cuenta)}</b>`,
      `Folio: <code>${escapeHtmlTg(folio)}</code>`,
      `Importe: <b>$${importeStr} ${escapeHtmlTg(after.moneda || "MXN")}</b>`,
      `Solicitante: ${escapeHtmlTg(solicitante)}`,
    ];
    if (operadora) lines.push(`Operadora: ${escapeHtmlTg(operadora)}`);

    const message = lines.join("\n");
    const keyboard = {
      inline_keyboard: [[
        { text: `📱 ${actionLabel} en Móvil`, url: MOBILE_GI_URL },
      ]],
    };

    const results = await Promise.all(
      targets.map((t) =>
        sendTelegram(t.chatId, message, { reply_markup: keyboard })
          .then((r) => ({ chatId: t.chatId, ok: !!r.ok }))
          .catch((e) => ({ chatId: t.chatId, ok: false, error: String(e) }))
      )
    );

    console.log("Telegram GI notify:", {
      solicitudId: context.params.solicitudId,
      status: afterStatus,
      targets: results.length,
      ok: results.filter((r) => r.ok).length,
    });
    return null;
  });
