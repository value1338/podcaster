// Actual MediaRecorder + camera/microphone fake device; no ffmpeg source fixture.
export async function streamBrowser(page,{base,id,epoch,seconds=20}){
 return page.evaluate(async({base,id,epoch,seconds})=>{
 const media=await navigator.mediaDevices.getUserMedia({video:{width:1280,height:720,frameRate:30},audio:true});
 const mimeType='video/webm;codecs=vp8,opus';
 const recorder=new MediaRecorder(media,{mimeType,videoBitsPerSecond:2500000});
 let tail=Promise.resolve(),seq=0;const chunks=[];let failed;
 recorder.ondataavailable=e=>{if(!e.data.size)return;const n=seq++;tail=tail.then(async()=>{const t=performance.now();const r=await fetch(`${base}/api/live/${id}/ingest/${epoch}/${n}`,{method:'PUT',headers:{'X-Studio':'1'},body:e.data});if(r.status!==204)throw Error('ingest '+r.status);chunks.push({seq:n,bytes:e.data.size,uploadMs:performance.now()-t});}).catch(e=>{failed=e.message;});};
 recorder.start(1000);await new Promise(r=>setTimeout(r,seconds*1000));await new Promise(r=>{recorder.onstop=r;recorder.stop();});await tail;media.getTracks().forEach(t=>t.stop());if(failed)throw Error(failed);return {mimeType,chunks};
 },{base,id,epoch,seconds});
}
