// ===============================
// DEPENDENCIAS (CommonJS)
// ===============================
const express = require("express");
const { google } = require("googleapis");
// Si en algún momento querés validar la firma, descomentá esto y cargá TWILIO_AUTH_TOKEN
// const twilio = require("twilio");

const app = express();

// Twilio manda application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===============================
// VARIABLES DE ENTORNO (protegidas)
// ===============================
const SHEET_ID        = process.env.SHEET_ID || "";
const GS_CLIENT_EMAIL = process.env.GS_CLIENT_EMAIL || "";
const GS_PRIVATE_KEY  = (process.env.GS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || "";

// ===============================
// RUTAS DE PRUEBA
// ===============================
app.get("/", (_req, res) => res.send("Manifiestos Bot OK"));
app.get("/healthz", (_req, res) => res.send("ok"));

// (Opcional) test rápido de OpenAI sin imagen
app.get("/test-openai", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
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

// ===============================
// HELPERS: Google Sheets
// ===============================
async function appendRowToSheet(values) {
  if (!SHEET_ID || !GS_CLIENT_EMAIL || !GS_PRIVATE_KEY) {
    throw new Error("Faltan credenciales de Google Sheets (SHEET_ID, GS_CLIENT_EMAIL, GS_PRIVATE_KEY).");
  }

  const auth = new google.auth.JWT(
    GS_CLIENT_EMAIL,
    null,
    GS_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Manifiestos!A:N",             // 14 columnas (A..N)
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

// ===============================
// HELPERS: OpenAI Visión
// ===============================
async function extractFieldsFromImage(imageUrl) {
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
- Normalizá fechas a YYYY-MM-DD si es posible; si no, dejá el formato tal como se ve.
- Si un dato no se ve, dejá "" (cadena vacía).
- No agregues nada fuera del JSON.
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: imageUrl }
        ]
      }]
    })
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${r.status}: ${txt}`);
  }

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content || "{}";

  // Intento robusto de parseo: tomar el primer bloque {...}
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No se pudo parsear JSON devuelto por OpenAI.");
    parsed = JSON.parse(m[0]);
  }

  // Normalizar claves
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
// Si querés validar firma de Twilio, usá el middleware siguiente y cargá TWILIO_AUTH_TOKEN:
// app.post("/whatsapp-webhook", twilio.webhook({ validate: true }), async (req, res) => { ... });

app.post("/whatsapp-webhook", async (req, res) => {
  try {
    console.log("TWILIO BODY:", req.body);

    const from = req.body.From;                         // whatsapp:+54911...
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

    // 1) OpenAI visión -> JSON con 14 campos
    const f = await extractFieldsFromImage(imageUrl);

    // 2) Orden para la fila (14 columnas)
    const row = [
      f.fecha_programacion,     // 1
      f.fecha_transporte,       // 2
      f.generador,              // 3
      f.domicilio_generador,    // 4
      f.operador,               // 5
      f.domicilio_operador,     // 6
      f.estado,                 // 7
      f.tipo_transporte,        // 8
      f.cantidad,               // 9
      f.unidad,                 // 10
      f.manifiesto_n,           // 11
      f.tipo_residuo,           // 12
      f.composicion,            // 13
      f.categoria_desecho       // 14
    ];

    // 3) Guardar en Google Sheets
    await appendRowToSheet(row);

    // 4) Responder al chofer (TwiML directo)
    res.type("text/xml");
    res.send(
      `<Response><Message>✅ Cargado Manif. ${f.manifiesto_n} | ${f.cantidad} ${f.unidad}</Message></Response>`
    );
  } catch (e) {
    console.error("Error webhook:", e);
    res.type("text/xml").send(`<Response><Message>❌ Error: ${String(e).slice(0,140)}</Message></Response>`);
  }
});

// ===============================
// START SERVER (Heroku asigna PORT)
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor en puerto", PORT));

