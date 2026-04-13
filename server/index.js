import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import { pipeline } from 'stream/promises';

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
const token = '8760915981:AAEHJMWgg8afVyfo4fHSVDexWhhjYwfqU6s';
const bot = new TelegramBot(token, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  if (msg.text && msg.text.startsWith('/start')) {
    return bot.sendMessage(chatId, `Assalomu alaykum! Shaxsiy Assistent hizmatda. Menga ovozli xabar (voice) yoki dildagi gaplaringizni yozib qoldirsangiz tushunib, Groq orqali bajaraman!`);
  }
  
  if (msg.text && msg.text.startsWith('/tasks')) {
    const db = loadDB();
    const openTasks = db.tasks.filter(t => t.status !== 'done');
    if (openTasks.length === 0) return bot.sendMessage(chatId, "Hozircha ochiq vazifalar yo'q!");
    let text = "📋 Ochiq vazifalar:\n\n";
    openTasks.forEach((t, i) => {
      text += `${i+1}. ${t.title}\n   ⏰ Due: ${t.due}\n`;
    });
    return bot.sendMessage(chatId, text);
  }

  try {
    bot.sendChatAction(chatId, 'typing');
    let userText = "";

    // If AUDIO/VOICE message
    if (msg.voice || msg.audio) {
      const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
      const fileLink = await bot.getFileLink(fileId);
      
      const res = await fetch(fileLink);
      if (!res.ok) throw new Error(`unexpected response ${res.statusText}`);
      
      const tempPath = path.join(__dirname, `${fileId}.ogg`);
      // Stream audio to disk
      await pipeline(res.body, fs.createWriteStream(tempPath));

      // Transcribe via Whisper large v3 natively hitting Groq
      const transcription = await groq.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: "whisper-large-v3",
        response_format: "json",
      });

      userText = transcription.text;
      
      // Cleanup temp audio and inform user we got it
      fs.unlinkSync(tempPath);
      bot.sendMessage(chatId, `🎤 Ovozli xabar tarjimasi:\n_"${userText}"_`, { parse_mode: 'Markdown' });
    } else if (msg.text) {
      userText = msg.text;
    } else {
      return bot.sendMessage(chatId, "Kechirasiz, faqat matn yoki ovoz qabul qila olaman.");
    }

    // Retrieve tasks to give context to the AI
    const dbContext = loadDB();
    const openTasks = dbContext.tasks.filter(t => t.status !== 'done');
    let tasksContextStr = "Foydalanuvchining joriy ochiq vazifalari ro'yxati (Bu ro'yxat faqat ma'lumot uchun. Agar foydalanuvchi 'Nima ishlarim bor?', 'Qanday rejalar bor?' deb SO'RASA, CHAT xatosiz qaytaring. Lekin agar uning gapida yangi vazifa KUZATILSA, albatta ADD_TASK qiling):\n";
    if (openTasks.length === 0) tasksContextStr += "Hech qanday ochiq vazifa yo'q.\n";
    openTasks.forEach((t, i) => {
      tasksContextStr += `${i+1}. ${t.title} (Muddat: ${t.due})\n`;
    });

    // Process text intent with LLM
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `Siz mukammal ishlaydigan aqlli assistent bot liganing miyasisiz (LLama 3.3). Hozirgi raqamli yil: 2026. Xabargingiz qat'iy JSON da bo'lishi shart.\n\n${tasksContextStr}\n\n${JSON_SCHEMA}`
        },
        {
          role: "user",
          content: userText
        }
      ],
      model: "llama-3.3-70b-versatile",
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    
    // Execute Action on DB
    const db = loadDB();
    if (parsed.action === 'ADD_TASK') {
      const newTask = {
        id: Date.now(),
        title: parsed.data.title || "Nomalum vazifa",
        project: "General",
        priority: "medium",
        status: "todo",
        due: parsed.data.due || "Deadline yo‘q",
        nextAction: "Keyingi qadam kiritilmagan",
        overdue: false,
      };
      db.tasks.unshift(newTask);
      saveDB(db);
    } else if (parsed.action === 'ADD_EXPENSE') {
      const newTx = {
        id: Date.now(),
        type: "expense",
        title: parsed.data.title || parsed.data.category || "Xarajat",
        category: parsed.data.category || "Personal",
        amount: Number(parsed.data.amount) || 0,
        currency: "UZS",
        date: new Date().toISOString().split('T')[0],
        wallet: "Naqd"
      };
      db.transactions.unshift(newTx);
      saveDB(db);
    }
    
    // Reply back
    bot.sendMessage(chatId, parsed.reply);

  } catch (error) {
    console.error("Groq AI Error:", error);
    bot.sendMessage(chatId, "AI tizimi xizmatida xatolik yuz berdi. " + error.message);
  }
});

// Catch-all: serve React app for any non-API route (in production)
app.get('*', (req, res) => {
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
