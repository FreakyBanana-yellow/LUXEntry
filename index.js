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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: "/etc/secrets/vision_key.json"
});

const isValidPaypalScreenshot = (text, expectedAmount) => {
  return (
    text.includes("Geld gesendet") &&
    /[A-ZÄÖÜa-zäöü]+\s\d{1,2},\s\d{1,2}:\d{2}\s(AM|PM)/.test(text) &&
    text.includes("Freunde und Familie") &&
    text.includes(`-${expectedAmount}`) &&
    text.match(/1WC[A-Z0-9]{13}G/)
  );
};

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const modelParam = match[1] ? match[1].trim().replace("=", "") : null;

  const { data: model } = await supabase
    .from("creator_config")
    .select("creator_id, bot_paket")
    .eq("telegramlink", modelParam)
    .single();

  const modelId = model?.creator_id;
  if (!modelId) return bot.sendMessage(chatId, "❌ Ungültiger Model-Link.");

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

    await bot.sendMessage(chatId, `🔐 Um Zugang zu erhalten:
1️⃣ Sende –${creator.preis} € an: **${creator.paypal}**
2️⃣ Danach Screenshot aus deinem PayPal-Zahlungsverlauf hier senden.`);
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const { data: userEntry } = await supabase.from("vip_users").select("creator_id, vip_bis").eq("telegram_id", userId).single();
  const creatorId = userEntry?.creator_id;

  const { data: creator } = await supabase.from("creator_config").select("paypal, preis, gruppe_link, bot_paket, vip_days, welcome_text, regeln_text").eq("creator_id", creatorId).single();
  if (!creator) return bot.sendMessage(chatId, "❌ Fehler beim Laden der Model-Daten.");

  const fileId = msg.photo[msg.photo.length - 1].file_id;
  try {
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();

    const [result] = await visionClient.textDetection({ image: { content: Buffer.from(buffer) } });
    const detections = result.textAnnotations;
    if (!detections.length) return bot.sendMessage(chatId, "❌ Kein Text erkannt.");

    const text = detections[0].description;
    if (isValidPaypalScreenshot(text, creator.preis)) {
      let newVipBis = new Date();
      const oldDate = userEntry?.vip_bis ? new Date(userEntry.vip_bis) : newVipBis;
      if (oldDate > newVipBis) newVipBis = oldDate;
      newVipBis.setDate(newVipBis.getDate() + (creator.vip_days || 7));

      await supabase.from("vip_users").update({
        zahlung_ok: true,
        vip_bis: newVipBis.toISOString().split("T")[0],
        screenshot_url: file.file_path,
        status: "aktiv"
      }).eq("telegram_id", userId);

      await bot.sendMessage(chatId, creator.welcome_text || "👋 Willkommen beim VIP-Zugang!");
      await bot.sendMessage(chatId, creator.regeln_text || "📜 Verhalte dich respektvoll. Verstöße = Bann.");
      await bot.sendMessage(chatId, `✅ Zahlung über –${creator.preis} € erkannt! Zugang verlängert.`);

      if (creator.bot_paket === "premium") {
        await bot.sendMessage(chatId, `📸 Bitte sende zusätzlich ein Selfie zur Altersverifikation.`);
        return;
      }

      await bot.sendMessage(chatId, `💬 Dein Zugang: ${creator.gruppe_link}`);
    } else {
      await bot.sendMessage(chatId, `⚠️ Screenshot ungültig. Achte auf:
- Text "Geld gesendet"
- Betrag –${creator.preis} €
- Transaktionsnummer
- "Freunde und Familie"
- Datum & Uhrzeit`);
    }
  } catch (err) {
    console.error("OCR Fehler:", err.message);
    await bot.sendMessage(chatId, "🚫 Fehler beim Verarbeiten des Screenshots.");
  }
});

cron.schedule("0 8 * * *", async () => {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const in3Days = new Date(today);
  in3Days.setDate(today.getDate() + 3);

  const format = (d) => d.toISOString().split("T")[0];

  const { data: fällig } = await supabase
    .from("vip_users")
    .select("telegram_id, vip_bis")
    .in("vip_bis", [format(tomorrow), format(in3Days)])
    .eq("zahlung_ok", true);

  if (fällig?.length) {
    for (const user of fällig) {
      await bot.sendMessage(user.telegram_id, `⏳ Dein VIP-Zugang endet am ${user.vip_bis}.

Sende jetzt einfach wieder einen Zahlungsbeleg, um ihn zu verlängern.`);
    }
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LUXEntryBot läuft via Webhook auf: ${webhookUrl}`);
});
