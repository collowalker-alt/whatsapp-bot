# NEXORA WhatsApp Community Bot v2

A combined NEXORA community assistant + moderation bot.

## What it does

### 🛡️ Moderation
- Blocks links from regular members.
- Admins may post links.
- 1st link violation: delete + warning.
- 2nd link violation: delete + warning.
- 3rd link violation: delete + remove member.
- Persists strikes in `data/strikes.json`.
- Detects several common obfuscated URL formats.
- Basic promotional/flood spam protection.

### 👋 Welcome system
New members receive a NEXORA-branded welcome explaining the platform, Academy, referrals, Wallet, Support and the group link rule.

### 🤖 NEXORA Assistant
The bot understands the verified NEXORA knowledge base covering:
- Dashboard functions
- Packages and tier-based commission eligibility
- Direct referrals and Level 2
- Referral Analytics
- Marketing Center
- Community
- Notifications
- NEXORA Academy
- Leaderboard
- Challenges/Achievements
- Wallet and withdrawals
- Transactions
- Support Center
- Profile & Security
- Community rules

It answers common questions from a built-in FAQ. Optional AI can answer natural-language NEXORA questions using an OpenAI-compatible API. The AI is explicitly instructed not to invent prices, balances, payment status, commissions or guarantees.

### 📢 Admin tools
- `/nexora` or `/menu` — assistant menu
- `/rules` — community rules
- `/announce <message>` — official announcement
- `/broadcast <message>` — admin announcement alias
- `/stats` — moderation status
- `/strikes @member` — inspect member strikes
- `/clearstrike @member` — clear strikes

Admin commands require WhatsApp group-admin status or a number listed in `BOT_OWNER_NUMBERS`.

## Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set `GROUP_JID` to the NEXORA WhatsApp group ID after the first run. You can initially leave it blank to see all groups and their IDs.
4. Optional: set `AI_API_KEY` for natural-language AI answers. The default endpoint is Groq's OpenAI-compatible endpoint; change `AI_API_URL`/`AI_MODEL` for another provider.
5. Run:

```bash
npm install
npm start
```

6. Scan the QR code using WhatsApp > Linked devices.
7. Make the bot account a **group administrator**. Deleting other members' group messages and removing participants requires appropriate admin rights; Baileys documents group message deletion and participant management. See the current project documentation: https://github.com/WhiskeySockets/Baileys

## AI configuration

Example `.env`:

```env
AI_API_URL=https://api.groq.com/openai/v1/chat/completions
AI_API_KEY=YOUR_KEY
AI_MODEL=llama-3.3-70b-versatile
```

If no AI key is configured, the bot still works with its verified NEXORA FAQ/knowledge base.

## Security

- Never commit `.env` or `auth/`.
- The `auth/` directory contains the linked WhatsApp session credentials.
- Do not put NEXORA admin credentials or member passwords in the bot.
- Do not let the AI answer private account questions unless you later add authenticated NEXORA API integration.

## Accuracy policy

The assistant must not promise income, guaranteed profits or risk-free returns. It should say when verified information is unavailable and direct members to NEXORA Support/an administrator.

## Important architecture note

This version is a WhatsApp community assistant, not a private NEXORA account portal. It can explain NEXORA features but does not currently read a member's private balance, package status, withdrawal status or account records. If you want that later, add an authenticated NEXORA API integration rather than exposing private data through a public WhatsApp command.

## WhatsApp library note

This project uses Baileys, an unofficial WhatsApp Web library. It is not an official WhatsApp product. Use it responsibly and comply with applicable WhatsApp terms and policies.

## Live NEXORA member account access

This version supports an explicit, one-time WhatsApp account-linking flow.

### Bot environment
Add these variables to `.env`:

```env
NEXORA_API_URL=https://nexora-api-shxf.onrender.com
WHATSAPP_BOT_SECRET=<the-same-long-random-secret-used by nexora-api>
```

### How members link
1. Sign in to NEXORA.
2. Open **Profile & Security → Connect WhatsApp**.
3. Generate the 6-digit one-time code.
4. Open a **private chat** with the bot and send `/link 123456`.
5. The code expires after 10 minutes and can only be used once.

### Private account commands
After linking:

- `/account` — account summary
- `/balance` — available/pending/earned/withdrawn balances
- `/package` — current package
- `/referrals` — direct and Level 2 counts
- `/withdrawals` — recent withdrawal requests/statuses
- `/transactions` — recent transactions
- `/unlink` — remove the WhatsApp link

Account information is intentionally **not** returned inside the public WhatsApp group. The bot uses a server-to-server secret to call the NEXORA API and never asks members for their NEXORA password or M-Pesa PIN.

### Important security
- Keep `WHATSAPP_BOT_SECRET` private.
- Do not commit `.env` or the `auth/` folder.
- Use a dedicated WhatsApp number for the bot where practical.
- The bot is a community integration, not an official Meta WhatsApp Business API integration.
