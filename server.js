// ===============================
// DEPENDENCIAS (CommonJS)
// ===============================
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio manda form-urlencoded
app.use(express.json());

// ===============================
// VARS DE ENTORNO (protegidas)
// ===============================
const SHEET_ID = process.env.SHEET_ID || "";
const GS_CLIENT_EMAIL = process.env.GS_CLIENT_EMAIL || "";
const GS_PRIVATE_KEY = (process.env.GS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ===============================
// RUTAS DE PRUEBA
// ===============================
app.get("/", (_req, res) => res.send("Manifiestos Bot OK"));
app.get("/healthz", (_req, res) => res.send("ok"));

// ===============================
// HELPERS: Google Sheets
// ===============================
async function appendRowToSheet(values) {
  // values = array de 14 columnas en el orden pedido
  if (!SHEET_ID || !GS_CLIENT_EMAIL || !GS_PRIVATE_KEY) {
    throw new Error("Faltan credenciales de Google Sheets en variables de entorno.");
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
    range: "Manifiestos!A:N", // 14 columnas (A..N)
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

// ===============================
// HELPERS: OpenAI visión (fetch nativo Node 18)
// ===============================
async function extractFieldsFromImage(imageUrl) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  const prompt = `
Extrae de la imagen del manifiesto estos 14 campos EXACTOS y devuelve SOLO un JSON válido (sin comentarios):
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
- Normaliza fechas a YYYY-MM-DD si es posible; si está manuscrita incompleta, deja el formato original.
- Si un dato no aparece, deja "" (cadena vacía).
- No agregues texto fuera del JSON.
`;

  const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: imageUrl }
          ]
        }
      ]
    })
  });

  if (!oaiRes.ok) {
    const txt = await oaiRes.text().catch(() => "");
    throw new Error(`OpenAI error HTTP ${oaiRes.status}: ${txt}`);
  }

  const data = await oaiRes.json();
  const content = data?.choices?.[0]?.message?.content || "{}";

  // Intentar parsear el JSON devuelto
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Intento extra: si vino con basura, buscar el primer bloque {...}
    const match = content.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error("No se pudo parsear JSON de OpenAI");
  }

  // Asegurar todas las claves
  const norm = {
    fecha_programacion: parsed.fecha_programacion ?? "",
    fecha_transporte: parsed.fecha_transporte ?? "",
    generador: parsed.generador ?? "",
    domicilio_generador: parsed.domicilio_generador ?? "",
    operador: parsed.operador ?? "",
    domicilio_operador: parsed.domicilio_operador ?? "",
    estado: parsed.estado ?? "",
    tipo_transporte: parsed.tipo_transporte ?? "",
    cantidad: parsed.cantidad ?? "",
    unidad: parsed.unidad ?? "",
    manifiesto_n: parsed.manifiesto_n ?? "",
    tipo_residuo: parsed.tipo_residuo ?? "",
    composicion: parsed.composicion ?? "",
    categoria_desecho: parsed.categoria_desecho ?? ""
  };

  return norm;
}

// ===============================
// WEBHOOK DE TWILIO (WhatsApp)
// ===============================
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    if (!from) {
      res.type("text/xml");
      return res.send(`<Response><Message>No reconozco el remitente.</Message></Response>`);
    }

    if (numMedia < 1) {
      res.type("text/xml");
      return res.send(
        `<Response><Message>No recibí ninguna foto 📷. Enviá la imagen como *foto normal* (no "ver una vez" ni "documento").</Message></Response>`
      );
    }

    const imageUrl = req.body.MediaUrl0;

    // 1) Extraer datos con OpenAI
    const fields = await extractFieldsFromImage(imageUrl);

    // 2) Mapear al orden exacto de columnas (14)
    const row = [
      fields.fecha_programacion,     // 1 Fecha Programación
      fields.fecha_transporte,       // 2 Fecha del transporte
      fields.generador,              // 3 Generador
      fields.domicilio_generador,    // 4 Domicilio generador
      fields.operador,               // 5 Operador
      fields.domicilio_operador,     // 6 Domicilio operador
      fields.estado,                 // 7 Estado
      fields.tipo_transporte,        // 8 Tipo Transporte
      fields.cantidad,               // 9 Cantidad
      fields.unidad,                 // 10 Unidad
      fields.manifiesto_n,           // 11 Manifiesto N°
      fields.tipo_residuo,           // 12 Tipo de residuo
      fields.composicion,            // 13 Composición
      fields.categoria_desecho       // 14 Categoría de desecho
    ];

    // 3) Grabar en Google Sheets
    await appendRowToSheet(row);

    // 4) Responder al chofer (TwiML en la respuesta)
    res.type("text/xml");
    res.send(
      `<Response><Message>✅ Cargado Manif. ${fields.manifiesto_n} | ${fields.cantidad} ${fields.unidad}</Message></Response>`
    );
  } catch (err) {
    console.error("Error en webhook:", err);
    res.type("text/xml");
    res.send(`<Response><Message>❌ Error: ${err.message.slice(0, 140)}</Message></Response>`);
  }
});

// ===============================
// START SERVER (Render usa PORT)
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor en puerto", PORT));
