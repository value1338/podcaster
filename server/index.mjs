import {createLive} from './live.mjs';
import {recoverRenders} from './render.mjs';
import {pelVersion,migrate} from './migrate.mjs';
import {adminSetup} from './setup.mjs';
import {existsSync} from 'node:fs';
import {createArchiveTarget} from './archive-target.mjs';
import {archiveHandler,archiveAuto} from './archive.mjs';
import {llmHandler} from './llm.mjs';
import {refreshAdapters} from './admin.mjs';
import {asrHandler} from './asr.mjs';
import { Work } from './work.mjs';
import { authConfig } from './auth.mjs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { openDB } from './db.mjs';
import { Jobs } from './jobs.mjs';
import { run } from './ffmpeg.mjs';
import { enqueueTrack } from './tracks.mjs';
import { enqueueExport } from './exports.mjs';
import { router } from './router.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function createStudioServer(options={}){
 const auth=authConfig(options);
 const dataDir=path.resolve(options.dataDir??process.env.STUDIO_DATA_DIR??path.join(root,'../../Daten'));await mkdir(dataDir,{recursive:true,mode:0o700});
 const file=path.join(dataDir,'studio.sqlite'),fresh=!existsSync(file);// Erstinstallation darf sich selbst initialisieren; Bestandsdaten nur per cli.mjs migrate.
 const db=openDB(file);if(db.sql.prepare('PRAGMA user_version').get().user_version!==1||pelVersion(db.sql)!==1){if(fresh)await migrate(db,file);else{db.close();throw Error('Explizite Migration erforderlich');}}const ctx={auth,dataDir,db,jobs:new Jobs(),uploads:new Set(),base:(options.base??process.env.STUDIO_BASE_PATH??'').replace(/\/$/,''),dist:options.dist??path.join(root,'../dist'),hasFFmpeg:false};
 try{await adminSetup(ctx,options.setupEnv??process.env);}catch(error){db.close();throw error;}
 try{await run('ffmpeg',['-version']);await run('ffprobe',['-version']);ctx.hasFFmpeg=true;}catch{}
 ctx.archive=createArchiveTarget(options.archiveEnv??process.env);ctx.archiveLocks=new Set();ctx.archiveReaders=new Map();
 // KI-Dienste aus der Verwaltung (settings); llmConfig/asrConfig nur als Test-Override.
 ctx.adapterOverrides={llm:options.llmConfig,asr:options.asrConfig};refreshAdapters(ctx);
 ctx.work=new Work(ctx,{...(ctx.archive.id?{archive:archiveHandler(ctx),restore:archiveHandler(ctx),evict:archiveHandler(ctx)}:{}),llm:llmHandler(ctx),asr:asrHandler(ctx),...options.workHandlers});
 const archiveTimer=setInterval(()=>{try{archiveAuto(ctx);}catch{console.error('Podcast-Studio archive scheduler failure internal');}},5000);archiveTimer.unref();
 ctx.live=createLive(ctx);
 recoverRenders(ctx);ctx.live.recover();
 const server=http.createServer(router(ctx));server.requestTimeout=300000;server.headersTimeout=30000;
 for(const t of db.all('tracks'))if(t.ownerId&&t.status==='processing')enqueueTrack(ctx,t);for(const e of db.all('exports'))if(e.ownerId&&['queued','processing'].includes(e.status))enqueueExport(ctx,e);
 return {server,ctx,async close(){await ctx.live.close();clearInterval(archiveTimer);await new Promise(resolve=>server.close(resolve));await ctx.work.close();await ctx.jobs.close();db.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 // Standard Loopback; andere Adresse (z. B. 0.0.0.0 im Container) nur bewusst und hinter Reverse-Proxy.
 const app=await createStudioServer();app.server.listen(Number(process.env.STUDIO_PORT??8850),process.env.STUDIO_HOST||'127.0.0.1',()=>console.log('Podcast-Studio: '+JSON.stringify(app.server.address())));
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
