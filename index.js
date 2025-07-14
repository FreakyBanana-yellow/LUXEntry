// index.js (LUXEntryBot – Supabase + optionaler SelfieCheck bei Premium)
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import vision from "@google-cloud/vision";
import fetch from "node-fetch";
import cron from "node-cron";

dotenv.config();

const app = express();
const token = process.env.BOT_TOKEN;
const baseUrl = process.env.BASE_URL;

const bot = new TelegramBot(token);
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

// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: "/etc/secrets/vision_key.json"
});

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

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const startParam = match[1] ? match[1].trim().replace("=", "") : null;

  const { data: model } = await supabase
    .from("creator_config")
    .select("creator_id, bot_paket")
    .eq("telegramlink", startParam)
    .single();

  const modelId = model?.creator_id;

  if (!modelId) {
    return bot.sendMessage(chatId, "❌ Ungültiger Model-Link. Bitte prüfe deinen Zugangslink.");
  }

  await supabase.from("vip_users").upsert({
    telegram_id: user.id,
    username: user.username,
    creator_id: modelId,
    status: "gestartet"
  }, { onConflict: ["telegram_id"] });

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
    await supabase.from("vip_users").update({ alter_ok: true }).eq("telegram_id", userId);
    await bot.sendMessage(chatId, `Super! ✨ Bitte bestätige auch, dass du unsere Gruppenregeln gelesen hast:`, {
      reply_markup: {
        inline_keyboard: [[{ text: "📜 Regeln gelesen ✅", callback_data: "rules_ok" }]]
      }
    });
  }

  if (data === "rules_ok") {
    await supabase.from("vip_users").update({ regeln_ok: true }).eq("telegram_id", userId);
    const { data: userEntry } = await supabase.from("vip_users").select("creator_id").eq("telegram_id", userId).single();
    const creatorId = userEntry?.creator_id;

    const { data: creator } = await supabase.from("creator_config").select("paypal, preis, welcome_text, regeln_text").eq("creator_id", creatorId).single();
    if (!creator) return bot.sendMessage(chatId, "❌ Fehler beim Laden der Model-Daten.");

    await bot.sendMessage(chatId, `🔐 Um Zugang zu erhalten, sende bitte einen Screenshot **aus deinem PayPal-Zahlungsverlauf**. Wichtig:

- Der Screenshot muss den Text "Geld gesendet" enthalten
- Datum & Uhrzeit sichtbar (z. B. "Juli 11, 10:12 AM")
- Betrag **-${creator.preis} €**
- "Freunde und Familie" muss angezeigt werden
- Transaktionsnummer wie z. B. 1WC88058A3980530G
- Die Zahlung muss an **${creator.paypal}** erfolgt sein ✅

📸 **Nur Screenshots direkt aus dem Verlauf** sind gültig!`);
  }
});
