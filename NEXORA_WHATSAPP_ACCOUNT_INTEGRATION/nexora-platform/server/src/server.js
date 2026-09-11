import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";

dotenv.config();
const prisma = new PrismaClient();
const app = express();

// FIX 1: Helmet was blocking cross-origin fetches — disable resource policy
app.use(helmet({ crossOriginResourcePolicy: false }));

// FIX 2: Allow ALL origins (including your live frontend on Render)
// Previously you only allowed localhost:5173, which caused "Failed to fetch"
app.use(cors({ 
  origin: true,
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-paystack-signature"]
}));

app.post("/api/paystack/webhook",express.raw({type:"application/json"}),async(req,res)=>{
  try{
    if(!process.env.PAYSTACK_SECRET_KEY) return res.sendStatus(503);
    const signature=req.headers["x-paystack-signature"];
    const expected=crypto.createHmac("sha512",process.env.PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
    if(!signature || signature.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return res.sendStatus(401);
    const event=JSON.parse(req.body.toString());
    if(event.event==="charge.success" && event.data?.reference) await activatePaidPackage(event.data.reference);
    res.sendStatus(200);
  }catch(e){console.error(e);res.sendStatus(500);}
});

app.use(express.json({ limit: "100kb" }));
app.use("/api/auth", rateLimit({ windowMs: 15*60*1000, max: 100 }));

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const WHATSAPP_BOT_SECRET = String(process.env.WHATSAPP_BOT_SECRET || "").trim();

const sign = user => jwt.sign({ id:user.id }, JWT_SECRET, { expiresIn:"7d" });
const auth = async (req,res,next) => {
  try {
    const token=(req.headers.authorization||"").replace("Bearer ","");
    if(!token) return res.status(401).json({message:"Authentication required"});
    const p=jwt.verify(token,JWT_SECRET);
    const u=await prisma.user.findUnique({where:{id:p.id}});
    if(!u || u.status!=="ACTIVE") return res.status(401).json({message:"Account unavailable"});
    req.user=u; next();
  } catch { res.status(401).json({message:"Invalid or expired session"}); }
};
const signAdmin = admin => jwt.sign({ id:admin.id, type:"admin" }, JWT_SECRET, { expiresIn:"12h" });
const adminAuth = async (req,res,next) => {
  try {
    const token=(req.headers.authorization||"").replace("Bearer ","");
    if(!token) return res.status(401).json({message:"Admin authentication required"});
    const p=jwt.verify(token,JWT_SECRET);
    if(p.type!=="admin") return res.status(403).json({message:"Admin access required"});
    const a=await prisma.admin.findUnique({where:{id:p.id}});
    if(!a || a.status!=="ACTIVE") return res.status(401).json({message:"Admin account unavailable"});
    req.admin=a; next();
  } catch { res.status(401).json({message:"Invalid or expired admin session"}); }
};

async function logAdminAction(req, action, targetType=null, targetId=null, targetEmail=null, details={}){
  try{
    await prisma.adminActivityLog.create({data:{adminId:req.admin.id,adminEmail:req.admin.email,action,targetType,targetId,targetEmail,details}});
  }catch(e){ console.error("[ADMIN AUDIT]",e.message); }
}

const PHONE_RE=/^(?:07\d{8}|011\d{7}|2547\d{8}|2541\d{8})$/;
const cleanPhone=v=>String(v||"").trim().replace(/[\s().-]/g,"").replace(/^\+/,"");
// Paystack's M-Pesa charge endpoint requires the international +254 format.
const paystackPhone=v=>{
  const n=cleanPhone(v);
  if(/^07\d{8}$/.test(n)) return `+254${n.slice(1)}`;
  if(/^011\d{7}$/.test(n)) return `+254${n.slice(1)}`;
  if(/^254[17]\d{8}$/.test(n)) return `+${n}`;
  return n;
};
const maskPhone=v=>{
  const n=String(v||"");
  return n.length>=7 ? `${n.slice(0,4)}****${n.slice(-3)}` : "***";
};
const maskEmail=v=>{
  const e=String(v||"");
  const [name,domain]=e.split("@");
  if(!domain) return "***";
  return `${(name||"").slice(0,2)}***@${domain}`;
};

async function ensureWhatsAppLinkTable(){
  try{
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS whatsapp_account_links (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        whatsapp_jid TEXT NOT NULL UNIQUE,
        whatsapp_phone TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT whatsapp_account_links_user_fk FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS whatsapp_account_links_phone_idx ON whatsapp_account_links(whatsapp_phone)`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS whatsapp_link_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT whatsapp_link_codes_user_fk FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS whatsapp_link_codes_user_idx ON whatsapp_link_codes(user_id)`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS whatsapp_link_codes_expiry_idx ON whatsapp_link_codes(expires_at)`);
  }catch(e){ console.error("[WHATSAPP] Unable to ensure link tables:",e.message); }
}

function requireWhatsAppBot(req,res,next){
  if(!WHATSAPP_BOT_SECRET) return res.status(503).json({message:"WhatsApp account integration is not configured"});
  const supplied=String(req.headers["x-whatsapp-bot-secret"]||"");
  if(!supplied || supplied.length!==WHATSAPP_BOT_SECRET.length || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(WHATSAPP_BOT_SECRET))) return res.status(401).json({message:"Unauthorized WhatsApp integration request"});
  next();
}
const whatsappCodeHash=code=>crypto.createHash("sha256").update(String(code)).digest("hex");
const whatsappCode=()=>String(crypto.randomInt(100000,1000000));
function privateWhatsappOnly(req,res,next){
  const jid=String(req.body?.whatsappJid||"");
  if(!jid || !/^(?:\d+|\d+:[^@]+)@(s\.whatsapp\.net|lid)$/.test(jid)) return res.status(400).json({message:"A private WhatsApp account JID is required"});
  next();
}

const paystackMode=()=>{
  const key=process.env.PAYSTACK_SECRET_KEY||"";
  return key.startsWith("sk_live_")?"live":key.startsWith("sk_test_")?"test":"unknown";
};
const logPaystackCharge=(label,{reference,httpStatus,response,phone,email}={})=>{
  const data=response?.data||{};
  console.log(`[PAYSTACK ${label}]`,JSON.stringify({
    reference,
    mode:paystackMode(),
    httpStatus,
    apiStatus:response?.status??null,
    message:response?.message||null,
    chargeStatus:data.status||null,
    displayText:data.display_text||null,
    gatewayResponse:data.gateway_response||null,
    channel:data.channel||null,
    currency:data.currency||null,
    amount:data.amount??null,
    paystackReference:data.reference||null,
    paystackId:data.id||null,
    phone:maskPhone(phone),
    email:maskEmail(email)
  }));
};
const makeCode = name => (name.replace(/[^a-z0-9]/gi,"").slice(0,5).toUpperCase() || "USER")+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();

// FIX 3: Health checks so / and /api don't return "Cannot GET"
app.get("/", (req,res) => res.json({ ok: true, name: "NEXORA API", version: "1.0" }));
app.get("/api", (req,res) => res.json({ ok: true, name: "NEXORA API", version: "1.0" }));
app.get("/api/health",(req,res)=>res.json({ok:true,name:"NEXORA API"}));

app.post("/api/auth/register", async (req,res)=>{
  try {
    const {name,email,phone,password,referralCode}=req.body;
    const normalizedPhone=cleanPhone(phone);
    if(!name||!email||!phone||!password) return res.status(400).json({message:"Name, email, phone and password are required"});
    if(password.length<8) return res.status(400).json({message:"Password must be at least 8 characters"});
    if(!PHONE_RE.test(normalizedPhone)) return res.status(400).json({message:"Invalid Kenyan phone number. Use 07…, 011…, 2547… or 2541…."});
    const exists=await prisma.user.findFirst({where:{OR:[{email:email.toLowerCase()},{phone:normalizedPhone}]}});
    if(exists) return res.status(409).json({message:"Email or phone is already registered"});
    let parent=null;
    if(referralCode) parent=await prisma.user.findUnique({where:{referralCode:referralCode.toUpperCase()}});
    const hash=await bcrypt.hash(password,12);
    const user=await prisma.user.create({data:{
      name,email:email.toLowerCase(),phone:normalizedPhone,passwordHash:hash,referralCode:makeCode(name),
      referredById:parent?.id,wallet:{create:{}}
    }});
    res.status(201).json({token:sign(user),user:{id:user.id,name:user.name,email:user.email,phone:user.phone,referralCode:user.referralCode}});
  } catch(e){ console.error(e); res.status(500).json({message:"Registration failed"}); }
});

app.post("/api/auth/login", async (req,res)=>{
  const {email,password}=req.body;
  const user=await prisma.user.findUnique({where:{email:(email||"").toLowerCase()}});
  if(!user || !(await bcrypt.compare(password||"",user.passwordHash))) return res.status(401).json({message:"Invalid login details"});
  if(user.status!=="ACTIVE") return res.status(403).json({message:"Account is suspended"});
  res.json({token:sign(user),user:{id:user.id,name:user.name,email:user.email,phone:user.phone,referralCode:user.referralCode}});
});

const DEFAULT_PACKAGES=[
  ["Starter",1,500,200,50],
  ["Growth",2,1000,400,150],
  ["Pro",3,1600,700,250],
  ["Elite",4,2200,900,300],
  ["Premium",5,4800,2000,500]
];
async function ensureAdmin(){
  const email=String(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
  const password=String(process.env.ADMIN_PASSWORD||"");
  const name=String(process.env.ADMIN_NAME||"NEXORA Administrator").trim()||"NEXORA Administrator";
  if(!email || !password){
    console.warn("ADMIN_EMAIL/ADMIN_PASSWORD are not set; admin account was not created or updated.");
    return;
  }
  if(password.length < 10){
    console.error("ADMIN_PASSWORD must be at least 10 characters; admin account was not created or updated.");
    return;
  }
  const passwordHash=await bcrypt.hash(password,12);
  await prisma.admin.upsert({
    where:{email},
    update:{name,passwordHash,status:"ACTIVE"},
    create:{name,email,passwordHash,status:"ACTIVE"}
  });
  console.log(`[ADMIN] Admin account ready: ${email}`);
}

async function ensurePackages(){
  for(const [name,tier,price,directCommission,level2Commission] of DEFAULT_PACKAGES){
    const existing=await prisma.package.findUnique({where:{name}});
    if(!existing) await prisma.package.create({data:{name,tier,price,directCommission,level2Commission,active:true}});
  }
}
app.get("/api/packages",async(req,res)=>{
  try{ await ensurePackages(); res.json(await prisma.package.findMany({where:{active:true},orderBy:{tier:"asc"}})); }
  catch(e){ console.error("Packages error:",e); res.status(500).json({message:"Unable to load packages. Please check the database setup."}); }
});

app.get("/api/me",auth,async(req,res)=>{
  const u=await prisma.user.findUnique({where:{id:req.user.id},include:{package:true,wallet:true}});
  const direct=await prisma.user.count({where:{referredById:u.id}});
  const level1=await prisma.user.findMany({where:{referredById:u.id},select:{id:true}});
  const level2=level1.length?await prisma.user.count({where:{referredById:{in:level1.map(x=>x.id)}}}):0;
  const tx=await prisma.transaction.findMany({where:{userId:u.id},orderBy:{createdAt:"desc"},take:10});
  res.json({user:{id:u.id,name:u.name,email:u.email,phone:u.phone,referralCode:u.referralCode},package:u.package,wallet:u.wallet,stats:{direct,level2},transactions:tx});
});

app.get("/api/referrals",auth,async(req,res)=>{
  try{
    const direct=await prisma.user.findMany({where:{referredById:req.user.id},orderBy:{createdAt:"desc"},select:{id:true,name:true,email:true,createdAt:true,package:true}});
    const ids=direct.map(x=>x.id);
    const level2=ids.length?await prisma.user.findMany({where:{referredById:{in:ids}},orderBy:{createdAt:"desc"},select:{id:true,name:true,email:true,createdAt:true,referredById:true,package:true}}):[];
    res.json({direct,level2});
  }catch(e){console.error(e);res.status(500).json({message:"Unable to load referrals"});}
});
app.get("/api/earnings",auth,async(req,res)=>{
  try{
    const rows=await prisma.commission.findMany({where:{receiverId:req.user.id},include:{sourceUser:{select:{name:true}}},orderBy:{createdAt:"desc"},take:100});
    res.json(rows);
  }catch(e){console.error(e);res.status(500).json({message:"Unable to load earnings"});}
});
app.get("/api/transactions",auth,async(req,res)=>{
  try{ const rows=await prisma.transaction.findMany({where:{userId:req.user.id},orderBy:{createdAt:"desc"},take:100}); res.json(rows); }
  catch(e){console.error(e);res.status(500).json({message:"Unable to load transactions"});}
});

app.post("/api/payments/initialize",auth,async(req,res)=>{
  const startedAt=Date.now();
  try {
    const {packageId,phone}=req.body;
    const normalizedPhone=cleanPhone(phone||req.user.phone);
    if(!PHONE_RE.test(normalizedPhone)) return res.status(400).json({message:"Invalid Kenyan phone number. Use 07…, 011…, 2547… or 2541…."});
    const pkg=await prisma.package.findUnique({where:{id:packageId}});
    if(!pkg||!pkg.active) return res.status(404).json({message:"Package not found"});
    const existingUser=await prisma.user.findUnique({where:{id:req.user.id},select:{packageId:true}});
    const currentPackage=existingUser?.packageId ? await prisma.package.findUnique({where:{id:existingUser.packageId}}) : null;
    if(currentPackage && currentPackage.id===pkg.id) return res.status(400).json({message:"You already have this package"});
    if(currentPackage && pkg.price<=currentPackage.price) return res.status(400).json({message:"You can only upgrade to a higher package"});
    const chargeAmount=currentPackage ? pkg.price-currentPackage.price : pkg.price;
    if(!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({message:"Paystack is not configured"});

    const reference=`NX-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const formattedPhone=paystackPhone(normalizedPhone);
    const payload={
      email:req.user.email,
      amount:chargeAmount*100,
      currency:"KES",
      mobile_money:{phone:formattedPhone,provider:"mpesa"},
      reference,
      metadata:{userId:req.user.id,packageId:pkg.id,chargeAmount,currentPackageId:currentPackage?.id||null}
    };

    console.log("[PAYSTACK INIT]",JSON.stringify({
      reference,mode:paystackMode(),packageId:pkg.id,package:pkg.name,amountKES:chargeAmount,
      phone:maskPhone(formattedPhone),email:maskEmail(req.user.email),startedAt:new Date().toISOString()
    }));

    const r=await fetch("https://api.paystack.co/charge",{
      method:"POST",
      headers:{"Authorization":`Bearer ${process.env.PAYSTACK_SECRET_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const data=await r.json().catch(()=>({status:false,message:"Paystack returned a non-JSON response"}));
    logPaystackCharge("INIT RESPONSE",{reference,httpStatus:r.status,response:data,phone:formattedPhone,email:req.user.email});

    if(!r.ok||!data.status){
      console.error("[PAYSTACK INIT ERROR]",JSON.stringify({reference,httpStatus:r.status,mode:paystackMode(),message:data.message||"Unknown Paystack error",response:data}));
      return res.status(400).json({
        message:data.message||"Unable to start M-Pesa payment",
        reference,
        paystack_http_status:r.status,
        paystack_status:data.data?.status||null,
        display_text:data.data?.display_text||""
      });
    }

    const chargeStatus=data.data?.status||"pending";
    const safePaystack={
      status:data.data?.status||null,
      display_text:data.data?.display_text||"",
      gateway_response:data.data?.gateway_response||null,
      channel:data.data?.channel||null,
      currency:data.data?.currency||"KES",
      amount:data.data?.amount??chargeAmount*100,
      reference:data.data?.reference||reference,
      id:data.data?.id||null,
      message:data.message||null,
      http_status:r.status,
      mode:paystackMode()
    };

    await prisma.transaction.create({data:{
      userId:req.user.id,type:"PACKAGE_PURCHASE",amount:chargeAmount,reference,status:"PENDING",
      metadata:{packageId:pkg.id,phone:normalizedPhone,chargeAmount,currentPackageId:currentPackage?.id||null,paystack:safePaystack,diagnostic:{initializedAt:new Date().toISOString(),responseMs:Date.now()-startedAt}}
    }});

    if(chargeStatus==="success") await activatePaidPackage(reference);
    else if(["failed","timeout"].includes(chargeStatus)) await prisma.transaction.update({where:{reference},data:{status:"FAILED"}});

    res.json({
      reference,
      status:chargeStatus,
      display_text:data.data?.display_text||"",
      message:data.message||"",
      paystack_http_status:r.status,
      paystack_status:chargeStatus,
      gateway_response:data.data?.gateway_response||"",
      paystack_mode:paystackMode(),
      chargeAmount
    });
  } catch(e){
    console.error("[PAYSTACK INIT EXCEPTION]",e);
    res.status(500).json({message:"Payment initialization failed"});
  }
});

async function activatePaidPackage(reference){
  const tx=await prisma.transaction.findUnique({where:{reference}});
  if(!tx || tx.status==="SUCCESS") return;
  const meta=tx.metadata||{};
  const packageId=meta.packageId;
  const pkg=await prisma.package.findUnique({where:{id:packageId}});
  if(!pkg) throw new Error("Package missing");
  await prisma.$transaction(async db=>{
    await db.transaction.update({where:{id:tx.id},data:{status:"SUCCESS"}});
    await db.user.update({where:{id:tx.userId},data:{packageId:pkg.id}});
    const buyer=await db.user.findUnique({where:{id:tx.userId}});
    if(!buyer?.referredById) return;
    // Commission is determined by the PACKAGE PURCHASED by the new member.
    // The upline can therefore earn when a referral purchases Starter, Growth, Pro, Elite or Premium.
    const parent=await db.user.findUnique({where:{id:buyer.referredById}});
    if(parent){
      // A member can earn from package purchases up to their own package tier.
      // Starter earns from Starter purchases; Growth earns from Starter + Growth;
      // Pro earns from Starter + Growth + Pro; and so on.
      if(!parent.packageId || (await db.package.findUnique({where:{id:parent.packageId}}))?.tier >= pkg.tier){
        const c1=pkg.directCommission;
        await db.commission.create({data:{receiverId:parent.id,sourceUserId:buyer.id,level:1,amount:c1,reference:`C1-${reference}` }});
        await db.wallet.update({where:{userId:parent.id},data:{balance:{increment:c1},totalEarned:{increment:c1}}});
      }
    }
    if(parent?.referredById){
      const grand=await db.user.findUnique({where:{id:parent.referredById}});
      const grandPkg=grand?.packageId ? await db.package.findUnique({where:{id:grand.packageId}}) : null;
      if(grand && grandPkg && grandPkg.tier >= pkg.tier){
        const c2=pkg.level2Commission;
        await db.commission.create({data:{receiverId:grand.id,sourceUserId:buyer.id,level:2,amount:c2,reference:`C2-${reference}` }});
        await db.wallet.update({where:{userId:grand.id},data:{balance:{increment:c2},totalEarned:{increment:c2}}});
      }
    }
  });
}

app.get("/api/payments/status/:reference",auth,async(req,res)=>{
  try{
    if(!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({message:"Paystack is not configured"});
    const tx=await prisma.transaction.findUnique({where:{reference:req.params.reference}});
    if(!tx || tx.userId!==req.user.id) return res.status(404).json({message:"Payment reference not found"});
    if(tx.status==="SUCCESS") return res.json({status:"success",display_text:"Payment confirmed. Your package is active."});

    const r=await fetch(`https://api.paystack.co/charge/${encodeURIComponent(req.params.reference)}`,{headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`}});
    const d=await r.json().catch(()=>({status:false,message:"Paystack returned a non-JSON response"}));
    logPaystackCharge("STATUS RESPONSE",{reference:req.params.reference,httpStatus:r.status,response:d,email:req.user.email});

    if(!r.ok || !d.status){
      console.error("[PAYSTACK STATUS ERROR]",JSON.stringify({reference:req.params.reference,httpStatus:r.status,mode:paystackMode(),message:d.message||"Unknown Paystack error",response:d}));
      return res.status(400).json({message:d.message||"Unable to check payment status",reference:req.params.reference,paystack_http_status:r.status});
    }

    const status=d.data?.status||"pending";
    const oldMeta=(tx.metadata&&typeof tx.metadata==="object")?tx.metadata:{};
    const oldPaystack=(oldMeta.paystack&&typeof oldMeta.paystack==="object")?oldMeta.paystack:{};
    await prisma.transaction.update({where:{reference:req.params.reference},data:{
      metadata:{...oldMeta,paystack:{...oldPaystack,status,display_text:d.data?.display_text||"",gateway_response:d.data?.gateway_response||null,channel:d.data?.channel||null,currency:d.data?.currency||"KES",amount:d.data?.amount??null,last_checked_at:new Date().toISOString(),http_status:r.status,mode:paystackMode()}}
    }});

    if(status==="success") await activatePaidPackage(req.params.reference);
    else if(["failed","timeout"].includes(status)) await prisma.transaction.update({where:{reference:req.params.reference},data:{status:"FAILED"}});

    res.json({
      status,
      display_text:d.data?.display_text||"",
      message:d.message||"",
      reference:req.params.reference,
      paystack_http_status:r.status,
      gateway_response:d.data?.gateway_response||"",
      paystack_mode:paystackMode()
    });
  }catch(e){console.error("[PAYMENT STATUS EXCEPTION]",e);res.status(500).json({message:"Payment status check failed"});}
});

// Kept for compatibility with older frontends. The Charge API endpoint above is the
// preferred status check for M-Pesa charges.
app.get("/api/payments/verify/:reference",auth,async(req,res)=>{
  try{
    if(!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({message:"Paystack is not configured"});
    const tx=await prisma.transaction.findUnique({where:{reference:req.params.reference}});
    if(!tx || tx.userId!==req.user.id) return res.status(404).json({message:"Payment reference not found"});
    const r=await fetch(`https://api.paystack.co/charge/${encodeURIComponent(req.params.reference)}`,{headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`}});
    const d=await r.json();
    if(!r.ok || !d.status) return res.status(400).json({message:d.message||"Unable to check payment status"});
    const status=d.data?.status||"pending";
    if(status==="success") await activatePaidPackage(req.params.reference);
    else if(status==="failed") await prisma.transaction.update({where:{reference:req.params.reference},data:{status:"FAILED"}});
    res.json({status,display_text:d.data?.display_text||"",message:d.message||"Charge attempted"});
  }catch(e){res.status(500).json({message:"Verification failed"});}
});

// -------------------- NEXORA ADMIN --------------------
app.post("/api/admin/auth/login", rateLimit({windowMs:15*60*1000,max:20}), async(req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const password=String(req.body?.password||"");
    const admin=await prisma.admin.findUnique({where:{email}});
    if(!admin || admin.status!=="ACTIVE" || !(await bcrypt.compare(password,admin.passwordHash))) return res.status(401).json({message:"Invalid admin login details"});
    res.json({token:signAdmin(admin),admin:{id:admin.id,name:admin.name,email:admin.email}});
  }catch(e){console.error("Admin login error:",e);res.status(500).json({message:"Admin login failed"});}
});
app.get("/api/admin/me",adminAuth,async(req,res)=>res.json({admin:{id:req.admin.id,name:req.admin.name,email:req.admin.email}}));
app.get("/api/admin/overview",adminAuth,async(req,res)=>{
  try{
    const [users,activeUsers,packages,transactions,pendingPayments,failedPayments,successfulPayments,withdrawals,pendingWithdrawals,totalEarned]=await Promise.all([
      prisma.user.count(),
      prisma.user.count({where:{status:"ACTIVE"}}),
      prisma.package.count({where:{active:true}}),
      prisma.transaction.count(),
      prisma.transaction.count({where:{status:"PENDING"}}),
      prisma.transaction.count({where:{status:"FAILED"}}),
      prisma.transaction.aggregate({where:{type:"PACKAGE_PURCHASE",status:"SUCCESS"},_sum:{amount:true}}),
      prisma.withdrawal.count(),
      prisma.withdrawal.count({where:{status:{in:["PENDING","PROCESSING"]}}}),
      prisma.commission.aggregate({_sum:{amount:true}})
    ]);
    res.json({users,activeUsers,packages,transactions,pendingPayments,successfulPayments:successfulPayments._sum.amount||0,withdrawals,pendingWithdrawals,failedPayments,totalCommissions:totalEarned._sum.amount||0,paystackMode:paystackMode()});
  }catch(e){console.error("Admin overview error:",e);res.status(500).json({message:"Unable to load admin overview"});}
});
app.get("/api/admin/users",adminAuth,async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const rows=await prisma.user.findMany({where:q?{OR:[{name:{contains:q,mode:"insensitive"}},{email:{contains:q,mode:"insensitive"}},{phone:{contains:q}}]}:undefined,include:{package:true,wallet:true,referredBy:{select:{name:true,email:true}}},orderBy:{createdAt:"desc"},take:200});
    res.json(rows.map(u=>({id:u.id,name:u.name,email:u.email,phone:u.phone,status:u.status,package:u.package,wallet:u.wallet,referralCode:u.referralCode,referredBy:u.referredBy,createdAt:u.createdAt})));
  }catch(e){console.error("Admin users error:",e);res.status(500).json({message:"Unable to load users"});}
});
app.post("/api/admin/users/balance",adminAuth,async(req,res)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const mode=String(req.body?.mode||"add").toLowerCase();
    const amount=Number(req.body?.amount);
    const reason=String(req.body?.reason||"").trim().slice(0,500);
    const updateTotalEarned=Boolean(req.body?.updateTotalEarned);
    if(!email || !email.includes("@")) return res.status(400).json({message:"Enter a valid member email address"});
    if(!["add","subtract","set"].includes(mode)) return res.status(400).json({message:"Invalid balance update mode"});
    if(!Number.isInteger(amount) || amount<0 || amount>10000000) return res.status(400).json({message:"Amount must be a whole number between KSh 0 and KSh 10,000,000"});
    if(!reason) return res.status(400).json({message:"A reason is required for every balance correction"});
    const user=await prisma.user.findUnique({where:{email},include:{wallet:true}});
    if(!user) return res.status(404).json({message:"No member was found with that email address"});
    const currentBalance=user.wallet?.balance||0;
    const currentTotalEarned=user.wallet?.totalEarned||0;
    const nextBalance=mode==="set"?amount:mode==="add"?currentBalance+amount:currentBalance-amount;
    if(nextBalance<0) return res.status(400).json({message:`Cannot reduce balance below KSh 0. Current balance is KSh ${currentBalance}.`});
    const delta=nextBalance-currentBalance;
    if(updateTotalEarned && currentTotalEarned+delta<0) return res.status(400).json({message:`This correction would make Total Earned negative. Current Total Earned is KSh ${currentTotalEarned}.`});
    const reference=`ADMIN-BAL-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const metadata={adminBalanceAdjustment:true,adminId:req.admin.id,adminEmail:req.admin.email,mode,previousBalance:currentBalance,newBalance:nextBalance,delta,reason,updateTotalEarned};
    const walletData={balance:nextBalance};
    if(updateTotalEarned) walletData.totalEarned={increment:delta};
    const result=await prisma.$transaction(async(tx)=>{
      const wallet=await tx.wallet.upsert({where:{userId:user.id},update:walletData,create:{userId:user.id,balance:nextBalance,totalEarned:updateTotalEarned?Math.max(0,delta):0}});
      if(delta!==0){
        await tx.transaction.create({data:{userId:user.id,type:"REFUND",amount:delta,status:"SUCCESS",reference,metadata}});
      }
      return wallet;
    });
    await logAdminAction(req,"BALANCE_CORRECTION","USER",user.id,user.email,{previousBalance:currentBalance,newBalance:result.balance,delta,mode,reason,reference,updateTotalEarned});
    res.json({message:`Balance updated for ${user.email}`,user:{id:user.id,name:user.name,email:user.email},previousBalance:currentBalance,newBalance:result.balance,delta,reference});
  }catch(e){
    console.error("Admin balance update error:",e);
    res.status(500).json({message:"Unable to update member balance"});
  }
});
app.patch("/api/admin/users/:id/status",adminAuth,async(req,res)=>{
  try{const status=req.body?.status;if(!["ACTIVE","SUSPENDED"].includes(status))return res.status(400).json({message:"Invalid user status"});const u=await prisma.user.update({where:{id:req.params.id},data:{status}});await logAdminAction(req,status==="ACTIVE"?"USER_REACTIVATED":"USER_SUSPENDED","USER",u.id,u.email,{status});res.json({message:`User ${status.toLowerCase()}`,user:{id:u.id,status:u.status}});}
  catch(e){console.error(e);res.status(500).json({message:"Unable to update user"});}
});
app.get("/api/admin/transactions",adminAuth,async(req,res)=>{
  try{const rows=await prisma.transaction.findMany({include:{user:{select:{id:true,name:true,email:true,phone:true}}},orderBy:{createdAt:"desc"},take:300});res.json(rows);}catch(e){console.error(e);res.status(500).json({message:"Unable to load transactions"});}
});
app.get("/api/admin/withdrawals",adminAuth,async(req,res)=>{
  try{const rows=await prisma.withdrawal.findMany({include:{user:{select:{id:true,name:true,email:true,phone:true}}},orderBy:{createdAt:"desc"},take:300});res.json(rows);}catch(e){console.error(e);res.status(500).json({message:"Unable to load withdrawals"});}
});
app.patch("/api/admin/withdrawals/:id/status",adminAuth,async(req,res)=>{
  try{
    const status=req.body?.status;
    if(!["PENDING","PROCESSING","PAID","FAILED"].includes(status))return res.status(400).json({message:"Invalid withdrawal status"});
    const current=await prisma.withdrawal.findUnique({where:{id:req.params.id}});
    if(!current)return res.status(404).json({message:"Withdrawal not found"});
    if(current.status!=="PAID" && status==="PAID"){
      await prisma.$transaction([
        prisma.withdrawal.update({where:{id:current.id},data:{status}}),
        prisma.wallet.update({where:{userId:current.userId},data:{pendingBalance:{decrement:current.amount},totalWithdrawn:{increment:current.amount}}}),
        prisma.transaction.create({data:{userId:current.userId,type:"WITHDRAWAL",amount:current.amount,status:"SUCCESS",reference:`WD-TX-${current.reference}`,metadata:{withdrawalId:current.id,processedBy:req.admin.id}}})
      ]);
    } else if(current.status!=="PAID" && status==="FAILED"){
      await prisma.$transaction([
        prisma.withdrawal.update({where:{id:current.id},data:{status}}),
        prisma.wallet.update({where:{userId:current.userId},data:{pendingBalance:{decrement:current.amount},balance:{increment:current.amount}}}),
        prisma.transaction.create({data:{userId:current.userId,type:"REFUND",amount:current.amount,status:"SUCCESS",reference:`WD-REFUND-${current.reference}`,metadata:{withdrawalId:current.id,processedBy:req.admin.id}}})
      ]);
    } else { await prisma.withdrawal.update({where:{id:current.id},data:{status}}); }
    await logAdminAction(req,"WITHDRAWAL_STATUS","WITHDRAWAL",current.id,null,{from:current.status,to:status,amount:current.amount,userId:current.userId,reference:current.reference});
    res.json({message:"Withdrawal status updated"});
  }catch(e){console.error("Admin withdrawal status error:",e);res.status(500).json({message:"Unable to update withdrawal"});}
});
app.get("/api/admin/packages",adminAuth,async(req,res)=>{try{res.json(await prisma.package.findMany({include:{_count:{select:{users:true}}},orderBy:{tier:"asc"}}));}catch(e){res.status(500).json({message:"Unable to load packages"});}});
app.patch("/api/admin/packages/:id",adminAuth,async(req,res)=>{
  try{const price=Number(req.body?.price),directCommission=Number(req.body?.directCommission),level2Commission=Number(req.body?.level2Commission),active=Boolean(req.body?.active),description=String(req.body?.description||""),badge=String(req.body?.badge||""),popular=Boolean(req.body?.popular),withdrawalLimit=Number(req.body?.withdrawalLimit||0),features=Array.isArray(req.body?.features)?req.body.features.map(x=>String(x).trim()).filter(Boolean):[];if(!Number.isInteger(price)||price<0||!Number.isInteger(directCommission)||directCommission<0||!Number.isInteger(level2Commission)||level2Commission<0||!Number.isInteger(withdrawalLimit)||withdrawalLimit<0)return res.status(400).json({message:"Package values must be whole non-negative amounts"});const p=await prisma.package.update({where:{id:req.params.id},data:{price,directCommission,level2Commission,active,description,badge,popular,withdrawalLimit,features}});await logAdminAction(req,"PACKAGE_UPDATED","PACKAGE",p.id,null,{name:p.name,price,directCommission,level2Commission,active,description,badge,popular,withdrawalLimit,features});res.json(p);}catch(e){console.error(e);res.status(500).json({message:"Unable to update package"});}
});
app.post("/api/admin/packages",adminAuth,async(req,res)=>{
  try{const name=String(req.body?.name||"").trim();const price=Number(req.body?.price),directCommission=Number(req.body?.directCommission),level2Commission=Number(req.body?.level2Commission),description=String(req.body?.description||""),badge=String(req.body?.badge||""),popular=Boolean(req.body?.popular),withdrawalLimit=Number(req.body?.withdrawalLimit||0),features=Array.isArray(req.body?.features)?req.body.features.map(x=>String(x).trim()).filter(Boolean):[];if(!name||!Number.isInteger(price)||price<0||!Number.isInteger(directCommission)||directCommission<0||!Number.isInteger(level2Commission)||level2Commission<0||!Number.isInteger(withdrawalLimit)||withdrawalLimit<0)return res.status(400).json({message:"Enter valid package values"});const maxTier=await prisma.package.aggregate({_max:{tier:true}}); const tier=Number(maxTier._max.tier||0)+1; const p=await prisma.package.create({data:{name,tier,price,directCommission,level2Commission,active:true,description,badge,popular,withdrawalLimit,features}});await logAdminAction(req,"PACKAGE_CREATED","PACKAGE",p.id,null,{name,price,directCommission,level2Commission,description,badge,popular,withdrawalLimit,features});res.status(201).json(p);}catch(e){console.error(e);res.status(500).json({message:e.code==="P2002"?"A package with that name already exists":"Unable to create package"});}
});

// Admin member details
app.get("/api/admin/users/:id/details",adminAuth,async(req,res)=>{
  try{
    const u=await prisma.user.findUnique({where:{id:req.params.id},include:{package:true,wallet:true,referredBy:{select:{id:true,name:true,email:true}},referrals:{select:{id:true,name:true,email:true,status:true,package:{select:{name:true}},createdAt:true},orderBy:{createdAt:"desc"}},transactions:{orderBy:{createdAt:"desc"},take:100},commissionsEarned:{orderBy:{createdAt:"desc"},take:100,include:{sourceUser:{select:{name:true,email:true}}}},withdrawals:{orderBy:{createdAt:"desc"},take:100}}});
    if(!u)return res.status(404).json({message:"Member not found"});
    res.json(u);
  }catch(e){console.error("Admin member details error:",e);res.status(500).json({message:"Unable to load member details"});}
});

// Admin payment repair: verifies a Paystack charge reference before activating the package.
app.post("/api/admin/payments/repair",adminAuth,async(req,res)=>{
  try{
    if(!process.env.PAYSTACK_SECRET_KEY)return res.status(503).json({message:"Paystack is not configured"});
    const email=String(req.body?.email||"").trim().toLowerCase();
    const reference=String(req.body?.reference||"").trim();
    if(!email||!email.includes("@"))return res.status(400).json({message:"Enter the member email address"});
    if(!reference)return res.status(400).json({message:"Enter the Paystack transaction reference"});
    const user=await prisma.user.findUnique({where:{email}});
    if(!user)return res.status(404).json({message:"No member was found with that email address"});
    let tx=await prisma.transaction.findUnique({where:{reference}});
    if(tx && tx.userId!==user.id)return res.status(409).json({message:"That payment reference belongs to a different member"});
    const r=await fetch(`https://api.paystack.co/charge/${encodeURIComponent(reference)}`,{headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`}});
    const d=await r.json().catch(()=>({}));
    if(!r.ok||!d.status)return res.status(400).json({message:d.message||"Paystack could not verify this reference"});
    const status=d.data?.status||"pending";
    if(!tx){
      if(status!=="success")return res.status(400).json({message:`Paystack reports this payment as ${status}. A transaction record cannot be created until it is successful.`});
      const packageCode=d.data?.metadata?.packageId||d.data?.metadata?.package_id||null;
      let pkg=packageCode?await prisma.package.findUnique({where:{id:String(packageCode)}}):null;
      if(!pkg){
        const amountKes=Math.round(Number(d.data?.amount||0)/100);
        pkg=await prisma.package.findFirst({where:{price:amountKes,active:true},orderBy:{price:"asc"}});
      }
      if(!pkg)return res.status(400).json({message:"Payment is successful, but NEXORA could not determine the package. Use manual balance correction or provide the correct package in the transaction metadata."});
      tx=await prisma.transaction.create({data:{userId:user.id,type:"PACKAGE_PURCHASE",amount:pkg.price,status:"PENDING",reference,metadata:{packageId:pkg.id,phone:d.data?.authorization?.mobile_money_number||null,paystack:{status,display_text:d.data?.display_text||"",gateway_response:d.data?.gateway_response||null,channel:d.data?.channel||null,currency:d.data?.currency||"KES",amount:d.data?.amount||null,reference}}}});
    }
    if(status==="success"){
      await activatePaidPackage(reference);
      await logAdminAction(req,"PAYMENT_REPAIRED","TRANSACTION",tx.id,user.email,{reference,paystackStatus:status,amount:d.data?.amount||null});
      return res.json({message:"Payment verified and member account repaired successfully",status:"success",reference});
    }
    if(["failed","timeout"].includes(status))await prisma.transaction.update({where:{reference},data:{status:"FAILED"}});
    await logAdminAction(req,"PAYMENT_CHECKED","TRANSACTION",tx.id,user.email,{reference,paystackStatus:status});
    res.json({message:`Paystack reports this payment as ${status}. No package activation was performed.`,status,reference});
  }catch(e){console.error("Admin payment repair error:",e);res.status(500).json({message:"Unable to repair payment"});}
});

// Admin activity/audit log

app.get("/api/admin/support/tickets",adminAuth,async(req,res)=>{try{res.json(await prisma.supportTicket.findMany({include:{user:{select:{id:true,name:true,email:true}}},orderBy:{createdAt:"desc"},take:300}));}catch(e){console.error(e);res.status(500).json({message:"Unable to load support tickets"});}});
app.patch("/api/admin/support/tickets/:id",adminAuth,async(req,res)=>{try{const status=String(req.body?.status||"OPEN").toUpperCase();const response=String(req.body?.response||"").trim().slice(0,3000);if(!["OPEN","IN_PROGRESS","CLOSED"].includes(status))return res.status(400).json({message:"Invalid ticket status"});const t=await prisma.supportTicket.update({where:{id:req.params.id},data:{status,response:response||null}});await logAdminAction(req,"SUPPORT_TICKET_UPDATED","SUPPORT_TICKET",t.id,null,{status,hasResponse:Boolean(response)});res.json(t);}catch(e){console.error(e);res.status(500).json({message:"Unable to update support ticket"});}});

app.get("/api/admin/activity",adminAuth,async(req,res)=>{
  try{const rows=await prisma.adminActivityLog.findMany({orderBy:{createdAt:"desc"},take:500});res.json(rows);}catch(e){console.error(e);res.status(500).json({message:"Unable to load admin activity"});}
});

// Simple CSV exports for admin records.
app.get("/api/admin/export/:type",adminAuth,async(req,res)=>{
  try{
    const type=String(req.params.type||"").toLowerCase(); let rows=[], headers=[];
    if(type==="users"){
      rows=await prisma.user.findMany({include:{wallet:true,package:true},orderBy:{createdAt:"desc"}});headers=["Name","Email","Phone","Status","Package","Balance","Total Earned","Total Withdrawn","Created"];
      rows=rows.map(x=>[x.name,x.email,x.phone,x.status,x.package?.name||"",x.wallet?.balance||0,x.wallet?.totalEarned||0,x.wallet?.totalWithdrawn||0,x.createdAt.toISOString()]);
    }else if(type==="transactions"){
      rows=await prisma.transaction.findMany({include:{user:{select:{email:true}}},orderBy:{createdAt:"desc"}});headers=["Reference","Email","Type","Amount","Status","Created"];rows=rows.map(x=>[x.reference,x.user?.email||"",x.type,x.amount,x.status,x.createdAt.toISOString()]);
    }else if(type==="withdrawals"){
      rows=await prisma.withdrawal.findMany({include:{user:{select:{email:true}}},orderBy:{createdAt:"desc"}});headers=["Reference","Email","Phone","Amount","Status","Created"];rows=rows.map(x=>[x.reference,x.user?.email||"",x.phone,x.amount,x.status,x.createdAt.toISOString()]);
    }else return res.status(400).json({message:"Unsupported export type"});
    const esc=v=>`"${String(v??"").replace(/"/g,'""')}"`;const csv=[headers, ...rows].map(r=>r.map(esc).join(",")).join("\n");
    res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename=nexora-${type}-${Date.now()}.csv`);res.send(csv);
    await logAdminAction(req,"DATA_EXPORT",type.toUpperCase(),null,null,{rows:rows.length});
  }catch(e){console.error("Admin export error:",e);res.status(500).json({message:"Unable to export data"});}
});


app.get("/api/announcements",async(req,res)=>{try{res.json(await prisma.announcement.findMany({where:{active:true},orderBy:{createdAt:"desc"},take:30}));}catch(e){console.error(e);res.status(500).json({message:"Unable to load announcements"});}});
app.get("/api/admin/announcements",adminAuth,async(req,res)=>{try{res.json(await prisma.announcement.findMany({orderBy:{createdAt:"desc"},take:100}));}catch(e){res.status(500).json({message:"Unable to load announcements"});}});
app.post("/api/admin/announcements",adminAuth,async(req,res)=>{try{const title=String(req.body?.title||"").trim().slice(0,120),body=String(req.body?.body||"").trim().slice(0,3000),category=String(req.body?.category||"UPDATE").trim().slice(0,30).toUpperCase();if(!title||!body)return res.status(400).json({message:"Title and body are required"});const a=await prisma.announcement.create({data:{title,body,category,active:req.body?.active!==false}});await logAdminAction(req,"ANNOUNCEMENT_CREATED","ANNOUNCEMENT",a.id,null,{title,category});res.status(201).json(a);}catch(e){console.error(e);res.status(500).json({message:"Unable to create announcement"});}});
app.patch("/api/admin/announcements/:id",adminAuth,async(req,res)=>{try{const data={};if(req.body?.title!==undefined)data.title=String(req.body.title).trim().slice(0,120);if(req.body?.body!==undefined)data.body=String(req.body.body).trim().slice(0,3000);if(req.body?.category!==undefined)data.category=String(req.body.category).trim().slice(0,30).toUpperCase();if(req.body?.active!==undefined)data.active=Boolean(req.body.active);const a=await prisma.announcement.update({where:{id:req.params.id},data});await logAdminAction(req,"ANNOUNCEMENT_UPDATED","ANNOUNCEMENT",a.id,null,{active:a.active});res.json(a);}catch(e){console.error(e);res.status(500).json({message:"Unable to update announcement"});}});


app.post("/api/member/whatsapp/link-code",auth,async(req,res)=>{
  try{
    const code=whatsappCode();
    const hash=whatsappCodeHash(code);
    const id=crypto.randomUUID();
    const expires=new Date(Date.now()+10*60*1000);
    await prisma.$executeRawUnsafe(`UPDATE whatsapp_link_codes SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`,req.user.id);
    await prisma.$executeRawUnsafe(`INSERT INTO whatsapp_link_codes(id,user_id,code_hash,expires_at) VALUES($1,$2,$3,$4)`,id,req.user.id,hash,expires);
    res.json({code,expiresAt:expires.toISOString(),message:"Use this one-time code in a private chat with the NEXORA WhatsApp assistant. It expires in 10 minutes."});
  }catch(e){console.error("WhatsApp link code error:",e);res.status(500).json({message:"Unable to create WhatsApp link code"});}
});

app.get("/api/member/analytics",auth,async(req,res)=>{
  try{
    const direct=await prisma.user.findMany({where:{referredById:req.user.id},select:{id:true,packageId:true,createdAt:true}});
    const ids=direct.map(x=>x.id);
    const level2=ids.length?await prisma.user.findMany({where:{referredById:{in:ids}},select:{id:true,packageId:true}}):[];
    const commissions=await prisma.commission.findMany({where:{receiverId:req.user.id},select:{level:true,amount:true,createdAt:true}});
    const now=new Date(); const monthStart=new Date(now.getFullYear(),now.getMonth(),1);
    const monthDirect=direct.filter(x=>new Date(x.createdAt)>=monthStart).length;
    const monthCommissions=commissions.filter(x=>new Date(x.createdAt)>=monthStart).reduce((a,x)=>a+x.amount,0);
    const directCommission=commissions.filter(x=>x.level===1).reduce((a,x)=>a+x.amount,0);
    const level2Commission=commissions.filter(x=>x.level===2).reduce((a,x)=>a+x.amount,0);
    const paidReferrals=direct.filter(x=>x.packageId).length;
    res.json({directCount:direct.length,level2Count:level2.length,paidReferrals,conversion:direct.length?Math.round(paidReferrals/direct.length*100):0,directCommission,level2Commission,totalCommission:directCommission+level2Commission,month:{directReferrals:monthDirect,commissions:monthCommissions}});
  }catch(e){console.error(e);res.status(500).json({message:"Unable to load analytics"});}
});

app.get("/api/member/leaderboard",auth,async(req,res)=>{
  try{
    const rows=await prisma.user.findMany({where:{status:"ACTIVE"},orderBy:{wallet:{totalEarned:"desc"}},take:20,select:{id:true,name:true,createdAt:true,package:{select:{name:true}},wallet:{select:{totalEarned:true}}}});
    res.json(rows.map(x=>({id:x.id,name:String(x.name||"Member").split(" ")[0],createdAt:x.createdAt,package:x.package?.name||null,totalEarned:x.wallet?.totalEarned||0})));
  }catch(e){console.error(e);res.status(500).json({message:"Unable to load leaderboard"});}
});

app.get("/api/support/tickets",auth,async(req,res)=>{try{res.json(await prisma.supportTicket.findMany({where:{userId:req.user.id},orderBy:{createdAt:"desc"},take:50}));}catch(e){console.error(e);res.status(500).json({message:"Unable to load support tickets"});}});
app.post("/api/support/tickets",auth,async(req,res)=>{try{const subject=String(req.body?.subject||"").trim().slice(0,120);const message=String(req.body?.message||"").trim().slice(0,3000);if(!subject||!message)return res.status(400).json({message:"Subject and message are required"});const t=await prisma.supportTicket.create({data:{userId:req.user.id,subject,message}});res.status(201).json({message:"Support request submitted",ticket:t});}catch(e){console.error(e);res.status(500).json({message:"Unable to create support ticket"});}});

app.patch("/api/member/profile",auth,async(req,res)=>{try{const name=String(req.body?.name||"").trim();const phone=cleanPhone(req.body?.phone||"");if(name.length<2)return res.status(400).json({message:"Enter your full name"});if(!PHONE_RE.test(phone))return res.status(400).json({message:"Invalid Kenyan phone number"});const clash=await prisma.user.findFirst({where:{phone,id:{not:req.user.id}}});if(clash)return res.status(409).json({message:"That phone number is already in use"});await prisma.user.update({where:{id:req.user.id},data:{name,phone}});res.json({message:"Profile updated successfully"});}catch(e){console.error(e);res.status(500).json({message:"Unable to update profile"});}});
app.post("/api/member/password",auth,async(req,res)=>{try{const current=String(req.body?.currentPassword||"");const next=String(req.body?.newPassword||"");if(next.length<8)return res.status(400).json({message:"New password must be at least 8 characters"});if(!(await bcrypt.compare(current,req.user.passwordHash)))return res.status(401).json({message:"Current password is incorrect"});await prisma.user.update({where:{id:req.user.id},data:{passwordHash:await bcrypt.hash(next,12)}});res.json({message:"Password updated successfully. Please use the new password next time you sign in."});}catch(e){console.error(e);res.status(500).json({message:"Unable to update password"});}});


app.post("/api/whatsapp/link/verify",requireWhatsAppBot,async(req,res)=>{
  try{
    const code=String(req.body?.code||"").replace(/\D/g,"");
    const whatsappJid=String(req.body?.whatsappJid||"").trim();
    const whatsappPhone=String(req.body?.whatsappPhone||"").replace(/\D/g,"");
    if(!/^\d{6}$/.test(code)||!whatsappJid) return res.status(400).json({message:"Valid link code and WhatsApp JID are required"});
    const rows=await prisma.$queryRawUnsafe(`SELECT * FROM whatsapp_link_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,whatsappCodeHash(code));
    const row=rows[0];
    if(!row) return res.status(400).json({message:"Invalid or expired link code"});
    const user=await prisma.user.findUnique({where:{id:row.user_id},select:{id:true,name:true,email:true,phone:true,status:true}});
    if(!user || user.status!=="ACTIVE") return res.status(403).json({message:"NEXORA account is unavailable"});
    await prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe(`UPDATE whatsapp_link_codes SET used_at=NOW() WHERE id=$1`,row.id);
      await tx.$executeRawUnsafe(`DELETE FROM whatsapp_account_links WHERE user_id=$1 OR whatsapp_jid=$2`,user.id,whatsappJid);
      await tx.$executeRawUnsafe(`INSERT INTO whatsapp_account_links(id,user_id,whatsapp_jid,whatsapp_phone) VALUES($1,$2,$3,$4)`,crypto.randomUUID(),user.id,whatsappJid,whatsappPhone||null);
    });
    res.json({message:"WhatsApp account linked successfully",user:{id:user.id,name:user.name,email:user.email,phone:user.phone}});
  }catch(e){console.error("WhatsApp link verify error:",e);res.status(500).json({message:"Unable to link WhatsApp account"});}
});

app.post("/api/whatsapp/unlink",requireWhatsAppBot,privateWhatsappOnly,async(req,res)=>{
  try{
    const jid=String(req.body.whatsappJid);
    await prisma.$executeRawUnsafe(`DELETE FROM whatsapp_account_links WHERE whatsapp_jid=$1`,jid);
    res.json({message:"WhatsApp account unlinked"});
  }catch(e){console.error(e);res.status(500).json({message:"Unable to unlink WhatsApp account"});}
});

app.post("/api/whatsapp/account",requireWhatsAppBot,privateWhatsappOnly,async(req,res)=>{
  try{
    const jid=String(req.body.whatsappJid);
    const links=await prisma.$queryRawUnsafe(`SELECT user_id,whatsapp_phone FROM whatsapp_account_links WHERE whatsapp_jid=$1 OR ($2<>'' AND whatsapp_phone=$2) LIMIT 1`,jid,String(req.body?.whatsappPhone||"").replace(/\D/g,""));
    const link=links[0];
    if(!link) return res.status(404).json({message:"This WhatsApp number is not linked to a NEXORA member account. Open NEXORA Profile & Security and generate a WhatsApp link code."});
    const user=await prisma.user.findUnique({where:{id:link.user_id},include:{package:true,wallet:true}});
    if(!user || user.status!=="ACTIVE") return res.status(403).json({message:"NEXORA account is unavailable"});
    const direct=await prisma.user.count({where:{referredById:user.id}});
    const directIds=await prisma.user.findMany({where:{referredById:user.id},select:{id:true}});
    const level2=directIds.length?await prisma.user.count({where:{referredById:{in:directIds.map(x=>x.id)}}}):0;
    const withdrawals=await prisma.withdrawal.findMany({where:{userId:user.id},orderBy:{createdAt:"desc"},take:5,select:{amount:true,status:true,reference:true,createdAt:true}});
    const transactions=await prisma.transaction.findMany({where:{userId:user.id},orderBy:{createdAt:"desc"},take:5,select:{type:true,amount:true,status:true,reference:true,createdAt:true}});
    res.json({user:{id:user.id,name:user.name,email:user.email,phone:user.phone,referralCode:user.referralCode},package:user.package?{name:user.package.name,price:user.package.price,tier:user.package.tier}:null,wallet:{balance:user.wallet?.balance||0,pendingBalance:user.wallet?.pendingBalance||0,totalEarned:user.wallet?.totalEarned||0,totalWithdrawn:user.wallet?.totalWithdrawn||0},referrals:{direct,level2},withdrawals,transactions});
  }catch(e){console.error("WhatsApp account error:",e);res.status(500).json({message:"Unable to load NEXORA account"});}
});

app.post("/api/withdrawals",auth,async(req,res)=>{
  const amount=Number(req.body.amount), phone=cleanPhone(req.body.phone||req.user.phone);
  if(!PHONE_RE.test(phone)) return res.status(400).json({message:"Invalid Kenyan phone number. Use 07…, 011…, 2547… or 2541…."});
  if(!Number.isInteger(amount)||amount<100) return res.status(400).json({message:"Minimum withdrawal is KSh 100"});
  const wallet=await prisma.wallet.findUnique({where:{userId:req.user.id}});
  if(!wallet || wallet.balance<amount) return res.status(400).json({message:"Insufficient balance"});
  const member=await prisma.user.findUnique({where:{id:req.user.id},include:{package:true}});
  const limit=Number(member?.package?.withdrawalLimit||0);
  if(limit>0 && amount>limit) return res.status(400).json({message:`Your ${member.package.name} package allows withdrawals up to KSh ${limit.toLocaleString()} per request.`});
  const reference=`WD-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  await prisma.$transaction([
    prisma.wallet.update({where:{userId:req.user.id},data:{balance:{decrement:amount},pendingBalance:{increment:amount}}}),
    prisma.withdrawal.create({data:{userId:req.user.id,amount,phone,reference}})
  ]);
  res.status(201).json({message:"Withdrawal request submitted",reference});
});

// -------------------- SERVE NEXORA FRONTEND FROM RENDER --------------------
// The production deployment uses one Render service for both the React UI and API.
// Vite builds client/dist, and Express serves it here. SPA fallback makes /admin work.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, "../../client/dist");
app.use(express.static(clientDist, { index: "index.html" }));
app.get("/{*splat}", (req,res,next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(clientDist, "index.html"), err => {
    if (err) next(err);
  });
});


async function ensureAnnouncementTable(){
  try{
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "Announcement" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "body" TEXT NOT NULL, "category" TEXT NOT NULL DEFAULT 'UPDATE', "active" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const count=await prisma.announcement.count();
    if(!count){
      const seed=[
        ["Welcome to NEXORA","Explore your member workspace, Academy, analytics, referral tools and support center. Keep your account information current and use the platform responsibly.","WELCOME"],
        ["Learn before you share","Use NEXORA Academy to understand the platform and communicate membership details clearly. Avoid misleading or guaranteed-income claims.","EDUCATION"],
        ["Protect your account","Never share your password or M-Pesa PIN. NEXORA support will not ask you to disclose those credentials.","SECURITY"]
      ];
      for(const [title,body,category] of seed) await prisma.announcement.create({data:{id:crypto.randomUUID(),title,body,category,active:true}});
    }
  }catch(e){console.error("[ANNOUNCEMENTS SETUP]",e.message);}
}

async function ensurePackageSettingsColumns(){
  await prisma.$executeRawUnsafe(`ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL DEFAULT ''`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "badge" TEXT NOT NULL DEFAULT ''`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "popular" BOOLEAN NOT NULL DEFAULT false`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "withdrawalLimit" INTEGER NOT NULL DEFAULT 0`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "tier" INTEGER NOT NULL DEFAULT 0`);
  const tiers=[["Starter",1],["Growth",2],["Pro",3],["Elite",4],["Premium",5]];
  for(const [name,tier] of tiers) await prisma.$executeRawUnsafe(`UPDATE "Package" SET "tier"=$1 WHERE "name"=$2`,tier,name);
  const defaults=[
    ["Starter","Start earning with the essentials.", ["Basic dashboard","Referral link","Basic referral statistics","Standard support"],"START",false,5000],
    ["Growth","Build your network with more tools.",["Everything in Starter","Advanced referral statistics","Marketing templates","Priority support"],"GROWTH",false,10000],
    ["Pro","A strong all-round package for serious users.",["Everything in Growth","Advanced analytics","Social-media marketing resources","Pro member badge","Higher withdrawal limit"],"MOST POPULAR",true,20000],
    ["Elite","Advanced tools for professional promoters.",["Everything in Pro","Team statistics","Premium marketing resources","Elite member badge","Priority withdrawal review","Early access to selected features"],"ELITE",false,50000],
    ["Premium","The complete NEXORA member experience.",["Everything in Elite","VIP support","Maximum available limits","Premium badge","VIP marketing resources","Early access to new features"],"VIP",false,100000]
  ];
  for(const [name,description,features,badge,popular,limit] of defaults){
    await prisma.$executeRawUnsafe(`UPDATE "Package" SET "description"=$1,"features"=$2,"badge"=$3,"popular"=$4,"withdrawalLimit"=$5 WHERE "name"=$6 AND ("description" = '' OR cardinality("features") = 0)`,description,features,badge,popular,limit,name);
  }
}

async function ensureAdminActivityTable(){
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AdminActivityLog" ("id" TEXT PRIMARY KEY,"adminId" TEXT NOT NULL,"adminEmail" TEXT NOT NULL,"action" TEXT NOT NULL,"targetType" TEXT,"targetId" TEXT,"targetEmail" TEXT,"details" JSONB,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AdminActivityLog_createdAt_idx" ON "AdminActivityLog"("createdAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AdminActivityLog_targetEmail_idx" ON "AdminActivityLog"("targetEmail")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AdminActivityLog_action_idx" ON "AdminActivityLog"("action")`);
}


async function ensureSupportTicketTable(){
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "SupportTicket" ("id" TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"subject" TEXT NOT NULL,"message" TEXT NOT NULL,"status" TEXT NOT NULL DEFAULT 'OPEN',"response" TEXT,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SupportTicket_userId_createdAt_idx" ON "SupportTicket"("userId","createdAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "SupportTicket_status_idx" ON "SupportTicket"("status")`);
}

async function startServer(){
  await ensureWhatsAppLinkTable();
  try{
    await ensurePackageSettingsColumns();
  await ensureAnnouncementTable();
    await ensureAdminActivityTable();
    await ensureSupportTicketTable();
    await ensureAdmin();
  }catch(e){
    console.error("[ADMIN] Could not initialize admin account:",e);
  }
  app.listen(PORT,()=>console.log(`NEXORA app/API running on port ${PORT}`));
}

startServer();
