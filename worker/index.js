import { summarize } from '../src/core/summarizer.js';
const buckets=new Map(),MAX_BYTES=256*1024;
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
export function rateLimit(ip,now=Date.now()){
 for(const [key,bucket]of buckets)if(bucket.until<=now)buckets.delete(key);
 const bucket=buckets.get(ip)||{count:0,until:now+60_000};
 if(!buckets.has(ip)&&buckets.size>=4096)return false;
 bucket.count++;buckets.set(ip,bucket);return bucket.count<=12;
}
async function readBody(request){
 if(Number(request.headers.get('Content-Length'))>MAX_BYTES)throw new RangeError('Input exceeds 256 KiB');
 if(!request.body)throw new Error('Missing body');
 const reader=request.body.getReader(),chunks=[];let size=0;
 try{while(true){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new RangeError('Input exceeds 256 KiB');}chunks.push(value);}}finally{reader.releaseLock();}
 const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder().decode(all));
}
export function validateInput(body){
 if(!body||!Array.isArray(body.items)||body.items.length>5000||!Number.isFinite(body.now)||body.now<0||body.now>8.64e15)throw new Error('Invalid window');
 if(body.viewer!==undefined&&(typeof body.viewer!=='string'||body.viewer.length>50))throw new Error('Invalid viewer');
 const items=body.items.map(item=>{
  if(!item||!Number.isFinite(item.ts)||item.ts<0||item.ts>8.64e15||!['chat','event'].includes(item.kind)||typeof item.text!=='string'||item.text.length>1000||typeof item.user!=='string'||item.user.length>50)throw new Error('Invalid item');
  return {ts:item.ts,kind:item.kind,text:item.text,user:item.user,eventType:String(item.eventType||'').slice(0,80),meta:{category:typeof item.meta?.category==='string'?item.meta.category.slice(0,100):undefined}};
 }).filter(item=>item.ts>=body.now-20*60_000&&item.ts<=body.now);
 return {items,viewer:body.viewer||'newcomer',now:body.now};
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/healthz')return json({ok:true,mode:'demo',runtime:'hosted'});
  if(url.pathname==='/api/config')return json({runtime:'hosted',mode:'demo'});
  if(url.pathname==='/api/state')return json({runtime:'hosted',mode:'demo',stateLocation:'browser',note:'The hosted replay state lives in the browser, not on the Worker.'});
  if(url.pathname==='/api/summarize'){
   if(request.method!=='POST')return json({error:'Method not allowed'},405,{Allow:'POST'});
   const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)return json({error:'Origin not allowed'},403);
   if(!request.headers.get('Content-Type')?.includes('application/json'))return json({error:'Expected application/json'},415);
   if(!rateLimit(request.headers.get('CF-Connecting-IP')||'local'))return json({error:'Too many summaries; local fallback is available'},429,{'Retry-After':'60'});
   try{
    const {items,viewer,now}=validateInput(await readBody(request));let backend='mock';
    const summary=await summarize(items,{viewer,now,env,onBackend:value=>{backend=value;}});
    return json({summary,backend});
   }catch(error){return json({error:error instanceof RangeError?'Input too large':'Invalid summary input'},error instanceof RangeError?413:400);}
  }
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/')||url.pathname==='/events')return json({error:'Not available in hosted demo'},404);
  if(request.method!=='GET'&&request.method!=='HEAD')return json({error:'Method not allowed'},405);
  const pages={'/':'/index.html','/demo':'/app.html','/panel':'/app.html','/overlay':'/app.html'};
  if(pages[url.pathname])url.pathname=pages[url.pathname];
  return env.ASSETS.fetch(new Request(url,request));
 }
};
