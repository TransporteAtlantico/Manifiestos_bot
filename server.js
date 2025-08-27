// ===============================
// DEPENDENCIAS
// ===============================
const express = require("express");
const fetch = require("node-fetch");
const { google } = require("googleapis");
// const twilio = require("twilio"); // solo si después querés usar la librería

const app = express();

// Middleware: Twilio envía x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===============================
// VARIABLES DE ENTORNO (SEGURAS)
// ===============================
const SHEET_ID = process.env.SHEET_ID || "";
const GS_CLIENT_EMAIL = process.env.GS_CLIENT_EMAIL || "";
const GS_PRIVATE_KEY = (process.env.GS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TWILIO_SID = process.env.TWILIO_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// ===============================
// RUTAS DE PRUEBA
// ===============================
app.get("/", (_req, res) => res.send("Manifiestos Bot OK"));
app.get("/healthz", (_req, res) => res.send("ok"));

// ===============================
// WEBHOOK WHATSAPP (Twilio)
// ===============================
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    console.log("TWILIO BODY:", req.body); // lo ves en Logs de Render

    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    if (numMedia < 1) {
      res.type("text/xml");
      return res.send(
        `<Response><Message>No recibí ninguna foto 📷. Mandala como *foto normal* (no "ver una vez").</Message></Response>`
      );
    }

    const imageUrl = req.body.MediaUrl0;

    // Aquí iría tu lógica con OpenAI Vision + Google Sheets
    // Por ahora solo hacemos eco de la URL
    console.log("Imagen recibida:", imageUrl);

    // Responder al chofer
    res.type("text/xml");
    res.send(
      `<Response><Message>✅ Recibí tu imagen. (URL: ${imageUrl})</Message></Response>`
    );
  } catch (err) {
    console.error("Error en webhook:", err);
    res.type("text/xml");
    res.send("<Response><Message>❌ Error procesando el manifiesto</Message></Response>");
  }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor en puerto", PORT));

