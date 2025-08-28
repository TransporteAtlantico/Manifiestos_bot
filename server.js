// ===============================
// DEPENDENCIAS (CommonJS)
// ===============================
const express = require("express");
const { google } = require("googleapis");
// const twilio = require("twilio"); // opcional, si luego querés enviar mensajes salientes

const app = express();

// Twilio envía application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===============================
// VARIABLES DE ENTORNO (protegidas)
// ===============================
const SHEET_ID        = process.env.SHEET_ID || "";
const GS_CLIENT_EMAIL = process.env.GS_CLIENT_EMAIL || "";
const GS_PRIVATE_KEY  = (process.env.GS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || "";
const OPENAI_ORG_ID   = process.env.OPENAI_ORG_ID || ""; // opcional
const TWILIO_SID      = process.env.TWILIO_SID || "";    // para descargar MediaUrl0
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// ===============================
// RUTAS DE PRUEBA
// ===============================
app.get("/", (_req, res) => res.send("Manifiestos Bot OK"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Diagnóstico OpenAI (texto)
app.get("/test-openai", async (_req, res) => {
  try {
    const extraHeaders = OPENAI_ORG_ID ? { "OpenAI-Organization": OPENAI_ORG_ID } : {};
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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
    const extraHeaders = OPENAI_ORG_ID ? { "OpenAI-Organization": OPENAI_ORG_ID } : {};
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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
    range: "Manifiestos!A:N", // 14 columnas (A..N)
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

// ===============================
// HELPERS: Twilio media → Data URL
// ===============================
async function fetchTwilioImageAsDataUrl(mediaUrl, contentTypeHint = "image/jpeg") {
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
  const buf = await r.arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  return `data:${contentTypeHint};base64,${b64}`;
}

// ===============================
// HELPERS: OpenAI (reintentos + visión)
// ===============================
async function callOpenAIWithRetry(payload, maxRetries = 3) {
  const extraHeaders = OPENAI_ORG_ID ? { "OpenAI-Organization": OPENAI_ORG_ID } : {};
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify(payload)
    });
    if (r.ok) return r.json();
    const status = r.status;
    const body = await r.text().catch(() => "");
    if ((status === 429 || status === 503) && i < maxRetries) {
      const waitMs = 1000 * Math.pow(2, i); // 1s, 2s, 4s
      await new Promise(res => setTimeout(res, waitMs));
      continue;
    }
    lastErr = new Error(`OpenAI HTTP ${status}: ${body}`);
    break;
  }
  throw lastErr || new Error("OpenAI: error desconocido");
}

async function extractFieldsFromDataUrl(dataUrl) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  const prompt = `
Extrae de la imagen del manifiesto estos 14 campos y devolvé SOLO un JSON válido (sin comentarios):
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
- Normalizá fechas a YYYY-MM-DD si es posible; si no, dejá el formato tal cual se ve.
- Si un dato no se ve, dejá "".
- No pongas nada fuera del JSON.
`;

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        // OJO: image_url DEBE ser un objeto con { url }
        { type: "image_url", image_url: { url: dataUrl } }
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

  return {
    fecha_programacion:   parsed.fecha_programacion   ?? "",
    fecha_transporte:     parsed.fecha_transporte     ?? "",
    generador:            parsed.generador            ?? "",
    domicilio_generador:  parsed.domicilio_generador  ?? "",
    operador:             parsed.operador             ?? "",
    domicilio_operador:   parsed.domicilio_operador   ?? "",
    estado:               parsed.estado               ?? "",
    tipo_transporte:      parsed.tipo_transporte      ?? "",
    cantidad:             parsed.cantidad             ?? "",
    unidad:               parsed.unidad               ?? "",
    manifiesto_n:         parsed.manifiesto_n         ?? "",
    tipo_residuo:         parsed.tipo_residuo         ?? "",
    composicion:          parsed.composicion          ?? "",
    categoria_desecho:    parsed.categoria_desecho    ?? ""
  };
}

// ===============================
// WEBHOOK DE TWILIO (WhatsApp)
// ===============================
// Si querés validar la firma de Twilio, podrías usar:
// app.post("/whatsapp-webhook", twilio.webhook({ validate: true }), async (req, res) => { ... });

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

    const imageUrl   = req.body.MediaUrl0;
    const contentType = req.body.MediaContentType0 || "image/jpeg";

    // 1) Descargar imagen de Twilio (privada) → data URL
    const dataUrl = await fetchTwilioImageAsDataUrl(imageUrl, contentType);

    // 2) OpenAI visión → JSON con 14 campos
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

    // 5) Responder al chofer
    res.type("text/xml");
    res.send(
      `<Response><Message>✅ Cargado Manif. ${f.manifiesto_n} | ${f.cantidad} ${f.unidad}</Message></Response>`
    );
  } catch (e) {
    console.error("Error webhook:", e);
    const msg =
      /OpenAI HTTP 429/.test(String(e)) ?
        "Estamos al tope de uso de IA unos minutos. Intentá reenviar la foto más tarde." :
        String(e).slice(0, 140);
    res.type("text/xml").send(`<Response><Message>❌ Error: ${msg}</Message></Response>`);
  }
});

// ===============================
// START SERVER (Heroku asigna PORT)
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor en puerto", PORT));
