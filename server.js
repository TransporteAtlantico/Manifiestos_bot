// server.js
const express = require("express");
const fetch = require("node-fetch");
const { google } = require("googleapis");
const twilio = require("twilio");

const app = express();
app.use(express.json());

// ===============================
// Variables de entorno necesarias
// ===============================
const SHEET_ID         = process.env.SHEET_ID || "";
const GS_CLIENT_EMAIL  = process.env.GS_CLIENT_EMAIL || "";
const GS_PRIVATE_KEY   = (process.env.GS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY || "";
const TWILIO_SID       = process.env.TWILIO_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || ""

// ===============================
// Webhook de Twilio (WhatsApp)
// ===============================
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    const body = req.body;

    // Extraer datos de Twilio
    const from = body.From;             // número del chofer
    const mediaUrl = body.MediaUrl0;    // URL de la foto enviada
    if (!mediaUrl) {
      return res.send("<Response><Message>No recibí ninguna imagen 📷</Message></Response>");
    }

    // 1) Mandar la imagen a ChatGPT Vision
    const oaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `De este manifiesto de transporte extrae los siguientes campos en formato JSON:
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
}`
              },
              { type: "image_url", image_url: mediaUrl }
            ]
          }
        ]
      })
    }).then(r => r.json());

    const data = JSON.parse(oaiRes.choices[0].message.content);

    // 2) Escribir en Google Sheets
    const auth = new google.auth.JWT(GS_CLIENT_EMAIL, null, GS_PRIVATE_KEY, [
      "https://www.googleapis.com/auth/spreadsheets"
    ]);
    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Manifiestos!A:N", // A:N = 14 columnas
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          data.fecha_programacion,
          data.fecha_transporte,
          data.generador,
          data.domicilio_generador,
          data.operador,
          data.domicilio_operador,
          data.estado,
          data.tipo_transporte,
          data.cantidad,
          data.unidad,
          data.manifiesto_n,
          data.tipo_residuo,
          data.composicion,
          data.categoria_desecho
        ]]
      }
    });

    // 3) Responder al chofer
    const resp = `<Response><Message>✅ Manifiesto ${data.manifiesto_n} cargado (${data.cantidad} ${data.unidad})</Message></Response>`;
    res.type("text/xml");
    res.send(resp);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error procesando el manifiesto");
  }
});

app.listen(3000, () => console.log("Servidor escuchando en puerto 3000"));
