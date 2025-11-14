// server.js - VERSI LENGKAP dengan fitur Reply untuk Update/Cancel
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

// Environment Variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Simpan semua user ID yang pernah chat (dalam production, gunakan database)
const userList = new Set();

console.log('Bot Telegram berjalan...');

// Function: Kirim data ke Google Sheets
async function sendToGoogleSheets(action, data) {
  try {
    const response = await axios.post(GOOGLE_SCRIPT_URL, {
      action: action,
      ...data
    });
    return response.data;
  } catch (error) {
    console.error('Error sending to Google Sheets:', error.message);
    return { success: false, message: 'Gagal menghubungi Google Sheets' };
  }
}

// Function: Baca pesan broadcast dari Google Sheets (kolom Q baris 3)
async function getBroadcastMessage() {
  try {
    const response = await axios.get(`${GOOGLE_SCRIPT_URL}?action=getBroadcast`);
    return response.data;
  } catch (error) {
    console.error('Error reading broadcast message:', error.message);
    return { success: false, message: 'Gagal membaca pesan broadcast' };
  }
}

// Function: Kirim broadcast ke semua user
async function sendBroadcast() {
  console.log('🔔 Menjalankan broadcast...');
  
  const broadcastData = await getBroadcastMessage();
  
  if (!broadcastData.success || !broadcastData.message) {
    console.log('❌ Tidak ada pesan broadcast atau gagal membaca');
    return;
  }
  
  const message = broadcastData.message;
  let successCount = 0;
  let failCount = 0;
  
  console.log(`📢 Mengirim ke ${userList.size} user: "${message}"`);
  
  for (const userId of userList) {
    try {
      await bot.sendMessage(userId, message);
      successCount++;
      // Delay untuk avoid rate limit Telegram (max 30 msg/second)
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Gagal kirim ke user ${userId}:`, error.message);
      failCount++;
    }
  }
  
  console.log(`✅ Broadcast selesai: ${successCount} berhasil, ${failCount} gagal`);
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
        model: 'gpt-3.5-turbo',
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
    
    // Parse JSON dari response ChatGPT
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return {
      orderType: 'inquiry',
      confidence: 0.5,
      extractedInfo: message,
      suggestedReply: 'Terima kasih atas pesan Anda. Tim kami akan segera menghubungi Anda.'
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

// Handler: Ketika user REPLY pesan (FIXED - support reply user atau bot message)
async function handleReply(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || 'Unknown';
  const replyText = msg.text;
  const repliedMessage = msg.reply_to_message;
  
  // Ambil Message ID dari pesan yang di-reply
  const repliedMessageId = repliedMessage.message_id;
  const isReplyToBot = repliedMessage.from.is_bot;

  console.log(`🔄 Reply dari ${username}: ${replyText}`);
  console.log(`🔍 Reply to message ID: ${repliedMessageId} (${isReplyToBot ? 'BOT' : 'USER'})`);

  await bot.sendMessage(chatId, '⏳ Memproses reply Anda...');

  let targetMessageId = repliedMessageId;
  
  // Jika user reply pesan BOT, extract Message ID dari text bot
  if (isReplyToBot) {
    const botText = repliedMessage.text;
    const messageIdMatch = botText.match(/#MSG(\d+)/);
    
    if (messageIdMatch) {
      targetMessageId = messageIdMatch[1];
      console.log(`📌 Extracted user message ID from bot: ${targetMessageId}`);
    } else {
      await bot.sendMessage(chatId, '❌ Tidak dapat menemukan Message ID. Pastikan Anda reply pesan yang benar.');
      return;
    }
  }

  // Analisis reply dengan ChatGPT untuk tahu intention
  const analysis = await analyzeMessageWithChatGPT(replyText, userId, username);
  
  console.log('Analisis reply:', analysis);

  let action = 'update';
  let sheetData = {
    messageId: targetMessageId, // Message ID dari USER (bukan bot)
    userId: userId,
    updateMessage: replyText,
    status: 'updated',
    notes: analysis.extractedInfo
  };

  // Jika deteksi cancel
  if (analysis.orderType === 'cancel' || replyText.toLowerCase().includes('cancel') || replyText.toLowerCase().includes('batal')) {
    action = 'cancel';
    sheetData = { messageId: targetMessageId };
  }

  // Kirim ke Google Sheets
  const sheetResponse = await sendToGoogleSheets(action, sheetData);

  // Response ke user
  let replyMessage = '';
  
  if (sheetResponse.success) {
    if (action === 'cancel') {
      replyMessage = `✅ Order #MSG${targetMessageId} berhasil dibatalkan\n\n📝 Order asli:\n"${sheetResponse.originalMessage}"`;
    } else {
      replyMessage = `✅ Order #MSG${targetMessageId} berhasil diupdate!\n\n📝 Order asli:\n"${sheetResponse.originalMessage}"\n\n🔄 Update:\n"${replyText}"\n\n${analysis.suggestedReply}`;
    }
  } else {
    replyMessage = `❌ Gagal update order.\nPesan: ${sheetResponse.message}`;
  }

  await bot.sendMessage(chatId, replyMessage);
}

