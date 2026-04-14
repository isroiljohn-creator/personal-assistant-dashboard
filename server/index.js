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
import pg from 'pg';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) app.use(express.static(distPath));

// ============================================================
// DATABASE — Railway PostgreSQL
// DATABASE_URL avtomatik beriladi Railway'da
// ============================================================
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const EMPTY_DB = () => ({
  tasks: [],
  transactions: [],
  wallets: [
    { id: 1, name: 'Naqd',  balance: 0, currency: 'UZS' },
    { id: 2, name: 'Karta', balance: 0, currency: 'UZS' },
  ],
});

// Birinchi ishga tushganda jadvalni yaratish
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_data (
        id   INTEGER PRIMARY KEY DEFAULT 1,
        data JSONB   NOT NULL
      );
      INSERT INTO app_data (id, data)
      VALUES (1, $1::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `, [JSON.stringify(EMPTY_DB())]);
    console.log('✅ PostgreSQL jadval tayyor');
  } catch (e) {
    console.error('DB init xatosi:', e.message);
  }
}

async function loadDB() {
  try {
    const res = await pool.query('SELECT data FROM app_data WHERE id = 1');
    if (res.rows.length > 0) return res.rows[0].data;
  } catch (e) {
    console.error('loadDB xatosi:', e.message);
  }
  return EMPTY_DB();
}

async function saveDB(data) {
  try {
    await pool.query(
      `INSERT INTO app_data (id, data) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = $1::jsonb`,
      [JSON.stringify(data)]
    );
  } catch (e) {
    console.error('saveDB xatosi:', e.message);
  }
}

// ============================================================
// REST APIs
// ============================================================
app.get('/api/data', async (req, res) => {
  res.json(await loadDB());
});

app.post('/api/tasks', async (req, res) => {
  const db = await loadDB();
  const newTask = { ...req.body, id: Date.now(), status: 'todo', overdue: false };
  db.tasks.unshift(newTask);
  await saveDB(db);
  res.json(newTask);
});

app.patch('/api/tasks/:id/toggle', async (req, res) => {
  const db = await loadDB();
  const task = db.tasks.find(t => t.id === parseInt(req.params.id));
  if (task) {
    task.status = task.status === 'done' ? 'todo' : 'done';
    task.overdue = false;
    await saveDB(db);
    return res.json(task);
  }
  res.status(404).send('Task not found');
});

app.post('/api/transactions', async (req, res) => {
  const db = await loadDB();
  const newTx = { ...req.body, id: Date.now(), amount: Number(req.body.amount) };
  db.transactions.unshift(newTx);
  await saveDB(db);
  res.json(newTx);
});

// ============================================================
// GROQ
// ============================================================
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const JSON_SCHEMA = `
MUHIM QOIDALAR - action tanlashda adashmang:
- ADD_EXPENSE = pul SARFLANDI: "obed qildim", "taksi oldim", "sotib oldim", "to'ladim", "sarfladim", "yedim", "kiyim oldim"
- ADD_INCOME  = pul KELDI: "maosh keldi", "oylik tushdi", "pul o'tkazildi", "freelance to'lov", "daromad"
- ADD_TASK    = vazifa, ish, uchrashuv, seminar, deadline, eslatma
- CHAT        = savol, so'rov, moliya/vazifa holati so'rash

Faqat JSON qaytaring:
{
  "action": "ADD_TASK | ADD_EXPENSE | ADD_INCOME | CHAT",
  "data": {
    "title": "Nomi (Obed, Taksi, Oylik maosh va h.k.)",
    "due": "Faqat ADD_TASK uchun: YYYY-MM-DD HH:MM. Boshqalar: Deadline yo'q",
    "amount": "Faqat raqam (ADD_EXPENSE va ADD_INCOME uchun MAJBURIY)",
    "category": "ADD_EXPENSE: Oziq-ovqat|Transport|Uy|Sogliq|Talim|Kiyim|Personal. ADD_INCOME: Maosh|Freelance|Biznes|Sovga|Boshqa"
  },
  "reply": "Qisqa, do'stona javob. HECH QACHON ADD_TASK, ADD_EXPENSE, ADD_INCOME texnik so'zlarni ishlatma!"
}`;

// ============================================================
// AISHA STT
// ============================================================
const AISHA_API_KEY = process.env.AISHA_API_KEY || 'INhaFMlH.sEw75tbo0zFHdl9xcI1JIZSH1CWE4Gf4';

async function transcribeWithAisha(filePath) {
  const form = new FormData();
  form.append('audio', fs.createReadStream(filePath));
  form.append('language', 'uz');
  form.append('has_diarization', 'false');

  const postRes = await fetch('https://back.aisha.group/api/v2/stt/post/', {
    method: 'POST',
    headers: { 'x-api-key': AISHA_API_KEY, ...form.getHeaders() },
    body: form,
  });
  if (!postRes.ok) throw new Error(`AISHA ${postRes.status}: ${await postRes.text()}`);

  const { id, task_id } = await postRes.json();
  const taskId = id || task_id;
  if (!taskId) throw new Error('AISHA: task ID qaytmadi');

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`https://back.aisha.group/api/v2/stt/get/${taskId}/`, {
      headers: { 'x-api-key': AISHA_API_KEY },
    });
    if (!r.ok) continue;
    const d = await r.json();
    const s = d.status || d.state;
    if (['done', 'completed', 'SUCCESS'].includes(s))
      return d.result || d.text || d.transcript || JSON.stringify(d);
    if (['failed', 'FAILURE'].includes(s)) throw new Error('AISHA: audio xatolik');
  }
  throw new Error('AISHA: vaqt tugadi');
}

