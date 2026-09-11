# NEXORA WhatsApp Community Assistant — HOKAS Node 18

This build is specifically prepared for HOKAS Node.js 18.x.

## IMPORTANT
- Upload/extract this ZIP so `package.json` is directly in `/home/container`.
- Do NOT leave the project inside another folder.
- Startup command: `bash start-bot.sh`
- The bot uses Baileys 6.7.7, which predates the Node 20 engine requirement added to later Baileys releases.
- Keep the `auth/` directory after the first successful WhatsApp pairing.

## Environment
Set these in HOKAS:

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

Do not put NEXORA member passwords, admin passwords, payment credentials, or WhatsApp PINs in this file.

### Full-size QR image
The bot now saves every newly generated WhatsApp QR as `data/whatsapp-qr.png`. The HOKAS console may make the text QR look too small or wrap it. Open `data/whatsapp-qr.png` in the HOKAS File Manager and scan that image instead. The image is refreshed whenever WhatsApp generates a new QR.


### HOKAS connection stability
This build prefers IPv4 and uses longer WhatsApp WebSocket timeouts to reduce connection drops on hosts with unstable IPv6 routing. Keep the existing `auth/` folder so the paired WhatsApp session is preserved.
