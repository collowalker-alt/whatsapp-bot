import dotenv from "dotenv"; dotenv.config();
import {PrismaClient} from "@prisma/client";
const p=new PrismaClient();
const packages=[
  ["Starter",1,500,200,50,"Start earning with the essentials.",["Basic dashboard","Referral link","Basic referral statistics","Standard support","Withdraw up to KSh 5,000 per request"],"START",false,5000],
  ["Growth",2,1000,400,150,"Build your network with more tools.",["Everything in Starter","Advanced referral statistics","Marketing templates","Priority support","Withdraw up to KSh 10,000 per request"],"GROWTH",false,10000],
  ["Pro",3,1600,700,250,"A strong all-round package for serious users.",["Everything in Growth","Advanced analytics","Social-media marketing resources","Pro member badge","Withdraw up to KSh 20,000 per request"],"MOST POPULAR",true,20000],
  ["Elite",4,2200,900,300,"Advanced tools for professional promoters.",["Everything in Pro","Team statistics","Premium marketing resources","Elite member badge","Priority withdrawal review","Early access to selected features","Withdraw up to KSh 50,000 per request"],"ELITE",false,50000],
  ["Premium",5,4800,2000,500,"The complete NEXORA member experience.",["Everything in Elite","VIP support","Maximum available limits","Premium badge","VIP marketing resources","Early access to new features","Withdraw up to KSh 100,000 per request"],"VIP",false,100000]
];
for(const [name,tier,price,directCommission,level2Commission,description,features,badge,popular,withdrawalLimit] of packages)
 await p.package.upsert({where:{name},update:{tier},create:{name,tier,price,directCommission,level2Commission,description,features,badge,popular,withdrawalLimit}});

const adminEmail=String(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
const adminPassword=String(process.env.ADMIN_PASSWORD||"");
const adminName=String(process.env.ADMIN_NAME||"NEXORA Administrator").trim()||"NEXORA Administrator";
if(adminEmail && adminPassword){
  if(adminPassword.length<10) throw new Error("ADMIN_PASSWORD must be at least 10 characters");
  const bcrypt=(await import("bcryptjs")).default;
  const passwordHash=await bcrypt.hash(adminPassword,12);
  await p.admin.upsert({
    where:{email:adminEmail},
    update:{name:adminName,passwordHash,status:"ACTIVE"},
    create:{name:adminName,email:adminEmail,passwordHash,status:"ACTIVE"}
  });
  console.log(`Admin account seeded: ${adminEmail}`);
}else{
  console.log("Packages seeded. Admin account not changed because ADMIN_EMAIL/ADMIN_PASSWORD are not set.");
}
await p.$disconnect();
