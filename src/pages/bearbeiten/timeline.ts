import type {Edl,Transcript} from '../../lib/api';
import {timeline,validate} from '../../../server/edl.mjs';
export const newClipId=()=>crypto.randomUUID().replaceAll('-','');
/** Remove an episode-time interval. No inferred word timings and no source mutation. */
export function cutRange(edl:Edl,startMs:number,endMs:number):Edl{
 if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||startMs<0||endMs<=startMs)throw new Error('Ungültige Textauswahl.');
 const clips=timeline(edl).flatMap(c=>{
  if(endMs<=c.startMs||startMs>=c.endMs)return [{id:c.clipId,trackId:c.trackId,inMs:c.inMs,outMs:c.outMs}];
  const result=[];
  if(startMs>c.startMs)result.push({id:c.clipId,trackId:c.trackId,inMs:c.inMs,outMs:c.inMs+startMs-c.startMs});
  if(endMs<c.endMs)result.push({id:result.length?newClipId():c.clipId,trackId:c.trackId,inMs:c.inMs+endMs-c.startMs,outMs:c.outMs});
  return result;
 });return validate({v:1,clips},undefined);
}
export interface TextUnit {key:string;clipId:string;trackId:string;text:string;startMs:number;endMs:number;precise:boolean}
export function transcriptUnits(edl:Edl,transcripts:Record<string,Transcript>):TextUnit[]{
 return timeline(edl).flatMap(c=>{const t=transcripts[c.trackId];if(!t||t.timestamps==='none')return [];return t.segments.flatMap(s=>(s.words?.length?s.words:[s]).flatMap((w,i)=>{const start=Math.max(c.inMs,Math.round(w.startMs)),end=Math.min(c.outMs,Math.round(w.endMs));return end>start?[{key:c.clipId+':'+s.id+':'+i,clipId:c.clipId,trackId:c.trackId,text:w.text,startMs:c.startMs+start-c.inMs,endMs:c.startMs+end-c.inMs,precise:!!s.words?.length}]:[];}));});
}
