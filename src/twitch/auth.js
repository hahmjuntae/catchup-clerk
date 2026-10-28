import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
export const SCOPES=['user:read:chat','user:write:chat','moderator:read:followers','channel:read:subscriptions','bits:read'];
export class Auth {
  constructor({env,fetchImpl=fetch,tokenFile=new URL('../../.data/tokens.json',import.meta.url),onLogin=async()=>{}}){Object.assign(this,{env,fetchImpl,tokenFile,onLogin});this.states=new Map();}
  get redirect(){return this.env.TWITCH_REDIRECT_URI||'http://localhost:3101/auth/callback';}
  async load(){this.tokens=JSON.parse(await readFile(this.tokenFile,'utf8'));await chmod(this.tokenFile,0o600);return this.validate();}
  async save(tokens){
    if(!tokens.access_token||!tokens.refresh_token)throw new Error('Invalid token response');
    const path=this.tokenFile instanceof URL?this.tokenFile:pathToFileURL(this.tokenFile);
    await mkdir(dirname(fileURLToPath(path)),{recursive:true,mode:0o700});
    const next={...tokens,expires_at:Date.now()+(tokens.expires_in||0)*1000};
    const temp=new URL(`${path.href}.tmp`);
    await writeFile(temp,JSON.stringify(next),{mode:0o600});await chmod(temp,0o600);await rename(temp,path);this.tokens=next;
  }
  async exchange(params){
    const response=await this.fetchImpl('https://id.twitch.tv/oauth2/token',{method:'POST',signal:AbortSignal.timeout(8000),body:new URLSearchParams({client_id:this.env.TWITCH_CLIENT_ID,client_secret:this.env.TWITCH_CLIENT_SECRET,...params})});
    if(!response.ok)throw new Error('Twitch authorization failed');
    await this.save(await response.json());
  }
  async refresh(failedToken){
    if(failedToken&&this.tokens?.access_token!==failedToken)return;
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{if(!this.tokens?.refresh_token)throw new Error('Login required');await this.exchange({grant_type:'refresh_token',refresh_token:this.tokens.refresh_token});})().finally(()=>{this.refreshing=null;});
    return this.refreshing;
  }
  async token(){if(!this.tokens)throw new Error('Login required');if(this.tokens.expires_at<Date.now()+60_000)await this.refresh();return this.tokens.access_token;}
  async validate(retry=true){
    if(!this.tokens)throw new Error('Login required');
    const response=await this.fetchImpl('https://id.twitch.tv/oauth2/validate',{signal:AbortSignal.timeout(8000),headers:{Authorization:`OAuth ${this.tokens.access_token}`}});
    if(response.status===401&&retry){await this.refresh(this.tokens.access_token);return this.validate(false);}
    if(!response.ok)throw new Error('Twitch validation failed');
    const user=await response.json();
    if(user.client_id!==this.env.TWITCH_CLIENT_ID||!user.user_id)throw new Error('Wrong Twitch app or token type');
    this.identity=user;this.tokens.expires_at=Date.now()+user.expires_in*1000;return user;
  }
  async route(req,res,url){
    const respond=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(text);};
    if(req.method!=='GET')return respond(405,'Method not allowed');
    if(!this.env.TWITCH_CLIENT_ID||!this.env.TWITCH_CLIENT_SECRET)return respond(503,'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env, then restart.');
    if(url.pathname==='/auth/login'){
      for(const [state,expiry]of this.states)if(expiry<Date.now())this.states.delete(state);
      if(this.states.size>=20)return respond(429,'Too many pending logins. Try again later.');
      const state=randomBytes(24).toString('hex');this.states.set(state,Date.now()+600_000);
      const target=new URL('https://id.twitch.tv/oauth2/authorize');target.search=new URLSearchParams({client_id:this.env.TWITCH_CLIENT_ID,redirect_uri:this.redirect,response_type:'code',scope:SCOPES.join(' '),state}).toString();
      res.writeHead(302,{Location:target.href,'Set-Cookie':`clerk_oauth=${state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600`,'Cache-Control':'no-store'});res.end();return;
    }
    if(url.pathname!=='/auth/callback')return respond(404,'Not found');
    const state=url.searchParams.get('state')||'',cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('clerk_oauth='))?.slice(12)||'';
    const valid=state.length===cookie.length&&state.length>0&&timingSafeEqual(Buffer.from(state),Buffer.from(cookie))&&(this.states.get(state)||0)>Date.now();
    this.states.delete(state);res.setHeader('Set-Cookie','clerk_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0');
    if(!valid||!url.searchParams.get('code')||url.searchParams.has('error'))return respond(400,'Authorization was denied or expired. Open /auth/login to try again.');
    try{await this.exchange({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:this.redirect});await this.validate();await this.onLogin();res.writeHead(302,{Location:'/panel','Cache-Control':'no-store'});res.end();}
    catch{return respond(502,'Twitch connection failed. Check your app settings and channel, then try /auth/login again.');}
  }
}
