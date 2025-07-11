// index.js (Webhook-Version für LUXEntryBot)
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import visionPkg from "@google-cloud/vision";
import fetch from "node-fetch";

dotenv.config();
const { ImageAnnotatorClient } = visionPkg;
const app = express();
const port = process.env.PORT || 3000;
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
const visionClient = new ImageAnnotatorClient({
  keyFilename: "/etc/secrets/vision_key.json"
});

// Startnachricht
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;
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
    await bot.sendMessage(chatId, `🔐 Um Zugang zu erhalten, sende bitte einen Screenshot deiner Zahlung (z. B. PayPal).`);
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
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

    if (text.includes("30") && text.includes("luna.vip@paypal.com")) {
      await bot.sendMessage(chatId, "✅ Zahlung erkannt! Zugang wird eingerichtet...");

      // Beispiel: Eintrag in Supabase (vereinfachte Version)
      await supabase.from("entries").insert([
        {
          telegram_id: msg.from.id,
          username: msg.from.username,
          status: "confirmed",
          model_id: "luna"
        }
      ]);
    } else {
      await bot.sendMessage(chatId, "⚠️ Leider konnte keine gültige Zahlung erkannt werden. Bitte stelle sicher, dass Betrag und Empfänger sichtbar sind.");
    }
  } catch (error) {
    console.error("OCR Fehler:", error.message);
    await bot.sendMessage(chatId, "🚫 Beim Verarbeiten des Bildes ist ein Fehler aufgetreten.");
  }
});

app.listen(port, () => {
  console.log(`✅ LUXEntryBot läuft via Webhook auf: ${webhookUrl}`);
});
