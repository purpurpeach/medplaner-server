// ════════════════════════════════════════════════════════════
//  МедПланер — Backend Server
//  Node.js + Express + Supabase + OpenAI
//  Бот с AI-ассистентом: текст, фото, голос → планер
// ════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const crypto = require('crypto');
const icalGenerator = require('ical-generator');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// ─── Clients ───────────────────────────────────────────────
const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.warn(`Missing required environment variables: ${missingEnv.join(', ')}`);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const botMode = process.env.BOT_MODE || (process.env.NODE_ENV === 'production' ? 'webhook' : 'polling');
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const pendingEvents = new Map();
const ical = icalGenerator.default || icalGenerator;

function miniAppUrl() {
  return process.env.MINIAPP_URL || process.env.APP_URL || 'https://example.com';
}

function rememberEvent(event) {
  const id = crypto.randomBytes(8).toString('hex');
  pendingEvents.set(id, event);
  setTimeout(() => pendingEvents.delete(id), 30 * 60 * 1000).unref?.();
  return id;
}

function addEventKeyboard(event, text = '✅ Добавить') {
  return [[
    { text, callback_data: `add:${rememberEvent(event)}` },
    { text: '❌ Отмена', callback_data: 'cancel' }
  ]];
}

// ─── Encryption ────────────────────────────────────────────
const ENCRYPT_KEY = crypto
  .createHash('sha256')
  .update(process.env.ENCRYPT_KEY || 'default_key_change_me_please')
  .digest();

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  try {
    const [ivHex, encHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPT_KEY, iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch { return text; }
}

function encryptPatientNote(note) {
  if (!note) return note;
  const patientPattern = /[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+/;
  if (patientPattern.test(note)) return encrypt(note);
  return note;
}

// ─── Auth middleware ────────────────────────────────────────
function validateTelegramUser(req, res, next) {
  const userId = req.headers['x-telegram-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  next();
}

// ─── Schedule API ───────────────────────────────────────────
app.get('/api/schedule', validateTelegramUser, async (req, res) => {
  const { data, error } = await supabase
    .from('schedules').select('*').eq('user_id', req.userId).single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  if (!data) return res.json({ schedule: {}, categories: [] });
  const schedule = data.schedule_data || {};
  Object.values(schedule).forEach(day => {
    if (Array.isArray(day)) day.forEach(block => {
      if (block.note && block.note.includes(':')) {
        try { block.note = decrypt(block.note); } catch {}
      }
    });
  });
  res.json({ schedule, categories: data.categories || [] });
});

app.post('/api/schedule', validateTelegramUser, async (req, res) => {
  const { schedule, categories } = req.body;
  const encSchedule = JSON.parse(JSON.stringify(schedule));
  Object.values(encSchedule).forEach(day => {
    if (Array.isArray(day)) day.forEach(block => {
      block.note = encryptPatientNote(block.note);
    });
  });
  const { error } = await supabase.from('schedules').upsert({
    user_id: req.userId, schedule_data: encSchedule,
    categories, updated_at: new Date().toISOString()
  });
  if (error) return res.status(500).json({ error: error.message });
  syncToCalendars(req.userId, schedule).catch(console.error);
  res.json({ ok: true });
});

// ─── iCal ──────────────────────────────────────────────────
app.get('/ical/:userId.ics', async (req, res) => {
  const { userId } = req.params;
  const { data } = await supabase.from('schedules').select('*').eq('user_id', userId).single();
  const cal = ical({ name: 'МедПланер' });
  if (data?.schedule_data) {
    const today = new Date();
    Object.entries(data.schedule_data).forEach(([dayIdx, blocks]) => {
      if (!Array.isArray(blocks)) return;
      blocks.forEach(block => {
        const date = new Date(today);
        const dow = today.getDay();
        const mon = dow === 0 ? -6 : 1 - dow;
        date.setDate(date.getDate() + mon + parseInt(dayIdx));
        const start = new Date(date);
        start.setHours(Math.floor(block.start), (block.start % 1) * 60, 0, 0);
        const end = new Date(date);
        end.setHours(Math.floor(block.end), (block.end % 1) * 60, 0, 0);
        const note = block.note && block.note.includes(':') ? decrypt(block.note) : (block.note || '');
        cal.createEvent({ start, end, summary: block.title, description: note });
      });
    });
  }
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.send(cal.toString());
});

// ─── Evening summary ────────────────────────────────────────
app.post('/api/evening-summary', validateTelegramUser, async (req, res) => {
  const { eveData, easy, hard, win } = req.body;
  await supabase.from('daily_logs').insert({
    user_id: req.userId, date: new Date().toISOString().slice(0, 10),
    energy: eveData?.energy, focus: eveData?.focus,
    what_easy: easy, what_hard: hard, win_of_day: win,
  }); // handled
  const { data: user } = await supabase.from('users').select('telegram_id').eq('id', req.userId).single();
  if (user?.telegram_id) {
    const summary = await generateEveSummary({ easy, hard, win, energy: eveData?.energy });
    bot.sendMessage(user.telegram_id, summary, { parse_mode: 'Markdown' }); // handled
  }
  res.json({ ok: true });
});

async function generateEveSummary({ easy, hard, win, energy }) {
  if (!openai) {
    return 'Хороший день! Отдохните и подготовьтесь к завтрашнему.';
  }
  const prompt = `Составь краткое вечернее резюме дня для врача (3-4 предложения), на русском.
Что далось легко: ${easy || 'не указано'}
Что было сложно: ${hard || 'не указано'}
Победа дня: ${win || 'не указано'}
Уровень энергии: ${energy || '?'}/5
Будь ободряющим, добавь 1-2 рекомендации на завтра.`;
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini', max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    return r.choices[0].message.content;
  } catch { return 'Хороший день! Отдыхайте и готовьтесь к завтрашнему.'; }
}

// ─── Google Calendar sync ───────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.APP_URL + '/api/auth/gcal/callback'
);

async function syncToCalendars(userId, schedule) {
  const tokens = await getOAuthTokens(userId);
  if (!tokens.gcal) return;
  const today = new Date();
  const events = [];
  Object.entries(schedule).forEach(([dayIdx, blocks]) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach(block => {
      const date = new Date(today);
      const dow = today.getDay(); const mon = dow === 0 ? -6 : 1 - dow;
      date.setDate(date.getDate() + mon + parseInt(dayIdx));
      events.push({ ...block, date });
    });
  });
  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: tokens.gcal });
    const cal = google.calendar({ version: 'v3', auth });
    for (const event of events) {
      const start = new Date(event.date);
      start.setHours(Math.floor(event.start), (event.start % 1) * 60, 0, 0);
      const end = new Date(event.date);
      end.setHours(Math.floor(event.end), (event.end % 1) * 60, 0, 0);
      await cal.events.insert({ calendarId: 'primary', requestBody: {
        summary: event.title, description: event.note || '',
        start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() },
      }}); // handled
    }
  } catch (e) { console.error('GCal sync error:', e.message); }
}

