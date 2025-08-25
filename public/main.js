// Username improvement: Moved username to header for better UX
// Previously, the name input was in the composer area which made it:
// 1. Easy to accidentally change while typing messages
// 2. Cluttered the message composition area
// 3. Unclear when the name was actually being used
// Now users see "Chatting as: [Name]" in the header with clear change option

let ws = null;
let isHost = false;
let userName = '';
let reconnectAttempts = 0;
let reconnectTimeout = null;
let slowModeTimeout = null;
let currentSlowMode = 0;
let isEmojiOnly = false;
let hasScrolledUp = false;
let hasSetName = false;
let typingTimeout = null;
let lastTypingEmit = 0;
let replyingTo = null;

const urlParams = new URLSearchParams(window.location.search);
isHost = urlParams.get('host') === '1';

const elements = {
  status: document.getElementById('status'),
  reconnectBanner: document.getElementById('reconnectBanner'),
  messageList: document.getElementById('messageList'),
  userDisplay: document.getElementById('userDisplay'),
  changeNameBtn: document.getElementById('changeNameBtn'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  charCount: document.getElementById('charCount'),
  hostBar: document.getElementById('hostBar'),
  slowRange: document.getElementById('slowRange'),
  slowValue: document.getElementById('slowValue'),
  emojiOnlyCheck: document.getElementById('emojiOnlyCheck'),
  pinBtn: document.getElementById('pinBtn'),
  resetBtn: document.getElementById('resetBtn'),
  pinnedMessage: document.getElementById('pinnedMessage'),
  pinnedText: document.getElementById('pinnedText'),
  rulesBtn: document.getElementById('rulesBtn'),
  rulesDialog: document.getElementById('rulesDialog'),
  closeRulesBtn: document.getElementById('closeRulesBtn'),
  nameDialog: document.getElementById('nameDialog'),
  nameDialogInput: document.getElementById('nameDialogInput'),
  saveNameBtn: document.getElementById('saveNameBtn'),
  cancelNameBtn: document.getElementById('cancelNameBtn'),
  toastContainer: document.getElementById('toastContainer'),
  typingIndicator: document.getElementById('typingIndicator'),
  typingText: document.getElementById('typingText'),
  userCount: document.getElementById('userCount')
};

if (isHost) {
  elements.hostBar.style.display = 'block';
}

// Initialize username on page load
const savedName = localStorage.getItem('chatName');
if (savedName) {
  userName = savedName;
  hasSetName = true;
  elements.userDisplay.textContent = `Chatting as: ${savedName}`;
} else {
  // Generate guest name
  userName = `Guest-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
  elements.userDisplay.textContent = userName;
}

function showToast(message, duration = 3000) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    reconnectAttempts = 0;
    elements.status.textContent = '● LIVE';
    elements.status.className = 'status live';
    elements.reconnectBanner.style.display = 'none';
    
    // Load saved name on every reconnect or generate a guest name
    const savedName = localStorage.getItem('chatName');
    if (savedName) {
      userName = savedName;
      hasSetName = true;
      elements.userDisplay.textContent = `Chatting as: ${userName}`;
    } else if (!userName) {
      // Only generate guest name if we don't have one yet
      userName = `Guest-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
      elements.userDisplay.textContent = userName;
    }
    
    // Send the actual userName
    ws.send(JSON.stringify({
      type: 'hello',
      name: userName,
      host: isHost
    }));
  };
  
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error('Message parse error:', err);
    }
  };
  
  ws.onclose = () => {
    console.log('WebSocket closed');
    elements.status.textContent = '● OFFLINE';
    elements.status.className = 'status offline';
    elements.reconnectBanner.style.display = 'block';
    
    clearTimeout(reconnectTimeout);
    const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts), 10000);
    reconnectAttempts++;
    
    reconnectTimeout = setTimeout(() => {
      connectWebSocket();
    }, delay);
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'system':
      if (msg.mode) {
        currentSlowMode = msg.mode.slow;
        isEmojiOnly = msg.mode.emojiOnly;
        
        if (isHost) {
          elements.slowRange.value = currentSlowMode;
          elements.slowValue.textContent = `${currentSlowMode}s`;
          elements.emojiOnlyCheck.checked = isEmojiOnly;
        }
      }
      
      if (msg.pinned) {
        elements.pinnedMessage.style.display = msg.pinned ? 'block' : 'none';
        elements.pinnedText.textContent = msg.pinned;
      }
      
      if (msg.messages) {
        msg.messages.forEach(m => addMessageToList(m));
      }
      
      if (msg.userCount !== undefined) {
        elements.userCount.textContent = msg.userCount;
      }
      break;
      
    case 'msg':
      addMessageToList(msg);
      break;
      
    case 'pin':
      elements.pinnedMessage.style.display = msg.text ? 'block' : 'none';
      elements.pinnedText.textContent = msg.text;
      break;
      
    case 'reset':
      elements.messageList.innerHTML = '';
      break;
      
    case 'delete':
      const msgEl = document.querySelector(`[data-msg-id="${msg.id}"]`);
      if (msgEl) msgEl.remove();
      break;
      
    case 'error':
      showToast(msg.message);
      break;
      
    case 'typing':
      updateTypingIndicator(msg.users);
      break;
      
    case 'userCount':
      elements.userCount.textContent = msg.count;
      break;
  }
}

