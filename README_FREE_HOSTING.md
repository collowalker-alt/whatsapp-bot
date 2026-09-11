# NEXORA WhatsApp Bot — free-hosting edition

This edition adds a tiny HTTP health server so the Node bot can be deployed on a platform that requires a web service, while the WhatsApp connection runs in the same process.

## Recommended no-cost route
If you need a truly always-on bot with persistent WhatsApp session storage and no monthly hosting fee, use an Always Free VM (for example Oracle Cloud Always Free) and run this folder with Docker. The VM keeps `auth/` and `data/` on disk.

## Quick VM deployment
1. Create an Always Free Ubuntu ARM/x86 VM with at least 1 GB RAM.
2. Install Docker and Git.
3. Copy this project to the VM.
4. Create `.env` from `.env.example`.
5. Set `NEXORA_API_URL` and `WHATSAPP_BOT_SECRET`.
6. Run:

```bash
docker build -t nexora-whatsapp-bot .
docker run -d --name nexora-whatsapp-bot --restart unless-stopped --env-file .env -v "$PWD/auth:/app/auth" -v "$PWD/data:/app/data" -p 3000:3000 nexora-whatsapp-bot
```

7. View the QR:

```bash
docker logs -f nexora-whatsapp-bot
```

8. Scan the QR using WhatsApp > Linked devices.

The `auth/` directory is mounted from the VM, so restarting the container does not unlink WhatsApp.

## If you prefer a simple web-service host
The bot also exposes `GET /health` and can be run as a web service. However, many free web hosts sleep services and/or use ephemeral storage, which can cause WhatsApp sessions to be lost. For that reason, a persistent free VM is safer for this specific bot.

## Security
Never commit `.env`, `auth/`, or `data/`. Keep `WHATSAPP_BOT_SECRET` private.
