import {provider} from './fixture.mjs';
import {run} from './abnahme.mjs';
const f=await provider();
try{
 Object.assign(process.env,{NODE_ENV:'test',RA5_FIXTURE:'1',STUDIO_ASR_DRIVER:'fake',STUDIO_LLM_DRIVER:'openai',OPENAI_API_KEY:'ra5-synthetic-not-a-real-key',STUDIO_LLM_BASE_URL:f.base,RA5_LLM_MODEL:'fixture-only',RA5_INPUT_MICRO_PER_MTOK:'1000000',RA5_OUTPUT_MICRO_PER_MTOK:'5000000'});
 await run([...process.argv.slice(2),'--ohne-modellpruefung']);if(f.calls!==6&&!process.argv.includes('archiv-ausfall'))throw Error('expected six provider calls');console.log('RA5 fixture OK; provider calls='+f.calls);
}finally{await f.close();}
