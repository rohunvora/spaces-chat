# Spaces Chat

A lightweight real-time chat companion for Twitter Spaces and livestreams.

## What it does

- **Real-time chat** - WebSocket-powered instant messaging
- **Zero friction** - Start chatting immediately, no signup required
- **OBS-ready** - Built-in widget mode for streaming overlays
- **Host controls** - Slow mode, emoji-only mode, pin messages (`?host=1`)
- **Mobile friendly** - Works great on phones while listening to Spaces

## Quick start

```bash
npm install
npm start
```

Visit `http://localhost:3000`

## For streamers

Add to OBS as a Browser Source:
```
https://your-site.com/widget.html?direction=up&max=25&chromakey=green
```

**OBS Settings (Industry Standard):**
- Width: `700`
- Height: `800`
- FPS: `30`
- Add Chroma Key filter → Green (#00FF00)
- Position: Bottom corner of stream

## Host mode

Access host controls at:
```
https://your-site.com?host=1
```

## Deploy

Works great on [Railway](https://railway.app) - just connect your GitHub repo and deploy.
