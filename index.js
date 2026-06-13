// ════════════════════════════════════════════════════════════
//  МедПланер — Backend Server
//  Node.js + Express + Supabase + Claude AI
//  Файл: server/index.js
// ════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const crypto = require('crypto');
const ical = require('ical-generator');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// ─── Clients ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// ─── Encryption (AES-256 for patient data) ─────────────────
const ENCRYPT_KEY = Buffer.from(process.env.ENCRYPT_KEY || crypto.randomBytes(32).toString('hex').slice(0,32));

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

// Check if note contains patient data and encrypt it
function encryptPatientNote(note) {
  if (!note) return note;
  // Pattern: ФИО + code + diagnosis + operation
  const patientPattern = /[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+\d+[\w-]+/;
  if (patientPattern.test(note)) return encrypt(note);
  return note;
}

// ─── Telegram Auth Validation ──────────────────────────────
function validateTelegramUser(req, res, next) {
  const userId = req.headers['x-telegram-user-id'];
  // In production: validate initData hash from Telegram
  // const initData = req.headers['x-telegram-init-data'];
  // validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  next();
}

// ─── Schedule endpoints ────────────────────────────────────
app.get('/api/schedule', validateTelegramUser, async (req, res) => {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('user_id', req.userId)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  if (!data) return res.json({ schedule: {}, categories: [] });
  // Decrypt patient notes
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
  // Encrypt patient notes before saving
  const encSchedule = JSON.parse(JSON.stringify(schedule));
  Object.values(encSchedule).forEach(day => {
    if (Array.isArray(day)) day.forEach(block => {
      block.note = encryptPatientNote(block.note);
    });
  });
  const { error } = await supabase
    .from('schedules')
    .upsert({ user_id: req.userId, schedule_data: encSchedule, categories, updated_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  // Sync to calendars in background
  syncToCalendars(req.userId, schedule).catch(console.error);
  res.json({ ok: true });
});

// ─── iCal endpoint ─────────────────────────────────────────
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
        const start = new Date(date); start.setHours(Math.floor(block.start), (block.start % 1) * 60, 0, 0);
        const end = new Date(date); end.setHours(Math.floor(block.end), (block.end % 1) * 60, 0, 0);
        cal.createEvent({ start, end, summary: block.title, description: block.note ? decrypt(block.note) : '' });
      });
    });
  }
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.send(cal.toString());
});

// ─── Mail scanning ─────────────────────────────────────────
app.post('/api/mail/scan', validateTelegramUser, async (req, res) => {
  const tokens = await getOAuthTokens(req.userId);
  const results = [];
  if (tokens.gmail) {
    const gmailItems = await scanGmail(tokens.gmail, req.userId);
    results.push(...gmailItems);
  }
  if (tokens.yandex) {
    const yandexItems = await scanYandex(tokens.yandex, req.userId);
    results.push(...yandexItems);
  }
  res.json({ items: results });
});

async function scanGmail(accessToken, userId) {
  try {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: 'v1', auth });
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: 'is:unread newer_than:1d' });
    const messages = list.data.messages || [];
    const items = [];
    for (const msg of messages.slice(0, 10)) {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      // Get plain text body
      let body = '';
      const parts = full.data.payload.parts || [];
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf8');
          break;
        }
      }
      const analysis = await analyzeEmail(subject, from, body, date);
      items.push({ id: msg.id, from, subject, date, ...analysis, source: 'gmail' });
    }
    return items;
  } catch (e) { console.error('Gmail scan error:', e.message); return []; }
}

