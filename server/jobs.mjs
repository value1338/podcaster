// One batch worker; cancellation is scoped to each accepted key.
export class Jobs {
 constructor(){this.queue=[];this.running=false;this.stopped=false;this.abort=new AbortController();this.idle=Promise.resolve();}
 has(key){return this.current===key||this.queue.some(j=>j.key===key);}
 add(key,work,{onQueue,onDiscard}={}){if(this.stopped||this.has(key))return;onQueue?.();this.queue.push({key,work,abort:new AbortController(),onDiscard});this.pump();}
 cancel(key){const i=this.queue.findIndex(j=>j.key===key);if(i>=0){const [j]=this.queue.splice(i,1);j.onDiscard?.();return true;}if(this.current===key){this.currentAbort.abort();return true;}return false;}
 pump(){if(this.running||this.stopped)return;this.running=true;this.idle=(async()=>{try{while(this.queue.length&&!this.stopped){const j=this.queue.shift();this.current=j.key;this.currentAbort=j.abort;try{await j.work(AbortSignal.any([this.abort.signal,j.abort.signal]));}catch(e){console.error('Job:',e.message);}finally{this.current=null;this.currentAbort=null;}}}finally{this.running=false;}})();}
 async close(){this.stopped=true;for(const j of this.queue.splice(0))j.onDiscard?.();this.abort.abort();await this.idle;}
}
