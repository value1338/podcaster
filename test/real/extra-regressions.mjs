import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {run} from './abnahme.mjs';
const root=path.resolve('test/real/evidence/extra-'+Date.now());await fs.mkdir(root);
const audio=root+'/audio.wav';execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=duration=1',audio]);
Object.assign(process.env,{NODE_ENV:'test',STUDIO_ASR_DRIVER:'fake',OPENAI_API_KEY:'synthetic-extra-secret'});
const results=[];
for(const mode of ['clean','transcript','version','partial','secret']){
 const d=root+'/'+mode;await fs.mkdir(d);const ar=d+'/archive';await fs.mkdir(ar);const out=d+'/out';
 for(const n of ['db','migrate','accounts'])await fs.writeFile(d+'/'+n+'.mjs',`export * from ${JSON.stringify(path.resolve('server/'+n+'.mjs'))};`,{flag:'wx'});
 const code=`import {createStudioServer as real} from ${JSON.stringify(path.resolve('server/index.mjs'))};
import {archive} from ${JSON.stringify(path.resolve('test/real/fixture.mjs'))};
import * as fs from 'node:fs/promises';import path from 'node:path';
export async function createStudioServer(opts){const app=await real({...opts,archiveEnv:{},llmEnv:{},asrEnv:{NODE_ENV:'test',STUDIO_ASR_DRIVER:'fake'}});await archive(app,${JSON.stringify(ar)});
${mode==='partial'?"app.ctx.archive.commit=async()=>{throw Error('fixture_partial');};":''}
const close=app.close.bind(app);app.close=async()=>{await close();
${mode==='version'?`const files=await fs.readdir(${JSON.stringify(ar)},{recursive:true});const f=files.find(f=>f.endsWith('original.wav'));await fs.writeFile(path.join(${JSON.stringify(ar)},path.dirname(f),'manifest-backup-2020.json'),'KEEP VERSION',{flag:'wx'});`:''}
${mode==='secret'?`await fs.writeFile(${JSON.stringify(out+'/foreign.txt')},process.env.OPENAI_API_KEY,{flag:'wx'});`:''}
};return app;}`;
 await fs.writeFile(d+'/server.mjs',code,{flag:'wx'});process.env.STUDIO_ARCHIVE_PATH=ar;
 let error;try{await run(['--server',d+'/server.mjs','--audio',audio,'--out',out,'--stufen',mode==='transcript'?'asr,archiv':'archiv']);}catch(e){error={stage:e.stage,code:e.code,message:e.message};}
 const cleanup=JSON.parse(await fs.readFile(out+'/cleanup.json'));
 if(['clean','transcript'].includes(mode)){assert.equal(error,undefined);assert.equal(cleanup.dataRemoved,true);assert.equal((await fs.readdir(ar,{recursive:true})).some(n=>n.endsWith('.json')||n.endsWith('.wav')),false);}
 else if(mode==='secret'){assert.equal(error.code,'secret_detected');assert.equal(await fs.readFile(out+'/foreign.txt','utf8'),process.env.OPENAI_API_KEY);assert.ok(!error.message.includes(process.env.OPENAI_API_KEY));}
 else {assert.ok(error);assert.equal(cleanup.dataRemoved,false);const db=JSON.parse(await fs.readFile(out+'/retainedDataDir.json'));assert.ok((await fs.stat(db+'/studio.sqlite')).size>0);}
 results.push({mode,error,cleanup});
}
await fs.writeFile(root+'/summary.json',JSON.stringify(results,null,2),{flag:'wx'});await fs.unlink(audio);console.log(root);
