import {api, ApiError} from '../api';
export const LIVE_MIMES=['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/mp4;codecs=avc1.4D401F,mp4a.40.2','video/mp4'];
export const recorderMime=()=>typeof MediaRecorder==='undefined'?null:LIVE_MIMES.find(m=>MediaRecorder.isTypeSupported(m))??null;
export type SenderState={status:'bereit'|'sendet'|'gestört'|'unterbrochen';queued:number;message?:string};
/** One recorder/container per epoch. Never reorder or drop a chunk and continue. */
export class LiveSender {
 private generation=0; private recorder?:MediaRecorder; private abort?:AbortController;
 constructor(private notify:(s:SenderState)=>void){}
 cancel(){this.generation++;this.abort?.abort();if(this.recorder?.state!=='inactive')this.recorder?.stop();this.recorder=undefined;}
 async start(id:string,stream:MediaStream){
 this.cancel();const g=this.generation,mime=recorderMime();if(!mime)throw Error('Dieser Browser unterstützt kein geeignetes Sendeformat.');
 const {epoch}=await api.liveStart(id,mime);if(g!==this.generation)return;
 const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:2500000});this.recorder=recorder;
 const queue:Blob[]=[];let uploading=false,seq=0;const valid=()=>g===this.generation;
 const fail=(message:string)=>{if(!valid())return;this.cancel();queue.length=0;this.notify({status:'unterbrochen',queued:0,message});};
 const pump=async()=>{if(uploading)return;uploading=true;try{while(valid()&&queue.length){let success=false;for(let attempt=0;attempt<6&&valid();attempt++){
 const controller=new AbortController();this.abort=controller;const timer=setTimeout(()=>controller.abort(),6000);
 try{await api.request<void>('PUT',`/live/${encodeURIComponent(id)}/ingest/${epoch}/${seq}`,queue[0],controller.signal);success=true;break;}
 catch(e){if(!valid())return;if(e instanceof ApiError&&e.status!==0&&e.status<500)throw e;this.notify({status:'gestört',queued:queue.length,message:'Verbindung gestört – Wiederholung '+(attempt+1)});await new Promise(r=>setTimeout(r,500*(attempt+1)));}finally{clearTimeout(timer);}}
 if(!valid())return;if(!success)throw Error('Verbindung unterbrochen. Nach Serverfreigabe fortsetzen.');queue.shift();seq++;this.notify({status:'sendet',queued:queue.length});}}
 catch{fail('Übertragung unterbrochen. Nach Serverfreigabe fortsetzen.');}finally{uploading=false;}};
 recorder.ondataavailable=e=>{if(!valid()||!e.data.size)return;if(e.data.size>4194304||queue.length>=15){fail('Sendepuffer voll oder Abschnitt zu groß. Sendung unterbrochen.');return;}queue.push(e.data);void pump();};
 recorder.onerror=()=>fail('Kameraübertragung fehlgeschlagen.');recorder.start(1000);this.notify({status:'sendet',queued:0});
 }
}