async function scanYandex(accessToken, userId) {
  try {
    // Yandex Mail API
    const res = await fetch('https://mail.yandex.ru/api/v2/messages?folder=inbox&count=20', {
      headers: { Authorization: 'OAuth ' + accessToken }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items = [];
    for (const msg of (data.messages || []).slice(0, 10)) {
      const analysis = await analyzeEmail(msg.subject, msg.from.email, msg.body, msg.date);
      items.push({ id: msg.id, from: msg.from.email, subject: msg.subject, date: msg.date, ...analysis, source: 'yandex' });
    }
    return items;
  } catch (e) { console.error('Yandex scan error:', e.message); return []; }
}

async function analyzeEmail(subject, from, body, date) {
  const prompt = `Проанализируй это письмо и верни JSON.

От: ${from}
Тема: ${subject}
Дата: ${date}
Текст: ${body.slice(0, 1000)}

Верни ТОЛЬКО JSON без markdown:
{
  "category": "patient|conference|travel|other",
  "hasEvent": true/false,
  "event": {
    "title": "название события",
    "date": "YYYY-MM-DD или null",
    "startTime": "HH:MM или null",
    "endTime": "HH:MM или null",
    "location": "место или null",
    "note": "ФИО пациента код диагноз операция (если пациент) или описание"
  }
}

Для пациентов формат note: "Фамилия Имя Отчество КодИстории АббрДиагноза АббрОперации"
Если нет события, event = null.`;

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch { return { category: 'other', hasEvent: false, event: null }; }
}

app.post('/api/mail/add-event', validateTelegramUser, async (req, res) => {
  const { mailId } = req.body;
  // In production: fetch cached mail analysis
  // For demo: return mock event
  const event = { title: 'Событие из письма', cat: 'c-conf', start: 10, end: 11, note: '' };
  res.json({ event });
});

// ─── Calendar sync ─────────────────────────────────────────
async function syncToCalendars(userId, schedule) {
  const tokens = await getOAuthTokens(userId);
  const { data } = await supabase.from('schedules').select('categories').eq('user_id', userId).single();
  const cats = data?.categories || [];
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
  if (tokens.gcal) await syncGoogleCalendar(tokens.gcal, events);
}

async function syncGoogleCalendar(accessToken, events) {
  try {
    const auth = new google.auth.OAuth2(); auth.setCredentials({ access_token: accessToken });
    const cal = google.calendar({ version: 'v3', auth });
    for (const event of events) {
      const start = new Date(event.date); start.setHours(Math.floor(event.start), (event.start % 1) * 60, 0, 0);
      const end = new Date(event.date); end.setHours(Math.floor(event.end), (event.end % 1) * 60, 0, 0);
      await cal.events.insert({ calendarId: 'primary', requestBody: {
        summary: event.title,
        description: event.note || '',
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      }}).catch(() => {});
    }
  } catch (e) { console.error('GCal sync error:', e.message); }
}

// ─── OAuth flows ───────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.APP_URL + '/api/auth/gmail/callback'
);

app.get('/api/auth/gmail', (req, res) => {
  const { userId } = req.query;
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    state: userId
  });
  res.redirect(url);
});

app.get('/api/auth/gmail/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  await supabase.from('oauth_tokens').upsert({ user_id: userId, provider: 'gmail', tokens: JSON.stringify(tokens) });
  res.send('<script>window.close()</script><p>Gmail подключён! Закройте это окно.</p>');
});

app.get('/api/auth/yandex', (req, res) => {
  const { userId } = req.query;
  const url = `https://oauth.yandex.ru/authorize?response_type=code&client_id=${process.env.YANDEX_CLIENT_ID}&state=${userId}&scope=mail:imap.full`;
  res.redirect(url);
});

app.get('/api/auth/yandex/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  const resp = await fetch('https://oauth.yandex.ru/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: process.env.YANDEX_CLIENT_ID, client_secret: process.env.YANDEX_CLIENT_SECRET })
  });
  const tokens = await resp.json();
  await supabase.from('oauth_tokens').upsert({ user_id: userId, provider: 'yandex', tokens: JSON.stringify(tokens) });
  res.send('<script>window.close()</script><p>Яндекс.Почта подключёна! Закройте окно.</p>');
});

app.get('/api/auth/gcal', (req, res) => {
  const { userId } = req.query;
  const calOAuth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.APP_URL + '/api/auth/gcal/callback');
  const url = calOAuth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar'], state: userId });
  res.redirect(url);
});

