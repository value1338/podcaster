import {api} from '../api';
export const CODEC='video/mp4; codecs="avc1.4D401F, mp4a.40.2"';
export function playlist(text:string){
 if(text.length>16384||!text.startsWith('#EXTM3U'))throw Error('Ungültige Live-Playlist.');
 const lines=text.trim().split(/\r?\n/);const init=lines.find(l=>l.startsWith('#EXT-X-MAP:'));
 if(init!=='#EXT-X-MAP:URI="init.mp4"')throw Error('Ungültiger Medienanfang.');
 const sequence=Number(lines.find(l=>l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1]);
 const files=lines.filter(l=>l&&!l.startsWith('#'));
 if(!Number.isSafeInteger(sequence)||sequence<0||files.length>6||!files.every((f,i)=>/^seg-\d{1,7}\.m4s$/.test(f)&&f===`seg-${sequence+i}.m4s`))throw Error('Ungültige Live-Segmente.');
 return {sequence,files};
}
export function clearVideo(video:HTMLVideoElement){video.pause();video.removeAttribute('src');video.load();}
/** Bounded sequential loader; each epoch owns a fresh MediaSource and cancellation tree. */
export function playLive(video:HTMLVideoElement,epoch:number,onError:(message:string)=>void,forceMse=false){
 const abort=new AbortController();let source:MediaSource|undefined,url:string|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const dispose=()=>{abort.abort();clearTimeout(timer);clearVideo(video);if(url)URL.revokeObjectURL(url);};
 if(!forceMse&&video.canPlayType('application/vnd.apple.mpegurl')){
 let fallback:(()=>void)|undefined;let check:ReturnType<typeof setTimeout>;
 const failed=()=>{video.removeEventListener('error',failed);clearTimeout(check);dispose();fallback=playLive(video,epoch,onError,true);};
 video.addEventListener('error',failed,{once:true});video.src=api.watchHlsUrl(epoch,'index.m3u8');void video.play().catch(()=>{});
 check=setTimeout(()=>{if(!video.videoWidth)failed();},5000);
 return ()=>{video.removeEventListener('error',failed);clearTimeout(check);dispose();fallback?.();};
 }
 if(typeof MediaSource==='undefined'||!MediaSource.isTypeSupported(CODEC)){onError('Dieser Browser unterstützt die Live-Wiedergabe nicht.');return dispose;}
 source=new MediaSource();url=URL.createObjectURL(source);
 const bytes=async(file:string)=>{const res=await fetch(api.watchHlsUrl(epoch,file),{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(4000)]),credentials:'same-origin',cache:'no-store'});if(!res.ok)throw Error(String(res.status));const b=await res.arrayBuffer();if(b.byteLength>8388608)throw Error('Medienabschnitt zu groß.');return b;};
 const run=async()=>{try{
 if(abort.signal.aborted||source!.readyState!=='open')return;const buffer=source!.addSourceBuffer(CODEC);
 const update=(action:()=>void)=>new Promise<void>((resolve,reject)=>{const done=()=>{cleanup();resolve();};const fail=()=>{cleanup();reject(Error('Medienpuffer abgebrochen.'));};const cleanup=()=>{buffer.removeEventListener('updateend',done);buffer.removeEventListener('error',fail);abort.signal.removeEventListener('abort',fail);};buffer.addEventListener('updateend',done,{once:true});buffer.addEventListener('error',fail,{once:true});abort.signal.addEventListener('abort',fail,{once:true});try{action();}catch(e){cleanup();reject(e);}});
 let next:number|undefined,initialized=false,lastTime=-1,stalledAt=Date.now();
 const tick=async()=>{if(abort.signal.aborted)return;try{
 const r=await fetch(api.watchHlsUrl(epoch,'index.m3u8'),{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(4000)]),credentials:'same-origin',cache:'no-store'});
 if(!r.ok)throw Error(String(r.status));const p=playlist(await r.text());
 if(!initialized){const b=await bytes('init.mp4');await update(()=>buffer.appendBuffer(b));initialized=true;}
 next=Math.max(next??p.sequence,p.sequence);
 for(let i=next-p.sequence;i<p.files.length;i++){const b=await bytes(p.files[i]);await update(()=>buffer.appendBuffer(b));next=p.sequence+i+1;}
 if(buffer.buffered.length){const end=buffer.buffered.end(buffer.buffered.length-1);if(end-video.currentTime>6||video.currentTime<buffer.buffered.start(0))video.currentTime=Math.max(buffer.buffered.start(0),end-4);if(video.currentTime>30&&buffer.buffered.start(0)<video.currentTime-30)await update(()=>buffer.remove(0,video.currentTime-30));}
 if(video.currentTime!==lastTime){lastTime=video.currentTime;stalledAt=Date.now();}else if(Date.now()-stalledAt>8000)throw Error('stall');
 void video.play().catch(()=>{});
 }catch(e){if(abort.signal.aborted)return;/* 404 may be an expired segment; discard old frame while state heartbeat resolves authority. */
 clearVideo(video);onError(e instanceof Error&&e.message==='404'?'Livebild wird neu verbunden.':'Live-Wiedergabe unterbrochen.');dispose();return;}
 timer=setTimeout(()=>void tick(),1000);};void tick();
 }catch{if(!abort.signal.aborted){dispose();onError('Live-Wiedergabe unterbrochen.');}}};
 source.addEventListener('sourceopen',()=>void run(),{once:true});video.src=url;return dispose;
}
