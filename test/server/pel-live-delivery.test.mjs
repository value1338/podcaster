import {test,expect,vi} from 'vitest';
const boundary=vi.hoisted(()=>({afterStat:()=>{},sent:0}));
vi.mock('node:fs/promises',async original=>({...await original(),lstat:async()=>{boundary.afterStat();return {isFile:()=>true,isSymbolicLink:()=>false};}}));
vi.mock('../../server/storage.mjs',async original=>({...await original(),sendFile:async()=>{boundary.sent++;}}));
import {createLive} from '../../server/live.mjs';
import {hashToken} from '../../server/auth.mjs';
test('Mediendatei benötigt nach Dateiprüfung weiterhin eine gültige Freigabe',async()=>{
 const row={id:'local-fixture',status:'live',token_hash:hashToken('fixture-link'),epoch:1};
 const ctx={base:'',dataDir:'/unused-fixture',auth:{limits:new Map()},db:{sql:{prepare:()=>({get:()=>row,all:()=>[]})}}};
 const live=createLive(ctx);let cookie='';const response={setHeader:(k,v)=>{cookie=v.split(';')[0];},writeHead:()=>{},end:()=>{}};
 const req={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{}};
 const helpers={body:async()=>({token:'fixture-link'}),json:()=>{}};
 try{
 await live.handle(req,response,'/api/watch/enter',null,helpers);
 boundary.sent=0;boundary.afterStat=()=>{row.token_hash=null;};
 await expect(live.handle({...req,method:'GET',headers:{cookie}},response,'/api/watch/hls/1/init.mp4',null,helpers)).rejects.toMatchObject({code:'not_found'});
 expect(boundary.sent).toBe(0);
 }finally{boundary.afterStat=()=>{};await live.close();}
});
