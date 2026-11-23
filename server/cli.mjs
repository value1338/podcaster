import {pelVersion} from './migrate.mjs';
import { writeFile } from 'node:fs/promises';
import { ownerCreate, tokenCreate, legacyClaim } from './accounts.mjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDB } from './db.mjs';
import { migrate } from './migrate.mjs';
const command=process.argv[2];
if(!['status','migrate','owner:create','owner:link','legacy:claim','settings:import-env'].includes(command))throw Error('Unbekannter Befehl');
const args=process.argv.slice(3);const arg=k=>args[args.indexOf(k)+1];
const file=path.join(path.resolve(process.env.STUDIO_DATA_DIR??fileURLToPath(new URL('../../Daten',import.meta.url))),'studio.sqlite');
if(command==='status') {
 const sql=new DatabaseSync(file,{readOnly:true});
 try {
 const version=sql.prepare('PRAGMA user_version').get().user_version;
 const unassigned={};
 for(const table of ['projects','recordings','tracks','exports']) unassigned[table]=sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE json_extract(data,'$.ownerId') IS NULL`).get().n;
 const users=version===1?sql.prepare('SELECT count(*) AS n FROM users').get().n:0;
 const configured={};
 // KI-Dienste stehen in der DB (Verwaltung → Einstellungen); nur gesetzt ja/nein, nie Werte.
 if(version===1)for(const key of ['llm.baseUrl','llm.apiKey','asr.url','asr.token']) configured[key]=Boolean(sql.prepare('SELECT 1 FROM settings WHERE key=? AND value NOT IN (\'""\',\'null\')').get(key));
 for(const key of ['STUDIO_ARCHIVE_DRIVER','STUDIO_ARCHIVE_ID','STUDIO_ARCHIVE_PATH']) configured[key]=Boolean(process.env[key]);
 console.log(JSON.stringify({version,ext:{pel:pelVersion(sql)},users,unassigned,configured}));
 } finally {sql.close();}
} else if(command==='settings:import-env') {
 // Einmalige Übernahme alter Umgebungsvariablen in die DB. Vorhandene DB-Werte bleiben; Werte werden nie ausgegeben.
 const {connectionValid}=await import('./admin.mjs');
 const map={STUDIO_LLM_BASE_URL:['llmBaseUrl','llm.baseUrl',String],OPENAI_API_KEY:['llmApiKey','llm.apiKey',String],STUDIO_LLM_REASONING_EFFORT:['llmReasoningEffort','llm.reasoningEffort',String],STUDIO_LLM_TIMEOUT_MS:['llmTimeoutMs','llm.timeoutMs',Number],STUDIO_ASR_URL:['asrUrl','asr.url',String],STUDIO_ASR_TOKEN:['asrToken','asr.token',String],STUDIO_ASR_TIMEOUT_MS:['asrTimeoutMs','asr.timeoutMs',Number]};
 const db=openDB(file);try{if(db.sql.prepare('PRAGMA user_version').get().user_version!==1)throw Error('Explizite Migration erforderlich');
 const out={imported:[],kept:[],invalid:[]};
 db.tx(()=>{for(const [env,[field,key,cast]] of Object.entries(map)){if(!process.env[env])continue;const v=cast(process.env[env]);if(!connectionValid(field,v)){out.invalid.push(env);continue;}if(db.sql.prepare('SELECT 1 FROM settings WHERE key=?').get(key)){out.kept.push(env);continue;}db.sql.prepare('INSERT INTO settings VALUES (?,?,?,NULL)').run(key,JSON.stringify(v),new Date().toISOString());out.imported.push(env);}
 if(out.imported.length)db.sql.prepare('INSERT INTO audit(at,actor_id,action,subject) VALUES (?,?,?,?)').run(new Date().toISOString(),null,'settings.import-env',out.imported.join(','));});
 console.log(JSON.stringify(out));} finally {db.close();}
} else if(command==='migrate') {
 const db=openDB(file); try {console.log(JSON.stringify(await migrate(db,file)));} finally {db.close();}
}

else {const db=openDB(file);try {if(db.sql.prepare('PRAGMA user_version').get().user_version!==1||pelVersion(db.sql)!==1)throw Error('Explizite Migration erforderlich');const ctx={db,base:process.env.STUDIO_BASE_PATH??''};if(command==='legacy:claim'){console.log(JSON.stringify(legacyClaim(ctx,arg('--owner'),args.includes('--confirm'))));}else{const output=arg('--output');if(!args.includes('--output')||!output)throw Error('--output für geschützte Linkdatei erforderlich');const handle=await (await import('node:fs/promises')).open(output,'wx',0o600);try {const link=command==='owner:create'?ownerCreate(ctx,arg('--email'),arg('--name')):db.tx(()=>{const u=db.sql.prepare("SELECT id FROM users WHERE role='owner'").get();if(!u)throw Error('Eigentümer fehlt');db.sql.prepare('UPDATE tokens SET used_at=? WHERE user_id=? AND used_at IS NULL').run(new Date().toISOString(),u.id);return tokenCreate(ctx,{kind:'reset',userId:u.id});});await handle.writeFile(JSON.stringify(link));console.log(JSON.stringify({written:true}));}finally{await handle.close();}}}finally{db.close();}}
