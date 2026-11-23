import {canonical,validate} from '../../../server/edl.mjs';
import type {Edl} from '../../lib/api';
export type History={present:Edl;past:Edl[];future:Edl[]};
export const history=(present:Edl):History=>({present,past:[],future:[]});
export function change(h:History,next:Edl,tracks:unknown):History{const e=validate(next,tracks);return canonical(e)===canonical(h.present)?h:{present:e,past:[...h.past,h.present].slice(-200),future:[]};}
export function undo(h:History):History{return h.past.length?{present:h.past.at(-1)!,past:h.past.slice(0,-1),future:[h.present,...h.future].slice(0,200)}:h;}
export function redo(h:History):History{return h.future.length?{present:h.future[0],past:[...h.past,h.present].slice(-200),future:h.future.slice(1)}:h;}
export function message(e:unknown){const x=e as {status?:number;code?:string;message?:string;details?:{path?:string}};return `${x.status===402?'Kontingent erschöpft. ':x.status===404?'Schnitt oder Quelle fehlt oder ist nicht zugänglich. ':x.code==='not_local'?'Quelle liegt im Archiv. ':x.status===409?'Vorgang gesperrt oder Stand geändert. ':''}${x.message??'Vorgang fehlgeschlagen.'}${x.details?.path?' Feld: '+x.details.path:''}`;}
