// index.js (Webhook-Version für LUXEntryBot mit model_id + Supabase Lookup)
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import vision from "@google-cloud/vision";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const port = process.env.PORT;
const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL;

const bot = new TelegramBot(token, { webHook: { port: port } });
const webhookUrl = `${baseUrl}/bot${token}`;
bot.setWebHook(webhookUrl);

app.use(express.json());
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Supabase Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Google Vision Client (OCR für Screenshot-Auswertung)
const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: "/etc/secrets/vision_key.json"
});

// Screenshot-Validierung (PayPal-Verlauf)
const isValidPaypalScreenshot = (text, expectedAmount, recipientEmail) => {
  return (
    text.includes("Geld gesendet") &&
    text.match(/Juli\s\d{1,2},\s\d{1,2}:\d{2}\s(AM|PM)/) &&
    text.includes("Freunde und Familie") &&
    text.includes(`-${expectedAmount}`) &&
    text.includes(recipientEmail) &&
    text.match(/1WC[A-Z0-9]{13}G/)
  );
};

// Start mit /start oder /start=modelid
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const modelId = match[1] ? match[1].trim().replace("=", "") : null;

  if (modelId) {
    // In Supabase eintragen oder aktualisieren
    await supabase.from("entries").upsert({
      telegram_id: user.id,
      username: user.username,
      model_id: modelId,
      status: "started"
    }, { onConflict: ["telegram_id"] });
  }

  await bot.sendMessage(chatId, `👋 Willkommen, ${user.first_name}!

Bitte bestätige zunächst dein Alter, um fortzufahren.`, {
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Ich bin über 18", callback_data: "age_ok" },
        { text: "❌ Ich bin unter 18", callback_data: "age_no" }
      ]]
    }
  });
});

bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (data === "age_ok") {
    await bot.sendMessage(chatId, `Super! ✨ Bitte bestätige auch, dass du unsere Gruppenregeln gelesen hast:`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "📜 Regeln gelesen ✅", callback_data: "rules_ok" }
        ]]
      }
    });
  }

  if (data === "rules_ok") {
    const { data, error } = await supabase.from("entries").select("model_id").eq("telegram_id", userId).single();
    const modelId = data?.model_id;

    if (!modelId) return bot.sendMessage(chatId, "❌ Es wurde kein Model-Link gefunden. Bitte verwende einen gültigen Startlink wie z. B. t.me/LUXEntryBot?start=luna");

    // Hole die Model-Infos aus einer anderen Tabelle
    const { data: modelData } = await supabase.from("models").select("paypal_email, betrag").eq("id", modelId).single();

    if (!modelData) return bot.sendMessage(chatId, "❌ Model-Daten konnten nicht gefunden werden.");

    await bot.sendMessage(chatId, `🔐 Um Zugang zu erhalten, sende bitte einen Screenshot **aus deinem PayPal-Zahlungsverlauf**. Wichtig:

- Der Screenshot muss den Text "Geld gesendet" enthalten
- Datum und Uhrzeit sichtbar (z. B. "Juli 11, 10:12 AM")
- Betrag **-${modelData.betrag}**
- "Freunde und Familie" muss angezeigt werden
- Transaktionsnummer wie z. B. 1WC88058A3980530G
- Die Zahlung muss an **${modelData.paypal_email}** erfolgt sein ✅`);
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();

    const [result] = await visionClient.textDetection({ image: { content: Buffer.from(buffer) } });
    const detections = result.textAnnotations;

    if (!detections.length) {
      return bot.sendMessage(chatId, "❌ Leider konnte kein Text erkannt werden. Bitte versuche es erneut.");
    }

    const text = detections[0].description;
    console.log("OCR Text:", text);

    // Daten holen
    const { data: entryData } = await supabase.from("entries").select("model_id").eq("telegram_id", userId).single();
    if (!entryData) return bot.sendMessage(chatId, "❌ Kein Model-Eintrag gefunden. Bitte starte neu mit gültigem Link.");

    const { data: modelData } = await supabase.from("models").select("paypal_email, betrag").eq("id", entryData.model_id).single();
    if (!modelData) return bot.sendMessage(chatId, "❌ Model-Daten fehlen.");

    if (isValidPaypalScreenshot(text, modelData.betrag, modelData.paypal_email)) {
      await bot.sendMessage(chatId, `✅ Zahlung erkannt über **${modelData.betrag}** an **${modelData.paypal_email}**! Zugang wird eingerichtet...`);

      await supabase.from("entries").update({
        status: "confirmed"
      }).eq("telegram_id", userId);
    } else {
      await bot.sendMessage(chatId, "⚠️ Screenshot ungültig. Bitte sende ein Bild direkt aus deinem PayPal-Zahlungsverlauf mit dem korrekten Betrag und Empfänger.");
    }
  } catch (error) {
    console.error("OCR Fehler:", error.message);
    await bot.sendMessage(chatId, "🚫 Beim Verarbeiten des Bildes ist ein Fehler aufgetreten.");
  }
});

app.listen(port, () => {
  console.log(`✅ LUXEntryBot läuft via Webhook auf: ${webhookUrl}`);
});
