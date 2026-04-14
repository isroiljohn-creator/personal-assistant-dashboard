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

function loadDB() {
  const data = fs.readFileSync(dbPath, 'utf-8');
  return JSON.parse(data);
}

function saveDB(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// Toshkent vaqtida bugungi sana (UTC+5)
function tashkentDate(daysAgo = 0) {
  const d = new Date(Date.now() + 5 * 60 * 60 * 1000);
  if (daysAgo) d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

// REST APIs for Dashboard
app.get('/api/data', (req, res) => res.json(loadDB()));

app.post('/api/tasks', (req, res) => {
  const db = loadDB();
  const newTask = { ...req.body, id: Date.now(), status: 'todo', overdue: false };
  db.tasks.unshift(newTask);
  saveDB(db);
  res.json(newTask);
});

app.patch('/api/tasks/:id/toggle', (req, res) => {
  const db = loadDB();
  const task = db.tasks.find(t => t.id === parseInt(req.params.id));
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
  const newTx = { ...req.body, id: Date.now(), amount: Number(req.body.amount) };
  db.transactions.unshift(newTx);
  saveDB(db);
  res.json(newTx);
});

// GROQ
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const JSON_SCHEMA = `
MUHIM QOIDALAR - action tanlashda adashmang:
- ADD_EXPENSE = pul SARFLANDI, XARAJAT qilindi: "obed qildim", "taksi oldim", "sotib oldim", "to'ladim", "sarfladim", "yedim", "ichim", "kiyim oldim"
- ADD_INCOME = pul KELDI, DAROMAD: "maosh keldi", "pul o'tkazildi", "freelance to'lov", "sovga pul"
- ADD_TASK = vazifa, ish, uchrashuv, seminar, deadline
- CHAT = savol, so'rov, moliya/vazifa haqida ma'lumot olish

Faqat JSON formatida (boshqa narsa yozma):

{
  "action": "Bir tanlang: ADD_TASK (yangi ish/vazifa qo'shish), ADD_EXPENSE (xarajat/chiqim/sarflash/sotib olish), ADD_INCOME (kirim/daromad/maosh/pul keldi/tushum), CHAT (savol-javob, moliya holati, vazifalar haqida so'rov)",
  "data": {
    "title": "Vazifa yoki tranzaksiya nomi",
    "due": "Vazifa muddati YYYY-MM-DD HH:MM formatida. Yo'q bo'lsa: Deadline yo'q",
    "amount": "Pul summasi FAQAT raqam (ADD_EXPENSE va ADD_INCOME uchun MAJBURIY)",
    "category": "Toifa: Maosh/Freelance/Biznes/Sovga (kirim) yoki Oziq-ovqat/Transport/Uy/Sogliq/Talim/Kiyim/Personal (chiqim)"
  },
  "reply": "Foydalanuvchiga qisqa, do'stona javob. HECH QACHON ADD_TASK, ADD_EXPENSE, ADD_INCOME kabi texnik so'zlarni ishlatma!"
}`;

// AISHA STT
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
  if (!postRes.ok) {
    const err = await postRes.text();
    throw new Error(`AISHA POST xatosi: ${postRes.status} ${err}`);
  }
  const postData = await postRes.json();
  const taskId = postData.id || postData.task_id;
  if (!taskId) throw new Error('AISHA: task ID qaytmadi');

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

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://personal-assistant-dashboard-production.up.railway.app';
const DASHBOARD_BTN = { inline_keyboard: [[{ text: '📊 Dashboardni ochish', web_app: { url: DASHBOARD_URL } }]] };
const fmt = n => new Intl.NumberFormat('ru-RU').format(Number(n) || 0);

// ==== TASK HELPERS ====
function formatTaskLine(task, index) {
  const pri = { high: '🔴', medium: '🟡', low: '🟢' };
  const overdue = (task.overdue && task.status !== 'done') ? ' ⚠️' : '';
  const inprog  = task.status === 'in_progress' ? ' 🔄' : '';
  const due = task.due && task.due !== "Deadline yo'q" ? `⏰ ${task.due}` : "📭 Deadline yo'q";
  return `${pri[task.priority] || '🟡'} *${index}. ${task.title}*${overdue}${inprog}\n   ${due}`;
}

function formatTaskCard(task, index) {
  const pri = { high: '🔴', medium: '🟡', low: '🟢' };
  const st  = { todo: 'Bajarilmagan', in_progress: '🔄 Jarayonda', done: '✅ Tugagan' };
  const ov  = (task.overdue && task.status !== 'done') ? '\n⚠️ *KECHIKGAN!*' : '';
  return `${pri[task.priority] || '🟡'} *${index}. ${task.title}*${ov}\n📁 ${task.project}  •  ${st[task.status] || 'Bajarilmagan'}\n⏰ ${task.due || "Deadline yo'q"}`;
}

async function sendTaskList(chatId, tasks, header) {
  if (tasks.length === 0) {
    return bot.sendMessage(chatId, "🎉 Hozircha ochiq vazifalar yo'q!");
  }
  const lines = tasks.map((t, i) => formatTaskLine(t, i + 1)).join('\n\n');
  await bot.sendMessage(chatId, `${header}\n\n${lines}`, {
    parse_mode: 'Markdown',
    reply_markup: DASHBOARD_BTN,
  });
}

// ==== FINANCE HELPERS ====
function groupByCategory(txList) {
  return txList.reduce((acc, tx) => {
    const cat = tx.category || 'Boshqa';
    acc[cat] = (acc[cat] || 0) + (Number(tx.amount) || 0);
    return acc;
  }, {});
}

function barChart(amount, total) {
  const pct = total > 0 ? Math.round((amount / total) * 10) : 0;
  return '█'.repeat(pct) + '░'.repeat(10 - pct);
}

function sendFinanceSummary(chatId) {
  const db = loadDB();
  const cutoff = tashkentDate(30);
  const recentTx = db.transactions.filter(t => t.date >= cutoff);

  if (recentTx.length === 0) {
    return bot.sendMessage(chatId,
      "💰 So'nggi 30 kunda hech qanday tranzaksiya topilmadi.\n\n" +
      "Kirim uchun: \"Maoshim 5 million keldi\"\n" +
      "Chiqim uchun: \"Tushlikka 35 000 so'm sarfladim\""
    );
  }

  const income  = recentTx.filter(t => t.type === 'income');
  const expense = recentTx.filter(t => t.type === 'expense');
  const totalIn  = income.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const totalOut = expense.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const balance  = totalIn - totalOut;
  const savingsPct = totalIn > 0 ? Math.round((balance / totalIn) * 100) : 0;

  // Category breakdowns
  const incCats = groupByCategory(income);
  const expCats = groupByCategory(expense);

  let text = `💰 *So'nggi 30 kunlik moliya hisoboti*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Umumiy holat
  text += `📊 *Umumiy holat:*\n`;
  text += `➕ Kirim:    *${fmt(totalIn)} so'm*\n`;
  text += `➖ Chiqim:  *${fmt(totalOut)} so'm*\n`;
  text += `${balance >= 0 ? '📈' : '📉'} Balans:   *${fmt(balance)} so'm*\n`;
  if (totalIn > 0) {
    text += `💾 Tejash:  *${savingsPct}%* ${savingsPct >= 20 ? '✅' : savingsPct >= 10 ? '⚠️' : '🔴'}\n`;
  }
  text += '\n';

  // Kirim toifalari
  if (income.length > 0) {
    text += `➕ *Kirim toifalari:*\n`;
    const sortedIn = Object.entries(incCats).sort((a, b) => b[1] - a[1]);
    sortedIn.forEach(([cat, amount]) => {
      const pct = Math.round((amount / totalIn) * 100);
      text += `  ${barChart(amount, totalIn)} ${cat}\n`;
      text += `  ${fmt(amount)} so'm (${pct}%)\n`;
    });
    text += '\n';
  }

  // Chiqim toifalari
  if (expense.length > 0) {
    text += `➖ *Chiqim toifalari:*\n`;
    const sortedExp = Object.entries(expCats).sort((a, b) => b[1] - a[1]);
    sortedExp.forEach(([cat, amount]) => {
      const pct = Math.round((amount / totalOut) * 100);
      text += `  ${barChart(amount, totalOut)} ${cat}\n`;
      text += `  ${fmt(amount)} so'm (${pct}%)\n`;
    });
    text += '\n';
  }

  // Aqlli maslahat
  text += `💡 *Maslahat:*\n`;
  if (balance < 0) {
    const topExp = Object.entries(expCats).sort((a, b) => b[1] - a[1])[0];
    text += `Siz bu oy ${fmt(Math.abs(balance))} so'm zarar ko'rdingiz. `;
    if (topExp) text += `Eng ko'p xarajat: *${topExp[0]}* (${fmt(topExp[1])} so'm).`;
  } else if (savingsPct >= 20) {
    text += `Ajoyib! Daromadingizning ${savingsPct}% ini tejadingiz. 🎉`;
  } else if (savingsPct >= 10) {
    text += `Yaxshi holat, lekin tejashni yana oshirishingiz mumkin. Maqsad: 20%.`;
  } else {
    text += `Kirimingizning atigi ${savingsPct}% tejaldi. Chiqimlarni kamaytiring!`;
  }

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: DASHBOARD_BTN });
}


