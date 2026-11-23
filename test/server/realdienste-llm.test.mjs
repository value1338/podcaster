import {test,expect} from 'vitest';
import http from 'node:http';
import {createLlmAdapter} from '../../server/llm-adapter.mjs';

// Removing validation or changing any wire field must fail these contract tests.
const env={apiKey:'ra3-synthetic-key'};
test.each([undefined,'none','low','medium','high'])('RA3 HTTP body with effort %s',async effort=>{
 const calls=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  calls.push({url:req.url,method:req.method,body:JSON.parse(raw)});
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'answer'}}],usage:{prompt_tokens:10,completion_tokens:20}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const adapter=createLlmAdapter({...env,baseUrl:`http://127.0.0.1:${server.address().port}/v1`,...(effort===undefined?{}:{reasoningEffort:effort})});
  for(const json of [true,false]){
   const result=await adapter.complete({model:'gpt-6-luna',system:'system',user:'user',maxOutputTokens:500,json},new AbortController().signal);
   expect(result).toEqual({text:'answer',model:'gpt-6-luna',inputTokens:10,outputTokens:20,invalid:false});
   expect(calls.at(-1)).toEqual({url:'/v1/chat/completions',method:'POST',body:{model:'gpt-6-luna',messages:[{role:'system',content:'system'},{role:'user',content:'user'}],max_completion_tokens:500,store:false,stream:false,...(json?{response_format:{type:'json_object'}}:{}),...(effort===undefined?{}:{reasoning_effort:effort})}});
   if(effort===undefined)expect('reasoning_effort' in calls.at(-1).body).toBe(false);
  }
  expect(calls).toHaveLength(2);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test.each(['turbo','','NONE',' none','high ','xhigh','max',0,false])('RA3 rejects invalid effort %s before dispatch',effort=>{
 expect(()=>createLlmAdapter({...env,reasoningEffort:effort})).toThrow('Ungültiges llm.reasoningEffort');
});
