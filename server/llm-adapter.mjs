export const llmError=code=>Object.assign(Error(code),{code,sent:true,retryable:false});
// Dienst-URL aus der Verwaltung: http(s), ohne Benutzerinfo/Query/Fragment. null = ungültig.
export function serviceUrl(v){if(typeof v!=='string'||!v||v.length>2048||/[?#\s]/.test(v))return null;try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u:null;}catch{return null;}}
// Konfiguration kommt aus der settings-Tabelle (admin.mjs refreshAdapters), nicht aus der Umgebung.
// Dispatch itself is ambiguous: DNS/connect errors are deliberately not retryable.
export function createLlmAdapter(cfg={}){
 const effort=cfg.reasoningEffort??undefined;
 if(effort!==undefined&&!['none','low','medium','high'].includes(effort))throw Error('Ungültiges llm.reasoningEffort');
 if(cfg.driver==='fake'){
  if(process.env.NODE_ENV!=='test')throw Error('Fake-LLM nur in Tests erlaubt');
  return {id:'fake',complete:async i=>({text:JSON.stringify({content:'Test',data:null}),model:i.model,inputTokens:null,outputTokens:null})};
 }
 const missing=[],base=serviceUrl(cfg.baseUrl),apiKey=cfg.apiKey;if(!base)missing.push('llm.baseUrl');if(!apiKey)missing.push('llm.apiKey');
 if(missing.length)return {missing};
 const timeout=cfg.timeoutMs??120000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw Error('Ungültiges llm.timeoutMs');
 return {id:'openai',async complete(i,signal){
 const controller=new AbortController();const combined=AbortSignal.any([signal,controller.signal]);let timer;
 // Race bounds the lane even if a transport implementation fails to settle on abort.
 const stopped=new Promise((_,reject)=>{const stop=()=>reject(llmError('llm_unclear'));combined.addEventListener('abort',stop,{once:true});if(combined.aborted)stop();timer=setTimeout(()=>controller.abort(),timeout);});
 const request=async()=>{try{
 const r=await fetch(base.href.replace(/\/$/,'')+'/chat/completions',{method:'POST',redirect:'error',signal:combined,headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:i.model,messages:[{role:'system',content:i.system},{role:'user',content:i.user}],max_completion_tokens:i.maxOutputTokens,store:false,stream:false,...(effort===undefined?{}:{reasoning_effort:effort}),...(i.json?{response_format:{type:'json_object'}}:{})})});
 if(!r.ok){await r.body?.cancel();throw llmError([400,401,403,404,413,422,429].includes(r.status)?'llm_rejected':'llm_unclear');}
 let size=0,chunks=[];for await(const b of r.body){size+=b.length;if(size>1024*1024){controller.abort();throw llmError('llm_unclear');}chunks.push(Buffer.from(b));}
 const raw=Buffer.concat(chunks).toString('utf8');
 if(raw.includes(apiKey))throw llmError('llm_unclear');
 const v=JSON.parse(raw),c=v?.choices?.[0];
 const usage=v.usage;const valid=n=>Number.isSafeInteger(n)&&n>=0;const has=valid(usage?.prompt_tokens)&&valid(usage?.completion_tokens)&&Number.isSafeInteger(usage.prompt_tokens+usage.completion_tokens);
 return {text:typeof c?.message?.content==='string'?c.message.content:'',model:i.model,inputTokens:has?usage.prompt_tokens:null,outputTokens:has?usage.completion_tokens:null,invalid:c?.finish_reason!=='stop'||!!c?.message?.refusal};
 }catch(e){if(e?.code==='llm_rejected')throw e;throw llmError('llm_unclear');}};
 try{return await Promise.race([request(),stopped]);}finally{clearTimeout(timer);controller.abort();}
 }};
}