// ==== BOT COMMANDS ====
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
  const db = loadDB();
  const openTasks = db.tasks.filter(t => t.status !== 'done');
  await sendTaskList(msg.chat.id, openTasks, `📋 *Ochiq vazifalar — ${openTasks.length} ta:*`);
});

bot.onText(/\/done/, async (msg) => {
  const chatId = msg.chat.id;
  const db = loadDB();
  const done = db.tasks.filter(t => t.status === 'done');
  if (done.length === 0) return bot.sendMessage(chatId, 'Hali hech qanday vazifa tugallanmagan.');
  const lines = done.map((t, i) => `✅ *${i + 1}. ${t.title}*\n   ⏰ ${t.due || '—'}`).join('\n\n');
  bot.sendMessage(chatId, `✅ *Tugagan vazifalar — ${done.length} ta:*\n\n${lines}`, {
    parse_mode: 'Markdown',
    reply_markup: DASHBOARD_BTN,
  });
});

bot.onText(/\/finance/, (msg) => sendFinanceSummary(msg.chat.id));

// ==== INLINE BUTTONS ====
bot.on('callback_query', async (query) => {
  const { data, message } = query;
  const chatId = message.chat.id;
  const msgId  = message.message_id;
  const db = loadDB();

  if (data.startsWith('done_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'done'; task.overdue = false;
      saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '✅ Bajarildi!' });
      await bot.editMessageText(`✅ *${task.title}* — bajarildi!`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    }
  } else if (data.startsWith('prog_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'in_progress';
      saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '🔄 Jarayonda!' });
      await bot.editMessageText(formatTaskCard(task, '→'), {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[
          { text: '✅ Bajarildi', callback_data: `done_${task.id}` },
          { text: '🔄 Jarayonda', callback_data: `prog_${task.id}` },
        ]]}
      });
    }
  } else if (data.startsWith('undo_')) {
    const task = db.tasks.find(t => t.id === parseInt(data.slice(5)));
    if (task) {
      task.status = 'todo';
      saveDB(db);
      await bot.answerCallbackQuery(query.id, { text: '↩️ Qaytarildi!' });
      await bot.editMessageText(`↩️ *${task.title}* — qaytarildi`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    }
  }
});

