import {test,expect,vi,afterEach} from 'vitest';
import {ApiClient,ApiError} from '../../src/lib/api';
afterEach(()=>vi.unstubAllGlobals());
test('v2 headers, cookies, idempotency, query, base, abort and auth event',async()=>{
 const events:string[]=[];vi.stubGlobal('window',{dispatchEvent:(event:Event)=>events.push(event.type)});
 const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response('{}')));vi.stubGlobal('fetch',fetcher);
 const client=new ApiClient('/podcast/api');const signal=new AbortController().signal;
 await client.putChunk('a/b',0,new Blob(['x']),signal);
 expect(fetcher.mock.calls[0][0]).toBe('/podcast/api/tracks/a%2Fb/chunks/0');
 expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'same-origin',signal,headers:{'X-Studio':'1'}});
 await client.startTranscription('a',{},'key');expect(fetcher.mock.lastCall?.[1].headers['Idempotency-Key']).toBe('key');
 await client.listJobs({active:true,projectId:'a/b'});expect(fetcher.mock.lastCall?.[0]).toBe('/podcast/api/jobs?active=1&projectId=a%2Fb');
 expect(client.transcriptFileUrl('a','srt')).toBe('/podcast/api/tracks/a/transcript/file?format=srt');
 fetcher.mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({error:{code:'unauthenticated'}}),{status:401})));
 await expect(client.session()).rejects.toBeInstanceOf(ApiError);await expect(client.session()).rejects.toBeInstanceOf(ApiError);expect(events).toEqual(['studio:abgemeldet']);
 fetcher.mockRejectedValue(new DOMException('timeout','TimeoutError'));await expect(client.health(signal)).rejects.toMatchObject({code:'timeout',status:0});
});
