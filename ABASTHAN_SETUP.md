# NEXORA WhatsApp Bot — Abasthan Node 20 Setup

## Host
Abasthan Free Node.js Web Service. Select Node.js 20 (or 22).

## Build command
```bash
npm install --omit=dev --no-audit --no-fund
```

## Start command
```bash
npm start
```

## Environment variables
```env
NEXORA_API_URL=https://nexora-api-shxf.onrender.com
WHATSAPP_BOT_SECRET=YOUR_LONG_RANDOM_SECRET
GROUP_JID=
MAX_STRIKES=3
WARN_ON_LINK=true
WELCOME_ENABLED=true
AI_API_URL=https://api.groq.com/openai/v1/chat/completions
AI_API_KEY=
AI_MODEL=llama-3.3-70b-versatile
BOT_OWNER_NUMBERS=
WA_KEEPALIVE_MS=15000
WA_CONNECT_TIMEOUT_MS=60000
WA_QUERY_TIMEOUT_MS=60000
```

## Important
- Do NOT upload or commit the `auth/` directory containing a live WhatsApp session.
- The first start should generate a QR image at `data/whatsapp-qr.png`.
- Scan it from WhatsApp > Linked devices.
- Keep the server running while pairing.
- After pairing, make the linked WhatsApp account an admin in the NEXORA group so moderation can delete messages and remove members.
- Do not share the WhatsApp auth files or logs containing session credentials.

## Why this host setup
This bot uses a persistent WebSocket connection, so it needs a host that does not put the process to sleep.
