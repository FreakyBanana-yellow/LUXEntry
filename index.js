// index.js (Webhook-Version für LUXEntryBot mit Supabase + Screenshotprüfung)
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
  const modelId = match[1] ? match[1].trim().replace("=", "") : null;

  if (modelId) {
    await supabase.from("vip_users").upsert({
      telegram_id: user.id,
      username: user.username,
      creator_id: modelId,
      status: "gestartet"
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
    await supabase.from("vip_users").update({ alter_ok: true }).eq("telegram_id", userId);
    await bot.sendMessage(chatId, `Super! ✨ Bitte bestätige auch, dass du unsere Gruppenregeln gelesen hast:`, {
      reply_markup: {
        inline_keyboard: [[{ text: "📜 Regeln gelesen ✅", callback_data: "rules_ok" }]]
      ]
    });
  }

  if (data === "rules_ok") {
    await supabase.from("vip_users").update({ regeln_ok: true }).eq("telegram_id", userId);
    const { data: userEntry } = await supabase.from("vip_users").select("creator_id").eq("telegram_id", userId).single();
    const creatorId = userEntry?.creator_id;

    const { data: creator } = await supabase.from("creator_config").select("paypal, preis").eq("creator_id", creatorId).single();
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
    if (!detections.length) return bot.sendMessage(chatId, "❌ Kein Text erkannt. Bitte sende den Screenshot erneut.");

    const text = detections[0].description;
    console.log("OCR Text:", text);

    const { data: userEntry } = await supabase.from("vip_users").select("creator_id").eq("telegram_id", userId).single();
    const creatorId = userEntry?.creator_id;
    const { data: creator } = await supabase.from("creator_config").select("paypal, preis, vip_days").eq("creator_id", creatorId).single();

    if (!creator) return bot.sendMessage(chatId, "❌ Fehler beim Laden der Model-Daten.");

    if (isValidPaypalScreenshot(text, creator.preis, creator.paypal)) {
      const vipBis = new Date();
      vipBis.setDate(vipBis.getDate() + creator.vip_days);

      await supabase.from("vip_users").update({
        zahlung_ok: true,
        vip_bis: vipBis.toISOString().split("T")[0],
        screenshot_url: file.file_path,
        status: "aktiv"
      }).eq("telegram_id", userId);

      await bot.sendMessage(chatId, `✅ Zahlung über **${creator.preis} €** an **${creator.paypal}** erkannt! Zugang wird vorbereitet.`);
    } else {
      await bot.sendMessage(chatId, `⚠️ Screenshot ungültig.

Bitte achte darauf, dass **alle folgenden Punkte** sichtbar sind:
- Text "Geld gesendet"
- Betrag -${creator.preis} €
- Empfänger: ${creator.paypal}
- Transaktionsnummer (z. B. 1WC...G)
- "Freunde und Familie"
- Datum & Uhrzeit sichtbar

📸 Nur Screenshots **direkt aus dem PayPal-Verlauf** werden akzeptiert.`);
    }
  } catch (err) {
    console.error("OCR Fehler:", err.message);
    await bot.sendMessage(chatId, "🚫 Fehler beim Verarbeiten des Screenshots.");
  }
});

app.listen(port, () => {
  console.log(`✅ LUXEntryBot läuft via Webhook auf: ${webhookUrl}`);
});