// ============================================================
// TELEGRAM BOT
// ============================================================
const token = process.env.TELEGRAM_BOT_TOKEN || '8760915981:AAEHJMWgg8afVyfo4fHSVDexWhhjYwfqU6s';
const bot = new TelegramBot(token, { polling: true });

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://personal-assistant-dashboard-production.up.railway.app';
const DASHBOARD_BTN = { inline_keyboard: [[{ text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }]] };
const fmt = n => new Intl.NumberFormat('ru-RU').format(Number(n) || 0);

function tashkentDate(daysAgo = 0) {
  const d = new Date(Date.now() + 5 * 60 * 60 * 1000);
  if (daysAgo) d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function formatTaskLine(task, index) {
  const pri = { high: '🔴', medium: '🟡', low: '🟢' };
  const ov = (task.overdue && task.status !== 'done') ? ' ⚠️' : '';
  const ip = task.status === 'in_progress' ? ' 🔄' : '';
  const due = task.due && task.due !== "Deadline yo'q" ? `⏰ ${task.due}` : "📭 Deadline yo'q";
  return `${pri[task.priority] || '🟡'} *${index}. ${task.title}*${ov}${ip}\n   ${due}`;
}

function formatTaskCard(task, label) {
  const pri = { high: '🔴', medium: '🟡', low: '🟢' };
  const st  = { todo: 'Bajarilmagan', in_progress: '🔄 Jarayonda', done: '✅ Tugagan' };
  const ov  = (task.overdue && task.status !== 'done') ? '\n⚠️ *KECHIKGAN!*' : '';
  return `${pri[task.priority] || '🟡'} *${label || ''}. ${task.title}*${ov}\n📁 ${task.project}  •  ${st[task.status] || task.status}\n⏰ ${task.due || "Deadline yo'q"}`;
}

async function sendTaskList(chatId, tasks, header) {
  if (tasks.length === 0) return bot.sendMessage(chatId, "🎉 Hozircha ochiq vazifalar yo'q!");
  const lines = tasks.map((t, i) => formatTaskLine(t, i + 1)).join('\n\n');
  await bot.sendMessage(chatId, `${header}\n\n${lines}`, {
    parse_mode: 'Markdown', reply_markup: DASHBOARD_BTN,
  });
}

function groupByCategory(list) {
  return list.reduce((acc, tx) => {
    const c = tx.category || 'Boshqa';
    acc[c] = (acc[c] || 0) + (Number(tx.amount) || 0);
    return acc;
  }, {});
}

function bar(amount, total) {
  const n = total > 0 ? Math.round((amount / total) * 10) : 0;
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

async function sendFinanceSummary(chatId) {
  const db = await loadDB();
  const cutoff = tashkentDate(30);
  const recent = db.transactions.filter(t => t.date >= cutoff);

  if (recent.length === 0) {
    return bot.sendMessage(chatId,
      "💰 So'nggi 30 kunda hech qanday tranzaksiya topilmadi.\n\n" +
      "Kirim: \"Oylik maoshim 5 million keldi\"\n" +
      "Chiqim: \"Tushlikka 35 000 so'm sarfladim\""
    );
  }

  const income  = recent.filter(t => t.type === 'income');
  const expense = recent.filter(t => t.type === 'expense');
  const totalIn  = income.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const totalOut = expense.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const balance  = totalIn - totalOut;
  const savePct  = totalIn > 0 ? Math.round((balance / totalIn) * 100) : 0;
  const incCats  = groupByCategory(income);
  const expCats  = groupByCategory(expense);

  let text = `💰 *So'nggi 30 kunlik moliya hisoboti*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += `📊 *Umumiy holat:*\n`;
  text += `➕ Kirim:    *${fmt(totalIn)} so'm*\n`;
  text += `➖ Chiqim:  *${fmt(totalOut)} so'm*\n`;
  text += `${balance >= 0 ? '📈' : '📉'} Balans:   *${fmt(balance)} so'm*\n`;
  if (totalIn > 0)
    text += `💾 Tejash:  *${savePct}%* ${savePct >= 20 ? '✅' : savePct >= 10 ? '⚠️' : '🔴'}\n`;
  text += '\n';

  if (income.length > 0) {
    text += `➕ *Kirim toifalari:*\n`;
    Object.entries(incCats).sort((a, b) => b[1] - a[1]).forEach(([c, a]) => {
      text += `  ${bar(a, totalIn)} ${c}\n  ${fmt(a)} so'm (${Math.round(a / totalIn * 100)}%)\n`;
    });
    text += '\n';
  }
  if (expense.length > 0) {
    text += `➖ *Chiqim toifalari:*\n`;
    Object.entries(expCats).sort((a, b) => b[1] - a[1]).forEach(([c, a]) => {
      text += `  ${bar(a, totalOut)} ${c}\n  ${fmt(a)} so'm (${Math.round(a / totalOut * 100)}%)\n`;
    });
    text += '\n';
  }

  text += `💡 *Maslahat:* `;
  if (balance < 0) {
    const top = Object.entries(expCats).sort((a, b) => b[1] - a[1])[0];
    text += `Bu oy ${fmt(Math.abs(balance))} so'm zarar.`;
    if (top) text += ` Eng ko'p: *${top[0]}* (${fmt(top[1])} so'm).`;
  } else if (savePct >= 20) {
    text += `Ajoyib! ${savePct}% tejadingiz 🎉`;
  } else {
    text += `Tejash ${savePct}%. Maqsad: 20%.`;
  }

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: DASHBOARD_BTN });
}

