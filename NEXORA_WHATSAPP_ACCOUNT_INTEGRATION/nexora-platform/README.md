# NEXORA — Real Member Platform Upgrade

NEXORA is structured as a member workspace plus an administrator console. The member experience now includes dashboard intelligence, package comparison, progressive package-earning rules, referral analytics, a marketing center, QR sharing, Academy lessons, leaderboard, monthly challenges and achievements, wallet/transactions, support tickets, profile/security controls and payment recovery visibility.

## Member platform rules
- Starter is eligible for Starter package purchases.
- Growth is eligible for Starter + Growth purchases.
- Pro is eligible for Starter + Growth + Pro purchases.
- Elite is eligible for Starter + Growth + Pro + Elite purchases.
- Premium is eligible for Starter + Growth + Pro + Elite + Premium purchases.
- The commission amount comes from the package purchased by the referral.
- A package upgrade charges only the price difference.
- The member UI must describe commissions as eligibility/recorded commissions, never guaranteed income.

## New platform areas
1. Dashboard: profile strength, monthly progress, activity and sharing.
2. Achievements: first connection, network builder, consistent promoter and community leader.
3. Leaderboard: top recorded referral commissions, first-name display only.
4. Marketing Center: referral link, QR code, share actions and ready-to-share messages.
5. Referral Analytics: conversion, direct/Level 2 network and monthly commission metrics.
6. Smart notifications: surfaced through dashboard state, payment records and support status.
7. Monthly Challenges: activity goals that do not promise earnings.
8. NEXORA Academy: short lessons on platform use, marketing and safety.
9. Help & Support: member support tickets plus WhatsApp support.
10. Payment Center: transaction history and pending-payment checking.
11. Profile Strength: completeness meter and security checklist.
12. Security Center: update profile and change password.

## Admin
Admin tools include users, balance correction, payment repair, withdrawals, package configuration, activity/audit log and CSV exports.

## Deployment
Frontend and backend are deployed from the same repository. The Render build generates the Prisma client before building the Vite client. The backend creates/updates required additive database columns/tables at startup so the Free Render plan does not require Shell access.

Frontend settings:
- Root Directory: blank
- Build Command: `npm install --prefix client && npm run build --prefix client`
- Publish Directory: `client/dist`
- `VITE_API_URL=https://nexora-api-shxf.onrender.com/api`
- SPA rewrite: `/*` → `/index.html`

Backend required environment variables remain in `.env.example`.

## Important production note
Before taking real money at scale, review the referral/membership model with appropriate Kenyan legal, tax, payments and consumer-protection professionals. Keep package benefits and commission rules transparent and avoid guaranteed-income claims.

## NEXORA Real Platform additions

This build includes a public marketing website, responsive member workspace, profile card, visual referral network map, notification center, Community & Updates feed, configurable admin announcements, NEXORA Academy, achievements, challenges, leaderboard, referral analytics, marketing center, support tickets, security center, membership comparison, package upgrade rules, CSV exports, payment repair, balance correction, audit logging and a PWA install shell.

### Public pages
- `/` — NEXORA public landing page with login/register modal
- `/terms` — Terms of Service summary
- `/privacy` — Privacy Policy summary
- `/membership` — Membership & Referral Rules summary
- `/admin` — Administrator console

### Member experience
The member navigation includes Dashboard, Packages, My Referrals, Analytics, Marketing Center, Community, Notifications, NEXORA Academy, Leaderboard, Challenges, Wallet, Transactions, Help & Support and Security.

### Package earning hierarchy
Starter can earn from Starter purchases; Growth from Starter + Growth; Pro from Starter + Growth + Pro; Elite from Starter + Growth + Pro + Elite; Premium from all five. Eligibility is determined by the package `tier`, not merely by package price.

### Important deployment note
The package uses Prisma generation during the root build and also creates/repairs selected support, announcement, admin-audit and package-settings database structures at API startup. Keep `DATABASE_URL`, `JWT_SECRET`, Paystack keys and the admin environment variables configured on the Render API service.

### Responsible platform language
NEXORA UI intentionally avoids guaranteed-income claims. Referral commissions are described as recorded platform outcomes subject to package eligibility and qualifying purchases. Before taking real money at scale, have the membership, referral, payment, consumer-protection and tax model reviewed for the jurisdictions in which NEXORA operates.

## WhatsApp member account integration

The NEXORA WhatsApp Community Assistant can securely read a member's account after the member explicitly links WhatsApp from **Profile & Security → Connect WhatsApp**.

### Backend environment variable
Set this on the `nexora-api` Render Web Service:

```env
WHATSAPP_BOT_SECRET=<long-random-secret>
```

Use the same secret in the WhatsApp bot's `.env`. Never put this secret in the frontend or commit it to GitHub.

### Member flow
1. Member signs in to NEXORA.
2. Open **Profile & Security → Connect WhatsApp**.
3. Generate the one-time 6-digit code.
4. In a private chat with the NEXORA WhatsApp Assistant, send `/link CODE`.
5. The bot can then read account information only in that private chat.

The bot never receives or asks for the member's NEXORA password or M-Pesa PIN. Account information is deliberately blocked in the public WhatsApp group.
