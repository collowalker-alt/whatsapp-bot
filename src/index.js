import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import dns from 'node:dns';

// HOKAS can have unstable IPv6 routing; prefer IPv4 for WhatsApp WebSockets.
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const ROOT = process.cwd();
const AUTH_DIR = path.join(ROOT, 'auth');
const STRIKES_FILE = path.resolve(process.env.STRIKES_FILE || './data/strikes.json');
const STATE_FILE = path.resolve(process.env.STATE_FILE || './data/bot-state.json');
const GROUP_JID = (process.env.GROUP_JID || '').trim();
const MAX_STRIKES = Math.max(1, Number.parseInt(process.env.MAX_STRIKES || '3', 10) || 3);
const WARN_ON_LINK = String(process.env.WARN_ON_LINK ?? 'true').toLowerCase() !== 'false';
const WELCOME_ENABLED = String(process.env.WELCOME_ENABLED ?? 'true').toLowerCase() !== 'false';
const AI_API_URL = (process.env.AI_API_URL || '').trim();
const AI_API_KEY = (process.env.AI_API_KEY || '').trim();
const AI_MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const AI_TIMEOUT_MS = Math.max(5000, Number(process.env.AI_TIMEOUT_MS || 20000));
const AI_MAX_TOKENS = Math.max(100, Number(process.env.AI_MAX_TOKENS || 500));
const NEXORA_API_URL = (process.env.NEXORA_API_URL || '').trim().replace(/\/$/, '');
const WHATSAPP_BOT_SECRET = (process.env.WHATSAPP_BOT_SECRET || '').trim();
const OWNER_NUMBERS = new Set((process.env.BOT_OWNER_NUMBERS || '').split(',').map(x => x.replace(/\D/g, '')).filter(Boolean));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = Math.max(1, Number(process.env.PORT || 3000));
const QR_IMAGE_FILE = path.resolve(process.env.QR_IMAGE_FILE || './data/whatsapp-qr.png');
const QR_VIEW_KEY = (process.env.QR_VIEW_KEY || '').trim();
const WA_KEEPALIVE_MS = Math.max(10000, Number(process.env.WA_KEEPALIVE_MS || 15000));
const WA_CONNECT_TIMEOUT_MS = Math.max(30000, Number(process.env.WA_CONNECT_TIMEOUT_MS || 60000));
const WA_QUERY_TIMEOUT_MS = Math.max(30000, Number(process.env.WA_QUERY_TIMEOUT_MS || 60000));

fs.mkdirSync(path.dirname(STRIKES_FILE), { recursive: true });
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
let strikes = readJson(STRIKES_FILE, {});
let state = readJson(STATE_FILE, { welcomed: {}, spam: {}, lastAi: {} });
function saveStrikes() { fs.writeFileSync(STRIKES_FILE, JSON.stringify(strikes, null, 2)); }
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