app.get('/api/auth/gcal/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  const calOAuth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.APP_URL + '/api/auth/gcal/callback');
  const { tokens } = await calOAuth.getToken(code);
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

// ─── Evening summary ───────────────────────────────────────
app.post('/api/evening-summary', validateTelegramUser, async (req, res) => {
  const { eveData, easy, hard, win } = req.body;
  await supabase.from('daily_logs').insert({
    user_id: req.userId, date: new Date().toISOString().slice(0,10),
    energy: eveData?.energy, focus: eveData?.focus,
    what_easy: easy, what_hard: hard, win_of_day: win,
  });
  // Send AI summary to Telegram
  const { data: user } = await supabase.from('users').select('telegram_id').eq('id', req.userId).single();
  if (user?.telegram_id) {
    const summary = await generateEveSummary({ easy, hard, win, energy: eveData?.energy });
    bot.sendMessage(user.telegram_id, summary, { parse_mode: 'Markdown' }).catch(() => {});
  }
  res.json({ ok: true });
});

async function generateEveSummary({ easy, hard, win, energy }) {
  const prompt = `Составь краткое (3-4 предложения) вечернее резюме дня для врача-планировщика на русском языке.

Что далось легко: ${easy || 'не указано'}
Что было сложно: ${hard || 'не указано'}
Победа дня: ${win || 'не указано'}
Уровень энергии: ${energy || '?'}/5

Будь ободряющим, конкретным, без лишних слов. Добавь 1-2 рекомендации на завтра.`;
  try {
    const r = await claude.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
    return r.content[0].text;
  } catch { return 'Хороший день! Отдыхайте и готовьтесь к завтрашнему.'; }
}

// ─── Telegram Bot ──────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  // Register user
  await supabase.from('users').upsert({ id: userId, telegram_id: chatId, name: msg.from.first_name });
  bot.sendMessage(chatId,
    `👋 Добро пожаловать в *МедПланер*!\n\n` +
    `Я помогаю планировать рабочий день, читаю почту и синхронизирую с вашим календарём.\n\n` +
    `*Команды:*\n` +
    `/planner — Открыть планер\n` +
    `/today — План на сегодня\n` +
    `/add — Добавить задачу\n` +
    `/mail — Проверить почту\n` +
    `/settings — Настройки\n\n` +
    `Или просто напишите задачу текстом — я добавлю её в планер!`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📅 Открыть планер', web_app: { url: process.env.MINIAPP_URL } }]] } }
  );
});

bot.onText(/\/planner/, (msg) => {
  bot.sendMessage(msg.chat.id, '📅 Открывайте планер:', {
    reply_markup: { inline_keyboard: [[{ text: '📅 МедПланер', web_app: { url: process.env.MINIAPP_URL } }]] }
  });
});

