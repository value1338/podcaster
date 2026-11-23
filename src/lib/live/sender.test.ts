import {test,expect,vi} from 'vitest';
import {api} from '../api';
import {LiveSender} from './sender';
class Recorder{
 static instances:Recorder[]=[];static isTypeSupported(){return true;}state='inactive';ondataavailable?: (e:{data:Blob})=>void;onerror?:()=>void;
 constructor(){Recorder.instances.push(this);}start(){this.state='recording';}stop(){this.state='inactive';}emit(size=4){this.ondataavailable?.({data:new Blob([new Uint8Array(size)])});}
}
test('serial uploads, bounded queue, stale callbacks and fresh seq0 per epoch',async()=>{
 vi.stubGlobal('MediaRecorder',Recorder);const start=vi.spyOn(api,'liveStart').mockResolvedValue({epoch:1});let release:()=>void=()=>{};const calls:number[]=[];
 vi.spyOn(api,'request').mockImplementation(async(_method,p)=>{calls.push(Number(p.split('/').at(-1)));await new Promise<void>(r=>{release=r;});return undefined;});
 try{const states:unknown[]=[];const sender=new LiveSender(s=>states.push(s));await sender.start('dummy',{} as MediaStream);const first=Recorder.instances.at(-1)!;first.emit();first.emit();expect(calls).toEqual([0]);release();await new Promise(r=>setTimeout(r,0));expect(calls).toEqual([0,1]);sender.cancel();first.emit();release();await new Promise(r=>setTimeout(r,0));expect(calls).toEqual([0,1]);
 start.mockResolvedValue({epoch:2});await sender.start('dummy',{} as MediaStream);const second=Recorder.instances.at(-1)!;second.emit();expect(calls.at(-1)).toBe(0);for(let i=0;i<16;i++)second.emit();expect(second.state).toBe('inactive');expect(states.at(-1)).toMatchObject({status:'unterbrochen',queued:0});release();sender.cancel();
 }finally{vi.restoreAllMocks();vi.unstubAllGlobals();}
});
