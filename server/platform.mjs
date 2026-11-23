import {planner} from './planner.mjs';
import {edits} from './edits.mjs';
import {render} from './render.mjs';
import {live} from './live.mjs';
import {archive} from './archive.mjs';
import {llm} from './llm.mjs';
import {transcripts} from './transcripts.mjs';
import { problem } from './storage.mjs';
import { requireUser } from './auth.mjs';
import { accounts } from './accounts.mjs';
import { admin } from './admin.mjs';
export async function platform(...args){
 const [ctx,req,,pathname,user]=args;
 if(await archive(...args))return true;
 if(await llm(...args))return true;
 if(await transcripts(...args))return true;
 const m=pathname.match(/^\/api\/(tracks|projects)\/([^/]+)\/(transcription|generations|restore)$/);
 const a=pathname.match(/^\/api\/admin\/tracks\/([^/]+)\/(archive|evict)$/);
 if((m||a)&&req.method==='POST'||pathname==='/api/llm/estimate'&&req.method==='POST'||pathname==='/api/admin/archive'&&req.method==='GET'){
 requireUser(user);if((a||pathname==='/api/admin/archive')&&user.role!=='owner')throw problem(404,'not_found','Nicht gefunden.');
 if(m||a){const row=ctx.db.get(a?'tracks':m[1],a?a[1]:m[2]);if(!row||row.ownerId!==user.id)throw problem(404,'not_found','Nicht gefunden.');}
 const service=a||pathname==='/api/admin/archive'||m?.[3]==='restore'?'archive':m?.[3]==='transcription'?'asr':'llm';
 throw problem(503,'configuration_required','Diensttreiber noch nicht eingerichtet.',{service,missing:['STUDIO_'+service.toUpperCase()+'_DRIVER']});
 }
 if(await live(...args))return true;
 if(await planner(...args))return true;
 if(await edits(...args))return true;
 if(await render(...args))return true;
 return await admin(...args)||await accounts(...args);
}
