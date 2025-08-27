const express = require("express");
const app = express();
const data = await res.json();
console.log(data);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (_req, res) => res.send("Manifiestos Bot OK"));
app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/whatsapp-webhook", (req, res) => {
  console.log("TWILIO BODY:", req.body);
  res.type("text/xml").send("<Response><Message>Webhook vivo</Message></Response>");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor en puerto", PORT));
