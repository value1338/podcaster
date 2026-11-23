import { scrypt as crypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { problem } from './storage.mjs';
const scrypt=promisify(crypt), options={N:32768,r:8,p:1,maxmem:64*1024*1024};
export const hashToken=t=>createHash('sha256').update(t).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export async function passwordHash(password){if(typeof password!=='string'||password.length<10||password.length>200)throw problem(400,'invalid_input','Kennwort muss 10–200 Zeichen haben.');const salt=randomBytes(16);return 'scrypt$32768$8$1$'+salt.toString('base64')+'$'+(await scrypt(password,salt,64,options)).toString('base64');}
const dummy='scrypt$32768$8$1$'+Buffer.alloc(16).toString('base64')+'$'+Buffer.alloc(64).toString('base64');
export async function verifyPassword(password,encoded){const parts=(encoded||dummy).split('$');const key=await scrypt(typeof password==='string'&&password.length<=200?password:'',Buffer.from(parts[4],'base64'),64,options);return timingSafeEqual(key,Buffer.from(parts[5],'base64'))&&!!encoded;}
export function authConfig(options={}){const origins=(options.origins??process.env.STUDIO_ORIGINS??'').split(',').filter(Boolean);for(const o of origins)if(new URL(o).origin!==o)throw Error('Exakte STUDIO_ORIGINS erforderlich');const insecure=options.cookieInsecure??process.env.STUDIO_COOKIE_INSECURE==='1';if(process.env.NODE_ENV==='production'&&(insecure||!origins.length||['ASR','LLM','ARCHIVE'].some(k=>process.env['STUDIO_'+k+'_DRIVER']==='fake')))throw Error('Unsichere Produktionskonfiguration');if(!origins.length)throw Error('STUDIO_ORIGINS erforderlich');return {origins,insecure,limits:new Map()};}
export function guard(ctx,req,res){for(const [k,v] of Object.entries({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'}))res.setHeader(k,v);if(!['GET','HEAD'].includes(req.method)&&(req.headers['x-studio']!=='1'||!ctx.auth.origins.includes(req.headers.origin)))throw problem(403,'csrf','Ungültige Herkunft.');}
export function limit(ctx,key,max,ms){const now=Date.now(),map=ctx.auth.limits;for(const [k,v] of map)if(v.until<=now)map.delete(k);let entry=map.get(key);if(!entry){entry={n:0,until:now+ms};map.set(key,entry);}if(entry.n>=max)throw problem(429,'rate_limited','Zu viele Versuche.',{retryAfterS:Math.ceil((entry.until-now)/1000)});entry.n++;}
export function session(ctx,req){const token=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('ps_sitzung='))?.slice(11);if(!token||token.length>128)return null;const row=ctx.db.sql.prepare("SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='active' AND u.password_hash IS NOT NULL").get(hashToken(token),new Date().toISOString());return row??null;}
export function cookie(ctx,res,token,age=2592000){res.setHeader('Set-Cookie',`ps_sitzung=${token}; HttpOnly; ${ctx.auth.insecure?'':'Secure; '}SameSite=Strict; Path=${ctx.base}/; Max-Age=${age}`);}
export function issueSession(ctx,res,user){const token=secret(),now=new Date().toISOString();ctx.db.sql.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,NULL)').run(hashToken(token),user.id,now,now,new Date(Date.now()+2592000000).toISOString());cookie(ctx,res,token);}
export function requireUser(user){if(!user)throw problem(401,'unauthenticated','Anmeldung erforderlich.');return user;}

// Tailnet resource guard: bound concurrent expensive hashes, no shared long lockout.
export async function authHash(ctx,fn){if((ctx.auth.hashes??0)>=2)throw problem(429,'rate_limited','Zu viele Versuche.',{retryAfterS:1});ctx.auth.hashes=(ctx.auth.hashes??0)+1;try{return await fn();}finally{ctx.auth.hashes--;}}
