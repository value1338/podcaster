import {test,expect} from 'vitest';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {testServer} from './hilfen.mjs';

// KI-Dienste werden in der Verwaltung gepflegt: Secrets write-only, nur owner, Adapter lesen die DB ohne Neustart.
test('KI-Dienste: write-only Secrets, owner-only, Adapter nutzt DB-Werte, CLI-Import ohne Werte',async()=>{
 const seen=[];const fixture=http.createServer(async(req,res)=>{for await(const _ of req);seen.push({url:req.url,auth:req.headers.authorization});
  if(req.url==='/v1/health'){res.end(JSON.stringify({ok:true,model:'fx',device:'cuda',timestamps:'segment',maxAudioSeconds:null}));return;}
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'ok'}}]}));});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+fixture.address().port;
 const s=await testServer();
 try{
  const r=await s.request('POST','/auth/token/'+s.link.url.split('/').at(-1),{password:'test-password-123'});const cookie=r.headers.get('set-cookie').split(';')[0];
  const req=(m,p,b)=>s.request(m,p,b,cookie);
  let g=await(await req('GET','/admin/settings')).json();
  expect(g).toMatchObject({llmBaseUrl:'',asrUrl:'',llmApiKeySet:false,asrTokenSet:false});expect('llmApiKey' in g).toBe(false);
  let caps=await(await req('GET','/capabilities')).json();
  expect(caps.llm.state).toBe('configuration_required');expect(caps.llm.missing).toContain('llm.apiKey');expect(caps.asr.missing).toEqual(['asr.url','asr.token']);
  for(const bad of [{llmBaseUrl:'http://u:p@host/v1'},{llmBaseUrl:'https://host/v1?x=1'},{llmBaseUrl:'https://host/#f'},{llmBaseUrl:'ftp://host'},{asrUrl:'nope'},{llmApiKey:'mit leerzeichen'},{llmApiKey:5},{llmTimeoutMs:0},{llmReasoningEffort:'max'}])
   expect((await req('PUT','/admin/settings',bad)).status).toBe(400);
  const secretKey='sk-geheim-123',secretToken='asr-geheim-456';
  const put=await req('PUT','/admin/settings',{llmBaseUrl:base+'/v1',llmApiKey:secretKey,llmModel:'m1',llmPrices:{inputMicroPerMTok:1,outputMicroPerMTok:1},asrUrl:base,asrToken:secretToken,asrTimeoutMs:5000});
  expect(put.status).toBe(200);const putText=await put.text();expect(putText).not.toContain(secretKey);expect(putText).not.toContain(secretToken);
  g=await(await req('GET','/admin/settings')).json();expect(g).toMatchObject({llmBaseUrl:base+'/v1',llmApiKeySet:true,asrTokenSet:true,asrTimeoutMs:5000});expect(JSON.stringify(g)).not.toContain('geheim');
  expect(JSON.stringify(s.app.ctx.db.sql.prepare('SELECT * FROM audit').all())).not.toContain('geheim');
  // Ohne Neustart wirksam.
  caps=await(await req('GET','/capabilities')).json();expect(caps.llm.state).toBe('ready');expect(caps.asr.state).toBe('ready');
  expect(seen.find(x=>x.url==='/v1/health').auth).toBe('Bearer '+secretToken);
  await s.app.ctx.llm.complete({model:'m1',system:'s',user:'u',maxOutputTokens:5},new AbortController().signal);
  expect(seen.at(-1)).toEqual({url:'/v1/chat/completions',auth:'Bearer '+secretKey});
  // '' = unverändert, null = entfernen.
  expect((await(await req('PUT','/admin/settings',{llmApiKey:''})).json()).llmApiKeySet).toBe(true);
  expect((await(await req('PUT','/admin/settings',{llmApiKey:null})).json()).llmApiKeySet).toBe(false);
  caps=await(await req('GET','/capabilities')).json();expect(caps.llm.state).toBe('configuration_required');expect(caps.llm.missing).toContain('llm.apiKey');
  // Nur owner.
  const invite=await(await req('POST','/admin/invites',{planId:'free',email:'ki-b@example.test'})).json();
  const br=await s.request('POST','/auth/token/'+invite.url.split('/').at(-1),{password:'member-password-123',displayName:'B'});const bc=br.headers.get('set-cookie').split(';')[0];
  expect((await s.request('GET','/admin/settings',undefined,bc)).status).toBe(404);
  expect((await s.request('PUT','/admin/settings',{llmApiKey:'x'},bc)).status).toBe(404);
  // CLI: übernimmt nur Fehlendes, gibt keine Werte aus.
  const out=await new Promise((resolve,reject)=>execFile(process.execPath,['server/cli.mjs','settings:import-env'],{env:{...process.env,STUDIO_DATA_DIR:s.dir,OPENAI_API_KEY:'sk-import-789',STUDIO_ASR_TOKEN:'asr-import-000',STUDIO_LLM_TIMEOUT_MS:'abc'}},(e,o)=>e?reject(e):resolve(o)));
  expect(out).not.toContain('import-');expect(JSON.parse(out)).toEqual({imported:['OPENAI_API_KEY'],kept:['STUDIO_ASR_TOKEN'],invalid:['STUDIO_LLM_TIMEOUT_MS']});
  const status=await new Promise((resolve,reject)=>execFile(process.execPath,['server/cli.mjs','status'],{env:{...process.env,STUDIO_DATA_DIR:s.dir}},(e,o)=>e?reject(e):resolve(o)));
  expect(JSON.parse(status).configured).toMatchObject({'llm.baseUrl':true,'llm.apiKey':true,'asr.url':true,'asr.token':true});
 }finally{await s.close();fixture.closeAllConnections();await new Promise(r=>fixture.close(r));}
});
