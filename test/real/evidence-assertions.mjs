import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const base=path.resolve(process.env.RA5_EVIDENCE??'test/real/evidence/reviewfixes-final-20261120');
const read=async f=>JSON.parse(await fs.readFile(f));
test('original reviewer repros preserve foreign data and DB',async()=>{
 const review=base+'/review';const summary=await read(review+'/summary.json');assert.equal(summary[0].calls,6);assert.equal(summary[0].result.ok,true);assert.equal(summary[1].calls,0);
 for(const mode of ['foreign','missing']){const out=review+'/'+mode,c=await read(out+'/cleanup.json');assert.equal(c.dataRemoved,false);const db=await read(out+'/retainedDataDir.json');assert.ok((await fs.stat(db+'/studio.sqlite')).isFile());}
 const c=await read(review+'/foreign/cleanup.json'),dir=c.created[0].directory;
 for(const n of ['manifest-foreign.json','original.foreign'])assert.equal(await fs.readFile(dir+'/'+n,'utf8'),'FOREIGN SENTINEL');
 const missing=await read(review+'/missing/cleanup.json');assert.ok((await fs.stat(missing.created[0].directory.replace('/archive-missing/','/archive-missing-hidden/')+'/original.wav')).size>0);
 const errors=base+'/cleanup-errors';assert.equal(await fs.readFile(errors+'/err-output/result.json','utf8'),'FOREIGN OUTPUT SENTINEL');assert.ok((await fs.stat(errors+'/err-output/archive-cleanup-intent.json')).isFile());
 const signal=await read(base+'/signal/signal-summary.json');assert.equal(signal[0].calls,1);assert.equal(signal[0].result.code,'signal_aborted');
 const adversarial=await read(base+'/adversarial/adversarial-summary.json');assert.equal(adversarial[0].calls,1);assert.equal(adversarial.at(-1).value,'KEEP');
});
