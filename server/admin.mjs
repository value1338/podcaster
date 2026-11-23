import {archiveStatus} from './archive.mjs';
import {llmConfiguration} from './llm.mjs';
import {quota,periodNow} from './quota.mjs';
import {jobView} from './work.mjs';
import {problem} from './storage.mjs';
import {requireUser,limit} from './auth.mjs';
import {createLlmAdapter,serviceUrl} from './llm-adapter.mjs';
import {createAsrAdapter} from './asr-adapter.mjs';
const fields={name:'name',asrSecondsMonth:'asr_seconds_month',llmTokensMonth:'llm_tokens_month',llmCostMicroMonth:'llm_cost_micro_month',storageBytes:'storage_bytes',activeJobs:'active_jobs'};
const defaults={llmModel:'',llmPrices:null,llmGlobalTokensMonth:5000000,llmGlobalCostMicroMonth:null,asrRequireGpu:true,asrWindowSeconds:300,archiveMode:'off',archiveEvictAfterDays:null,llmBaseUrl:'',llmReasoningEffort:null,llmTimeoutMs:120000,asrUrl:'',asrTimeoutMs:120000};
const keys={llmModel:'llm.model',llmPrices:'llm.prices',llmGlobalTokensMonth:'llm.globalTokensMonth',llmGlobalCostMicroMonth:'llm.globalCostMicroMonth',asrRequireGpu:'asr.requireGpu',asrWindowSeconds:'asr.windowSeconds',archiveMode:'archive.mode',archiveEvictAfterDays:'archive.evictAfterDays',llmBaseUrl:'llm.baseUrl',llmReasoningEffort:'llm.reasoningEffort',llmTimeoutMs:'llm.timeoutMs',asrUrl:'asr.url',asrTimeoutMs:'asr.timeoutMs'};
// Write-only: nie in settings()/GET, nur als <name>Set. null = entfernen, '' = unverändert.
const secrets={llmApiKey:'llm.apiKey',asrToken:'asr.token'};
const connection=['llmBaseUrl','llmReasoningEffort','llmTimeoutMs','asrUrl','asrTimeoutMs',...Object.keys(secrets)];
export function settings(db){return Object.fromEntries(Object.entries(defaults).map(([k,v])=>{const r=db.sql.prepare('SELECT value FROM settings WHERE key=?').get(keys[k]);return [k,r?JSON.parse(r.value):v];}));}
const secret=(db,key)=>{const r=db.sql.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):null;};
export function settingsView(db){const s=settings(db);for(const [k,key] of Object.entries(secrets))s[k+'Set']=secret(db,key)!==null;return s;}
/** Prüft die KI-Dienst-Felder (auch für cli settings:import-env). */
export function connectionValid(k,v){
 if(k==='llmBaseUrl'||k==='asrUrl')return v===''||serviceUrl(v)!==null;
 if(k==='llmReasoningEffort')return v===null||['none','low','medium','high'].includes(v);
 if(k==='llmTimeoutMs')return Number.isSafeInteger(v)&&v>=1000&&v<=120000;
 if(k==='asrTimeoutMs')return Number.isSafeInteger(v)&&v>=1000&&v<=3600000;
 if(secrets[k])return v===null||typeof v==='string'&&v.length<=4096&&/^[\x21-\x7e]*$/.test(v);
 return false;
}
/** Adapter aus der DB neu bauen. Laufende ASR-Jobs halten ihre Adapter-Referenz; LLM-Jobs lesen ctx.llm beim Versand. */
export function refreshAdapters(ctx){
 const s=settings(ctx.db),o=ctx.adapterOverrides??{};
 const build=(create,cfg,missing)=>{try{return create(cfg);}catch(e){if(cfg.driver)throw e;return {missing};}};
 ctx.llm=build(createLlmAdapter,{baseUrl:s.llmBaseUrl,apiKey:secret(ctx.db,'llm.apiKey'),timeoutMs:s.llmTimeoutMs,reasoningEffort:s.llmReasoningEffort??undefined,...o.llm},['llm.config']);
 ctx.asr=build(createAsrAdapter,{url:s.asrUrl,token:secret(ctx.db,'asr.token'),timeoutMs:s.asrTimeoutMs,...o.asr},['asr.config']);
 ctx.asrCapability=undefined;ctx.asrHealthUntil=0;
}
export function capabilities(ctx){const s=settings(ctx.db);return {asr:ctx.asrCapability??{state:'configuration_required',model:null,device:null,timestamps:null,diarization:false,missing:ctx.asr?.missing??['asr.url']},llm:{state:llmConfiguration(ctx).missing.length?'configuration_required':'ready',provider:ctx.llm?.id?'openai':null,model:s.llmModel||null,dataScopes:['transcript_text','brief_text'],missing:llmConfiguration(ctx).missing},archive:{state:ctx.archiveCapability?.state??'configuration_required',mode:s.archiveMode,missing:ctx.archive?.missing??['STUDIO_ARCHIVE_DRIVER']},upload:{maxBytes:50*1024**3,mimeTypes:['audio/webm','audio/mp4','video/webm','video/mp4','audio/mpeg','audio/wav']}};}
const invalid=()=>problem(400,'invalid_input','Ungültige Verwaltungsdaten.');
const integer=v=>v===null||Number.isSafeInteger(v)&&v>=0;
export async function admin(ctx,req,res,pathname,user,{json,body}){
 if(!['/api/account/usage','/api/capabilities'].includes(pathname)&&!pathname.startsWith('/api/jobs')&&!pathname.startsWith('/api/admin/'))return false;
 requireUser(user);const sql=ctx.db.sql,q=quota(ctx.db),method=req.method,url=new URL(req.url,'http://localhost');const send=(status,value)=>{json(res,status,value);return true;};const nf=()=>problem(404,'not_found','Nicht gefunden.');
 if(pathname==='/api/account/usage'&&method==='GET')return send(200,q.usageOf(user.id));
 if(pathname==='/api/capabilities'&&method==='GET'){if(ctx.asr?.id){
 if(!ctx.asrHealthPending&&!(ctx.asrHealthUntil>Date.now())){
  ctx.asrHealthPending=(async()=>{const controller=new AbortController(),adapter=ctx.asr;let timer;let value;
   try{const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},1000);});const h=await Promise.race([adapter.health(controller.signal),deadline]);value={state:'ready',model:h.model,device:h.device,timestamps:h.timestamps,diarization:false,missing:[]};}
   catch{value={state:'unavailable',model:null,device:null,timestamps:null,diarization:false,missing:[]};}
   finally{clearTimeout(timer);controller.abort();if(ctx.asr===adapter){ctx.asrCapability=value;ctx.asrHealthUntil=Date.now()+5000;}}
  })().finally(()=>{ctx.asrHealthPending=null;});
 }
 if(ctx.asrHealthPending)await ctx.asrHealthPending;
 }ctx.archiveCapability=await archiveStatus(ctx);return send(200,capabilities(ctx));}
 if(pathname==='/api/jobs'&&method==='GET'){let rows=sql.prepare('SELECT * FROM jobs WHERE owner_id=? ORDER BY created_at DESC,rowid DESC').all(user.id);if(url.searchParams.get('active')==='1')rows=rows.filter(j=>['queued','running'].includes(j.status));const pid=url.searchParams.get('projectId');if(pid){const p=ctx.db.get('projects',pid);if(!p||p.ownerId!==user.id)throw nf();rows=rows.filter(j=>j.subject_type==='project'?j.subject_id===pid:ctx.db.get('recordings',ctx.db.get('tracks',j.subject_id)?.recordingId)?.projectId===pid);}return send(200,rows.slice(0,100).map(jobView));}
 const jm=pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(retry|cancel))?$/);if(jm){const j=ctx.work.get(jm[1]);const privileged=j&&['archive','evict'].includes(j.kind);if(!j||(j.owner_id!==user.id&&!(privileged&&user.role==='owner')))throw nf();if(method==='GET'&&!jm[2])return send(200,jobView(j));if(method==='POST'&&jm[2]){if(privileged&&user.role!=='owner')throw nf();limit(ctx,'job:'+user.id,30,60000);const updated=ctx.db.tx(()=>{if(privileged){const input={...JSON.parse(j.input??'{}'),actorId:user.id};sql.prepare('UPDATE jobs SET input=? WHERE id=?').run(JSON.stringify(input),j.id);sql.prepare('INSERT INTO audit(at,actor_id,action,subject) VALUES (?,?,?,?)').run(new Date().toISOString(),user.id,'archive.job.'+jm[2],j.id);}return ctx.work[jm[2]](j.id);});return send(jm[2]==='retry'?202:200,jobView(updated));}return false;}
 if(!pathname.startsWith('/api/admin/'))return false;if(user.role!=='owner')throw nf();
 const view=p=>({id:p.id,...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,p[v]]))});
 if(pathname==='/api/admin/plans'&&method==='GET')return send(200,sql.prepare('SELECT * FROM plans').all().map(view));
 const pm=pathname.match(/^\/api\/admin\/plans\/([^/]+)$/);if(pm&&method==='PUT'){if(!sql.prepare('SELECT id FROM plans WHERE id=?').get(pm[1]))throw nf();const b=await body(req);if(Object.keys(b).some(k=>!fields[k])||typeof b.name!=='string'||!b.name.trim()||b.name.length>120||Object.keys(fields).filter(k=>k!=='name').some(k=>!integer(b[k])))throw invalid();ctx.db.tx(()=>{sql.prepare('UPDATE plans SET name=?,asr_seconds_month=?,llm_tokens_month=?,llm_cost_micro_month=?,storage_bytes=?,active_jobs=?,updated_at=? WHERE id=?').run(...Object.keys(fields).map(k=>b[k]),new Date().toISOString(),pm[1]);audit('plan.update',pm[1]);});return send(200,view(sql.prepare('SELECT * FROM plans WHERE id=?').get(pm[1])));}
 function audit(action,subject){sql.prepare('INSERT INTO audit(at,actor_id,action,subject) VALUES (?,?,?,?)').run(new Date().toISOString(),user.id,action,subject);}
 if(pathname==='/api/admin/settings'){if(method==='GET')return send(200,settingsView(ctx.db));if(method==='PUT'){const b=await body(req);for(const [k,v] of Object.entries(b)){if(!keys[k]&&!secrets[k])throw invalid();if(connection.includes(k)&&!connectionValid(k,v))throw invalid();if(['llmGlobalTokensMonth','llmGlobalCostMicroMonth','archiveEvictAfterDays'].includes(k)&&!integer(v))throw invalid();if(k==='llmModel'&&(typeof v!=='string'||! /^[A-Za-z0-9._:-]{1,64}$/.test(v)))throw invalid();if(k==='llmPrices'&&v!==null&&(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='inputMicroPerMTok,outputMicroPerMTok'||!Number.isSafeInteger(v.inputMicroPerMTok)||v.inputMicroPerMTok<0||!Number.isSafeInteger(v.outputMicroPerMTok)||v.outputMicroPerMTok<0))throw invalid();if(k==='asrRequireGpu'&&typeof v!=='boolean'||k==='asrWindowSeconds'&&(!Number.isInteger(v)||v<60||v>1200)||k==='archiveMode'&&!['off','manual','auto'].includes(v))throw invalid();}ctx.db.tx(()=>{for(const [k,v] of Object.entries(b)){if(secrets[k]&&v==='')continue;if(secrets[k]&&v===null){sql.prepare('DELETE FROM settings WHERE key=?').run(secrets[k]);continue;}sql.prepare('INSERT INTO settings VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by').run(keys[k]??secrets[k],JSON.stringify(v),new Date().toISOString(),user.id);}audit('settings.update',null);});if(Object.keys(b).some(k=>connection.includes(k)))refreshAdapters(ctx);return send(200,settingsView(ctx.db));}}
 if(pathname==='/api/admin/usage'&&method==='GET'){const period=url.searchParams.get('period')??periodNow();if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||period.startsWith('0000'))throw invalid();return send(200,{period,platform:{llmTokens:q.meterState('*','llm_tokens',period),llmCostMicro:q.meterState('*','llm_cost_micro',period),asrSeconds:q.meterState('*','asr_seconds',period)},users:sql.prepare('SELECT id,email FROM users').all().map(u=>({userId:u.id,email:u.email,usage:q.usageOf(u.id,period),llmCostMicro:q.meterState(u.id,'llm_cost_micro',period).used})),unclear:sql.prepare("SELECT job_id jobId,user_id userId,settled_at at,reserved reservedTokens FROM usage WHERE period=? AND meter='llm_tokens' AND user_id!='*' AND note='nach_versand_unklar'").all(period)});}
 return false;
}