function addMessageToList(msg) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message';
  messageEl.setAttribute('data-msg-id', msg.id);
  
  const time = new Date(msg.ts).toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  
  const userColor = getUserColor(msg.name);
  
  messageEl.innerHTML = `
    <span class="message-name" style="color: ${userColor}">${escapeHtml(msg.name)}</span>
    <span class="message-time">${time}</span>
    <button class="reply-btn" data-id="${msg.id}" data-name="${escapeHtml(msg.name)}" data-text="${escapeHtml(msg.text)}">↵</button>
    ${isHost ? `<button class="delete-btn" data-id="${msg.id}">×</button>` : ''}
    <div class="message-text">${escapeHtml(msg.text)}</div>
  `;
  
  elements.messageList.appendChild(messageEl);
  
  if (!hasScrolledUp) {
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getUserColor(name) {
  // Generate consistent color from username
  // Using a set of readable colors that work on white background
  const colors = [
    '#e11d48', // rose-600
    '#dc2626', // red-600
    '#ea580c', // orange-600
    '#ca8a04', // yellow-600
    '#16a34a', // green-600
    '#059669', // emerald-600
    '#0891b2', // cyan-600
    '#2563eb', // blue-600
    '#7c3aed', // violet-600
    '#c026d3', // fuchsia-600
    '#db2777', // pink-600
    '#0f766e', // teal-700
    '#7c2d12', // orange-900
    '#1e40af', // blue-800
    '#6b21a8', // purple-800
  ];
  
  // Simple hash function to get consistent index
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return colors[Math.abs(hash) % colors.length];
}

function updateTypingIndicator(users) {
  const otherUsers = users.filter(u => u !== userName);
  
  if (otherUsers.length === 0) {
    elements.typingIndicator.style.display = 'none';
    return;
  }
  
  let text = '';
  if (otherUsers.length === 1) {
    text = `${otherUsers[0]} is typing...`;
  } else if (otherUsers.length === 2) {
    text = `${otherUsers[0]} and ${otherUsers[1]} are typing...`;
  } else {
    text = `${otherUsers.length} people are typing...`;
  }
  
  elements.typingText.textContent = text;
  elements.typingIndicator.style.display = 'block';
}

function emitTyping(isTyping) {
  const now = Date.now();
  // Throttle typing emissions to every 500ms
  if (isTyping && now - lastTypingEmit < 500) {
    return;
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'typing',
      isTyping: isTyping
    }));
    lastTypingEmit = now;
  }
}

function setReplyingTo(msgId, name, text) {
  replyingTo = { id: msgId, name: name, text: text };
  
  // Create and show reply preview
  const existingPreview = document.querySelector('.reply-preview');
  if (existingPreview) {
    existingPreview.remove();
  }
  
  const previewEl = document.createElement('div');
  previewEl.className = 'reply-preview';
  previewEl.innerHTML = `
    <div class="reply-preview-content">
      <div class="reply-preview-label">Replying to <span style="color: ${getUserColor(name)}">${escapeHtml(name)}</span></div>
      <div class="reply-preview-text">${escapeHtml(text.substring(0, 50))}${text.length > 50 ? '...' : ''}</div>
    </div>
    <button class="reply-cancel" onclick="cancelReply()">×</button>
  `;
  
  elements.messageInput.parentElement.insertBefore(previewEl, elements.messageInput);
  elements.messageInput.focus();
}

function cancelReply() {
  replyingTo = null;
  const preview = document.querySelector('.reply-preview');
  if (preview) {
    preview.remove();
  }
}

window.cancelReply = cancelReply;

