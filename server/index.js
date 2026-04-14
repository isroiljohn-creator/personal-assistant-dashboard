import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import FormData from 'form-data';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'db.json');

const app = express();
app.use(cors());
app.use(express.json());

// Serve React build in production
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Load DB
function loadDB() {
  const data = fs.readFileSync(dbPath, 'utf-8');
  return JSON.parse(data);
}

// Save DB
function saveDB(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// REST APIs for Dashboard
app.get('/api/data', (req, res) => {
  res.json(loadDB());
});

app.post('/api/tasks', (req, res) => {
  const db = loadDB();
  const newTask = {
    ...req.body,
    id: Date.now(),
    status: 'todo',
    overdue: false,
  };
  db.tasks.unshift(newTask);
  saveDB(db);
  res.json(newTask);
});

app.patch('/api/tasks/:id/toggle', (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const task = db.tasks.find(t => t.id === id);
  if (task) {
    task.status = task.status === 'done' ? 'todo' : 'done';
    task.overdue = false;
    saveDB(db);
    return res.json(task);
  }
  res.status(404).send('Task not found');
});

app.post('/api/transactions', (req, res) => {
  const db = loadDB();
  const newTx = {
    ...req.body,
    id: Date.now(),
    amount: Number(req.body.amount),
  };
  db.transactions.unshift(newTx);
  saveDB(db);
  res.json(newTx);
});

// INITIALIZE GROQ
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const JSON_SCHEMA = `
Qaytarishingiz kerak bo'lgan strict JSON strukturasi (faqat JSON qaytaring, boshqa gap qo'shmang):
{
  "action": "Javob turi: Agar foydalanuvchi qandaydir YANILIK qo'shayotgan, saqlayotgan bo'lsa majburiy ADD_TASK qiling. ADD_EXPENSE (xarajat). Agar faqat nima ishlarim bor deb eski ma'lumotdan so'rov qilsa, CHAT.",
  "data": {
    "title": "Vazifa nomi yoki Xarajat nomi/turi",
    "due": "Vazifaning muddatini imkon qadar kun, soat formatida hisoblang masalan: 2026-04-15 10:00 yoki agar berilmagan bo'lsa 'Deadline yo‘q' yozing",
    "amount": "Taqdim etilgan xarajatning summasi raqamlarda (majburiy izlash ADD_EXPENSE uchun)",
    "category": "Xarajat toifasi (masalan: Personal, Business, Health, Transport va hk)"
  },
  "reply": "Telegram dagi foydalanuvchiga yuboriladigan chiroyli qisqa o'zbek tilidagi javobingiz. Xarajat kiritildi deb masalan."
}`;

// AISHA STT
const AISHA_API_KEY = process.env.AISHA_API_KEY || 'INhaFMlH.sEw75tbo0zFHdl9xcI1JIZSH1CWE4Gf4';

async function transcribeWithAisha(filePath) {
  // 1. Faylni yuborish
  const form = new FormData();
  form.append('audio', fs.createReadStream(filePath));
  form.append('language', 'uz');
  form.append('has_diarization', 'false');

  const postRes = await fetch('https://back.aisha.group/api/v2/stt/post/', {
    method: 'POST',
    headers: { 'x-api-key': AISHA_API_KEY, ...form.getHeaders() },
    body: form,
  });
  if (!postRes.ok) {
    const err = await postRes.text();
    throw new Error(`AISHA POST xatosi: ${postRes.status} ${err}`);
  }
  const postData = await postRes.json();
  const taskId = postData.id || postData.task_id;
  if (!taskId) throw new Error('AISHA: task ID qaytmadi');

  // 2. Natijani polling — max 30 soniya
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const getRes = await fetch(`https://back.aisha.group/api/v2/stt/get/${taskId}/`, {
      headers: { 'x-api-key': AISHA_API_KEY },
    });
    if (!getRes.ok) continue;
    const getData = await getRes.json();
    const status = getData.status || getData.state;
    if (status === 'done' || status === 'completed' || status === 'SUCCESS') {
      return getData.result || getData.text || getData.transcript || JSON.stringify(getData);
    }
    if (status === 'failed' || status === 'FAILURE') {
      throw new Error('AISHA: audio qayta ishlashda xatolik');
    }
  }
  throw new Error('AISHA: vaqt tugadi (30 soniya)');
}

// TELEGRAM BOT
const token = process.env.TELEGRAM_BOT_TOKEN || '8760915981:AAEHJMWgg8afVyfo4fHSVDexWhhjYwfqU6s';
const bot = new TelegramBot(token, { polling: true });


// Dashboard URL
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://personal-assistant-dashboard-production.up.railway.app';

// Helper: single task -> one line for combined list
function formatTaskLine(task, index) {
  const pri = { high: '🔴', medium: '🟡', low: '🟢' };
  const overdue = (task.overdue && task.status !== 'done') ? ' ⚠️' : '';
  const status = task.status === 'in_progress' ? ' 🔄' : '';
  const due = task.due && task.due !== "Deadline yo'q" ? `⏰ ${task.due}` : '📭 Deadline yo\'q';
  return `${pri[task.priority] || '🟡'} *${index}. ${task.title}*${overdue}${status}\n   ${due}`;
}

