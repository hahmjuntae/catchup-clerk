import { Auth } from './auth.js';
import { Helix,ChatSender } from './helix.js';
import { EventSub } from './eventsub.js';
export class Twitch {
 constructor({env,clerk}){Object.assign(this,{env,clerk});this.auth=new Auth({env,onLogin:()=>this.connect()});this.helix=new Helix({auth:this.auth,clientId:env.TWITCH_CLIENT_ID});}
 async start(){await this.auth.load();await this.connect();}
 async connect(){
  this.stop();
  const channel=(this.env.TWITCH_CHANNEL||'').trim().toLowerCase();
  if(!/^[a-z0-9_]{1,25}$/.test(channel))throw new Error('Set a Twitch channel login');
  const users=await this.helix.request(`users?login=${encodeURIComponent(channel)}`),broadcaster=users.data?.[0];
  if(!broadcaster)throw new Error('Channel not found');
  const user=this.auth.identity;
  this.clerk.ownUserId=user.user_id;this.clerk.ownLogin=user.login;this.clerk.channel=broadcaster.display_name;this.clerk.reset();
  this.sender=new ChatSender({helix:this.helix,broadcasterId:broadcaster.id,senderId:user.user_id});this.clerk.sendChat=reply=>this.sender.send(reply);
  this.events=new EventSub({helix:this.helix,broadcasterId:broadcaster.id,userId:user.user_id,onItem:item=>this.clerk.ingest(item),onStatus:status=>{this.clerk.status=status;this.clerk.publish();}});
  this.events.start();
  this.validation=setInterval(()=>this.auth.validate().catch(()=>{this.stop();this.clerk.status='Twitch authorization expired. Reconnect at /auth/login';this.clerk.publish();}),60*60_000);
 }
 stop(){this.events?.stop();this.sender?.stop();clearInterval(this.validation);}
}
