// ===============================
// DEPENDENCIAS (CommonJS)
// ===============================
const express = require("express");
const { google } = require("googleapis");
const sharp = require("sharp"); // <— mejora de imagen

const app = express();

// Twilio envía application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===============================
// VARIABLES DE ENTORNO (protegidas)
// ===============================
const SHEET_ID           = process.env.SHEET_ID || "";
const GS_CLIENT_EMAIL    = process.env.GS_CLIENT_EMAIL || "";
const GS_PRIVATE_KEY     = (process.env.GS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || "";
const OPENAI_ORG_ID      = process.env.OPENAI_ORG_ID || ""; // opcional
const TWILIO_SID         = process.env.TWILIO_SID || "";    // para descargar MediaUrl0
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN || "";
const SHEET_RANGE        = process.env.SHEET_RANGE || "'Manifiestos'!A:N"; // <— configurable
const OPENAI_MODEL       = process.env.OPENAI_MODEL || "gpt-4o"; // mejor precisión

// ===============================
// RUTAS DE PRUEBA
// ===============================
app.get("/", (_req, res) => res.send("Manifiestos Bot OK"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Diagnóstico OpenAI (texto)
app.get("/test-openai", async (_req, res) => {
  try {
    const extra = OPENAI_ORG_ID ? { "OpenAI-Organization": OPENAI_ORG_ID } : {};
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json", ...extra },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: [{ type: "text", text: "decí 'ok' si me escuchás" }] }]
      })
    });
    const j = await r.json();
    res.json({ ok: true, content: j?.choices?.[0]?.message?.content || "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Diagnóstico OpenAI (status y preview)
app.get("/diag/openai", async (_req, res) => {
  try {
    const extra = OPENAI_ORG_ID ? { "OpenAI-Organization": OPENAI_ORG_ID } : {};
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json", ...extra },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
      })
    });
    const text = await r.text();
    res.json({ httpStatus: r.status, bodyPreview: text.slice(0, 300) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Test Sheets: inserta una fila de prueba
app.get("/test-sheets", async (_req, res) => {
  try {
    await appendRowToSheet([
      "2025-08-28","2025-08-28","PRUEBA","Calle 123",
      "OPERADOR SA","Av. 456","Semisólido","Cisterna",
      "5","m3","TEST-123","No Especiales","Barros","010410"
    ]);
    res.send("fila OK");
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// Status callback opcional de Twilio (para mensajes salientes)
app.post("/twilio-status", (req, res) => {
  console.log("TWILIO STATUS:", req.body); // MessageSid, MessageStatus, ErrorCode...
  res.sendStatus(200);
});

// ===============================
// HELPERS: Google Sheets
// ===============================
async function appendRowToSheet(values) {
  if (!SHEET_ID || !GS_CLIENT_EMAIL || !GS_PRIVATE_KEY) {
    throw new Error("Faltan credenciales de Google Sheets (SHEET_ID, GS_CLIENT_EMAIL, GS_PRIVATE_KEY).");
  }
  const auth = new google.auth.JWT(
    GS_CLIENT_EMAIL, null, GS_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE, // <— usar env var
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

// ===============================
// HELPERS: Preprocesar imagen Twilio → Data URL
// ===============================
async function downloadAndEnhanceTwilioImageAsDataUrl(mediaUrl) {
  if (!TWILIO_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Faltan TWILIO_SID/TWILIO_AUTH_TOKEN para leer MediaUrl de Twilio.");
  }
  const r = await fetch(mediaUrl, {
    headers: {
      "Authorization": "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")
    }
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`No pude descargar la imagen de Twilio (${r.status}): ${txt}`);
  }
  const original = Buffer.from(await r.arrayBuffer());

  // 🔧 Preprocesado: EXIF rotate, grayscale, normalize, sharpen, resize y PNG
  const processed = await sharp(original)
    .rotate()
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 1600, withoutEnlargement: false })
    .toFormat("png", { compressionLevel: 9 })
    .toBuffer();

  return `data:image/png;base64,${processed.toString("base64")}`;
}

// ===============================
// HELPERS: OpenAI (reintentos + visión)
// ===============================
async function callOpenAIWithRetry(payload, maxRetries = 3) {
  const extra = OPENAI_ORG_ID ? { "OpenAI-Organization": OPENAI_ORG_ID } : {};
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json", ...extra },
      body: JSON.stringify(payload)
    });
    if (r.ok) return r.json();
    const status = r.status;
    const body = await r.text().catch(() => "");
