"use strict";

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

function detectProjectId() {
  const candidates = [
    process.env.GCLOUD_PROJECT,
    process.env.GOOGLE_CLOUD_PROJECT,
    process.env.FIREBASE_CONFIG ? (() => {
      try {
        return JSON.parse(process.env.FIREBASE_CONFIG).projectId || null;
      } catch (error) {
        return null;
      }
    })() : null,
  ].filter(Boolean);

  if (candidates.length) {
    return candidates[0];
  }

  try {
    const firebasercPath = path.resolve(__dirname, "..", "..", ".firebaserc");
    const firebaserc = JSON.parse(fs.readFileSync(firebasercPath, "utf8"));
    return firebaserc?.projects?.default || null;
  } catch (error) {
    return null;
  }
}

if (!admin.apps.length) {
  const projectId = detectProjectId();
  admin.initializeApp(projectId ? { projectId } : undefined);
}

const db = admin.firestore();
const OPERACIONES_COLLECTION = "operaciones";
const PAGE_SIZE = 400;
const EPSILON = 0.009;

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value)
    .replace(/[$,\s]/g, "")
    .trim();
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function amountsMatch(a, b) {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= EPSILON;
}

function formatAmount(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "N/A";
  return value.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });
}

function classifyOperation(docSnap) {
  const data = docSnap.data() || {};
  const current = parseAmount(data.importe);
  const original = parseAmount(data.importe_reporte_original_snapshot);
  const override = parseAmount(data.importe_reporte_ajustado);
  const active = Boolean(data.importe_reporte_ajuste_activo);

  if (!active) {
    return { status: "ignored", reason: "ajuste_inactivo" };
  }
  if (current === null) {
    return { status: "skipped", reason: "importe_actual_invalido" };
  }
  if (original === null) {
    return { status: "skipped", reason: "sin_snapshot_original" };
  }
  if (override === null) {
    return { status: "skipped", reason: "sin_importe_reporte_ajustado" };
  }
  if (amountsMatch(current, original)) {
    return {
      status: "already_restored",
      current,
      original,
      override,
    };
  }
  if (!amountsMatch(current, override)) {
    return {
      status: "skipped",
      reason: "importe_actual_no_coincide_con_override",
      current,
      original,
      override,
    };
  }

  return {
    status: "candidate",
    current,
    original,
    override,
  };
}

async function* listAdjustedOperations() {
  let lastDoc = null;
  while (true) {
    let query = db
      .collection(OPERACIONES_COLLECTION)
      .where("importe_reporte_ajuste_activo", "==", true)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc.id);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      return;
    }

    for (const doc of snapshot.docs) {
      yield doc;
    }

    if (snapshot.size < PAGE_SIZE) {
      return;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }
}

async function main() {
  const shouldApply = process.argv.includes("--apply");
  const verbose = process.argv.includes("--verbose");

  const summary = {
    scanned: 0,
    candidates: 0,
    repaired: 0,
    alreadyRestored: 0,
    skipped: 0,
    ignored: 0,
  };
  const skippedSamples = [];
  const candidateSamples = [];

  console.log(
    shouldApply
      ? "Aplicando reparacion de importes contaminados..."
      : "Dry-run: revisando importes contaminados sin escribir cambios..."
  );

  for await (const doc of listAdjustedOperations()) {
    summary.scanned += 1;
    const result = classifyOperation(doc);

    if (result.status === "candidate") {
      summary.candidates += 1;
      candidateSamples.push({
        id: doc.id,
        current: result.current,
        original: result.original,
        override: result.override,
      });

      if (shouldApply) {
        await doc.ref.update({
          importe: result.original,
        });
        summary.repaired += 1;
      }
      continue;
    }

    if (result.status === "already_restored") {
      summary.alreadyRestored += 1;
      continue;
    }

    if (result.status === "ignored") {
      summary.ignored += 1;
      continue;
    }

    summary.skipped += 1;
    if (skippedSamples.length < 20) {
      skippedSamples.push({
        id: doc.id,
        reason: result.reason,
        current: result.current ?? null,
        original: result.original ?? null,
        override: result.override ?? null,
      });
    }
  }

  console.log("");
  console.log("Resumen");
  console.log(`- Revisadas: ${summary.scanned}`);
  console.log(`- Candidatas: ${summary.candidates}`);
  console.log(`- Reparadas: ${summary.repaired}`);
  console.log(`- Ya restauradas: ${summary.alreadyRestored}`);
  console.log(`- Omitidas: ${summary.skipped}`);

  if (candidateSamples.length) {
    console.log("");
    console.log("Muestras de candidatas:");
    candidateSamples.slice(0, 20).forEach((item) => {
      console.log(
        `- ${item.id}: actual=${formatAmount(item.current)} | original=${formatAmount(item.original)} | override=${formatAmount(item.override)}`
      );
    });
  }

  if (verbose && skippedSamples.length) {
    console.log("");
    console.log("Muestras omitidas:");
    skippedSamples.forEach((item) => {
      console.log(
        `- ${item.id}: ${item.reason} | actual=${formatAmount(item.current)} | original=${formatAmount(item.original)} | override=${formatAmount(item.override)}`
      );
    });
  }

  if (!shouldApply) {
    console.log("");
    console.log("Para aplicar la restauracion real ejecuta:");
    console.log("npm run repair:importe:apply");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fallo la reparacion de importes:", error);
    process.exit(1);
  });