// ============================================================
// BOT COMMANDS
// ============================================================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 *Assalomu alaykum!*\n\nShaxsiy assistent hizmatda 🤖\n\n` +
    `📋 /tasks — Ochiq vazifalar\n` +
    `✅ /done — Tugagan vazifalar\n` +
    `💰 /finance — Moliya holati\n\n` +
    `_Xabar yozing yoki ovoz yuboring!_`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/tasks/, async (msg) => {
  const db = await loadDB();
  const open = db.tasks.filter(t => t.status !== 'done');
  await sendTaskList(msg.chat.id, open, `📋 *Ochiq vazifalar — ${open.length} ta:*`);
});

bot.onText(/\/done/, async (msg) => {
  const chatId = msg.chat.id;
  const db = await loadDB();
  const done = db.tasks.filter(t => t.status === 'done');
  if (done.length === 0) return bot.sendMessage(chatId, 'Hali hech qanday vazifa tugallanmagan.');
  const lines = done.map((t, i) => `✅ *${i+1}. ${t.title}*\n   ⏰ ${t.due || '—'}`).join('\n\n');
  bot.sendMessage(chatId, `✅ *Tugagan — ${done.length} ta:*\n\n${lines}`, {
    parse_mode: 'Markdown', reply_markup: DASHBOARD_BTN,
  });
});

