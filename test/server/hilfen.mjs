import { openDB } from '../../server/db.mjs';
import { migrate } from '../../server/migrate.mjs';
import { ownerCreate } from '../../server/accounts.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../../server/index.mjs';
export async function testServer(options={}) {
 // tmpfs: SQLite synchronous=FULL fsyncs on the I/O-loaded project disk took up to ~9 s per setup.
 const dir=await mkdtemp(path.join(os.tmpdir(),'studio-pa-test-'));
 let app;
 try {
 const link=await prepareTestDB(dir);
 app=await createStudioServer({origins:'http://127.0.0.1:8871',cookieInsecure:true,...options,dataDir:dir});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 return {app,dir,link,request:(method,p,body,cookie,extra)=>fetch('http://127.0.0.1:'+app.server.address().port+'/api'+p,{method,headers:{'X-Studio':'1',Origin:'http://127.0.0.1:8871','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)}),async close(){await app.close();await rm(dir,{recursive:true,force:true});}};
 } catch(error) {if(app)await app.close();await rm(dir,{recursive:true,force:true});throw error;}
}
// Public HTTP only: requires PA1. No test-only production account bootstrap.
export async function kontoAnlegen(request,token,input) {
 const response=await request('POST','/auth/token/'+encodeURIComponent(token),input);
 if(!response.ok)throw Error('Token einlösen: '+response.status);
 return response;
}
export async function anmelden(request,email,password) {
 const response=await request('POST','/auth/login',{email,password});
 if(!response.ok)throw Error('Anmelden: '+response.status);
 return response.headers.get('set-cookie')?.split(';')[0];
}

export async function prepareTestDB(dir){const file=path.join(dir,'studio.sqlite'),db=openDB(file);try{await migrate(db,file);return ownerCreate({db,base:''},'test-owner@example.test','Test Owner');}finally{db.close();}}