function sendMessage() {
  const text = elements.messageInput.value.trim();
  
  // Prompt for name on first message if still using guest name
  if (!hasSetName && userName.startsWith('Guest-')) {
    elements.nameDialog.showModal();
    elements.nameDialogInput.focus();
    // Store the message to send after name is set
    elements.messageInput.setAttribute('data-pending-message', text);
    return;
  }
  
  if (!text) {
    return;
  }
  
  if (text.length > 240) {
    showToast('Message too long (max 240 characters)');
    return;
  }
  
  if (/https?:\/\//i.test(text)) {
    showToast('Links are not allowed');
    return;
  }
  
  if (isEmojiOnly && !/^[\p{Emoji}\s]+$/u.test(text)) {
    showToast('Emoji-only mode is enabled');
    return;
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    const messageData = {
      type: 'msg',
      text: text
    };
    
    if (replyingTo) {
      messageData.replyTo = replyingTo;
    }
    
    ws.send(JSON.stringify(messageData));
    
    // Clear reply after sending
    cancelReply();
    
    elements.messageInput.value = '';
    
    // Clear typing indicator
    if (typingTimeout) {
      clearTimeout(typingTimeout);
      emitTyping(false);
    }
    updateCharCount();
    
    if (currentSlowMode > 0) {
      elements.sendBtn.disabled = true;
      let remaining = currentSlowMode;
      
      slowModeTimeout = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          elements.sendBtn.textContent = `Wait ${remaining}s`;
        } else {
          clearInterval(slowModeTimeout);
          elements.sendBtn.disabled = false;
          elements.sendBtn.textContent = 'Send';
        }
      }, 1000);
    }
  } else {
    showToast('Not connected to server');
  }
}

function updateCharCount() {
  const length = elements.messageInput.value.length;
  elements.charCount.textContent = `${length}/240`;
  elements.charCount.className = length > 200 ? 'char-count warning' : 'char-count';
}

elements.messageInput.addEventListener('input', (e) => {
  updateCharCount();
  
  // Handle typing indicator
  if (e.target.value.trim()) {
    emitTyping(true);
    
    // Clear existing timeout
    if (typingTimeout) {
      clearTimeout(typingTimeout);
    }
    
    // Set new timeout to stop typing
    typingTimeout = setTimeout(() => {
      emitTyping(false);
    }, 1500);
  } else if (typingTimeout) {
    clearTimeout(typingTimeout);
    emitTyping(false);
  }
});

elements.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

elements.sendBtn.addEventListener('click', sendMessage);

elements.messageList.addEventListener('scroll', () => {
  const scrollBottom = elements.messageList.scrollHeight - elements.messageList.clientHeight - elements.messageList.scrollTop;
  hasScrolledUp = scrollBottom > 50;
});

elements.messageList.addEventListener('click', (e) => {
  if (e.target.classList.contains('delete-btn') && isHost) {
    const id = e.target.getAttribute('data-id');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'delete',
        id: id
      }));
    }
  } else if (e.target.classList.contains('reply-btn')) {
    const id = e.target.getAttribute('data-id');
    const name = e.target.getAttribute('data-name');
    const text = e.target.getAttribute('data-text');
    setReplyingTo(id, name, text);
  }
});

if (isHost) {
  elements.slowRange.addEventListener('input', () => {
    const value = elements.slowRange.value;
    elements.slowValue.textContent = `${value}s`;
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'setMode',
        slow: parseInt(value),
        emojiOnly: elements.emojiOnlyCheck.checked
      }));
    }
  });
  
  elements.emojiOnlyCheck.addEventListener('change', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'setMode',
        slow: parseInt(elements.slowRange.value),
        emojiOnly: elements.emojiOnlyCheck.checked
      }));
    }
  });
  
  elements.pinBtn.addEventListener('click', () => {
    const text = prompt('Enter message to pin (leave empty to unpin):');
    if (text !== null && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'pin',
        text: text
      }));
    }
  });
  
  elements.resetBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all messages?')) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'reset'
        }));
      }
    }
  });
}

elements.rulesBtn.addEventListener('click', () => {
  elements.rulesDialog.showModal();
});

elements.closeRulesBtn.addEventListener('click', () => {
  elements.rulesDialog.close();
});

// Name change functionality
elements.changeNameBtn.addEventListener('click', () => {
  elements.nameDialogInput.value = hasSetName ? userName : '';
  elements.nameDialog.showModal();
  elements.nameDialogInput.focus();
  elements.nameDialogInput.select();
});

elements.saveNameBtn.addEventListener('click', () => {
  const newName = elements.nameDialogInput.value.trim();
  if (newName && newName !== userName) {
    userName = newName;
    hasSetName = true;
    localStorage.setItem('chatName', userName);
    elements.userDisplay.textContent = `Chatting as: ${userName}`;
    
    // Update server with new name
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'hello',
        name: userName,
        host: isHost
      }));
    }
    
    // Check if there was a pending message to send
    const pendingMessage = elements.messageInput.getAttribute('data-pending-message');
    if (pendingMessage) {
      elements.messageInput.removeAttribute('data-pending-message');
      // Send the message after a brief delay to ensure name is registered
      setTimeout(() => sendMessage(), 100);
    }
  }
  elements.nameDialog.close();
});

elements.cancelNameBtn.addEventListener('click', () => {
  elements.nameDialog.close();
});

// Allow Enter to save name in dialog
elements.nameDialogInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    elements.saveNameBtn.click();
  }
});

connectWebSocket();