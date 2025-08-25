const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  path: '/ws'
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
const messageBuffer = [];
const MAX_BUFFER_SIZE = 200;
let messageIdCounter = 1;

const state = {
  pinned: '',
  slow: 0,
  emojiOnly: false
};

function isEmojiOnly(text) {
  const emojiRegex = /^[\p{Emoji}\s]+$/u;
  return emojiRegex.test(text);
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, '');
}

function broadcast(message, exclude = null) {
  const messageStr = JSON.stringify(message);
  clients.forEach(client => {
    if (client !== exclude && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(messageStr);
    }
  });
}

function addMessage(msg) {
  messageBuffer.push(msg);
  if (messageBuffer.length > MAX_BUFFER_SIZE) {
    messageBuffer.shift();
  }
}

wss.on('connection', (ws) => {
  const client = {
    ws,
    name: 'Guest',
    lastSentAt: 0,
    isHost: false
  };
  
  clients.add(client);
  
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
          client.name = stripHtml(msg.name || 'Guest').substring(0, 30);
          client.isHost = Boolean(msg.host);
          
          ws.send(JSON.stringify({
            type: 'system',
            mode: {
              slow: state.slow,
              emojiOnly: state.emojiOnly
            },
            pinned: state.pinned,
            messages: messageBuffer
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
          
          addMessage(message);
          broadcast(message);
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
          
          messageBuffer.length = 0;
          broadcast({
            type: 'reset'
          });
          break;
          
        case 'delete':
          if (!client.isHost) return;
          
          const index = messageBuffer.findIndex(m => m.id === msg.id);
          if (index !== -1) {
            messageBuffer.splice(index, 1);
            broadcast({
              type: 'delete',
              id: msg.id
            });
          }
          break;
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });
  
  ws.on('close', () => {
    clearInterval(pingInterval);
    clients.delete(client);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});