bot.onText(/\/today/, async (msg) => {
  const userId = String(msg.from.id);
  const { data } = await supabase.from('schedules').select('schedule_data').eq('user_id', userId).single();
  if (!data?.schedule_data) { bot.sendMessage(msg.chat.id, 'Расписание пока пустое. Добавьте задачи в планере.'); return; }
  const today = new Date().getDay();
  const dayIdx = today === 0 ? 6 : today - 1;
  const blocks = data.schedule_data[String(dayIdx)] || [];
  if (!blocks.length) { bot.sendMessage(msg.chat.id, '📅 Сегодня задач нет. Отличный день для отдыха!'); return; }
  const lines = blocks.map(b => `• ${b.start}:00–${b.end}:00 *${b.title}*${b.note ? '\n  _' + decrypt(b.note) + '_' : ''}`).join('\n');
  bot.sendMessage(msg.chat.id, `📅 *План на сегодня:*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/mail/, async (msg) => {
  const userId = String(msg.from.id);
  bot.sendMessage(msg.chat.id, '📨 Сканирую почту…');
  const tokens = await getOAuthTokens(userId);
  if (!tokens.gmail && !tokens.yandex) {
    bot.sendMessage(msg.chat.id, '⚠️ Подключите почту в настройках планера.', {
      reply_markup: { inline_keyboard: [[{ text: '⚙️ Настройки', web_app: { url: process.env.MINIAPP_URL + '?page=settings' } }]] }
    });
    return;
  }
  const results = [];
  if (tokens.gmail) results.push(...(await scanGmail(tokens.gmail, userId)));
  if (tokens.yandex) results.push(...(await scanYandex(tokens.yandex, userId)));
  if (!results.length) { bot.sendMessage(msg.chat.id, '📭 Новых писем нет.'); return; }
  for (const item of results.slice(0, 5)) {
    const emoji = item.category === 'patient' ? '🏥' : item.category === 'conference' ? '📊' : item.category === 'travel' ? '✈️' : '📧';
    let text = `${emoji} *От:* ${item.from}\n*Тема:* ${item.subject}`;
    if (item.hasEvent && item.event) text += `\n\n📅 Найдено событие: *${item.event.title}*`;
    const keyboard = item.hasEvent ? [[{ text: '+ Добавить в планер', callback_data: `add_event:${JSON.stringify(item.event).slice(0,200)}` }]] : [];
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined });
  }
});

bot.onText(/\/add/, (msg) => {
  bot.sendMessage(msg.chat.id, '✏️ Напишите задачу в формате:\n\n`Название задачи в 14:00 до 15:30`\n\nили для пациента:\n`Иванов Иван Иванович 078-Ф ПолипПН КХК в 10:00 до 12:00`', { parse_mode: 'Markdown' });
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  if (data === 'cancel') {
    bot.answerCallbackQuery(query.id, { text: 'Отменено' });
    bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
    return;
  }
  const [action, ...rest] = data.split(':');
  const eventStr = rest.join(':');
  if (action === 'add_event') {
    const event = JSON.parse(eventStr);
    const userId = String(query.from.id);
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
      note: event.note || '',
      noTime: event.noTime || false,
      urgent: false,
      done: false,
      steps: []
    });
    await supabase.from('schedules').upsert({
      user_id: userId,
      schedule_data: schedule,
      updated_at: new Date().toISOString()
    });
    bot.answerCallbackQuery(query.id, { text: '✅ Добавлено в планер!' });
    bot.editMessageText(
      `✅ Добавлено в планер!\n\n📝 *${event.title}*${event.noTime ? '\n⏰ Без конкретного времени' : `\n⏰ ${event.start}:00–${event.end}:00`}`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
  }
});

// Handle free-form text as task
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;

  // Show typing indicator
  bot.sendChatAction(chatId, 'typing');

  const parsed = await parseTaskMessage(msg.text);
  if (!parsed) {
    bot.sendMessage(chatId, 'Не смог распознать задачу. Попробуйте написать иначе, например:\n\n«Встреча с коллегой завтра в 14:00»\n«Позвонить пациенту Иванову»\n«Конференция 15 июня в 10 утра до 12»');
    return;
  }

  // Format display time
  const timeStr = parsed.noTime
    ? 'без конкретного времени'
    : `${parsed.start}:00–${parsed.end}:00`;

  const catNames = {
    'c-med': '🏥 Пациенты',
    'c-conf': '📊 Конференции',
    'c-trav': '✈️ Поездки',
    'c-adm': '📋 Административное',
    'c-pers': '🙋 Личное'
  };

  const preview = `📝 *${parsed.title}*\n⏰ ${timeStr}\n📁 ${catNames[parsed.cat] || 'Другое'}${parsed.note ? '\n📎 _' + parsed.note + '_' : ''}`;

  const eventData = JSON.stringify(parsed).slice(0, 200);
  const kb = {
    inline_keyboard: [[
      { text: '✅ Добавить в планер', callback_data: `add_event:${eventData}` },
      { text: '❌ Отмена', callback_data: 'cancel' }
    ]]
  };

  bot.sendMessage(chatId, `Понял! Добавить в планер?\n\n${preview}`, {
    parse_mode: 'Markdown',
    reply_markup: kb
  });
});

async function parseTaskMessage(text) {
  const prompt = `Извлеки задачу из сообщения пользователя и верни ТОЛЬКО JSON без markdown и пояснений.

Формат ответа:
{
  "title": "краткое название задачи",
  "start": 9,
  "end": 10,
  "noTime": false,
  "cat": "c-med",
  "note": ""
}

Правила:
- title: короткое и чёткое название
- start, end: целые числа от 6 до 23 (часы). Если "в 9 утра" — start=9, end=10. Если "с 10 до 12" — start=10, end=12
- noTime: true если время НЕ указано вообще. Тогда start=9, end=10 (значения по умолчанию)
- cat: выбери одно из: c-med (пациент/операция/медицина), c-conf (конференция/совещание/встреча), c-trav (поездка/командировка/перелёт), c-adm (административное/отчёт/документы), c-pers (личное/спорт/отдых/семья)
- note: если пациент — "ФИО код диагноз операция". Иначе краткое уточнение или пусто
- Если упоминается "завтра" — это обычная задача, просто добавь в планер

Сообщение: "${text}"`;

  try {
    const r = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    const clean = r.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('parseTaskMessage error:', e.message);
    return null;
  }
}


// ─── Morning briefing cron ─────────────────────────────────
cron.schedule('30 7 * * *', async () => {
  const { data: users } = await supabase.from('users').select('*');
  for (const user of (users || [])) {
    const { data: sched } = await supabase.from('schedules').select('schedule_data').eq('user_id', user.id).single();
    if (!sched?.schedule_data) continue;
    const today = new Date().getDay(); const dayIdx = today === 0 ? 6 : today - 1;
    const blocks = sched.schedule_data[String(dayIdx)] || [];
    if (!blocks.length) continue;
    const lines = blocks.map(b => `• ${b.start}:00 ${b.title}`).join('\n');
    const greeting = `🌅 *Доброе утро!*\n\nСегодня у вас ${blocks.length} задач:\n\n${lines}\n\n_Хорошего продуктивного дня!_`;
    bot.sendMessage(user.telegram_id, greeting, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📅 Открыть планер', web_app: { url: process.env.MINIAPP_URL } }]] }
    });
  }
}, { timezone: 'Europe/Moscow' });

// Evening briefing reminder
cron.schedule('0 20 * * *', async () => {
  const { data: users } = await supabase.from('users').select('*');
  for (const user of (users || [])) {
    bot.sendMessage(user.telegram_id, '🌙 Вечерняя планёрка — как прошёл день?', {
      reply_markup: { inline_keyboard: [[{ text: '📝 Открыть вечернюю планёрку', web_app: { url: process.env.MINIAPP_URL + '?eve=1' } }]] }
    });
  }
}, { timezone: 'Europe/Moscow' });

// Hourly mail scan
cron.schedule('0 * * * *', async () => {
  const { data: users } = await supabase.from('users').select('id');
  for (const user of (users || [])) {
    const tokens = await getOAuthTokens(user.id);
    const results = [];
    if (tokens.gmail) results.push(...(await scanGmail(tokens.gmail, user.id)));
    if (tokens.yandex) results.push(...(await scanYandex(tokens.yandex, user.id)));
    for (const item of results.filter(r => r.hasEvent)) {
      const { data: u } = await supabase.from('users').select('telegram_id').eq('id', user.id).single();
      if (!u?.telegram_id) continue;
      const text = `📨 Новое письмо с событием!\n\n*Тема:* ${item.subject}\n*Событие:* ${item.event?.title || ''}`;
      bot.sendMessage(u.telegram_id, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '+ В планер', callback_data: `add_event:${JSON.stringify(item.event || {}).slice(0,200)}` }]] }
      });
    }
  }
});

// ─── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`МедПланер сервер запущен на порту ${PORT}`));
