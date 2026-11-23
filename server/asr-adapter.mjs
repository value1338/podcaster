import {createReadStream} from 'node:fs';
import {serviceUrl} from './llm-adapter.mjs';
export const asrError=(code,retryable=false)=>Object.assign(Error(code),{code,retryable});
const bad=()=>{throw asrError('asr_bad_response');};
export function healthValue(v){if(!v||typeof v.model!=='string'||!v.model||!['cuda','cpu','unknown'].includes(v.device)||!['word','segment','none'].includes(v.timestamps)||!(v.maxAudioSeconds===null||Number.isFinite(v.maxAudioSeconds)&&v.maxAudioSeconds>0))bad();return {model:v.model,device:v.device,timestamps:v.timestamps,maxAudioSeconds:v.maxAudioSeconds};}
export function normalize(v,durationMs,h){
 if(!v||typeof v.text!=='string'||!(v.language===null||typeof v.language==='string'))bad();
 const meta=healthValue({...h,...v,maxAudioSeconds:null});const mode=v.timestamps??h.timestamps;
 const timed=(x,lo,hi,word=false)=>{if(!x||typeof x!=='object')bad();let startMs=Math.round(x.start*1000),endMs=Math.round(x.end*1000);const text=word?x.word:x.text;const toleranceMs=100;if(typeof x.start!=='number'||typeof x.end!=='number'||!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<lo-toleranceMs||endMs<startMs||endMs>hi+toleranceMs||startMs>hi+toleranceMs||typeof text!=='string')bad();startMs=Math.max(lo,Math.min(hi,startMs));endMs=Math.max(startMs,Math.min(hi,endMs));return {startMs,endMs,text};};
 let segments=[];
 if(mode==='none')segments=[{startMs:0,endMs:durationMs,text:v.text}];
 else if(Array.isArray(v.segments)&&v.segments.length){let previous=0;segments=v.segments.map(s=>{const out=timed(s,previous,durationMs);previous=out.endMs;if(mode==='word'){if(!Array.isArray(s.words)||!s.words.length)bad();let last=out.startMs;out.words=s.words.map(w=>{const t=timed(w,last,out.endMs,true);last=t.endMs;return t;});}return out;});}
 else if(mode==='word'&&Array.isArray(v.words)){let last=0,current;for(const w of v.words){const t=timed(w,last,durationMs,true);if(!current||t.startMs-last>800||t.endMs-current.startMs>15000||/[.!?]$/.test(current.text)){current={startMs:t.startMs,endMs:t.endMs,text:'',words:[]};segments.push(current);}current.words.push(t);current.text+=(current.text?' ':'')+t.text;current.endMs=t.endMs;last=t.endMs;}}
 else if(v.text.trim())bad();
 return {text:v.text,language:v.language,...meta,timestamps:mode,segments};
}
export function createAsrAdapter(cfg={}){
 if(cfg.driver==='fake'){if(process.env.NODE_ENV!=='test')throw Error('Fake-ASR nur in Tests erlaubt');return {id:'fake',health:async()=>({model:'test-only',device:'cuda',timestamps:'segment',maxAudioSeconds:1200}),transcribe:async i=>({text:'Test',language:i.language,model:'test-only',device:'cuda',timestamps:'segment',segments:[{startMs:0,endMs:i.durationMs,text:'Test'}]})};}
 const missing=[],base=serviceUrl(cfg.url),token=cfg.token;if(!base)missing.push('asr.url');if(!token)missing.push('asr.token');
 if(missing.length)return {missing};
 const timeout=cfg.timeoutMs??120000;if(!Number.isSafeInteger(timeout)||timeout<1)throw Error('Ungültiges asr.timeoutMs');
 const request=async(p,signal,init={})=>{const deadline=AbortSignal.timeout(timeout);try{const r=await fetch(base.href.replace(/\/$/,'')+p,{...init,redirect:'error',signal:AbortSignal.any([signal,deadline]),headers:{Authorization:'Bearer '+token,...init.headers}});if(!r.ok)throw asrError(r.status>=500||r.status===429?'asr_unavailable':'asr_rejected',r.status>=500||r.status===429);let bytes=0,chunks=[];for await(const b of r.body){bytes+=b.length;if(bytes>8*1024*1024)bad();chunks.push(Buffer.from(b));}try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{bad();}}catch(e){if(String(e.code).startsWith('asr_'))throw e;if(signal.aborted)throw e;throw asrError(deadline.aborted?'asr_timeout':'asr_unavailable',true);}};
 return {id:'studio-asr-v1',health:async signal=>{const v=await request('/v1/health',signal);if(v?.ok!==true)bad();return healthValue(v);},async transcribe(i,signal){const h=await this.health(signal);const stream=createReadStream(i.wavPath);try{return normalize(await request('/v1/transcriptions'+(i.language?'?language='+encodeURIComponent(i.language):''),signal,{method:'POST',headers:{'Content-Type':'audio/wav','X-Request-Id':i.requestId},body:stream,duplex:'half'}),i.durationMs,h);}finally{stream.destroy();}}};
}