const LINK_RE = /(?:https?:\/\/|http:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|net|org|co|ke|io|app|dev|me|ly|gg|biz|info|xyz|site|online|store|shop|tech|cloud)(?:[/:?#][^\s]*)?)/iu;
const OBFUSCATED_LINK_RE = /(?:hxxps?:\/\/|hxxp:\/\/|www\s*\.\s*|\b(?:[a-z0-9-]+\s*\[?dot\]?\s*)+(?:com|net|org|co|ke|io|app|dev|me|ly|gg)\b)/iu;
const SPAM_RE = /(.)\1{8,}|(?:free money|guaranteed profit|double your money|investment opportunity|send usdt|send crypto|dm me for profit|airdrop now)/iu;
function hasLink(text='') { return LINK_RE.test(text) || OBFUSCATED_LINK_RE.test(text); }
function unwrapMessage(message) { if (!message) return null; return message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message.documentWithCaptionMessage?.message || message; }
function messageText(message) { const m=unwrapMessage(message); if(!m)return ''; return [m.conversation,m.extendedTextMessage?.text,m.imageMessage?.caption,m.videoMessage?.caption,m.documentMessage?.caption,m.buttonsResponseMessage?.selectedDisplayText,m.listResponseMessage?.title,m.templateButtonReplyMessage?.selectedDisplayText].filter(Boolean).join('\n'); }
function isGroup(jid) { return typeof jid === 'string' && jid.endsWith('@g.us'); }
function isAdmin(p) { return p?.admin === 'admin' || p?.admin === 'superadmin'; }
function senderJid(key) { return key?.participantAlt || key?.participant || key?.remoteJid; }
function numberOf(jid='') { return jid.split('@')[0].split(':')[0]; }
function shortJid(jid='') { return numberOf(jid); }
function mentionName(metadata, jid) { const p=metadata?.participants?.find(x=>x.id===jid); return p?.notify || p?.name || `@${shortJid(jid)}`; }
function groupAllowed(jid) { return isGroup(jid) && (!GROUP_JID || GROUP_JID === jid); }


function isPrivateChat(jid='') { return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')); }
function privateIdentity(msg) {
  const key=msg?.key||{};
  const jid=key.remoteJid || '';
  const alt=key.remoteJidAlt || '';
  const participantAlt=key.participantAlt || '';
  const candidates=[alt,participantAlt,jid].filter(Boolean);
  const phoneJid=candidates.find(x=>String(x).endsWith('@s.whatsapp.net')) || '';
  return { jid, phone: phoneJid ? numberOf(phoneJid) : '' };
}
async function nexoraApi(path, body) {
  if(!NEXORA_API_URL || !WHATSAPP_BOT_SECRET) return { ok:false, status:503, data:{message:'NEXORA account integration is not configured on the bot.'} };
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const r=await fetch(`${NEXORA_API_URL}${path}`, { method:'POST', headers:{'Content-Type':'application/json','x-whatsapp-bot-secret':WHATSAPP_BOT_SECRET}, body:JSON.stringify(body), signal:controller.signal });
    const data=await r.json().catch(()=>({message:'Invalid API response'}));
    return {ok:r.ok,status:r.status,data};
  } catch(err) {
    logger.warn({err:String(err),path},'NEXORA account API unavailable');
    return {ok:false,status:503,data:{message:'NEXORA account service is temporarily unavailable. Please try again shortly.'}};
  } finally { clearTimeout(timer); }
}
function moneyKsh(n) { return `KSh ${Number(n||0).toLocaleString()}`; }
function accountIntro(a) {
  return `👤 *NEXORA Account*\n\n*${a.user.name}*\nPackage: *${a.package?.name||'No active package'}*\nAvailable balance: *${moneyKsh(a.wallet.balance)}*\nPending balance: *${moneyKsh(a.wallet.pendingBalance)}*\nTotal earned: *${moneyKsh(a.wallet.totalEarned)}*\nTotal withdrawn: *${moneyKsh(a.wallet.totalWithdrawn)}*\nDirect referrals: *${a.referrals.direct}*\nLevel 2 network: *${a.referrals.level2}*`;
}
async function linkedAccount(msg) {
  const identity=privateIdentity(msg);
  if(!isPrivateChat(identity.jid)) return {error:'🔒 Account information is private. Please message the NEXORA WhatsApp Assistant directly, not in the group.'};
  const r=await nexoraApi('/api/whatsapp/account',identity);
  if(!r.ok) return {error:r.data?.message||'Unable to load your NEXORA account.'};
  return {account:r.data,identity};
}

const KNOWLEDGE = `
NEXORA is a membership and referral community platform focused on connecting members, learning, referrals, community activity, wallet/withdrawal tools and support. NEXORA uses the phrase "Connect. Grow. Learn." The assistant must never promise income, guaranteed profit or risk-free returns.

MEMBER DASHBOARD FUNCTIONS:
- Dashboard/Overview: shows available balance, total earned, direct referrals, Level 2 referrals, package, referral marketing, recent activity, profile strength and monthly progress. Members can open their package and share their NEXORA referral link.
- Packages: compare active packages, see price, commission information, features and withdrawal limits, and upgrade when eligible. Package tiers control which purchased-package commissions a member can earn from.
- My Referrals: shows direct referrals and Level 2 referrals and a visual referral tree.
- Referral Analytics: shows direct members, Level 2 members, paid referrals, conversion, direct commissions, Level 2 commissions and monthly activity.
- Marketing Center: personal referral link, sharing tools, QR code, ready-to-share messages and referral best-practice guidance.
- Community: NEXORA announcements and community information.
- Notifications: account/platform notices and smart notifications.
- NEXORA Academy: learning area with lessons and progress tracking.
- Leaderboard: community ranking based on recorded commissions; it is not a promise of future earnings.
- Challenges/Achievements: community goals and achievement progress.
- Wallet: available balance, pending balance, withdrawal tools and withdrawal history/status.
- Transactions: transaction history, including package/payment and withdrawal-related records.
- Support Center: create support tickets and access support/WhatsApp contact options.
- Profile & Security: update profile, change password and review security checklist.
- Instructions: explains how to use the platform.
- Logout: securely ends the member session.

PACKAGE EARNING RULES:
- Starter: eligible for commissions from Starter purchases.
- Growth: eligible for commissions from Starter + Growth purchases.
- Pro: eligible for commissions from Starter + Growth + Pro purchases.
- Elite: eligible for commissions from Starter + Growth + Pro + Elite purchases.
- Premium: eligible for commissions from Starter + Growth + Pro + Elite + Premium purchases.
The commission amount is determined by the package purchased by the referral. Eligibility depends on the member's package tier and applicable program rules.

REFERRALS:
Direct = a person directly referred by the member. Level 2 = a referral made by someone in the member's direct referral network, subject to the program rules. Members should use their personal referral link from Marketing Center. Referral activity does not guarantee commissions.

WITHDRAWALS:
Current member-facing minimum withdrawal is KSh 100. Members submit a withdrawal request from Wallet using a valid Kenyan phone number. The system moves the requested amount from available balance to pending balance while the request is reviewed. Withdrawals are reviewed/processed by an administrator. The bot must not claim that it has sent money or that a withdrawal is paid unless an integrated system explicitly confirms it.

COMMUNITY RULES:
Regular members are not allowed to post links in the official NEXORA WhatsApp group. Group admins may post links. A blocked link receives a strike; the default policy is 3 strikes then removal. No spam, scams, abusive behavior, unsolicited promotions or misleading income claims.

SUPPORT:
If the bot does not have verified information for a question, it should say so and direct the member to NEXORA Support/an administrator rather than inventing an answer.

IMPORTANT LIMITATION:
Some older NEXORA frontend builds have client-side free counters for the first 3 publishes/edits/downloads; secure enforcement must be performed by the backend. The WhatsApp bot should describe features without claiming that a free allowance has been consumed unless connected to the live NEXORA API.
`;

const FAQ = [
  [/^\/?(help|menu|nexora|commands)$/i, () => menuText()],
  [/how.*nexora|what.*nexora|nexora.*work/i, () => `🚀 *How NEXORA works*\n\nNEXORA is built around membership, referrals, learning, community activity, wallet tools and support. Your dashboard gives you access to Packages, Referrals, Analytics, Marketing, Academy, Wallet, Transactions, Support and Profile & Security.\n\nNEXORA does not guarantee income. Eligibility and recorded commissions depend on the applicable program rules and member activity.`],
  [/package|starter|growth|pro|elite|premium/i, () => `💎 *NEXORA Packages*\n\nStarter → Starter commissions\nGrowth → Starter + Growth\nPro → Starter + Growth + Pro\nElite → Starter + Growth + Pro + Elite\nPremium → Starter + Growth + Pro + Elite + Premium\n\nThe package tier determines which purchased-package commissions you are eligible for. Ask an administrator for the current package prices if you need the latest configured amounts.`],
  [/referral|level ?2|direct referral/i, () => `🤝 *Referrals*\n\nDirect = someone you personally refer.\nLevel 2 = someone referred by a person in your direct referral network.\n\nUse *Marketing Center* in your NEXORA dashboard to copy/share your personal referral link, generate a QR code and access ready-to-share messages. Referral activity does not guarantee earnings.`],
  [/withdraw|cash ?out|wallet/i, () => `💸 *Withdrawals*\n\nMinimum withdrawal: *KSh 100*.\n\nOpen *Wallet*, enter the amount and valid Kenyan phone number, then submit the request. The requested amount becomes pending while an administrator reviews/processes it.\n\nI cannot truthfully mark a withdrawal as paid unless the connected NEXORA system confirms it.`],
  [/academy|lesson|learn/i, () => `📚 *NEXORA Academy*\n\nAcademy contains NEXORA learning lessons and tracks your completion progress. Open *Academy* from the member menu to learn how the platform and community work.`],
  [/support|help me|problem|issue/i, () => `🆘 *NEXORA Support*\n\nOpen *Support Center* in your dashboard to create a support ticket or use the available support/WhatsApp contact option. If you send me a question I can verify from my NEXORA knowledge base, I'll answer it here.`],
  [/link|links|group rule|rules/i, () => `🛡️ *NEXORA Group Rule*\n\nRegular members may not post links in this official group. Admins are allowed to post links.\n\nThe Link Guard uses a 3-strike policy by default; the third link violation results in removal.`]
];
function menuText() { return `🚀 *NEXORA COMMUNITY ASSISTANT*\n\nAsk me things like:\n\n• How does NEXORA work?\n• Explain the packages\n• How do referrals work?\n• What is Level 2?\n• How do I withdraw?\n• What is NEXORA Academy?\n• How do I contact support?\n• What does the Wallet button do?\n\nAdmin controls:\n• /announce <message>\n• /rules\n• /stats\n• /strikes @member\n• /clearstrike @member\n• /broadcast <message>\n\nI only provide verified NEXORA information. I do not guarantee income or profits.`; }
function rulesText() { return `🛡️ *NEXORA COMMUNITY RULES*\n\n1. Respect every member.\n2. No spam or scams.\n3. No unsolicited promotions.\n4. Regular members may not post links.\n5. Admins may post official/approved links.\n6. No misleading income or guaranteed-profit claims.\n7. Use NEXORA Support for account-specific issues.\n\n🚫 Link violations: 3 strikes = removal.`; }

function findFaq(text) { for (const [re, fn] of FAQ) if (re.test(text)) return fn(); return null; }

async function askAI(question, context='') {
  if (!AI_API_URL || !AI_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const system = `You are the official NEXORA Community Assistant for a WhatsApp group. Answer only from the verified knowledge below. Do not invent prices, commission amounts, payment addresses, transaction status, account balances, eligibility, or support outcomes. If the knowledge does not contain the answer, say: "I don't have verified information for that yet. Please contact NEXORA Support/an administrator." Never promise profit or guaranteed income. Keep WhatsApp answers concise, friendly and professional.\n\nVERIFIED KNOWLEDGE:\n${KNOWLEDGE}`;
  try {
    const r = await fetch(AI_API_URL, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${AI_API_KEY}`}, body:JSON.stringify({model:AI_MODEL,messages:[{role:'system',content:system},{role:'user',content:`${context}\n\nQUESTION: ${question}`}],temperature:0.15,max_tokens:AI_MAX_TOKENS}), signal:controller.signal });
    if (!r.ok) throw new Error(`AI ${r.status}`);
    const d = await r.json();
    const answer = d.choices?.[0]?.message?.content?.trim();
    return answer || null;
  } catch (err) { logger.warn({err:String(err)}, 'AI answer unavailable'); return null; }
  finally { clearTimeout(timer); }
}

async function getGroup(sock, jid) { const metadata=await sock.groupMetadata(jid); return { metadata, admins:new Set(metadata.participants.filter(isAdmin).map(p=>p.id)), botIsAdmin:metadata.participants.some(p=>isAdmin(p)&&numberOf(p.id)===numberOf(sock.user?.id||'')) }; }
function isOwner(jid) { return OWNER_NUMBERS.has(numberOf(jid)); }
async function isGroupAdmin(sock, jid, sender) { try { const g=await getGroup(sock,jid); return g.admins.has(sender) || isOwner(sender); } catch { return isOwner(sender); } }

async function sendWelcome(sock, jid, participants) {
  if (!WELCOME_ENABLED || !groupAllowed(jid)) return;
  const g = await getGroup(sock,jid).catch(()=>null);
  for (const participant of participants || []) {
    const key=`${jid}:${participant}`;
    if (state.welcomed[key]) continue;
    state.welcomed[key]=Date.now();
    saveState();
    const name = g ? mentionName(g.metadata,participant) : `@${shortJid(participant)}`;
    await sock.sendMessage(jid,{text:`🚀 *Welcome to NEXORA, ${name}!*

*Connect. Grow. Learn.*

💎 Explore your NEXORA membership
🤝 Learn about referrals
📚 Use NEXORA Academy
💰 Understand packages and commissions
💼 Explore Wallet & Transactions
🆘 Use Support Center when you need help

🛡️ Please follow the group rules. Regular members may not post links.

Type */nexora* anytime and I can help with NEXORA questions.`,mentions:[participant]}).catch(()=>{});
  }
}

async function moderate(sock,msg) {
  const jid=msg.key.remoteJid; if(!groupAllowed(jid)||msg.key.fromMe)return;
  const text=messageText(msg.message); if(!text)return;
  const sender=senderJid(msg.key); if(!sender)return;
  const g=await getGroup(sock,jid).catch(()=>null); if(!g)return;
  const participant=g.metadata.participants.find(p=>p.id===sender);
  if (hasLink(text)) {
    if (isAdmin(participant)) return;
    if (!g.botIsAdmin) { await sock.sendMessage(jid,{text:'⚠️ NEXORA Link Guard detected a link, but the bot needs group-admin rights to remove it.'}).catch(()=>{}); return; }
    const key=`${jid}:${sender}`; strikes[key]=Number(strikes[key]||0)+1; const count=strikes[key]; saveStrikes();
    try { await sock.sendMessage(jid,{delete:msg.key}); } catch(err) { logger.error({err:String(err)},'Failed to delete link'); return; }
    if(count>=MAX_STRIKES){ await sock.sendMessage(jid,{text:`🚫 @${shortJid(sender)} has reached ${MAX_STRIKES} link violations and has been removed from the NEXORA group.`,mentions:[sender]}).catch(()=>{}); await sock.groupParticipantsUpdate(jid,[sender],'remove').catch(()=>{}); delete strikes[key]; saveStrikes(); return; }
    if(WARN_ON_LINK){ const remaining=MAX_STRIKES-count; await sock.sendMessage(jid,{text:`⚠️ @${shortJid(sender)} links are not allowed in the NEXORA group.\n\nStrike ${count}/${MAX_STRIKES}. ${remaining} ${remaining===1?'violation':'violations'} remaining before removal.`,mentions:[sender]}).catch(()=>{}); }
    return;
  }
  if(SPAM_RE.test(text) && !isAdmin(participant)) {
    const key=`${jid}:${sender}`; const now=Date.now(); const prev=state.spam[key]||0;
    if(now-prev<15000){ state.spam[key]=now; saveState(); if(g.botIsAdmin){ await sock.sendMessage(jid,{delete:msg.key}).catch(()=>{}); await sock.sendMessage(jid,{text:`⚠️ @${shortJid(sender)} please avoid repeated promotional/spam messages.`,mentions:[sender]}).catch(()=>{}); } return; }
    state.spam[key]=now; saveState();
  }
}

async function handleCommand(sock,msg) {
  const jid=msg.key.remoteJid; if(msg.key.fromMe)return false;
  const text=messageText(msg.message).trim(); if(!text.startsWith('/')) return false;
  const [raw,...rest]=text.split(/\s+/); const cmd=raw.toLowerCase(); const arg=rest.join(' ').trim();
  const privateCommands=new Set(['/link','/account','/balance','/package','/referrals','/withdrawals','/transactions','/unlink']);
  if(!isPrivateChat(jid) && !groupAllowed(jid)) return false;
  if(isPrivateChat(jid) && !privateCommands.has(cmd)) return false;
  const sender=senderJid(msg.key); const admin=isGroup(jid)?await isGroupAdmin(sock,jid,sender):false;
  if(cmd==='/link'){
    if(!isPrivateChat(jid)){await sock.sendMessage(jid,{text:'🔒 WhatsApp account linking must be completed in a private chat with me. Open a private chat and send: /link YOUR-CODE'});return true;}
    if(!/^\d{6}$/.test(arg)){await sock.sendMessage(jid,{text:'🔗 Usage: /link 123456\n\nGenerate the one-time code from NEXORA → Profile & Security → Connect WhatsApp.'});return true;}
    const identity=privateIdentity(msg); const r=await nexoraApi('/api/whatsapp/link/verify',{code:arg,whatsappJid:identity.jid,whatsappPhone:identity.phone});
    await sock.sendMessage(jid,{text:r.ok?`✅ *WhatsApp linked successfully*\n\nWelcome, ${r.data.user.name}. I can now securely read your NEXORA account information in this private chat.\n\nTry: /account, /balance, /package, /referrals, /withdrawals or /transactions\n\n🔐 I will never ask for your NEXORA password or M-Pesa PIN.`:`❌ ${r.data?.message||'Unable to link this WhatsApp account.'}`});
    return true;
  }
  if(['/account','/balance','/package','/referrals','/withdrawals','/transactions','/unlink'].includes(cmd)){
    if(!isPrivateChat(jid)){await sock.sendMessage(jid,{text:'🔒 Account information is private. Please message the NEXORA WhatsApp Assistant directly to use that command.'});return true;}
    if(cmd==='/unlink'){
      const identity=privateIdentity(msg); const r=await nexoraApi('/api/whatsapp/unlink',identity); await sock.sendMessage(jid,{text:r.ok?'✅ Your WhatsApp account has been unlinked from NEXORA.':'❌ '+(r.data?.message||'Unable to unlink your WhatsApp account.')}); return true;
    }
    const result=await linkedAccount(msg);
    if(result.error){await sock.sendMessage(jid,{text:`❌ ${result.error}

To link your account, open NEXORA → Profile & Security → Connect WhatsApp, generate a code, then send /link CODE here.`});return true;}
    const a=result.account;
    if(cmd==='/account'){await sock.sendMessage(jid,{text:accountIntro(a)});return true;}
    if(cmd==='/balance'){await sock.sendMessage(jid,{text:`💰 *NEXORA Wallet*\n\nAvailable: *${moneyKsh(a.wallet.balance)}*\nPending: *${moneyKsh(a.wallet.pendingBalance)}*\nTotal earned: *${moneyKsh(a.wallet.totalEarned)}*\nTotal withdrawn: *${moneyKsh(a.wallet.totalWithdrawn)}*`});return true;}
    if(cmd==='/package'){await sock.sendMessage(jid,{text:`💎 *Your NEXORA Package*\n\nPackage: *${a.package?.name||'No active package'}*\n${a.package?`Package price: *${moneyKsh(a.package.price)}*\nTier: *${a.package.tier}*`: 'You do not currently have an active package.'}`});return true;}
    if(cmd==='/referrals'){await sock.sendMessage(jid,{text:`🤝 *Your NEXORA Network*\n\nDirect referrals: *${a.referrals.direct}*\nLevel 2 network: *${a.referrals.level2}*\n\nReferral activity does not guarantee commissions.`});return true;}
    if(cmd==='/withdrawals'){const rows=a.withdrawals||[];await sock.sendMessage(jid,{text:`💸 *Recent Withdrawals*\n\n${rows.length?rows.map(x=>`• ${x.reference} — ${moneyKsh(x.amount)} — *${x.status}* — ${new Date(x.createdAt).toLocaleDateString()}`).join('\n'):'No withdrawal requests found.'}`});return true;}
    if(cmd==='/transactions'){const rows=a.transactions||[];await sock.sendMessage(jid,{text:`🧾 *Recent Transactions*\n\n${rows.length?rows.map(x=>`• ${x.type.replaceAll('_',' ')} — ${moneyKsh(x.amount)} — *${x.status}* — ${new Date(x.createdAt).toLocaleDateString()}`).join('\n'):'No transactions found.'}`});return true;}
  }
  if(cmd==='/nexora'||cmd==='/help'||cmd==='/menu'){ await sock.sendMessage(jid,{text:menuText()}); return true; }
  if(cmd==='/rules'){ await sock.sendMessage(jid,{text:rulesText()}); return true; }
  if(cmd==='/announce'||cmd==='/broadcast'){
    if(!admin){await sock.sendMessage(jid,{text:'🔒 Admin-only command.'});return true;}
    if(!arg){await sock.sendMessage(jid,{text:`Usage: ${cmd} <message>`});return true;}
    await sock.sendMessage(jid,{text:`📢 *NEXORA OFFICIAL ANNOUNCEMENT*\n\n${arg}\n\n— NEXORA Community Team`}); return true;
  }
  if(cmd==='/stats'){
    if(!admin){await sock.sendMessage(jid,{text:'🔒 Admin-only command.'});return true;}
    const count=Object.entries(strikes).filter(([k,v])=>k.startsWith(`${jid}:`)&&Number(v)>0).length;
    await sock.sendMessage(jid,{text:`🛡️ *NEXORA MODERATION STATS*\n\nMembers with active strikes: ${count}\nMaximum strikes: ${MAX_STRIKES}\nLink policy: members blocked / admins allowed\nAI assistant: ${AI_API_KEY?'enabled':'knowledge-base mode'}`}); return true;
  }
  if(cmd==='/strikes'||cmd==='/clearstrike'){
    if(!admin){await sock.sendMessage(jid,{text:'🔒 Admin-only command.'});return true;}
    const target=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || arg.replace(/\D/g,'')+'@s.whatsapp.net';
    const key=`${jid}:${target}`;
    if(cmd==='/strikes'){await sock.sendMessage(jid,{text:`🛡️ @${shortJid(target)} has ${Number(strikes[key]||0)}/${MAX_STRIKES} link strikes.`,mentions:[target]});}
    else {delete strikes[key];saveStrikes();await sock.sendMessage(jid,{text:`✅ Cleared link strikes for @${shortJid(target)}.`,mentions:[target]});}
    return true;
  }
  return false;
}

async function answerQuestion(sock,msg) {
  const jid=msg.key.remoteJid; if(!groupAllowed(jid)||msg.key.fromMe)return;
  const text=messageText(msg.message).trim(); if(!text||text.startsWith('/'))return;
  if(hasLink(text))return;
  // Respond only when the message looks like a question or explicitly names NEXORA/bot topics.
  const lower=text.toLowerCase(); const relevant=/\b(nexora|package|starter|growth|pro|elite|premium|referral|level\s*2|commission|withdraw|wallet|academy|support|dashboard|marketing|transaction|leaderboard|challenge|security|balance|earn)\b/i.test(text) || /\?$/.test(text);
  if(!relevant)return;
  const faq=findFaq(text);
  if(faq){ await sock.sendMessage(jid,{text:faq}); return; }
  const now=Date.now(); const sender=senderJid(msg.key); const key=`${jid}:${sender}`; if(now-(state.lastAi[key]||0)<12000)return; state.lastAi[key]=now; saveState();
  const answer=await askAI(text); if(answer) await sock.sendMessage(jid,{text:`🤖 *NEXORA Assistant*\n\n${answer}`}); else await sock.sendMessage(jid,{text:`🤖 *NEXORA Assistant*\n\nI don't have verified information for that yet. Please contact NEXORA Support or an administrator so you receive an accurate answer.`});
}

async function listGroups(sock) {
  try { const groups=await sock.groupFetchAllParticipating(); console.log('\n=== NEXORA COMMUNITY BOT: GROUPS ==='); for(const g of Object.values(groups).sort((a,b)=>String(a.subject).localeCompare(String(b.subject)))){const me=g.participants?.find(p=>numberOf(p.id)===numberOf(sock.user?.id||'')); console.log(`${g.subject||'(unnamed)'} -> ${g.id} ${isAdmin(me)?'[BOT ADMIN]':'[BOT NOT ADMIN]'}`);} console.log('======================================\n'); } catch(err){logger.warn({err:String(err)},'Could not list groups');}
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({ok:true,service:'nexora-whatsapp-bot',time:new Date().toISOString()}));
      return;
    }
    if (url.pathname === '/qr') {
      if (QR_VIEW_KEY && url.searchParams.get('key') !== QR_VIEW_KEY) {
        res.writeHead(403, {'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({ok:false,message:'QR access denied'}));
        return;
      }
      if (!fs.existsSync(QR_IMAGE_FILE)) {
        res.writeHead(404, {'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
        res.end('<!doctype html><html><body style="font-family:system-ui;background:#07090d;color:#f4fbff;padding:32px"><h2>NEXORA WhatsApp QR</h2><p>No QR code is currently available. Check the Abasthan logs and try again.</p></body></html>');
        return;
      }
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>NEXORA WhatsApp QR</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#07090d;color:#f4fbff;font-family:system-ui,sans-serif"><main style="width:min(92vw,560px);text-align:center;background:#111722;border:1px solid #26384d;border-radius:18px;padding:22px;box-sizing:border-box"><h2 style="margin:0 0 8px">NEXORA WhatsApp QR</h2><p style="margin:0 0 18px;color:#aebdca">Open WhatsApp → Linked devices → Link a device, then scan this QR.</p><img src="/qr-image${QR_VIEW_KEY ? `?key=${encodeURIComponent(QR_VIEW_KEY)}` : ''}" alt="WhatsApp pairing QR code" style="display:block;width:min(100%,500px);height:auto;margin:auto;background:white;border-radius:12px"><p style="font-size:13px;color:#8fa0af;margin:16px 0 0">Keep this page private. Anyone who can scan the QR can link a WhatsApp account to the bot.</p></main></body></html>`;
      res.writeHead(200, {'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
      res.end(html);
      return;
    }
    if (url.pathname === '/qr-image') {
      if (QR_VIEW_KEY && url.searchParams.get('key') !== QR_VIEW_KEY) {
        res.writeHead(403, {'content-type':'text/plain','cache-control':'no-store'});
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(QR_IMAGE_FILE)) {
        res.writeHead(404, {'content-type':'text/plain','cache-control':'no-store'});
        res.end('QR not available');
        return;
      }
      res.writeHead(200, {'content-type':'image/png','cache-control':'no-store','x-content-type-options':'nosniff'});
      fs.createReadStream(QR_IMAGE_FILE).pipe(res);
      return;
    }
    res.writeHead(404, {'content-type':'application/json'});
    res.end(JSON.stringify({ok:false,message:'Not found'}));
  });
  server.listen(PORT, '0.0.0.0', () => logger.info({port:PORT}, 'Health server listening'));
}

async function start(){
  const {state:authState,saveCreds}=await useMultiFileAuthState(AUTH_DIR); let version; try{({version}=await fetchLatestBaileysVersion())}catch{version=undefined;}
  const sock=makeWASocket({auth:authState,version,logger,printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false,generateHighQualityLinkPreview:false,keepAliveIntervalMs:WA_KEEPALIVE_MS,connectTimeoutMs:WA_CONNECT_TIMEOUT_MS,defaultQueryTimeoutMs:WA_QUERY_TIMEOUT_MS,retryRequestDelayMs:2000});
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async({connection,lastDisconnect,qr})=>{
    if(qr){
      console.log('\nScan this QR code with the WhatsApp account that will run NEXORA Community Bot:\n');
      qrcode.generate(qr,{small:true});
      try {
        fs.mkdirSync(path.dirname(QR_IMAGE_FILE), { recursive: true });
        await QRCode.toFile(QR_IMAGE_FILE, qr, { type:'png', width:900, margin:4, errorCorrectionLevel:'M' });
        logger.info({file:QR_IMAGE_FILE}, 'Full-size WhatsApp QR image saved');
        console.log(`\nFULL-SIZE QR IMAGE SAVED: ${QR_IMAGE_FILE}\nOpen https://YOUR-ABASTHAN-DOMAIN/qr in a browser and scan it from your phone.`);
      } catch(err) {
        logger.warn({err:String(err)}, 'Could not save QR image');
      }
    }
    if(connection==='open'){console.log('\n✅ NEXORA Community Bot connected and ready.');console.log(`Group restriction: ${GROUP_JID||'ALL GROUPS WHERE BOT IS ADMIN'}`);console.log(`Policy: member links blocked; admins allowed; ${MAX_STRIKES} strikes = removal.`);console.log(`AI: ${AI_API_KEY?'enabled':'verified knowledge-base mode'}`);console.log('Commands: /nexora /rules /stats /announce /strikes /clearstrike\n');await listGroups(sock);}
    if(connection==='close'){const code=lastDisconnect?.error?.output?.statusCode;const shouldReconnect=code!==DisconnectReason.loggedOut;logger.warn({code,shouldReconnect},'WhatsApp connection closed');if(shouldReconnect){ const delay=code===DisconnectReason.connectionClosed || code===DisconnectReason.timedOut ? 5000 : 3000; setTimeout(start,delay); }else console.error('❌ WhatsApp session logged out. Delete auth/ and link the account again.');}
  });
  sock.ev.on('group-participants.update',async({id,participants,action})=>{if(action==='add')await sendWelcome(sock,id,participants).catch(err=>logger.warn({err:String(err)},'Welcome failed'));});
  sock.ev.on('messages.upsert',async({messages,type})=>{if(type!=='notify')return;for(const msg of messages){try{if(await handleCommand(sock,msg))continue;await moderate(sock,msg);await answerQuestion(sock,msg);}catch(err){logger.error({err:String(err)},'Message handling error');}}});
}
process.on('uncaughtException',err=>logger.error({err:String(err)},'Uncaught exception'));
process.on('unhandledRejection',err=>logger.error({err:String(err)},'Unhandled rejection'));
startHealthServer();

start().catch(err=>{console.error(err);process.exit(1);});