app.get('/api/auth/gcal', (req, res) => {
  const { userId } = req.query;
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar'], state: userId
  });
  res.redirect(url);
});

app.get('/api/auth/gcal/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  await supabase.from('oauth_tokens').upsert({ user_id: userId, provider: 'gcal', tokens: JSON.stringify(tokens) });
  res.send('<script>window.close()</script><p>Google Calendar подключён!</p>');
});

async function getOAuthTokens(userId) {
  const { data } = await supabase.from('oauth_tokens').select('*').eq('user_id', userId);
  const result = {};
  (data || []).forEach(row => {
    const t = JSON.parse(row.tokens || '{}');
    result[row.provider] = t.access_token;
  });
  return result;
}

// ─── AI helpers ─────────────────────────────────────────────

// Добавить событие в расписание пользователя
async function addEventToSchedule(userId, event) {
  const { data: sched } = await supabase.from('schedules').select('schedule_data').eq('user_id', userId).single();
  const schedule = sched?.schedule_data || {};
  const today = new Date().getDay();
  const dayIdx = today === 0 ? 6 : today - 1;
  if (!schedule[dayIdx]) schedule[dayIdx] = [];
  schedule[dayIdx].push({
    id: crypto.randomBytes(4).toString('hex'),
    title: event.title,
    cat: event.cat || 'c-adm',
    start: event.start || 9,
    end: event.end || 10,
    note: encryptPatientNote(event.note || ''),
    noTime: event.noTime || false,
    urgent: false, done: false, steps: []
  });
  await supabase.from('schedules').upsert({
    user_id: userId, schedule_data: schedule, updated_at: new Date().toISOString()
  });
  return schedule;
}