// ==== AI MESSAGE HANDLER ====
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

    const dbCtx = loadDB();
    const openTasks = dbCtx.tasks.filter(t => t.status !== 'done');

    // Tasks context
    let tasksCtx = "Ochiq vazifalar:\n";
    if (openTasks.length === 0) tasksCtx += "Yo'q.\n";
    openTasks.forEach((t, i) => { tasksCtx += `${i + 1}. ${t.title} (${t.due})\n`; });

    // Finance context — so'nggi 30 kun
    const cutoff = tashkentDate(30);
    const recentTx = dbCtx.transactions.filter(t => t.date >= cutoff);
    const totalIn  = recentTx.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const totalOut = recentTx.filter(t => t.type === 'expense').reduce((s, t) => s + (Number(t.amount) || 0), 0);
    let financeCtx = `So'nggi 30 kunlik moliya: Kirim ${fmt(totalIn)} so'm, Chiqim ${fmt(totalOut)} so'm, Balans ${fmt(totalIn - totalOut)} so'm. Tranzaksiyalar soni: ${recentTx.length}.\n`;
    recentTx.slice(0, 5).forEach(tx => {
      financeCtx += `${tx.type === 'income' ? '+' : '-'} ${tx.title}: ${fmt(tx.amount)} so'm (${tx.date})\n`;
    });

    // Toshkent datetime
    const nowTZ = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const todayStr = `${nowTZ.getUTCFullYear()}-${pad(nowTZ.getUTCMonth() + 1)}-${pad(nowTZ.getUTCDate())}`;
    const timeStr  = `${pad(nowTZ.getUTCHours())}:${pad(nowTZ.getUTCMinutes())}`;
    const days = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
    const tomorrowStr = (() => {
      const t = new Date(nowTZ); t.setUTCDate(t.getUTCDate() + 1);
      return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    })();

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content:
            `Siz aqlli shaxsiy assistent bo'tsiz. Javob faqat JSON.\n\n` +
            `🕐 Hozir: ${todayStr} ${timeStr} (Toshkent UTC+5), ${days[nowTZ.getUTCDay()]}\n` +
            `Bugun=${todayStr}, Ertaga=${tomorrowStr}\n\n` +
            `${tasksCtx}\n${financeCtx}\n${JSON_SCHEMA}`,
        },
        { role: 'user', content: userText },
      ],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const db = loadDB();
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
      db.tasks.unshift(newTask);
      saveDB(db);
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
      db.transactions.unshift(newTx);
      saveDB(db);
      await bot.sendMessage(chatId, parsed.reply);

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
      db.transactions.unshift(newTx);
      saveDB(db);
      await bot.sendMessage(chatId, parsed.reply);

    } else {
      // CHAT
      await bot.sendMessage(chatId, parsed.reply);

      // Vazifalar so'ralsa
      const taskKw = ['vazifa', 'task', 'ishlar', 'reja', 'todo', 'deadline', 'ishim', 'nima qilish'];
      if (taskKw.some(k => userText.toLowerCase().includes(k)) && openTasks.length > 0) {
        await sendTaskList(chatId, openTasks, `📋 *Sizning ${openTasks.length} ta ochiq vazifangiz:*`);
      }

      // Moliya so'ralsa
      const finKw = ['moliya', 'pul', 'kirim', 'chiqim', 'balans', 'xarajat', 'daromad', 'maosh', 'finance', 'necha pul', 'qancha pul'];
      if (finKw.some(k => userText.toLowerCase().includes(k))) {
        sendFinanceSummary(chatId);
      }
    }

  } catch (error) {
    console.error('Bot Error:', error);
    bot.sendMessage(chatId, 'Xatolik yuz berdi: ' + error.message);
  }
});

// Catch-all: serve React app
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
