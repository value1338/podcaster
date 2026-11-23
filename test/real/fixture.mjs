// Explicit test-only bootstrap: no service environment, no mount, no SMB semantics.
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export async function provider(){let calls=0;const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const v=JSON.parse(raw);calls++;const system=v.messages[0].content,source=JSON.parse(v.messages[1].content);let data=null;if(system.includes('zehn Titel'))data={titles:Array.from({length:10},(_,i)=>'Fixture '+i)};if(system.includes('Kapitel.'))data={chapters:[{startMs:source.segments[0].startMs,title:'Fixture'}]};res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({content:'Fixture only',data})}}],usage:{prompt_tokens:10,completion_tokens:20}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {base:'http://127.0.0.1:'+server.address().port+'/v1',get calls(){return calls;},async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};}
export async function archive(app,root,unavailable=false){
 const fail=()=>{throw Object.assign(Error('fixture'),{code:'archive_unavailable',status:503});};
 const target={id:'fixture',archiveId:'RA5-fixture',preflight:async()=>unavailable?fail():({freeBytes:10*1024**3}),stat:async rel=>fs.stat(path.join(root,rel)).then(s=>({bytes:s.size})).catch(()=>null),sha256:async rel=>createHash('sha256').update(await fs.readFile(path.join(root,rel))).digest('hex'),put:async(src,rel)=>{await fs.mkdir(path.dirname(path.join(root,rel)),{recursive:true});await fs.copyFile(src,path.join(root,rel),1);},commit:async(a,b)=>{await fs.link(path.join(root,a),path.join(root,b));await fs.unlink(path.join(root,a));},remove:async rel=>fs.unlink(path.join(root,rel)).catch(e=>{if(e.code!=='ENOENT')throw e;})};
 app.ctx.archive=target;const {archiveHandler}=await import('../../server/archive.mjs');app.ctx.work.handlers.archive=archiveHandler(app.ctx);
}
