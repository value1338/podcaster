// Erststart: Einmal-Einrichtungslink für den Admin (owner) automatisch erzeugen. Kein Standardkennwort.
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownerCreate, tokenCreate } from './accounts.mjs';
import { hashToken } from './auth.mjs';
export const SETUP_FILE='admin-einrichtung.txt';
const TTL=24*3600000;
const validToken=(ctx,token)=>!!token&&!!ctx.db.sql.prepare("SELECT 1 FROM tokens WHERE token_hash=? AND kind='setup' AND used_at IS NULL AND expires_at>?").get(hashToken(token),new Date().toISOString());
// Ergebnis: 'done' (Admin eingerichtet), 'kept' (gültiger Link liegt schon vor), 'created', 'missing_email'.
export async function adminSetup(ctx,env=process.env,log=console){
 const owner=ctx.db.sql.prepare("SELECT id,password_hash FROM users WHERE role='owner'").get();
 if(owner?.password_hash)return 'done';
 const file=path.join(ctx.dataDir,SETUP_FILE);
 const old=await readFile(file,'utf8').catch(()=>'');
 if(owner&&validToken(ctx,old.match(/\/einladung\/([A-Za-z0-9_-]+)/)?.[1])){log.log(`Podcast-Studio: Admin-Einrichtung offen, Einmal-Link liegt in ${file}`);return 'kept';}
 if(!owner&&!env.STUDIO_ADMIN_EMAIL){log.warn('Podcast-Studio: Kein Admin-Konto. STUDIO_ADMIN_EMAIL setzen und neu starten oder `node server/cli.mjs owner:create --email … --name … --output DATEI` ausführen.');return 'missing_email';}
 const link=owner?tokenCreate(ctx,{kind:'setup',userId:owner.id,ttl:TTL}):ownerCreate(ctx,env.STUDIO_ADMIN_EMAIL,'Admin',TTL);
 const publicBase=(env.STUDIO_PUBLIC_URL??(ctx.auth.origins[0]??'')+ctx.base).replace(/\/$/,'');
 const url=publicBase+link.url.slice(ctx.base.length);
 const tmp=file+'.'+randomUUID();
 await writeFile(tmp,`Podcast-Studio – Admin-Einrichtung\n\nEinmal-Link (gültig bis ${link.expiresAt}):\n${url}\n\nLink öffnen und Kennwort setzen. Danach ist der Link verbraucht.\nAbgelaufen? Server neu starten – es wird ein neuer Link erzeugt.\n`,{mode:0o600,flag:'wx'});
 await rename(tmp,file);
 log.log(`Podcast-Studio: Admin-Einrichtungslink (einmalig, gültig bis ${link.expiresAt}): ${url} – auch in ${file}`);
 return 'created';
}
