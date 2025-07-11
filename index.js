const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const userStates = {};

bot.onText(/\/start(?:\s(\w+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || '';
  const creatorId = match[1];

  if (!creatorId) {
    bot.sendMessage(chatId, 'Bitte nutze den personalisierten Startlink des Models. Beispiel: /start luna');
    return;
  }

  const { data: config, error } = await supabase
    .from('creator_config')
    .select('*')
    .eq('creator_id', creatorId)
    .single();

  if (error || !config) {
    bot.sendMessage(chatId, 'Fehler beim Laden der Creator-Konfiguration.');
    return;
  }

  userStates[chatId] = { creatorId, step: 'alter' };

  bot.sendMessage(chatId, `${config.welcome_text}

Bist du mindestens 18 Jahre alt?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Ja', callback_data: 'alter_yes' }],
        [{ text: '❌ Nein', callback_data: 'alter_no' }]
      ]
    }
  });
});

bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const username = callbackQuery.from.username || '';
  const data = callbackQuery.data;
  const state = userStates[chatId];

  if (!state || !state.creatorId) return;

  const { creatorId, step } = state;

  const { data: config } = await supabase
    .from('creator_config')
    .select('*')
    .eq('creator_id', creatorId)
    .single();

  if (data === 'alter_yes') {
    userStates[chatId].step = 'regeln';
    bot.sendMessage(chatId, config.regeln_text + '

Stimmst du den Regeln zu?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Ich stimme zu', callback_data: 'regeln_yes' }],
          [{ text: '❌ Nein', callback_data: 'regeln_no' }]
        ]
      }
    });
  } else if (data === 'alter_no') {
    bot.sendMessage(chatId, 'Du musst mindestens 18 Jahre alt sein, um fortzufahren.');
  } else if (data === 'regeln_yes') {
    userStates[chatId].step = 'zahlung';
    bot.sendMessage(chatId, `Perfekt! 💸 Der Zugang kostet ${config.preis} €.
Bitte sende den Betrag an: ${config.paypal}

Anschließend sende bitte einen Screenshot deiner Zahlung.`);
  } else if (data === 'regeln_no') {
    bot.sendMessage(chatId, 'Du musst den Regeln zustimmen, um fortzufahren.');
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const state = userStates[chatId];
  if (!state || !state.creatorId || state.step !== 'zahlung') return;

  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    const { data: config } = await supabase
      .from('creator_config')
      .select('*')
      .eq('creator_id', state.creatorId)
      .single();

    const vipBis = new Date();
    vipBis.setDate(vipBis.getDate() + config.vip_dauer);

    await supabase.from('vip_users').insert({
      telegram_id: String(chatId),
      username: msg.from.username || '',
      creator_id: state.creatorId,
      alter_ok: true,
      regeln_ok: true,
      zahlung_ok: true,
      vip_bis: vipBis.toISOString().split('T')[0],
      status: 'aktiv',
      screenshot_url: fileId,
    });

    bot.sendMessage(chatId, `Danke! ✅ Deine Zahlung wurde registriert.
Hier ist dein Zugang: ${config.gruppe_link}`);
    delete userStates[chatId];
  }
});
