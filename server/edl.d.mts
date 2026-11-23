export interface EdlClip { id:string; trackId:string; inMs:number; outMs:number }
export interface Edl { v:1; clips:EdlClip[] }
export interface TimelineClip extends EdlClip { clipId:string; startMs:number; endMs:number }
export function validate(edl:unknown,tracks:unknown):Edl;
export function durationMs(edl:Edl):number;
export function timeline(edl:Edl):Omit<TimelineClip,'id'>[];
export function toSource(edl:Edl,editMs:number):{clipId:string;trackId:string;sourceMs:number}|null;
export function split(edl:Edl,clipId:string,editMs:number,newId:string):Edl;
export function trim(edl:Edl,clipId:string,bounds:{inMs?:number;outMs?:number}):Edl;
export function remove(edl:Edl,clipId:string):Edl;
export function move(edl:Edl,clipId:string,toIndex:number):Edl;
export function canonical(edl:Edl):string;
