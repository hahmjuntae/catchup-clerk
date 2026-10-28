import { mkdir, writeFile } from 'node:fs/promises';
let seed=20261028;
const random=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
const users=['moss_packet','cinder_jam','velvet_turnip','orbit_kettle','fern_byte','soup_cartographer','soft_static','plum_signal','bramble_loop','tiny_cairn','cobalt_moth','pocket_rune','quiet_pixel','biscuit_scope','amber_socket','river_spool','sleepy_aster','sprout_clock','copper_owl','fable_finch','dusk_pickle','woolly_comet','marble_fern','toast_archivist'];
const phases=[
 ['Tea check before the run','What game are we playing today?','LanternLark has the coziest starting screen','Audio sounds good now','I brought snacks for this run','Just got home, perfect timing','That menu music is so good'],
 ['Ember Vault looks beautiful','Lantern and shield is such a strange build','Does the lantern heal or only light the room?','The map has a hidden door on the left','Save the dash for the traps','That tiny pot survived the whole room','The pot is our emotional support pot now'],
 ['The shield parry restores lantern charge','Does the lantern heal or only light the room?','Protect the emotional support pot','The left path has the merchant','Lantern build is finally coming together','That room almost ended the run','Do not spend all the coins on soup'],
 ['Glass Warden phase two has the delayed slam','Dodge after the second bell, not the first','Is this the final boss or just floor three?','The emotional support pot believes in you','Shield parry into lantern burst looks strong','We reached the Glass Warden with one flask','The boss has so much health'],
 ['Glass Warden defeated with one heart left!','Boss down! The lantern build actually worked','Victory and the emotional support pot is still intact','Next floor unlocked: the Ashen Library','Does the lantern heal or only light the room?','The shield carried that entire boss fight','That last parry was unbelievable']
];
const items=[];
const event=(sec,eventType,text,user='LanternLark',meta={})=>items.push({ts:sec*1000,kind:'event',user,text,eventType,meta});
event(0,'stream.online','LanternLark went live');
event(2,'channel.update','Category: Just Chatting. Title: Tea first, dungeon later','LanternLark',{category:'Just Chatting',title:'Tea first, dungeon later'});
event(180,'channel.update','Category changed to Ember Vault. Title: One lantern, one very questionable plan','LanternLark',{category:'Ember Vault',title:'One lantern, one very questionable plan'});
event(575,'channel.subscribe','fern_byte subscribed at Tier 1','fern_byte',{tier:'1000'});
event(720,'channel.raid','MossyCircuit raided with 120 viewers','MossyCircuit',{viewers:120});
event(840,'channel.subscription.message','cobalt_moth celebrated 6 months: for the pot','cobalt_moth',{months:6});
event(975,'channel.subscription.gift','orbit_kettle gifted 20 subscriptions','orbit_kettle',{total:20});
event(1080,'channel.cheer','velvet_turnip cheered 1500 bits: parry fund','velvet_turnip',{bits:1500});
event(1140,'channel.update','Title changed: Glass Warden attempts | protect the pot','LanternLark',{category:'Ember Vault',title:'Glass Warden attempts | protect the pot'});
event(1380,'channel.cheer','bramble_loop cheered 500 bits for the victory','bramble_loop',{bits:500});
for(const sec of [100,265,450,726,732,739,745,761,960,1230]) { const user=users[Math.floor(random()*users.length)]; event(sec,'channel.follow',`${user} followed`,user); }
for(let i=0;i<400;i++){
 const sec=5+i*3.7+random()*2;
 const phase=sec<180?0:sec<550?1:sec<1010?2:sec<1280?3:4;
 const pool=phases[phase];
 const spam=(sec>720&&sec<760)||(sec>1280&&sec<1320);
 const text=i===346?'Glass Warden defeated with one heart left!':spam?['KEKW KEKW','PogChamp','LUL','PogChamp PogChamp'][i%4]:pool[Math.floor(random()*pool.length)];
 items.push({ts:Math.round(sec*1000),kind:'chat',user:users[Math.floor(random()*users.length)],text,eventType:'',meta:{messageId:`demo-${i}`}});
}
for(const [sec,user] of [[1290,'late_lantern'],[1380,'paper_badger'],[1470,'mint_satellite']]) items.push({ts:sec*1000,kind:'chat',user,text:'!catchup',eventType:'',meta:{messageId:`catchup-${user}`,userId:user}});
items.push({ts:1260*1000,kind:'chat',user:'fern_byte',text:'!recap',eventType:'',meta:{isMod:true,messageId:'recap-1'}});
items.sort((a,b)=>a.ts-b.ts);
await mkdir(new URL('../fixtures/',import.meta.url),{recursive:true});
await writeFile(new URL('../fixtures/demo-stream.json',import.meta.url),JSON.stringify({channel:'LanternLark',game:'Ember Vault',durationMs:25*60_000,seed:20261028,items},null,2)+'\n');
console.log(`Generated ${items.length} items (${items.filter(x=>x.kind==='chat').length} chat messages).`);
