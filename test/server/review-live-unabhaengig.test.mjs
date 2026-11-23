import {test,expect} from 'vitest';
import {testServer,kontoAnlegen,anmelden} from './hilfen.mjs';
// Unabhängiges Review 2026-11-21: Belegtests, ändern keinen Produktivcode.
async function setup(){
 const s=await testServer();
 await kontoAnlegen(s.request,s.link.url.split('/').at(-1),{password:'Testpassword-1234',name:'Owner'});
 const a=await anmelden(s.request,'test-owner@example.test','Testpassword-1234');
 const inv=await (await s.request('POST','/admin/invites',{email:'b@example.test',planId:'pro'},a)).json();
 await kontoAnlegen(s.request,inv.url.split('/').at(-1),{password:'Testpassword-1234',displayName:'B',email:'b@example.test'});
 const b=await anmelden(s.request,'b@example.test','Testpassword-1234');
 const made=await (await s.request('POST','/live',{publicTitle:'A-Sendung'},a)).json();
 return {s,a,b,id:made.live.id,token:made.link.url.split('#t=')[1]};
}
test('Mandantentrennung: Konto B erhält 404 auf alle Steuerrouten von A, A bleibt unverändert',async()=>{
 const {s,a,b,id,token}=await setup();
 try{
  for(const [m,p,body] of [['GET',`/live/${id}`],['POST',`/live/${id}/stop`,{}],['POST',`/live/${id}/link`,{}],['DELETE',`/live/${id}/link`],['POST',`/live/${id}/start`,{mimeType:'video/webm'}]])
   expect((await s.request(m,p,body,b)).status,m+' '+p).toBe(404);
  expect((await (await s.request('GET','/live',undefined,b)).json()).length).toBe(0);
  const own=await (await s.request('GET',`/live/${id}`,undefined,a)).json();expect(own.status).toBe('created');expect(own.linkActive).toBe(true);
  expect((await s.request('POST','/watch/enter',{token})).status).toBe(204);
 }finally{await s.close();}
});
test('W1 behoben: Fehlversuche sperren nur den eigenen Proxy-Peer, gültige Links bleiben offen',async()=>{
 const {s,token}=await setup();
 try{
  const xff=ip=>({'X-Forwarded-For':ip});
  for(let i=0;i<20;i++)expect((await s.request('POST','/watch/enter',{token:'falsch-'+i},undefined,xff('100.64.0.9'))).status).toBe(404);
  expect((await s.request('POST','/watch/enter',{token:'falsch-x'},undefined,xff('100.64.0.9'))).status).toBe(429);
  expect((await s.request('POST','/watch/enter',{token:'falsch-y'},undefined,xff('100.64.0.10'))).status).toBe(404);
  expect((await s.request('POST','/watch/enter',{token},undefined,xff('100.64.0.9'))).status).toBe(204);
 }finally{await s.close();}
});
test('Widerruf/Rotation: alter Zuschauer-Cookie sofort 404 auf state und hls',async()=>{
 const {s,a,id,token}=await setup();
 try{
  const wc=(await s.request('POST','/watch/enter',{token})).headers.get('set-cookie').split(';')[0];
  expect((await s.request('GET','/watch/state',undefined,wc)).status).toBe(200);
  const neu=await (await s.request('POST',`/live/${id}/link`,{},a)).json();
  expect((await s.request('GET','/watch/state',undefined,wc)).status).toBe(404);
  expect((await s.request('GET','/watch/hls/0/index.m3u8',undefined,wc)).status).toBe(404);
  expect((await s.request('POST','/watch/enter',{token})).status).toBe(404);
  const wc2=(await s.request('POST','/watch/enter',{token:neu.url.split('#t=')[1]})).headers.get('set-cookie').split(';')[0];
  expect((await s.request('DELETE',`/live/${id}/link`,undefined,a)).status).toBe(204);
  expect((await s.request('GET','/watch/state',undefined,wc2)).status).toBe(404);
  // Pfadmanipulation: kodierte Trenner und fremde Dateitypen
  for(const f of ['..%2F..%2Fstudio.sqlite','%2e%2e%2fstudio.sqlite','index.m3u8.tmp','seg-1.m4s%00','x.mp4'])
   expect([400,404]).toContain((await s.request('GET','/watch/hls/0/'+f,undefined,wc2)).status);
 }finally{await s.close();}
});
