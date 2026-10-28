import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { Clerk } from './core/clerk.js';
import { Replay } from './core/replay.js';
import { summarize } from './core/summarizer.js';
import { Twitch } from './twitch/index.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const mode=process.env.MODE || 'demo', port=Number(process.env.PORT)||3101;
if(!['live','demo'].includes(mode)) throw new Error('MODE must be live or demo');
const clients=new Set();
const emit=(type,data)=>{ const message=`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for(const client of clients) { if(client.writableLength>1_000_000) { client.destroy(); clients.delete(client); } else client.write(message); } };
const clerk=new Clerk({mode,channel:mode==='demo'?'LanternLark':process.env.TWITCH_CHANNEL||'Not connected',windowMs:(Number(process.env.WINDOW_MINUTES)||20)*60_000,maxItems:Number(process.env.MAX_ITEMS)||5000,emit,summarizeFn:(items,options)=>summarize(items,{...options,env:process.env})});
let replay,twitch;
if(mode==='demo') { replay=new Replay(clerk,JSON.parse(await readFile(resolve(root,'fixtures/demo-stream.json'),'utf8')),{speed:process.env.DEMO_SPEED}); replay.start(); }
else { twitch=new Twitch({env:process.env,clerk}); }
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req) {
  let text=''; for await(const chunk of req) { text+=chunk; if(Buffer.byteLength(text)>4096) throw new Error('Body too large'); }
  return JSON.parse(text||'{}');
}
const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  try {
    const url=new URL(req.url,'http://localhost');
    // Local API is not exposed to arbitrary web origins; server binds loopback by default.
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) return json(res,{error:'Origin not allowed'},403);
    if(url.pathname.startsWith('/auth/')) { if(!twitch) return json(res,{error:'Authentication is available in live mode only'},404); return await twitch.auth.route(req,res,url); }
    if(req.method==='GET' && url.pathname==='/healthz') return json(res,{ok:true,mode});
    if(req.method==='GET' && url.pathname==='/api/config') return json(res,{runtime:'node',mode});
    if(req.method==='GET' && url.pathname==='/api/state') return json(res,clerk.state());
    if(req.method==='GET' && url.pathname==='/events') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write(`event: state\ndata: ${JSON.stringify(clerk.state())}\n\n`); clients.add(res);
      req.on('close',()=>clients.delete(res)); return;
    }
    if(req.method==='POST' && url.pathname==='/api/demo' && replay) {
      const {action,value}=await body(req);
      if(!['speed','pause','restart','jump','catchup'].includes(action)) return json(res,{error:'Unknown action'},400);
      replay.action(action,value); return json(res,{ok:true});
    }
    if(req.method!=='GET' && req.method!=='HEAD') return json(res,{error:'Method not allowed'},405);
    const pages={'/':'index.html','/panel':'app.html','/overlay':'app.html','/demo':'app.html'};
    let dir=resolve(root,'public'), relative=pages[url.pathname] || decodeURIComponent(url.pathname).slice(1);
    if(url.pathname.startsWith('/core/')) {dir=resolve(root,'src/core');relative=url.pathname.slice(6);}
    if(url.pathname==='/fixtures/demo-stream.json') {dir=resolve(root,'fixtures');relative='demo-stream.json';}
    const path=resolve(dir,relative);
    if(!path.startsWith(dir+sep) || relative.startsWith('.')) return json(res,{error:'Not found'},404);
    const data=await readFile(path);
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'}[extname(path)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':`${mime}; charset=utf-8`,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
  } catch(error) { if(!res.headersSent) json(res,{error:error.code==='ENOENT'?'Not found':'Request failed'},error.code==='ENOENT'?404:400); else res.end(); }
});
const tick=setInterval(()=>{if(replay)replay.tick();else clerk.publish();},500);
const refresh=setInterval(()=>{if(!clerk.refreshing)clerk.refresh().catch(()=>{});},15000);
const heartbeat=setInterval(()=>{for(const c of clients)c.write(': heartbeat\n\n');},15000);
server.listen(port,process.env.HOST||'127.0.0.1',()=>{
  console.log(`Catch-up Clerk (${mode}) at http://localhost:${port}`);
  if(twitch)twitch.start().catch(()=>{clerk.status='Connect Twitch to start';clerk.publish();console.log('Twitch authentication needed. Open /auth/login.');});
});
function shutdown(){ clearInterval(tick);clearInterval(refresh);clearInterval(heartbeat);twitch?.stop();for(const c of clients)c.end();server.close(); }
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