bot.onText(/\/finance/, async (msg) => sendFinanceSummary(msg.chat.id));

// ============================================================
// INLINE BUTTONS
// ============================================================
bot.on('callback_query', async (query) => {
  const { data, message } = query;
  const chatId = message.chat.id;
  const msgId  = message.message_id;
  const db = await loadDB();

  if (data.startsWith('done_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'done'; task.overdue = false;
      await saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '✅ Bajarildi!' });
      await bot.editMessageText(`✅ *${task.title}* — bajarildi!`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    }
  } else if (data.startsWith('prog_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'in_progress';
      await saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '🔄 Jarayonda!' });
      await bot.editMessageText(formatTaskCard(task, '→'), {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Bajarildi', callback_data: `done_${task.id}` },
          { text: '🔄 Jarayonda', callback_data: `prog_${task.id}` },
        ]]},
      });
    }
  } else if (data.startsWith('undo_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'todo';
      await saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '↩️ Qaytarildi!' });
      await bot.editMessageText(`↩️ *${task.title}* — qaytarildi`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    }
  }
});

// ============================================================
// AI MESSAGE HANDLER
// ============================================================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (msg.text && msg.text.startsWith('/')) return;

  try {
    bot.sendChatAction(chatId, 'typing');
    let userText = '';

    if (msg.voice || msg.audio) {
      const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
      const localPath = await bot.downloadFile(fileId, __dirname);
      try {
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

    const db = await loadDB();
    const openTasks = db.tasks.filter(t => t.status !== 'done');

    let tasksCtx = 'Ochiq vazifalar:\n';
    if (openTasks.length === 0) tasksCtx += "Yo'q.\n";
    openTasks.slice(0, 10).forEach((t, i) => { tasksCtx += `${i+1}. ${t.title} (${t.due})\n`; });

    const cutoff = tashkentDate(30);
    const recentTx = db.transactions.filter(t => t.date >= cutoff);
    const totalIn  = recentTx.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const totalOut = recentTx.filter(t => t.type === 'expense').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    let finCtx = `So'nggi 30 kun: Kirim ${fmt(totalIn)} so'm, Chiqim ${fmt(totalOut)} so'm, Balans ${fmt(totalIn - totalOut)} so'm (${recentTx.length} ta tranzaksiya)\n`;
    recentTx.slice(0, 5).forEach(tx => {
      finCtx += `${tx.type === 'income' ? '+' : '-'} ${tx.title}: ${fmt(tx.amount)} so'm (${tx.date})\n`;
    });

    const nowTZ = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const todayStr    = `${nowTZ.getUTCFullYear()}-${pad(nowTZ.getUTCMonth()+1)}-${pad(nowTZ.getUTCDate())}`;
    const timeStr     = `${pad(nowTZ.getUTCHours())}:${pad(nowTZ.getUTCMinutes())}`;
    const tomorrowStr = (() => { const t = new Date(nowTZ); t.setUTCDate(t.getUTCDate()+1); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth()+1)}-${pad(t.getUTCDate())}`; })();
    const days = ['Yakshanba','Dushanba','Seshanba','Chorshanba','Payshanba','Juma','Shanba'];

    const completion = await groq.chat.completions.create({
      messages: [{
        role: 'system',
        content:
          `Siz aqlli shaxsiy assistent bo'tsiz. Javob faqat JSON.\n` +
          `Hozir: ${todayStr} ${timeStr} (Toshkent UTC+5), ${days[nowTZ.getUTCDay()]}\n` +
          `Bugun=${todayStr}, Ertaga=${tomorrowStr}\n\n` +
          `${tasksCtx}\n${finCtx}\n${JSON_SCHEMA}`,
      }, { role: 'user', content: userText }],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const today = tashkentDate();

    if (parsed.action === 'ADD_TASK') {
      const newTask = {
        id: Date.now(),
        title: parsed.data.title || 'Nomalum vazifa',
        project: 'General',
        priority: 'medium',
        status: 'todo',
        due: parsed.data.due || "Deadline yo'q",
        nextAction: '',
        overdue: false,
      };
      const fresh = await loadDB();
      fresh.tasks.unshift(newTask);
      await saveDB(fresh);
      await bot.sendMessage(chatId, parsed.reply);
      await bot.sendMessage(chatId, formatTaskCard(newTask, '🆕'), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Bajarildi', callback_data: `done_${newTask.id}` },
          { text: '🔄 Jarayonda', callback_data: `prog_${newTask.id}` },
        ]]},
      });

    } else if (parsed.action === 'ADD_EXPENSE') {
      const newTx = {
        id: Date.now(),
        type: 'expense',
        title: parsed.data.title || parsed.data.category || 'Xarajat',
        category: parsed.data.category || 'Personal',
        amount: Number(parsed.data.amount) || 0,
        currency: 'UZS',
        date: today,
        wallet: 'Naqd',
      };
      const fresh = await loadDB();
      fresh.transactions.unshift(newTx);
      await saveDB(fresh);
      await bot.sendMessage(chatId,
        `${parsed.reply}\n\n➖ *${newTx.title}*: ${fmt(newTx.amount)} so'm\n📂 ${newTx.category}`,
        { parse_mode: 'Markdown' }
      );

    } else if (parsed.action === 'ADD_INCOME') {
      const newTx = {
        id: Date.now(),
        type: 'income',
        title: parsed.data.title || parsed.data.category || 'Kirim',
        category: parsed.data.category || 'Maosh',
        amount: Number(parsed.data.amount) || 0,
        currency: 'UZS',
        date: today,
        wallet: 'Naqd',
      };
      const fresh = await loadDB();
      fresh.transactions.unshift(newTx);
      await saveDB(fresh);
      await bot.sendMessage(chatId,
        `${parsed.reply}\n\n➕ *${newTx.title}*: ${fmt(newTx.amount)} so'm\n📂 ${newTx.category}`,
        { parse_mode: 'Markdown' }
      );

    } else {
      await bot.sendMessage(chatId, parsed.reply);
      const taskKw = ['vazifa', 'task', 'ishlar', 'reja', 'todo', 'deadline', 'ishim'];
      if (taskKw.some(k => userText.toLowerCase().includes(k)) && openTasks.length > 0)
        await sendTaskList(chatId, openTasks, `📋 *${openTasks.length} ta ochiq vazifangiz:*`);
      const finKw = ['moliya', 'pul', 'kirim', 'chiqim', 'balans', 'xarajat', 'daromad', 'maosh', 'qancha', 'hisobot'];
      if (finKw.some(k => userText.toLowerCase().includes(k)))
        await sendFinanceSummary(chatId);
    }

  } catch (error) {
    console.error('Bot Error:', error);
    bot.sendMessage(chatId, 'Xatolik: ' + error.message);
  }
});

// ============================================================
// REACT APP
// ============================================================
app.get('/{*splat}', (req, res) => {
  const idx = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('Frontend not built.');
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
});
