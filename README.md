<div align="center">
  <img src="/.github/social-preview.png" alt="spaces-chat" width="800" />
  <p><strong>Real-time chat overlay for Twitter Spaces and livestreams with OBS integration.</strong></p>
</div>

# Spaces Chat

**Real-time chat overlay for Twitter Spaces and livestreams with OBS integration.**

Turn any livestream into an interactive experience with zero-friction chat that viewers can join instantly. Built specifically for streamers who need a lightweight, OBS-ready chat widget that works seamlessly with browser sources and chroma key effects.

## What it does

- **OBS-ready widget** - Drop into any streaming setup as a browser source with chroma key support
- **Zero friction chat** - Viewers start chatting immediately, no signup or login required  
- **Host controls** - Slow mode, emoji-only mode, message pinning for stream moderation
- **Mobile optimized** - Perfect for Twitter Spaces listeners chatting on their phones
- **Real-time WebSocket** - Instant message delivery with SQLite persistence

## For streamers

Add to OBS as a Browser Source:
```
https://your-site.com/widget.html?direction=up&max=25&chromakey=green
```

**Recommended OBS settings:**
- Width: `700`
- Height: `800` 
- FPS: `30`
- Add Chroma Key filter → Green (#00FF00)
- Position: Bottom corner of stream

## Host controls

Access moderation tools at:
```
https://your-site.com?host=1
```

Features:
- **Slow mode** - Rate limit messages
- **Emoji-only mode** - Text-free chat periods
- **Pin messages** - Highlight important viewer comments
- **Message moderation** - Remove inappropriate content

## Quick setup

```bash
git clone https://github.com/yourusername/spaces-chat
cd spaces-chat
npm install
npm start
```

Visit `http://localhost:3000` to test locally.

## Deploy

**Railway (recommended):**
1. Connect your GitHub repo to [Railway](https://railway.app)
2. Deploy automatically with zero config
3. Use the generated URL for your OBS browser source

**Environment variables:**
```bash
PORT=3000
NODE_ENV=production
```

## Tech stack

- **Backend:** Node.js + Express + WebSocket
- **Database:** SQLite with better-sqlite3
- **Frontend:** Vanilla JavaScript (no frameworks)
- **Deployment:** Railway-optimized with nixpacks

## Widget customization

URL parameters for the widget:
- `direction=up|down` - Message scroll direction
- `max=25` - Maximum visible messages
- `chromakey=green` - Background color for chroma key

Example:
```
/widget.html?direction=down&max=15&chromakey=blue
```

---

**Perfect for:** Twitter Spaces hosts, Twitch streamers, YouTube live creators, podcast recordings, virtual events