// Разобрать текстовое сообщение
async function parseTextMessage(text) {
  if (!openai) {
    return {
      type: 'task',
      title: text.slice(0, 80),
      start: 9,
      end: 10,
      noTime: true,
      cat: 'c-adm',
      note: ''
    };
  }
  const prompt = `Ты помощник врача-планировщика. Разбери сообщение и верни JSON без markdown.

Формат:
{
  "type": "task|question|other",
  "title": "название задачи",
  "start": 9,
  "end": 10,
  "noTime": false,
  "cat": "c-med|c-conf|c-trav|c-adm|c-pers",
  "note": "",
  "reply": "ответ если type=question или other"
}

Правила:
- type=task если это задача/событие/запись для планера
- type=question если спрашивают совет, информацию, задают вопрос
- type=other если просто общение
- cat: c-med=пациент/операция, c-conf=конференция/совещание, c-trav=поездка/перелёт, c-adm=административное, c-pers=личное
- noTime=true если время не указано, тогда start=9 end=10
- note для пациентов: "Фамилия Имя Отчество КодИстории Диагноз Операция"
- reply: краткий ответ на вопрос (если type=question/other)

Сообщение: "${text}"`;

  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini', max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });
    const clean = r.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('parseText error:', e.message);
    return null;
  }
}

// Разобрать изображение (билет, направление, документ)
async function parseImageMessage(imageUrl) {
  if (!openai) {
    return null;
  }
  const prompt = `Ты помощник врача-планировщика. Посмотри на изображение и извлеки информацию для планера.

Верни JSON без markdown:
{
  "found": true/false,
  "title": "название события",
  "start": 9,
  "end": 10,
  "noTime": false,
  "cat": "c-med|c-conf|c-trav|c-adm|c-pers",
  "note": "детали: ФИО, номер рейса, адрес и т.д.",
  "description": "краткое описание что найдено на фото"
}

Если это билет — извлеки рейс, дату, время вылета/прилёта.
Если это направление пациента — извлеки ФИО, диагноз, процедуру.
Если это письмо/документ — извлеки суть события и время.
Если ничего не найдено — found=false.`;

  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    });
    const clean = r.choices[0].message.content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('parseImage error:', e.message);
    return null;
  }
}

// Расшифровать голосовое сообщение
async function transcribeVoice(fileUrl) {
  if (!openai) {
    return null;
  }
  try {
    // Скачиваем файл
    const tmpPath = `/tmp/voice_${Date.now()}.ogg`;
    await downloadFile(fileUrl, tmpPath);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'ru'
    });
    fs.unlinkSync(tmpPath);
    return transcription.text;
  } catch (e) {
    console.error('transcribe error:', e.message);
    return null;
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); }).on('error', reject);
  });
}

// ─── Telegram Bot ───────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  await supabase.from('users').upsert({ id: userId, telegram_id: chatId, name: msg.from.first_name });
  bot.sendMessage(chatId,
    `👋 Привет, *${msg.from.first_name}*!\n\n` +
    `Я ваш AI-планировщик. Просто напишите мне что нужно сделать — я добавлю в планер.\n\n` +
    `*Что я умею:*\n` +
    `📝 Текст → «Операция в 10 утра, Иванов 078-Ф»\n` +
    `🖼 Фото → скиньте билет или направление\n` +
    `🎤 Голос → надиктуйте задачу\n` +
    `❓ Вопросы → спросите что угодно\n\n` +
    `*Команды:*\n` +
    `/today — план на сегодня\n` +
    `/planner — открыть планер\n` +
    `/help — помощь`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📅 Открыть планер', web_app: { url: miniAppUrl() } }
        ]]
      }
    }
  );
});

