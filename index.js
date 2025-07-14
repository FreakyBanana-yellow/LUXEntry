// index.js (Vollständig dynamisch – LUXEntryBot mit Supabase)
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
  const modelName = match[1] ? match[1].trim().replace("=", "") : null;

  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(modelName);
  if (!isUUID) {
    return bot.sendMessage(chatId, "❌ Ungültiger Link – bitte klicke direkt auf deinen personalisierten Zugang.");
  }

  const { data: model } = await supabase.from("creator_config").select("creator_id").eq("creator_id", modelName).single();
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

// ... (Rest bleibt unverändert)
