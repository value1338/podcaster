// PA10: rerun existing browser journeys on fresh scratch builds. No product edits.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.env.PA10_OUT??'../Pruefungen/Plattform/PA10-Gesamt');
const scratch=await mkdtemp(path.resolve('../.pa10-browser-'));
const root='/tmp/pa10-root-build',podcast='/tmp/pa10-podcast-build';
const runs=[['konto','test/e2e/review-pa6.mjs',[root,podcast]],['recorder','test/e2e/review-pa7.mjs'],['integration','test/e2e/review-integration.mjs'],['video','test/e2e/review-video.mjs'],['video-recovery','test/e2e/review-video-recovery.mjs'],['f1f2','src/lib/recorder/f1f2.browser-check.mjs'],['upload','test/ui/pa8-upload-transkript.mjs',[root,podcast]],['upload-fixes','test/ui/pa8-reviewfixes.mjs',[root,podcast]],['ki','test/ui/pa9-ki.mjs',[root,podcast]]];
const results=[];
for(const [name,file,args] of runs.filter(r=>!process.argv[2]||process.argv[2].split(',').includes(r[0]))){const dir=path.join(out,name);await mkdir(dir,{recursive:true});let log='';const start=Date.now();const code=await new Promise(resolve=>{const p=spawn(process.execPath,[file,...(args?[...args,dir]:[])],{env:{...process.env,PORT:process.env.PORT??'8876',DIST:podcast,OUT:dir,SEK:'8',TMPDIR:scratch},stdio:['ignore','pipe','pipe']});p.stdout.on('data',b=>log+=b);p.stderr.on('data',b=>log+=b);p.on('exit',resolve)});await writeFile(path.join(out,name+'.log'),log);results.push({name,code,durationMs:Date.now()-start});await writeFile(path.join(out,'browser-runs.json'),JSON.stringify(results,null,2));console.log(name,code);}
await rm(scratch,{recursive:true,force:true});
process.exitCode=results.some(r=>r.code!==0)?1:0;
