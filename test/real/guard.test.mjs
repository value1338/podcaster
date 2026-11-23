import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reserveCost,run} from './abnahme.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('reserve bounds and explicit arithmetic',()=>{assert.equal(reserveCost({reserveTokens:1500,maxOutputTokens:500},{inputMicroPerMTok:1000000,outputMicroPerMTok:5000000}),3500);assert.throws(()=>reserveCost({reserveTokens:1,maxOutputTokens:2},{}));});
test('nonexistent standalone server fails without output or data creation',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'ra5-guard-'));try{await assert.rejects(run(['--server',root+'/missing.mjs','--audio',root+'/missing.wav','--out',root+'/out','--stufen','llm']));assert.deepEqual(await fs.readdir(root),[]);}finally{await fs.rm(root,{recursive:true});}});
test('reserve rejects negative, unsafe, overflow and inverted output',()=>{
 const p={inputMicroPerMTok:1000000,outputMicroPerMTok:5000000};
 for(const e of [{reserveTokens:-1,maxOutputTokens:-2},{reserveTokens:1,maxOutputTokens:-1},{reserveTokens:1,maxOutputTokens:2},{reserveTokens:Number.MAX_SAFE_INTEGER,maxOutputTokens:0},{reserveTokens:2**53,maxOutputTokens:0}])assert.throws(()=>reserveCost(e,p));
 for(const price of [-1,0,2**53])assert.throws(()=>reserveCost({reserveTokens:1,maxOutputTokens:0},{...p,inputMicroPerMTok:price}));
 assert.throws(()=>reserveCost({reserveTokens:2,maxOutputTokens:1},{inputMicroPerMTok:Number.MAX_SAFE_INTEGER,outputMicroPerMTok:Number.MAX_SAFE_INTEGER}));
});
