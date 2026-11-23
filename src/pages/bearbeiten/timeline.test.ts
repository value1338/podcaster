import {describe,it,expect} from 'vitest';
import {split,trim,move,timeline,toSource} from '../../../server/edl.mjs';
import {cutRange,transcriptUnits} from './timeline';
import type {Edl,Transcript} from '../../lib/api';
const edl:Edl={v:1,clips:[{id:'a',trackId:'one',inMs:1000,outMs:5000},{id:'b',trackId:'two',inMs:500,outMs:2500}]};
describe('Episode timeline',()=>{
 it('split trim move preserve exact source intervals and contiguous episode time',()=>{let e=split(edl,'a',1500,'c');e=trim(e,'c',{inMs:3000,outMs:4500});e=move(e,'b',0);expect(e.clips.map(c=>[c.trackId,c.inMs,c.outMs])).toEqual([['two',500,2500],['one',1000,2500],['one',3000,4500]]);expect(timeline(e).map(c=>[c.startMs,c.endMs])).toEqual([[0,2000],[2000,3500],[3500,5000]]);expect(toSource(e,3500)?.sourceMs).toBe(3000);expect(toSource(e,5000)).toBeNull();});
 it('text selection spanning clips cuts only selected episode interval',()=>{const e=cutRange(edl,2500,4500);expect(e.clips.map(c=>[c.trackId,c.inMs,c.outMs])).toEqual([['one',1000,3500],['two',1000,2500]]);expect(edl.clips).toHaveLength(2);});
 it('middle deletion creates independent valid clip ids',()=>{const e=cutRange(edl,1000,2000);expect(e.clips.map(c=>[c.inMs,c.outMs])).toEqual([[1000,2000],[3000,5000],[500,2500]]);expect(new Set(e.clips.map(c=>c.id)).size).toBe(3);});
 it('rejects subminimum remaining media rather than silently cutting more',()=>{expect(()=>cutRange(edl,50,500)).toThrow();});
 it('maps repeated source words to each clip and uses whole segments without word timing',()=>{const t={timestamps:'word',segments:[{id:'s',startMs:1000,endMs:5000,text:'Hallo Welt',words:[{text:'Hallo',startMs:1100,endMs:1500},{text:'Welt',startMs:3100,endMs:3500}]}]} as Transcript;const u=transcriptUnits(edl,{one:t});expect(u.map(x=>[x.text,x.startMs,x.endMs])).toEqual([['Hallo',100,500],['Welt',2100,2500]]);expect(transcriptUnits(edl,{one:{...t,segments:[{...t.segments[0],words:null}]}})[0].precise).toBe(false);expect(transcriptUnits(edl,{one:{...t,timestamps:'none'}})).toEqual([]);});
});
