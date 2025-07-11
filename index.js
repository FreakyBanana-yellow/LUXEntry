require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const vision = require('@google-cloud/vision');
const fs = require('fs');

// === Setup ===
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const visionClient = new vision.ImageAnnotatorClient();

// === Start-Flow ===
bot.onText(/\/(start|hilfe)/i, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || 'unbekannt';

  // Creator aus Supabase laden
  const { data: creator, error } = await supabase
    .from('creator_config')
    .select('*')
    .eq('creator_id', 'luna') // Später dynamisch
    .single();

  if (error || !creator) return bot.sendMessage(chatId, 'Fehler beim Laden der Creator-Daten.');

  await bot.sendMessage(chatId, creator.welcome_text + '\n\nBist du mindestens 18 Jahre alt?', {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Ja', callback_data: 'alter_ok' },
        { text: '❌ Nein', callback_data: 'alter_nicht_ok' },
      ]],
    },
  });
});

// === CallbackHandler ===
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const username = query.from.username;

  if (data === 'alter_ok') {
    await bot.sendMessage(chatId, 'Super! Bitte bestätige die Gruppenregeln:', {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ich akzeptiere die Regeln', callback_data: 'regeln_ok' },
        ]],
      },
    });
  } else if (data === 'alter_nicht_ok') {
    await bot.sendMessage(chatId, 'Du musst mindestens 18 Jahre alt sein, um fortzufahren.');
  } else if (data === 'regeln_ok') {
    const gruppeLink = 'https://t.me/+DeinVIPLink'; // später dynamisch
    await bot.sendMessage(chatId, `Perfekt! Hier ist dein Zugang zur VIP-Gruppe:\n${gruppeLink}`);

    // Speichern in Supabase
    await supabase.from('vip_users').upsert({
      telegram_id: chatId,
      username,
      creator_id: 'luna',
      alter_ok: true,
      regeln_ok: true,
      status: 'aktiv',
    });
  }
});

// === Screenshot-Upload zur Zahlung (Text wird mit Vision geprüft) ===
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
    const fileLink = await bot.getFileLink(fileId);
    const response = await fetch(fileLink);
    const buffer = await response.arrayBuffer();
    const tempPath = `/tmp/${fileId}.jpg`;
    fs.writeFileSync(tempPath, Buffer.from(buffer));

    const [result] = await visionClient.textDetection(tempPath);
    const detections = result.textAnnotations;
    const text = detections[0]?.description || '';

    if (text.includes('30') && text.includes('luna.vip@paypal.com')) {
      await bot.sendMessage(chatId, '✅ Zahlung erkannt! Du bekommst gleich deinen Zugang.');
      await supabase.from('vip_users').update({ zahlung_ok: true }).eq('telegram_id', chatId);
    } else {
      await bot.sendMessage(chatId, '❌ Leider konnte ich deine Zahlung nicht eindeutig erkennen. Bitte prüfe den Screenshot.');
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, 'Fehler bei der Verarbeitung des Screenshots.');
  }
});

console.log('🤖 LUXEntryBot läuft!');
