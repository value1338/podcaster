import {mkdtempSync,rmSync} from 'node:fs';
import {openDB} from '../../server/db.mjs';
import {migrate} from '../../server/migrate.mjs';
import {ownerCreate} from '../../server/accounts.mjs';
import {createStudioServer} from '../../server/index.mjs';
const dir=mkdtempSync('../Pruefungen/review-csrf-'),file=dir+'/studio.sqlite',db=openDB(file);await migrate(db,file);const setup=ownerCreate({db,base:'/podcast'},'csrf@example.test','CSRF');db.close();
const origin='http://127.0.0.1:8877',base=origin+'/podcast/api';const app=await createStudioServer({dataDir:dir,base:'/podcast',origins:origin,cookieInsecure:true});await new Promise(r=>app.server.listen(8877,'127.0.0.1',r));
try{for(const [headers,expected] of [[{},403],[{'X-Studio':'1',Origin:'https://foreign.invalid'},403],[{'X-Studio':'1',Origin:origin},200]]){const r=await fetch(base+'/auth/token/'+setup.url.split('/').at(-1),{method:'POST',headers,body:JSON.stringify({password:'csrf-review-password'})});if(r.status!==expected)throw Error('Unexpected '+r.status);console.log('OK CSRF '+expected)}const r=await fetch(base+'/projects');if(r.status!==401)throw Error('AuthGate backend');console.log('OK no-session projects 401');}finally{await app.close();rmSync(dir,{recursive:true,force:true})}
