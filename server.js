// server.js - VERSI DEBUG (tanpa AI dulu)
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

// Environment Variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const userList = new Set();

console.log('Bot Telegram berjalan...');
console.log('Google Script URL:', GOOGLE_SCRIPT_URL); // Debug

// Function: Kirim data ke Google Sheets
async function sendToGoogleSheets(action, data) {
  try {
    console.log('=== SENDING TO SHEETS ===');
    console.log('URL:', GOOGLE_SCRIPT_URL);
    console.log('Action:', action);
    console.log('Data:', JSON.stringify(data));
    
    const response = await axios.post(GOOGLE_SCRIPT_URL, {
      action: action,
      ...data
    });
    
    console.log('✅ Sheet Response Status:', response.status);
    console.log('✅ Sheet Response Data:', JSON.stringify(response.data));
    
    return response.data;
  } catch (error) {
    console.error('❌ Error sending to Google Sheets:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return { success: false, message: 'Gagal menghubungi Google Sheets: ' + error.message };
  }
}

// Function: Analisis pesan menggunakan ChatGPT
async function analyzeMessageWithChatGPT(message, userId, username) {
  try {
    const systemPrompt = `Kamu adalah asisten yang menganalisis pesan order dari customer.
Tugasmu adalah mengidentifikasi jenis pesan:
- "new_order" = pesan berisi pesanan baru
- "update" = pesan berisi permintaan update/perubahan order
- "cancel" = pesan berisi pembatalan order
- "inquiry" = pesan berisi pertanyaan atau informasi umum

Analisis pesan dan berikan response dalam format JSON:
{
  "orderType": "new_order|update|cancel|inquiry",
  "confidence": 0.0-1.0,
  "extractedInfo": "informasi penting dari pesan",
  "suggestedReply": "balasan yang sesuai untuk user"
}`;

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `User: ${username} (ID: ${userId})\nPesan: ${message}` }
        ],
        temperature: 0.3,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return {
      orderType: 'inquiry',
      confidence: 0.5,
      extractedInfo: message,
      suggestedReply: 'Terima kasih atas pesan Anda.'
    };

  } catch (error) {
    console.error('Error analyzing with ChatGPT:', error.message);
    return {
      orderType: 'inquiry',
      confidence: 0,
      extractedInfo: message,
      suggestedReply: 'Pesan Anda telah kami terima.'
    };
  }
}

// Handler: Setiap pesan yang masuk
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || 'Unknown';
  const message = msg.text;
  const telegramMessageId = msg.message_id;

  userList.add(userId);

  console.log(`Pesan dari ${username} (${userId}, MSG:${telegramMessageId}): ${message}`);

  // CEK: Apakah ini adalah REPLY?
  if (msg.reply_to_message) {
    console.log('⚠️ This is a reply - skipping for now');
    await bot.sendMessage(chatId, '⚠️ Fitur reply sedang dalam maintenance. Kirim pesan baru untuk order.');
    return;
  }

  // Kirim notifikasi
  await bot.sendMessage(chatId, '⏳ Memproses pesan Anda...');

  // 1. Analisis dengan ChatGPT
  const analysis = await analyzeMessageWithChatGPT(message, userId, username);
  console.log('Analisis ChatGPT:', analysis);

  // 2. Siapkan data untuk Google Sheets
  const sheetData = {
    messageId: telegramMessageId,
    userId: userId,
    username: username,
    message: message,
    orderType: analysis.orderType,
    status: 'pending',
    notes: analysis.extractedInfo
  };

  console.log('📤 Preparing to send to sheets...');

  // 3. Kirim ke Google Sheets
  const sheetResponse = await sendToGoogleSheets('add', sheetData);

  console.log('📥 Sheet response received:', sheetResponse);

  // 4. Kirim response ke user
  let replyMessage = '';
  
  if (sheetResponse && sheetResponse.success) {
    replyMessage = `✅ Pesan Anda telah tercatat!\n\n📌 Message ID: #MSG${telegramMessageId}\n🔢 Row: ${sheetResponse.rowNumber}\n\n${analysis.suggestedReply}`;
  } else {
    replyMessage = `❌ Maaf, terjadi kesalahan sistem.\nPesan: ${sheetResponse ? sheetResponse.message : 'Unknown error'}`;
  }

  await bot.sendMessage(chatId, replyMessage);
});

// Command: /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    `🤖 Selamat datang di Bot Order!\n\n` +
    `Silakan kirim pesan untuk membuat order.\n` +
    `Semua pesan akan diproses otomatis dan tersimpan di sistem.`
  );
});

// Command: /test - test koneksi
bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId, '🧪 Testing connection to Google Sheets...');
  
  const testData = {
    messageId: '99999',
    userId: msg.from.id,
    username: msg.from.username || 'Test',
    message: 'Test connection',
    orderType: 'test',
    status: 'testing',
    notes: 'Connection test from /test command'
  };
  
  const result = await sendToGoogleSheets('add', testData);
  
  if (result && result.success) {
    await bot.sendMessage(chatId, `✅ Connection OK!\nRow: ${result.rowNumber}\nCheck your spreadsheet.`);
  } else {
    await bot.sendMessage(chatId, `❌ Connection FAILED!\nError: ${result ? result.message : 'Unknown'}`);
  }
});

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Keep alive endpoint
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Telegram Bot is running!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    googleScriptUrl: GOOGLE_SCRIPT_URL ? 'configured' : 'missing',
    openaiKey: OPENAI_API_KEY ? 'configured' : 'missing'
  });
});

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});