// Helper: single task card for new task notification (with buttons)
function formatTaskCard(task, index) {
  const priorityEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
  const statusLabel = { todo: 'Bajarilmagan', in_progress: '🔄 Jarayonda', done: '✅ Tugagan' };
  const overdueLine = (task.overdue && task.status !== 'done') ? '\n⚠️ *KECHIKGAN!*' : '';
  return (
    `${priorityEmoji[task.priority] || '🟡'} *${index}. ${task.title}*${overdueLine}\n` +
    `📁 ${task.project}  •  ${statusLabel[task.status] || 'Bajarilmagan'}\n` +
    `⏰ ${task.due || "Deadline yo'q"}`
  );
}

// Helper: ALL tasks in ONE message + dashboard button
async function sendTaskList(chatId, tasks, headerText) {
  if (tasks.length === 0) {
    return bot.sendMessage(chatId, '🎉 Hozircha ochiq vazifalar yo\'q!');
  }
  const lines = tasks.map((t, i) => formatTaskLine(t, i + 1)).join('\n\n');
  const text = `${headerText}\n\n${lines}`;
  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }
      ]]
    }
  });
}

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 *Assalomu alaykum\\!*\n\n` +
    `Shaxsiy assistent hizmatda 🤖\n\n` +
    `📋 /tasks — Ochiq vazifalar\n` +
    `✅ /done — Tugagan vazifalar\n` +
    `💰 /finance — Moliya holati\n\n` +
    `_Xabar yozing yoki ovoz yuboring!_`,
    { parse_mode: 'Markdown' }
  );
});

// /tasks — BITTA xabarda barcha ochiq vazifalar
bot.onText(/\/tasks/, async (msg) => {
  const chatId = msg.chat.id;
  const db = loadDB();
  const openTasks = db.tasks.filter(t => t.status !== 'done');
  await sendTaskList(chatId, openTasks, `📋 *Ochiq vazifalar — ${openTasks.length} ta:*`);
});

// /done — tugagan vazifalar
bot.onText(/\/done/, async (msg) => {
  const chatId = msg.chat.id;
  const db = loadDB();
  const doneTasks = db.tasks.filter(t => t.status === 'done');
  if (doneTasks.length === 0) {
    return bot.sendMessage(chatId, 'Hali hech qanday vazifa tugallanmagan.');
  }
  const lines = doneTasks.map((t, i) => `✅ *${i+1}. ${t.title}*\n   ⏰ ${t.due || '—'}`).join('\n\n');
  await bot.sendMessage(chatId,
    `✅ *Tugagan vazifalar — ${doneTasks.length} ta:*\n\n${lines}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }
        ]]
      }
    }
  );
});

// /finance — bugungi moliya
bot.onText(/\/finance/, (msg) => {
  const chatId = msg.chat.id;
  const db = loadDB();
  const today = new Date().toISOString().split('T')[0];
  const todayTx = db.transactions.filter(t => t.date === today);
  const fmt = n => new Intl.NumberFormat('ru-RU').format(n);

  if (todayTx.length === 0) {
    return bot.sendMessage(chatId,
      `💰 *Bugungi tranzaksiyalar yo'q*\n\n_Xarajat qo'shish uchun: "Tushlikka 25000 so'm sarfladim" deb yozing_`,
      { parse_mode: 'Markdown' }
    );
  }

  let text = `💰 *Bugungi tranzaksiyalar:*\n\n`;
  todayTx.forEach(tx => {
    const sign = tx.type === 'income' ? '➕' : '➖';
    text += `${sign} *${tx.title}*\n   ${fmt(tx.amount)} ${tx.currency === 'UZS' ? "so'm" : '$'}  —  _${tx.category}_\n\n`;
  });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// Inline button callbacks (✅ Bajarildi, 🔄 Jarayonda, ↩️ Qaytarish)
bot.on('callback_query', async (query) => {
  const { data, message } = query;
  const chatId = message.chat.id;
  const msgId = message.message_id;
  const db = loadDB();

  if (data.startsWith('done_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'done'; task.overdue = false;
      saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '✅ Bajarildi!' });
      await bot.editMessageText(
        `✅ *${task.title}* — bajarildi!`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      );
    }
  } else if (data.startsWith('prog_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'in_progress';
      saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '🔄 Jarayonda!' });
      await bot.editMessageText(
        formatTaskCard(task, '→'),
        {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Bajarildi', callback_data: `done_${task.id}` },
            { text: '🔄 Jarayonda', callback_data: `prog_${task.id}` },
          ]]}
        }
      );
    }
  } else if (data.startsWith('undo_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'todo';
      saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '↩️ Qaytarildi!' });
      await bot.editMessageText(
        `↩️ *${task.title}* — qaytarildi`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      );
    }
  }
});