bot.onText(/\/today/, async (msg) => {
  const userId = String(msg.from.id);
  const { data } = await supabase.from('schedules').select('schedule_data').eq('user_id', userId).single();
  if (!data?.schedule_data) {
    bot.sendMessage(msg.chat.id, '📅 Расписание пока пустое. Добавьте задачи!');
    return;
  }
  const today = new Date().getDay();
  const dayIdx = today === 0 ? 6 : today - 1;
  const blocks = data.schedule_data[String(dayIdx)] || [];
  if (!blocks.length) {
    bot.sendMessage(msg.chat.id, '📅 Сегодня задач нет. Хороший день для отдыха!');
    return;
  }
  const lines = blocks.map(b => {
    const time = b.noTime ? 'без времени' : `${b.start}:00–${b.end}:00`;
    const done = b.done ? '✅' : '◻️';
    const note = b.note ? '\n    _' + (b.note.includes(':') ? decrypt(b.note) : b.note) + '_' : '';
    return `${done} ${time} *${b.title}*${note}`;
  }).join('\n');
  bot.sendMessage(msg.chat.id,
    `📅 *План на сегодня:*\n\n${lines}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📅 Открыть планер', web_app: { url: miniAppUrl() } }]] }
    }
  );
});

bot.onText(/\/planner/, (msg) => {
  bot.sendMessage(msg.chat.id, '📅 Открываю планер:', {
    reply_markup: { inline_keyboard: [[{ text: '📅 МедПланер', web_app: { url: miniAppUrl() } }]] }
  });
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*Как пользоваться МедПланером:*\n\n` +
    `*Добавить задачу текстом:*\n` +
    `Просто напишите мне — я пойму и добавлю.\n` +
    `Примеры:\n` +
    `• «Операция в 9 утра два часа»\n` +
    `• «Иванов Иван Иванович 078-Ф ПолипПН КХК в 10:00»\n` +
    `• «Конференция по хирургии 20 июня с 9 до 17»\n` +
    `• «Позвонить в страховую» (без времени)\n\n` +
    `*Добавить через фото:*\n` +
    `Скиньте фото билета, направления или любого документа — я распознаю дату и детали.\n\n` +
    `*Голосом:*\n` +
    `Запишите голосовое сообщение — я расшифрую и добавлю.\n\n` +
    `*Задать вопрос:*\n` +
    `Спросите меня что угодно — я отвечу как AI-ассистент.`,
    { parse_mode: 'Markdown' }
  );
});

// Главный обработчик сообщений
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return; // команды обрабатываются выше

  const chatId = msg.chat.id;
  const userId = String(msg.from.id);

  // Убедимся что пользователь есть в базе
  try { await supabase.from('users').upsert({ id: userId, telegram_id: chatId, name: msg.from.first_name }); } catch {}

  bot.sendChatAction(chatId, 'typing');

  // ── Голосовое сообщение ──────────────────────────────────
  if (msg.voice) {
    const fileInfo = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const text = await transcribeVoice(fileUrl);
    if (!text) {
      bot.sendMessage(chatId, '😕 Не смог распознать голос. Попробуйте ещё раз или напишите текстом.');
      return;
    }
    bot.sendMessage(chatId, `🎤 Распознал: _"${text}"_`, { parse_mode: 'Markdown' });
    await handleTextTask(chatId, userId, text);
    return;
  }

  // ── Фото или документ ────────────────────────────────────
  if (msg.photo || msg.document) {
    let fileId;
    if (msg.photo) {
      fileId = msg.photo[msg.photo.length - 1].file_id; // берём наибольшее разрешение
    } else if (msg.document && msg.document.mime_type?.startsWith('image/')) {
      fileId = msg.document.file_id;
    } else {
      bot.sendMessage(chatId, '📎 Скиньте фото (не файл) — так я смогу его распознать.');
      return;
    }

    bot.sendMessage(chatId, '🔍 Анализирую изображение…');
    const fileInfo = await bot.getFile(fileId);
    const imageUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const parsed = await parseImageMessage(imageUrl);

    if (!parsed || !parsed.found) {
      bot.sendMessage(chatId, '😕 Не смог найти событие на этом изображении. Попробуйте написать задачу текстом.');
      return;
    }

    const timeStr = parsed.noTime ? 'без конкретного времени' : `${parsed.start}:00–${parsed.end}:00`;
    const catNames = { 'c-med':'🏥','c-conf':'📊','c-trav':'✈️','c-adm':'📋','c-pers':'🙋' };
    const text = `${catNames[parsed.cat]||'📝'} Нашёл событие:\n\n*${parsed.title}*\n⏰ ${timeStr}${parsed.note ? '\n📎 _'+parsed.note+'_' : ''}\n\n_${parsed.description}_`;

    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          ...addEventKeyboard(parsed, '✅ Добавить в планер')[0]
        ]]
      }
    });
    return;
  }

  // ── Текстовое сообщение ──────────────────────────────────
  if (msg.text) {
    await handleTextTask(chatId, userId, msg.text);
  }
});