// Handler: Setiap pesan yang masuk
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || 'Unknown';
  const message = msg.text;
  const telegramMessageId = msg.message_id; // Message ID unik dari Telegram

  // Simpan user ID untuk broadcast
  userList.add(userId);

  console.log(`Pesan dari ${username} (${userId}, MSG:${telegramMessageId}): ${message}`);

  // CEK: Apakah ini adalah REPLY ke pesan apapun (bot ATAU user sendiri)?
  if (msg.reply_to_message) {
    await handleReply(msg);
    return; // Stop processing, sudah ditangani handleReply
  }

  // Kirim notifikasi bahwa pesan sedang diproses
  await bot.sendMessage(chatId, '⏳ Memproses pesan Anda...');

  // 1. Analisis pesan dengan ChatGPT
  const analysis = await analyzeMessageWithChatGPT(message, userId, username);
  
  console.log('Analisis ChatGPT:', analysis);

  // 2. Siapkan data untuk Google Sheets
  let action = 'add';
  let sheetData = {
    messageId: telegramMessageId, // PENTING: Telegram Message ID
    userId: userId,
    username: username,
    message: message,
    orderType: analysis.orderType,
    status: 'pending',
    notes: analysis.extractedInfo
  };

  // 3. Kirim ke Google Sheets
  const sheetResponse = await sendToGoogleSheets(action, sheetData);

  // 4. Kirim response ke user dengan Message ID
  let replyMessage = '';
  
  if (sheetResponse.success) {
    // Cek apakah ada AI response
    if (sheetResponse.aiResponse) {
      // Kirim AI response langsung
      replyMessage = `🤖 ${sheetResponse.aiResponse}\n\n📌 Message ID: #MSG${telegramMessageId}`;
    } else {
      // Fallback ke response biasa
      replyMessage = `✅ Pesan Anda telah tercatat!\n\n📌 Message ID: #MSG${telegramMessageId}\n🔢 Row: ${sheetResponse.rowNumber}\n\n${analysis.suggestedReply}\n\n💡 Tips:\n• Reply pesan Anda sendiri untuk update/cancel\n• ATAU reply pesan bot ini juga bisa`;
    }
  } else {
    replyMessage = `❌ Maaf, terjadi kesalahan sistem.\nPesan: ${sheetResponse.message}`;
  }

  await bot.sendMessage(chatId, replyMessage);
});

// Command: /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    `🤖 Selamat datang di Bot Order!\n\n` +
    `Silakan kirim pesan untuk:\n` +
    `• Membuat order baru\n` +
    `• Update order (reply pesan bot)\n` +
    `• Membatalkan order (reply pesan bot)\n` +
    `• Bertanya informasi\n\n` +
    `Semua pesan akan diproses otomatis dan tersimpan di sistem.\n\n` +
    `💡 Setiap order punya Message ID unik, reply pesan bot untuk update order spesifik!`
  );
});

// Command: /status - cek order user
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  await bot.sendMessage(chatId, '🔍 Mencari order Anda...');

  const response = await sendToGoogleSheets('search', { userId: userId });

  if (response.success && response.count > 0) {
    let statusMessage = `📋 Order Anda (${response.count} order):\n\n`;
    
    response.orders.slice(-5).forEach((order, index) => {
      statusMessage += `${index + 1}. #MSG${order.messageId} - ${order.status}\n`;
      statusMessage += `   📝 ${order.message.substring(0, 50)}...\n`;
      statusMessage += `   🕒 ${new Date(order.timestamp).toLocaleString('id-ID')}\n\n`;
    });
    
    statusMessage += '💡 Reply pesan order untuk update/cancel';

    await bot.sendMessage(chatId, statusMessage);
  } else {
    await bot.sendMessage(chatId, '❌ Belum ada order yang tercatat.');
  }
});

// Command: /broadcast - manual trigger broadcast (untuk testing)
bot.onText(/\/broadcast/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Opsional: Batasi hanya admin yang bisa trigger
  // const ADMIN_ID = 123456789; // Ganti dengan user ID Anda
  // if (userId !== ADMIN_ID) {
  //   await bot.sendMessage(chatId, '❌ Anda tidak memiliki akses untuk broadcast');
  //   return;
  // }
  
  await bot.sendMessage(chatId, '📢 Mengirim broadcast...');
  await sendBroadcast();
  await bot.sendMessage(chatId, `✅ Broadcast terkirim ke ${userList.size} user`);
});

// Scheduler: Kirim broadcast otomatis setiap jam tertentu
cron.schedule('0 8,12,18 * * *', () => {
  console.log('⏰ Waktu broadcast terjadwal!');
  sendBroadcast();
}, {
  timezone: "Asia/Jakarta"
});

console.log('⏰ Scheduler aktif: Broadcast akan dikirim jam 08:00, 12:00, 18:00 WIB');

// Error handling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Keep alive endpoint untuk Railway
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Telegram Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});