// General message handler (AI)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && msg.text.startsWith('/')) return; // skip commands

  try {
    bot.sendChatAction(chatId, 'typing');
    let userText = '';

    if (msg.voice || msg.audio) {
      const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
      const localPath = await bot.downloadFile(fileId, __dirname);
      try {
        // AISHA STT — O'zbek tili uchun
        userText = await transcribeWithAisha(localPath);
      } finally {
        try { fs.unlinkSync(localPath); } catch (_) {}
      }
      bot.sendMessage(chatId, `🎤 _"${userText}"_`, { parse_mode: 'Markdown' });
    } else if (msg.text) {
      userText = msg.text;
    } else {
      return bot.sendMessage(chatId, 'Kechirasiz, faqat matn yoki ovoz qabul qila olaman.');
    }

    const dbContext = loadDB();
    const openTasks = dbContext.tasks.filter(t => t.status !== 'done');
    let tasksContextStr = "Foydalanuvchining joriy ochiq vazifalari:\n";
    if (openTasks.length === 0) tasksContextStr += "Hech qanday ochiq vazifa yo'q.\n";
    openTasks.forEach((t, i) => { tasksContextStr += `${i+1}. ${t.title} (Muddat: ${t.due})\n`; });

    // Toshkent vaqti (UTC+5) — AI uchun aniq sana/vaqt
    const nowTZ = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const todayStr = `${nowTZ.getUTCFullYear()}-${pad(nowTZ.getUTCMonth()+1)}-${pad(nowTZ.getUTCDate())}`;
    const timeStr  = `${pad(nowTZ.getUTCHours())}:${pad(nowTZ.getUTCMinutes())}`;
    const weekDays = ['Yakshanba','Dushanba','Seshanba','Chorshanba','Payshanba','Juma','Shanba'];
    const dayName  = weekDays[nowTZ.getUTCDay()];

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Siz mukammal ishlaydigan aqlli shaxsiy assistent bo'tsiz (LLama 3.3). Xabargingiz qat'iy JSON da bo'lishi shart.\n\n` +
            `🕐 HOZIRGI VAQT: ${todayStr} ${timeStr} (Toshkent, UTC+5), ${dayName}\n` +
            `"Bugun" = ${todayStr}, "Ertaga" = keyingi kun, "Indinga" = ikki kun keyin.\n` +
            `Vaqt hisoblashda AYNAN shu sanani asos qiling. Masalan: agar foydalanuvchi "ertaga soat 15:00" desa, due = "${
              (() => { const t = new Date(nowTZ); t.setUTCDate(t.getUTCDate()+1); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth()+1)}-${pad(t.getUTCDate())}`; })()
            } 15:00" bo'lishi kerak.\n\n` +
            `${tasksContextStr}\n\n${JSON_SCHEMA}`
        },
        { role: 'user', content: userText }
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const db = loadDB();

    if (parsed.action === 'ADD_TASK') {
      const newTask = {
        id: Date.now(),
        title: parsed.data.title || 'Nomalum vazifa',
        project: 'General',
        priority: 'medium',
        status: 'todo',
        due: parsed.data.due || "Deadline yo'q",
        nextAction: 'Keyingi qadam kiritilmagan',
        overdue: false,
      };
      db.tasks.unshift(newTask);
      saveDB(db);
      // AI reply + new task as card with buttons
      await bot.sendMessage(chatId, parsed.reply);
      await bot.sendMessage(chatId, formatTaskCard(newTask, '🆕'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Bajarildi', callback_data: `done_${newTask.id}` },
          { text: '🔄 Jarayonda', callback_data: `prog_${newTask.id}` },
        ]]}
      });

    } else if (parsed.action === 'ADD_EXPENSE') {
      const newTx = {
        id: Date.now(),
        type: 'expense',
        title: parsed.data.title || parsed.data.category || 'Xarajat',
        category: parsed.data.category || 'Personal',
        amount: Number(parsed.data.amount) || 0,
        currency: 'UZS',
        date: new Date().toISOString().split('T')[0],
        wallet: 'Naqd',
      };
      db.transactions.unshift(newTx);
      saveDB(db);
      bot.sendMessage(chatId, parsed.reply);

    } else {
      // CHAT reply (plain text — AI javoblari markdown buzmaydi)
      await bot.sendMessage(chatId, parsed.reply);
      // If user asked about tasks -> auto-show ONE combined message
      const taskKeywords = ['vazifa', 'task', 'ishlar', 'nima qilish', 'rejalar', 'todo', 'deadline', 'reja', 'rejam', 'ishim'];
      if (taskKeywords.some(kw => userText.toLowerCase().includes(kw)) && openTasks.length > 0) {
        await sendTaskList(chatId, openTasks, `📋 *Sizning ${openTasks.length} ta ochiq vazifangiz:*`);
      }
    }

  } catch (error) {
    console.error('Bot Error:', error);
    bot.sendMessage(chatId, 'AI tizimi xizmatida xatolik yuz berdi. ' + error.message);
  }
});


// Catch-all: serve React app for any non-API route (in production)
app.get('/{*splat}', (req, res) => {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Run npm run build first.');
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Telegram bot with Groq AI is running...`);
});
