// reply_alert_cron.mjs — runs INSIDE email_api every 15 min (via cron + docker exec).
// 1) triggers the reply IMAP import (classifies + auto-suppresses opt-outs),
// 2) emails an alert for every NEW 'interested' (positive) reply so hot leads are never missed.
import * as mariadb from 'mariadb';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const SECRET = process.env.API_JWT_SECRET;
const TENANT = 1, ADMIN_USER = 1;
const API = `http://127.0.0.1:${process.env.API_PORT || 4000}`;

const KEY = crypto.createHash('sha256').update(SECRET || 'insecure-dev-key').digest();
function dec(b64){const b=Buffer.from(b64,'base64');const iv=b.subarray(0,12),tag=b.subarray(12,28),ct=b.subarray(28);const d=crypto.createDecipheriv('aes-256-gcm',KEY,iv);d.setAuthTag(tag);return Buffer.concat([d.update(ct),d.final()]).toString('utf8');}
const pool = mariadb.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,connectionLimit:2,bigIntAsNumber:true});
async function secret(ref){const r=await pool.query('SELECT value_enc FROM mailbox_secrets WHERE ref_name=? LIMIT 1',[ref]);if(r.length&&r[0].value_enc){try{return dec(r[0].value_enc);}catch{}}return process.env[ref];}
async function getSetting(k,def){const r=await pool.query('SELECT value FROM platform_settings WHERE `key`=? LIMIT 1',[k]);if(!r.length)return def;try{return JSON.parse(r[0].value);}catch{return r[0].value;}}
async function setSetting(k,v){await pool.query('INSERT INTO platform_settings (`key`,value,updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE value=VALUES(value),updated_at=NOW()',[k,JSON.stringify(v)]);}

const log = (o)=>console.log(JSON.stringify({t:new Date().toISOString(),...o}));

// 1) trigger import
let imported=0, suppressedAuto=0;
try{
  const token = jwt.sign({sub:ADMIN_USER, tenant:TENANT}, SECRET, {expiresIn:'5m'});
  const res = await fetch(`${API}/manual-outreach/replies/import`,{method:'POST',headers:{'authorization':`Bearer ${token}`,'x-tenant-id':String(TENANT),'content-type':'application/json'},body:'{}'});
  const j = await res.json().catch(()=>({}));
  imported = j.imported ?? 0; suppressedAuto = j.suppressedAuto ?? 0;
  log({step:'import', status:res.status, imported, suppressedAuto});
}catch(e){ log({step:'import', error:String(e?.message||e).slice(0,160)}); }

// 2) alert on NEW interested replies
const lastId = Number(await getSetting('reply_alert_last_id','0')) || 0;
const alertTo = await getSetting('reply_alert_to','microsendcrypto@gmail.com');
const rows = await pool.query(
  // Alert on 'interested' AND 'unknown' — 'unknown' is a real human reply that didn't match the
  // English keyword list (e.g. a Russian "давай"), so positives are never missed. Noise categories
  // (auto_reply / out_of_office / bounce_like / unsubscribe / do_not_contact / not_interested / wrong_person)
  // are excluded.
  `SELECT r.id, r.from_email, r.from_name, r.subject, r.body_snippet, r.received_at, r.classification, m.from_email AS mailbox
     FROM inbox_replies r LEFT JOIN sender_identities m ON m.id=r.mailbox_id
    WHERE r.tenant_id=? AND r.classification IN ('interested','unknown') AND r.id>?
    ORDER BY r.id ASC LIMIT 50`,[TENANT,lastId]);
if(!rows.length){ log({step:'alert', new_interested:0}); await pool.end(); process.exit(0); }

const u = await secret('SUPPORT_CLIENTS_HELP_SMTP_USER');
const p = await secret('SUPPORT_CLIENTS_HELP_SMTP_PASSWORD');
let sent=false, err;
if(u&&p){
  try{
    const t = nodemailer.createTransport({host:'mail.spacemail.com',port:465,secure:true,auth:{user:u,pass:p},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:18000});
    const lines = rows.map(r=>`• FROM: ${r.from_name?`${r.from_name} <${r.from_email}>`:r.from_email}  [${r.classification}]\n  via: ${r.mailbox} | ${r.received_at}\n  subj: ${r.subject||'(no subject)'}\n  "${(r.body_snippet||'').replace(/\s+/g,' ').slice(0,300)}"`).join('\n\n');
    await t.sendMail({
      from:{name:'Outreach Alert', address:u}, to:alertTo,
      subject:`🔥 ${rows.length} new repl${rows.length>1?'ies':'y'} to review (possible lead)`,
      text:`${rows.length} new repl${rows.length>1?'ies':'y'} that may be positive (classified interested/unknown). Reply from the mailbox shown, or in the portal -> Manual outreach -> Replies.\n\n${lines}\n\n-- automated alert from the email platform`,
    });
    t.close(); sent=true;
  }catch(e){ err=String(e?.message||e).slice(0,160); }
}
if(sent){ await setSetting('reply_alert_last_id', rows[rows.length-1].id); log({step:'alert', new_interested:rows.length, sent:true, to:alertTo}); }
else { log({step:'alert', new_interested:rows.length, sent:false, err:err||'no_sender_creds'}); }
await pool.end();
