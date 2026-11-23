import {it,expect} from 'vitest';
import {validate,split,trim,move,remove,timeline,toSource,canonical} from '../../server/edl.mjs';
import {cutRange,transcriptUnits} from '../../src/pages/bearbeiten/timeline';
import {history,change,undo,redo} from '../../src/pages/bearbeiten/history';
import type {Transcript} from '../../src/lib/api';
it('boundary validation, empty draft and full exact undo/redo',()=>{
 const sources=[{id:'t',durationMs:4000}];const e={v:1 as const,clips:[{id:'a',trackId:'t',inMs:500,outMs:2500}]};
 for(const ms of [0,1,99,1901,1999,2000,2001,100.5,NaN,Infinity])expect(()=>split(e,'a',ms,'b')).toThrow();
 const s=split(e,'a',100,'b');expect(s.clips[0].outMs-s.clips[0].inMs).toBe(100);
 expect(toSource(s,100)?.sourceMs).toBe(600);expect(toSource(s,2000)).toBeNull();
 for(const outMs of [599,600.5,4001])expect(()=>validate(trim(e,'a',{outMs}),sources)).toThrow();
 expect(cutRange(e,0,2000).clips).toEqual([]);expect(validate(remove(e,'a'),sources).clips).toEqual([]);
 let h=history(e);for(const next of [s,move(s,'b',0),remove(s,'a'),cutRange(e,0,2000)])h=change(h,next,sources);
 for(let i=0;i<4;i++)h=undo(h);expect(canonical(h.present)).toBe(canonical(e));for(let i=0;i<4;i++)h=redo(h);expect(h.present.clips).toEqual([]);
 expect(timeline(e)[0]).toMatchObject({startMs:0,endMs:2000});
});
it('transcript maps rounded and clipped word times for repeated sources',()=>{
 const e={v:1 as const,clips:[{id:'a',trackId:'t',inMs:1000,outMs:2000},{id:'b',trackId:'t',inMs:1000,outMs:2000}]};
 const t={timestamps:'word',segments:[{id:'s',startMs:900,endMs:2100,text:'x',words:[{text:'x',startMs:999.7,endMs:1500.4},{text:'y',startMs:1800.6,endMs:2100.2}]}]} as Transcript;
 expect(transcriptUnits(e,{t}).map(u=>[u.startMs,u.endMs])).toEqual([[0,500],[801,1000],[1000,1500],[1801,2000]]);
});
