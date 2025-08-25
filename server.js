const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  path: '/ws'
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
const typingUsers = new Map();
const TYPING_TIMEOUT = 2000;

// Initialize SQLite database
const db = new Database('chat.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  )
`);

// Prepare statement to get recent messages from database
const getRecentMessagesStmt = db.prepare(`
  SELECT * FROM messages 
  ORDER BY ts DESC 
  LIMIT 200
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (id, name, text, ts) 
  VALUES (?, ?, ?, ?)
`);

const deleteMessage = db.prepare(`
  DELETE FROM messages WHERE id = ?
`);

const clearMessages = db.prepare(`
  DELETE FROM messages
`);

let messageIdCounter = 1;

const state = {
  pinned: '',
  slow: 0,
  emojiOnly: false
};

// Load word filter configuration
let filterConfig = { bannedWords: [], bannedPatterns: [] };
try {
  const configData = fs.readFileSync('config.json', 'utf8');
  filterConfig = JSON.parse(configData);
  console.log(`Loaded ${filterConfig.bannedWords.length} banned words and ${filterConfig.bannedPatterns.length} patterns`);
} catch (err) {
  console.log('No config.json found or invalid format, running without word filter');
}

// Watch for config changes
if (fs.existsSync('config.json')) {
  fs.watchFile('config.json', () => {
    try {
      const configData = fs.readFileSync('config.json', 'utf8');
      filterConfig = JSON.parse(configData);
      console.log('Reloaded word filter config');
    } catch (err) {
      console.error('Error reloading config:', err);
    }
  });
}

function isEmojiOnly(text) {
  const emojiRegex = /^[\p{Emoji}\s]+$/u;
  return emojiRegex.test(text);
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, '');
}

function containsBannedContent(text) {
  const lowerText = text.toLowerCase();
  
  // Check exact banned words
  for (const word of filterConfig.bannedWords) {
    if (lowerText.includes(word.toLowerCase())) {
      return true;
    }
  }
  
  // Check regex patterns for variations
  for (const pattern of filterConfig.bannedPatterns) {
    try {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(text)) {
        return true;
      }
    } catch (err) {
      console.error(`Invalid regex pattern: ${pattern}`);
    }
  }
  
  return false;
}

function broadcast(message, exclude = null) {
  const messageStr = JSON.stringify(message);
  clients.forEach(client => {
    if (client !== exclude && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(messageStr);
    }
  });
}


function broadcastTypingStatus() {
  const typingList = Array.from(typingUsers.keys());
  broadcast({
    type: 'typing',
    users: typingList
  });
}

function getActiveUserCount() {
  let count = 0;
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      count++;
    }
  }
  return count;
}

function broadcastUserCount() {
  broadcast({
    type: 'userCount',
    count: getActiveUserCount()
  });
}

wss.on('connection', (ws) => {
  const client = {
    ws,
    name: 'Guest',
    lastSentAt: 0,
    isHost: false
  };
  
  clients.add(client);
  
  // Immediately broadcast updated user count when someone connects
  broadcastUserCount();
  
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
  
  ws.on('pong', () => {
    client.lastPong = Date.now();
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'hello':
          const requestedName = stripHtml(msg.name || 'Guest').substring(0, 30);
          
          // No name collision check - allow multiple tabs with same name
          // This is better for personal use where you might have multiple tabs open
          
          client.name = requestedName;
          client.isHost = Boolean(msg.host);
          
          // Get fresh messages from database
          const recentMessages = getRecentMessagesStmt.all().reverse();
          
          ws.send(JSON.stringify({
            type: 'system',
            mode: {
              slow: state.slow,
              emojiOnly: state.emojiOnly
            },
            pinned: state.pinned,
            messages: recentMessages,
            userCount: getActiveUserCount()
          }));
          break;
          
        case 'msg':
          const now = Date.now();
          const timeSinceLastMsg = (now - client.lastSentAt) / 1000;
          
          if (state.slow > 0 && timeSinceLastMsg < state.slow) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Slow mode: wait ${Math.ceil(state.slow - timeSinceLastMsg)}s`
            }));
            return;
          }
          
          const text = stripHtml(msg.text || '').substring(0, 240);
          
          if (!text) return;
          
          // Silent filter - just return without any error message
          if (containsBannedContent(text)) {
            console.log(`Filtered message from ${client.name}: "${text}"`);
            return;
          }
          
          if (state.emojiOnly && !isEmojiOnly(text)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Emoji-only mode is enabled'
            }));
            return;
          }
          
          if (/https?:\/\//i.test(text)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Links are not allowed'
            }));
            return;
          }
          
          client.lastSentAt = now;
          
          const message = {
            type: 'msg',
            id: `${now}-${messageIdCounter++}`,
            name: client.name,
            text: text,
            ts: now
          };
          
          // Save to database
          insertMessage.run(message.id, message.name, message.text, message.ts);
          broadcast(message);
          break;
          
        case 'typing':
          if (msg.isTyping) {
            // Clear existing timeout
            if (typingUsers.has(client.name)) {
              clearTimeout(typingUsers.get(client.name));
            }
            
            // Set new timeout
            const timeout = setTimeout(() => {
              typingUsers.delete(client.name);
              broadcastTypingStatus();
            }, TYPING_TIMEOUT);
            
            typingUsers.set(client.name, timeout);
            broadcastTypingStatus();
          } else {
            // User stopped typing
            if (typingUsers.has(client.name)) {
              clearTimeout(typingUsers.get(client.name));
              typingUsers.delete(client.name);
              broadcastTypingStatus();
            }
          }
          break;
          
        case 'setMode':
          if (!client.isHost) return;
          
          state.slow = Math.max(0, Math.min(5, msg.slow || 0));
          state.emojiOnly = Boolean(msg.emojiOnly);
          
          broadcast({
            type: 'system',
            mode: {
              slow: state.slow,
              emojiOnly: state.emojiOnly
            }
          });
          break;
          
        case 'pin':
          if (!client.isHost) return;
          
          state.pinned = stripHtml(msg.text || '').substring(0, 240);
          
          broadcast({
            type: 'pin',
            text: state.pinned
          });
          break;
          
        case 'reset':
          if (!client.isHost) return;
          
          clearMessages.run();
          broadcast({
            type: 'reset'
          });
          break;
          
        case 'delete':
          if (!client.isHost) return;
          
          deleteMessage.run(msg.id);
          broadcast({
            type: 'delete',
            id: msg.id
          });
          break;
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });
  
  ws.on('close', () => {
    clearInterval(pingInterval);
    clients.delete(client);
    
    // Clean up typing status
    if (client.name && typingUsers.has(client.name)) {
      clearTimeout(typingUsers.get(client.name));
      typingUsers.delete(client.name);
      broadcastTypingStatus();
    }
    
    // Broadcast updated user count
    setTimeout(() => broadcastUserCount(), 100);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});