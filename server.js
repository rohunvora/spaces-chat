const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  path: '/ws'
});

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || null;

// W counter state
let wCounter = 0;
let isPaused = false;

// Force HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    res.redirect(`https://${req.header('host')}${req.url}`);
  } else {
    next();
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname))); // Serve root files like moderation-presets.json

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
    ts INTEGER NOT NULL,
    reply_to_id TEXT,
    reply_to_name TEXT,
    reply_to_text TEXT
  )
`);

// Prepare statement to get recent messages from database
const getRecentMessagesStmt = db.prepare(`
  SELECT id, name, text, ts, reply_to_id, reply_to_name, reply_to_text
  FROM messages 
  ORDER BY ts DESC 
  LIMIT 200
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (id, name, text, ts, reply_to_id, reply_to_name, reply_to_text) 
  VALUES (?, ?, ?, ?, ?, ?, ?)
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
          
          // Get fresh messages from database and format them
          const recentMessages = getRecentMessagesStmt.all().reverse().map(row => {
            const msg = {
              type: 'msg',
              id: row.id,
              name: row.name,
              text: row.text,
              ts: row.ts
            };
            
            if (row.reply_to_id) {
              msg.replyTo = {
                id: row.reply_to_id,
                name: row.reply_to_name,
                text: row.reply_to_text
              };
            }
            
            return msg;
          });
          
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
          
          // Count W's in the message (if W counter is not paused)
          if (!isPaused) {
            const wCount = (text.match(/w/gi) || []).length;
            if (wCount > 0) {
              wCounter += wCount;
              broadcast({ type: 'updateCount', count: wCounter });
            }
          }
          
          const message = {
            type: 'msg',
            id: `${now}-${messageIdCounter++}`,
            name: client.name,
            text: text,
            ts: now
          };
          
          // Add reply data if present
          if (msg.replyTo) {
            message.replyTo = {
              id: msg.replyTo.id,
              name: stripHtml(msg.replyTo.name).substring(0, 30),
              text: stripHtml(msg.replyTo.text).substring(0, 100)
            };
          }
          
          // Save to database with reply data
          insertMessage.run(
            message.id, 
            message.name, 
            message.text, 
            message.ts,
            message.replyTo?.id || null,
            message.replyTo?.name || null,
            message.replyTo?.text || null
          );
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

// Admin API endpoints
app.get('/api/count', (req, res) => {
  res.json({ count: wCounter, paused: isPaused });
});

// Moderation API endpoints
app.get('/api/moderation/words', (req, res) => {
  // Check admin key
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({ 
    bannedWords: filterConfig.bannedWords,
    bannedPatterns: filterConfig.bannedPatterns 
  });
});

app.post('/api/moderation/words', (req, res) => {
  // Check admin key
  if (!ADMIN_KEY || req.body.key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { bannedWords, bannedPatterns } = req.body;

  // Update in memory
  filterConfig.bannedWords = bannedWords || filterConfig.bannedWords;
  filterConfig.bannedPatterns = bannedPatterns || filterConfig.bannedPatterns;

  // Save to config.json
  try {
    fs.writeFileSync('config.json', JSON.stringify(filterConfig, null, 2));
    console.log(`Updated filter: ${filterConfig.bannedWords.length} banned words`);
    res.json({ 
      success: true, 
      message: 'Word filter updated',
      wordCount: filterConfig.bannedWords.length 
    });
  } catch (err) {
    console.error('Failed to save config:', err);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

app.post('/api/admin', (req, res) => {
  // Check admin key
  if (!ADMIN_KEY || req.body.key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, value } = req.body;

  switch (action) {
    case 'reset':
      wCounter = 0;
      broadcast({ type: 'updateCount', count: wCounter });
      res.json({ success: true, count: wCounter, message: 'Counter reset to 0' });
      break;

    case 'set':
      if (typeof value === 'number' && value >= 0) {
        wCounter = value;
        broadcast({ type: 'updateCount', count: wCounter });
        res.json({ success: true, count: wCounter, message: `Counter set to ${value}` });
      } else {
        res.status(400).json({ error: 'Invalid value' });
      }
      break;

    case 'pause':
      isPaused = Boolean(value);
      broadcast({ type: 'paused', paused: isPaused });
      res.json({ success: true, paused: isPaused, message: isPaused ? 'Counter paused' : 'Counter resumed' });
      break;

    case 'celebrate':
      broadcast({ type: 'celebration' });
      res.json({ success: true, message: 'Celebration triggered!' });
      break;

    default:
      res.status(400).json({ error: 'Invalid action' });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (ADMIN_KEY) {
    console.log(`Admin panel: http://localhost:${PORT}/admin.html?key=${ADMIN_KEY}`);
  } else {
    console.log('Warning: No ADMIN_KEY set. Admin panel disabled.');
  }
});