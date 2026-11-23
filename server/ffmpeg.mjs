import { spawn } from 'node:child_process';
export function run(command,args,{durationMs=0,signal,captureErrors=false,throttle=false}={}) {
 return new Promise((resolve,reject)=>{let output='',errors='',failure; const child=spawn(throttle?'nice':command,throttle?['-n','10',command,...args]:args,{stdio:['ignore','pipe','pipe'],signal});
 const timer=setTimeout(()=>child.kill('SIGKILL'),Math.max(300000,durationMs*4)); timer.unref();
 child.stdout.on('data',b=>{output=(output+b).slice(-262144);});child.stderr.on('data',b=>{errors=(errors+b).slice(captureErrors?-262144:-4000);});
 // Wait for close even after AbortError: shutdown must own the subprocess lifetime.
 child.on('error',e=>{failure=e;});child.on('close',code=>{clearTimeout(timer);if(failure){reject(failure);return;}code===0?resolve(captureErrors?errors:output):reject(Error(`${command} fehlgeschlagen (${code}): ${errors.slice(-1500)}`));}); });
}
export async function probe(file,options){const p=JSON.parse(await run('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],options)); const duration=Number(p.format?.duration); if(!Number.isFinite(duration)||duration<=0||!p.streams?.length)throw Error('Keine gültigen Medienströme/Dauer.');return p;}
export const ffmpeg=(args,options)=>run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y',...args.slice(0,-1),...(options?.throttle?['-threads','3']:[]),...args.slice(-1)],options);
