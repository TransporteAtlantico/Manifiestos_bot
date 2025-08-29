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
    if ((status === 429 || status === 503) && i < maxRetries) {
      await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i))); // 1s,2s,4s
      continue;
    }
    lastErr = new Error(`OpenAI HTTP ${status}: ${body}`);
    break;
  }
  throw lastErr || new Error("OpenAI: error desconocido");
}

// ===============================
// Limpieza/normalización de campos
// ===============================
function cleanValue(s) {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

function normalizeFields(parsed) {
  const f = {
    fecha_programacion:  cleanValue(parsed.fecha_programacion),
    fecha_transporte:    cleanValue(parsed.fecha_transporte),
    generador:           cleanValue(parsed.generador),
    domicilio_generador: cleanValue(parsed.domicilio_generador),
    operador:            cleanValue(parsed.operador),
    domicilio_operador:  cleanValue(parsed.domicilio_operador),
    estado:              cleanValue(parsed.estado),
    tipo_transporte:     cleanValue(parsed.tipo_transporte),
    cantidad:            cleanValue(parsed.cantidad),
    unidad:              cleanValue(parsed.unidad),
    manifiesto_n:        cleanValue(parsed.manifiesto_n),
    tipo_residuo:        cleanValue(parsed.tipo_residuo),
    composicion:         cleanValue(parsed.composicion),
    categoria_desecho:   cleanValue(parsed.categoria_desecho)
  };

  // Tipo de residuo a valores válidos
  const tr = f.tipo_residuo.toLowerCase();
  if (/no\s*esp(eciales)?/.test(tr)) f.tipo_residuo = "No Especiales";
  else if (/esp(eciales)?/.test(tr)) f.tipo_residuo = "Especiales";
  else f.tipo_residuo = f.tipo_residuo || "";

  // Cantidad: coma→punto y solo numérico
  if (f.cantidad) {
    const c = f.cantidad.replace(",", ".").match(/[0-9]+(\.[0-9]+)?/);
    f.cantidad = c ? c[0] : "";
  }

  // Unidad: normalizar
  const u = f.unidad.toLowerCase();
  if (/kilos?|kg/.test(u)) f.unidad = "kg";
  else if (/ton|tn|t(?![a-z])/.test(u)) f.unidad = "tn";
  else if (/m3|metro.*c(ú|u)bico/.test(u)) f.unidad = "m3";
  else if (/^l$|litro/.test(u)) f.unidad = "L";

  // Fechas DD/MM/AAAA → YYYY-MM-DD
  function normFecha(s) {
    const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (m) {
      const d = m[1].padStart(2, "0");
      const mo = m[2].padStart(2, "0");
      const y = m[3].length === 2 ? ("20" + m[3]) : m[3];
      return `${y}-${mo}-${d}`;
    }
    return s;
  }
  f.fecha_programacion = normFecha(f.fecha_programacion);
  f.fecha_transporte   = normFecha(f.fecha_transporte);

  return f;
}

// ===============================
// Extracción con OpenAI (visión)
// ===============================
async function extractFieldsFromDataUrl(dataUrl) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  const prompt = `
Extraé de la imagen del MANIFIESTO estos 14 campos EXACTOS y devolvé SOLO un JSON válido:
{
 "fecha_programacion": "",
 "fecha_transporte": "",
 "generador": "",
 "domicilio_generador": "",
 "operador": "",
 "domicilio_operador": "",
 "estado": "",
 "tipo_transporte": "",
 "cantidad": "",
 "unidad": "",
 "manifiesto_n": "",
 "tipo_residuo": "Especiales|No Especiales",
 "composicion": "",
 "categoria_desecho": ""
}
Reglas:
- NO inventes. Si no se ve claro, dejá "".
- Normalizá fechas a YYYY-MM-DD si es posible; si está incompleta, dejala tal cual.
- "tipo_residuo" debe ser "Especiales" o "No Especiales".
- "cantidad" sólo números (coma → punto) y "unidad" en kg/tn/m3/L si se deduce.
- Considerá secciones: Generador (origen), Operador, Residuos, Transportista.
`;

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } } // ← objeto { url }
      ]
    }]
  };

  const data = await callOpenAIWithRetry(payload);
  const content = data?.choices?.[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No se pudo parsear JSON devuelto por OpenAI.");
    parsed = JSON.parse(m[0]);
  }

  return normalizeFields(parsed);
}

// ===============================
// WEBHOOK DE TWILIO (WhatsApp)
// ===============================
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    console.log("TWILIO BODY:", req.body);

    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || "0", 10);
    if (!from) {
      res.type("text/xml");
      return res.send(`<Response><Message>No reconozco el remitente.</Message></Response>`);
    }
    if (numMedia < 1) {
      res.type("text/xml");
      return res.send(`<Response><Message>No recibí imagen. Enviá *foto normal* (no "ver una vez" ni "Documento").</Message></Response>`);
    }

    const imageUrl = req.body.MediaUrl0;

    // 1) Descargar + mejorar imagen → data URL
    const dataUrl = await downloadAndEnhanceTwilioImageAsDataUrl(imageUrl);

    // 2) OpenAI (visión) → JSON con 14 campos
    const f = await extractFieldsFromDataUrl(dataUrl);

    // 3) Aplanar la fila (14 columnas exactas)
    const row = [
      f.fecha_programacion,   // 1
      f.fecha_transporte,     // 2
      f.generador,            // 3
      f.domicilio_generador,  // 4
      f.operador,             // 5
      f.domicilio_operador,   // 6
      f.estado,               // 7
      f.tipo_transporte,      // 8
      f.cantidad,             // 9
      f.unidad,               // 10
      f.manifiesto_n,         // 11
      f.tipo_residuo,         // 12
      f.composicion,          // 13
      f.categoria_desecho     // 14
    ];

    // 4) Guardar en Google Sheets
    await appendRowToSheet(row);

    // 5) Responder
    res.type("text/xml");
    res.send(`<Response><Message>✅ Cargado Manif. ${f.manifiesto_n} | ${f.cantidad} ${f.unidad}</Message></Response>`);
  } catch (e) {
    console.error("Error webhook:", e);
    const msg =
      /OpenAI HTTP 429/.test(String(e)) ?
      "Estamos al tope de uso de IA unos minutos. Intentá reenviar la foto más tarde." :
      String(e).slice(0, 160);
    res.type("text/xml").send(`<Response><Message>❌ Error: ${msg}</Message></Response>`);
  }
});

// ===============================
// START SERVER (Heroku asigna PORT)
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor en puerto", PORT));