async function handleTextTask(chatId, userId, text) {
  const parsed = await parseTextMessage(text);
  if (!parsed) {
    bot.sendMessage(chatId, '😕 Не понял сообщение. Попробуйте написать иначе.');
    return;
  }

  // Если это вопрос или общение — просто отвечаем
  if (parsed.type === 'question' || parsed.type === 'other') {
    bot.sendMessage(chatId, parsed.reply || 'Чем могу помочь?', { parse_mode: 'Markdown' });
    return;
  }

  // Это задача — показываем превью с кнопками
  const timeStr = parsed.noTime ? 'без конкретного времени' : `${parsed.start}:00–${parsed.end}:00`;
  const catNames = { 'c-med':'🏥 Пациенты','c-conf':'📊 Конференции','c-trav':'✈️ Поездки','c-adm':'📋 Административное','c-pers':'🙋 Личное' };
  const preview = `📝 *${parsed.title}*\n⏰ ${timeStr}\n📁 ${catNames[parsed.cat]||'Другое'}${parsed.note ? '\n📎 _'+parsed.note+'_' : ''}`;

  bot.sendMessage(chatId, `Добавить в планер?\n\n${preview}`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        ...addEventKeyboard(parsed, '✅ Добавить')[0]
      ]]
    }
  });
}

// Callback кнопки
bot.on('callback_query', async (query) => {
  const data = query.data;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;

  if (data === 'cancel') {
    bot.answerCallbackQuery(query.id, { text: 'Отменено' });
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); // handled
    return;
  }

  if (data.startsWith('add:')) {
    const eventId = data.slice(4);
    try {
      const event = pendingEvents.get(eventId);
      if (!event) {
        bot.answerCallbackQuery(query.id, { text: 'Событие устарело. Отправьте задачу ещё раз.' });
        return;
      }
      pendingEvents.delete(eventId);
      await addEventToSchedule(userId, event);
      bot.answerCallbackQuery(query.id, { text: '✅ Добавлено!' });
      const timeStr = event.noTime ? 'без времени' : `${event.start}:00–${event.end}:00`;
      bot.editMessageText(
        `✅ *Добавлено в планер!*\n\n📝 ${event.title}\n⏰ ${timeStr}`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '📅 Открыть планер', web_app: { url: miniAppUrl() } }]] } }
      ); // handled
    } catch (e) {
      bot.answerCallbackQuery(query.id, { text: 'Ошибка, попробуйте снова' });
    }
  }
});

// ─── Cron: утренняя планёрка 7:30 ──────────────────────────
cron.schedule('30 7 * * *', async () => {
  const { data: users } = await supabase.from('users').select('*');
  for (const user of (users || [])) {
    const { data: sched } = await supabase.from('schedules').select('schedule_data').eq('user_id', user.id).single();
    if (!sched?.schedule_data) continue;
    const today = new Date().getDay();
    const dayIdx = today === 0 ? 6 : today - 1;
    const blocks = sched.schedule_data[String(dayIdx)] || [];
    if (!blocks.length) continue;
    const lines = blocks.map(b => `• ${b.noTime ? 'без времени' : b.start+':00'} ${b.title}`).join('\n');
    bot.sendMessage(user.telegram_id,
      `🌅 *Доброе утро!*\n\nСегодня у вас ${blocks.length} задач:\n\n${lines}\n\n_Удачного дня!_`,
      { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '📅 Открыть планер', web_app: { url: miniAppUrl() } }]] } }
    ); // handled
  }
}, { timezone: 'Europe/Moscow' });

// Вечерняя планёрка 20:00
cron.schedule('0 20 * * *', async () => {
  const { data: users } = await supabase.from('users').select('*');
  for (const user of (users || [])) {
    bot.sendMessage(user.telegram_id, '🌙 Как прошёл день? Давайте подведём итоги.', {
      reply_markup: { inline_keyboard: [[{ text: '📝 Вечерняя планёрка', web_app: { url: miniAppUrl() + '?eve=1' } }]] }
    }); // handled
  }
}, { timezone: 'Europe/Moscow' });

// ─── Health check ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/telegram/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`МедПланер сервер запущен на порту ${PORT}`);

  try {
    if (botMode === 'disabled') {
      console.log('Telegram bot disabled by BOT_MODE=disabled');
    } else if (botMode === 'webhook') {
      const baseUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
      if (!baseUrl) {
        console.warn('APP_URL/RENDER_EXTERNAL_URL не задан. Webhook Telegram не установлен.');
        return;
      }
      const webhookUrl = `${baseUrl.replace(/\/$/, '')}/telegram/webhook`;
      await bot.stopPolling();
      await bot.setWebHook(webhookUrl);
      console.log(`Telegram webhook установлен: ${webhookUrl}`);
    } else {
      await bot.deleteWebHook({ drop_pending_updates: true });
      await bot.startPolling({ restart: true });
      console.log('Telegram bot запущен в polling mode');
    }
  } catch (error) {
    console.error('Telegram startup error:', error.message);
  }
});
