import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';
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

// TELEGRAM BOT
const token = process.env.TELEGRAM_BOT_TOKEN || '8760915981:AAEHJMWgg8afVyfo4fHSVDexWhhjYwfqU6s';
const bot = new TelegramBot(token, { polling: true });


// Helper: single task -> beautiful card text
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

// Helper: send tasks as individual cards with buttons
async function sendTaskCards(chatId, tasks) {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const text = formatTaskCard(task, i + 1);
    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Bajarildi', callback_data: `done_${task.id}` },
        { text: '🔄 Jarayonda', callback_data: `prog_${task.id}` },
      ]]
    };
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
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

// /tasks — har bir vazifa ALOHIDA card sifatida
bot.onText(/\/tasks/, async (msg) => {
  const chatId = msg.chat.id;
  const db = loadDB();
  const openTasks = db.tasks.filter(t => t.status !== 'done');

  if (openTasks.length === 0) {
    return bot.sendMessage(chatId, '🎉 Barcha vazifalar bajarilgan! Zo\'r!');
  }

  await bot.sendMessage(chatId, `📋 *Ochiq vazifalar — ${openTasks.length} ta:*`, { parse_mode: 'Markdown' });
  await sendTaskCards(chatId, openTasks);
});

// /done — tugagan vazifalar
bot.onText(/\/done/, async (msg) => {
  const chatId = msg.chat.id;
  const db = loadDB();
  const doneTasks = db.tasks.filter(t => t.status === 'done');

  if (doneTasks.length === 0) {
    return bot.sendMessage(chatId, 'Hali hech qanday vazifa tugallanmagan.');
  }

  await bot.sendMessage(chatId, `✅ *Tugagan vazifalar — ${doneTasks.length} ta:*`, { parse_mode: 'Markdown' });
  for (const task of doneTasks) {
    await bot.sendMessage(
      chatId,
      `✅ *${task.title}*\n📁 ${task.project}  •  ⏰ ${task.due || '—'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '↩️ Qaytarish', callback_data: `undo_${task.id}` }]] }
      }
    );
  }
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
      // bot.downloadFile() — library ichki yuklovchi, ishonchli
      const localPath = await bot.downloadFile(fileId, __dirname);
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(localPath),
        model: 'whisper-large-v3',
        response_format: 'json',
      });
      userText = transcription.text;
      try { fs.unlinkSync(localPath); } catch (_) {}
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

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Siz mukammal ishlaydigan aqlli assistent bot liganing miyasisiz (LLama 3.3). Hozirgi raqamli yil: 2026. Xabargingiz qat'iy JSON da bo'lishi shart.\n\n${tasksContextStr}\n\n${JSON_SCHEMA}`
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
      await bot.sendMessage(chatId, parsed.reply, { parse_mode: 'Markdown' });
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
      bot.sendMessage(chatId, parsed.reply, { parse_mode: 'Markdown' });

    } else {
      // CHAT reply
      await bot.sendMessage(chatId, parsed.reply, { parse_mode: 'Markdown' });
      // If user asked about tasks -> auto-show task cards
      const taskKeywords = ['vazifa', 'task', 'ishlar', 'nima qilish', 'rejalar', 'todo'];
      if (taskKeywords.some(kw => userText.toLowerCase().includes(kw)) && openTasks.length > 0) {
        await bot.sendMessage(chatId, `📋 *${openTasks.length} ta ochiq vazifa:*`, { parse_mode: 'Markdown' });
        await sendTaskCards(chatId, openTasks);
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
