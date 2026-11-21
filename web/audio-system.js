import {opfsDirectory,writeFile} from "./io.js";

const WORKER_TIMEOUT=120000;
export class HcaWorker {
  constructor() {
    this.worker=new Worker(new URL("./hca-worker.js",import.meta.url),{type:"module"});this.pending=new Map();this.serial=0;
    this.worker.onmessage=event=>{const {id,ok,value,error}=event.data,request=this.pending.get(id);if(!request)return;clearTimeout(request.timer);this.pending.delete(id);ok?request.resolve(value):request.reject(new Error(error));};
    this.worker.onerror=()=>this.close(new Error("HCA worker failed"));this.worker.onmessageerror=()=>this.close(new Error("Invalid HCA worker message"));
  }
  request(type,fields={},transfer=[]) {
    if(this.closed)return Promise.reject(new Error("HCA worker closed"));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.close(new Error("HCA worker timeout")),WORKER_TIMEOUT);
      this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,type,...fields},transfer);
    });
  }
  close(error=new Error("Audio request cancelled")){if(this.closed)return;this.closed=true;this.worker.terminate();for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();}
}
function cacheId(filename,hash) {
  const bytes=new TextEncoder().encode(filename);let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,"")+"."+hash;
}
async function keyCache() {
  try {const directory=await opfsDirectory(["cache","temp","decode"]);const file=await(await directory.getFileHandle("keys.json")).getFile();
    const value=JSON.parse(await file.text());if(!value||value.schema_version!==1||!value.entries||typeof value.entries!=="object"||Array.isArray(value.entries))return {schema_version:1,entries:{}};return value;
  }catch(error){if(error.name!=="NotFoundError"&&!(error instanceof SyntaxError))throw error;return {schema_version:1,entries:{}};}
}
async function saveKey(id,filename,hash,key,expected) {
  if(!navigator.locks)return;
  await navigator.locks.request("reorsg-hca-key-cache",async()=>{
    const value=await keyCache();
    if(key)value.entries[id]={filename,sha256:hash,key_decimal:key};
    else {if(value.entries[id]?.key_decimal!==expected)return;delete value.entries[id];}
    const directory=await opfsDirectory(["cache","temp","decode"],true);
    await writeFile(directory,"keys.json",new TextEncoder().encode(JSON.stringify(value)));
  });
}
export class AudioSystem {
  constructor(onError=()=>{}) {
    this.context=null;this.onError=onError;this.playbacks=new Set();this.volumes={bgm:1,se:1,voice:1,video:1};this.bgm=null;this.pendingBgm=null;this.epoch=0;
  }
  async prepare(data,assets) {
    const loaded=await assets.bytes(data.file);return this.prepareBytes(loaded.bytes,loaded.hash,data.file.split('/').at(-1));
  }
  async prepareBytes(bytes,hash,filename,codec="hca") {
    const id=cacheId(filename,hash),cache=await keyCache(),entry=cache.entries[id];
    const cached=entry?.filename===filename&&entry?.sha256===hash&&/^(0|[1-9][0-9]*)$/.test(entry.key_decimal)?entry.key_decimal:"";
    const worker=new HcaWorker();
    try {
      const copy=bytes.slice(0),info=await worker.request("open",{bytes:copy,cachedKey:cached,codec},[copy]);
      const first=await worker.request("pull");validatePcm(first.pcm,info.sampleRate);
      if(info.verifiedKey)await saveKey(id,filename,hash,info.verifiedKey);
      else if(cached)await saveKey(id,filename,hash,null,cached);
      return {hash,sampleRate:info.sampleRate,channels:info.channels,dispose(){ /* Immutable compressed bytes are released when all Scene/playback references are gone. */ },
        async open(){const session=new HcaWorker(),copy=bytes.slice(0);
          try{await session.request("open",{bytes:copy,cachedKey:info.verifiedKey,codec},[copy]);return session;}catch(error){session.close();throw error;}}};
    }catch(error){
      if(cached)await saveKey(id,filename,hash,null,cached);
      throw error;
    }finally{worker.close();}
  }
  unlock() {
    if(!this.context)this.context=new AudioContext();
    return this.context.resume().then(()=>{if(this.pendingBgm){const resource=this.pendingBgm;this.pendingBgm=null;return this.play(resource,"bgm");}});
  }
  setVolume(kind,value){if(!(kind in this.volumes)||!Number.isFinite(value)||value<0||value>1)throw new Error("Invalid audio volume");this.volumes[kind]=value;for(const p of this.playbacks)if(p.kind===kind)p.gain.gain.value=value;}
  transition(){this.epoch++;for(const p of [...this.playbacks])if(p.kind!=="bgm")p.stop();}
  async play(resource,kind) {
    if(!(kind in this.volumes))throw new Error("Invalid audio category");
    if(kind==="bgm") {
      if(this.bgm?.hash===resource.hash||this.pendingBgm?.hash===resource.hash)return {ok:true};
      this.bgm?.stop();this.bgm=null;this.pendingBgm=resource;
    }
    if(!this.context||this.context.state!=="running")return {ok:false,error:"permission_pending"};
    if(kind==="se"&&[...this.playbacks].filter(p=>p.kind==="se").length>=5)return {ok:true,dropped:true};
    if(kind==="bgm")this.pendingBgm=null;
    const epoch=this.epoch,context=this.context,gain=context.createGain();gain.gain.value=this.volumes[kind];gain.connect(context.destination);
    const playback={kind,hash:resource.hash,gain,nodes:new Set(),stopped:false,worker:null,timer:null,
      stop:()=>{if(playback.stopped)return;playback.stopped=true;clearTimeout(playback.timer);playback.worker?.close();for(const node of playback.nodes){node.onended=null;try{node.stop();}catch{}node.disconnect();}gain.disconnect();this.playbacks.delete(playback);if(this.bgm===playback)this.bgm=null;}};
    this.playbacks.add(playback);if(kind==="bgm")this.bgm=playback;
    try {
      playback.worker=await resource.open();if(playback.stopped||(kind!=="bgm"&&epoch!==this.epoch)){playback.stop();playback.worker.close();return {ok:false,error:"stale_audio"};}
      let next=context.currentTime,eof=false;
      const pump=async()=>{
        if(playback.stopped)return;
        try {
          if(context.state!=="running"){playback.timer=setTimeout(pump,50);return;}
          if(eof){if(!playback.nodes.size)playback.stop();else playback.timer=setTimeout(pump,50);return;}
          // Refill below 250 ms; each worker pull supplies at most ~500 ms plus one codec frame.
          if(next-context.currentTime<0.25){const part=await playback.worker.request("pull");if(playback.stopped)return;validatePcm(part.pcm,resource.sampleRate);
            if(part.pcm.length){const length=part.pcm.length/2,buffer=context.createBuffer(2,length,resource.sampleRate);
              for(let channel=0;channel<2;channel++){const target=buffer.getChannelData(channel);for(let i=0;i<length;i++)target[i]=part.pcm[i*2+channel];}
              const node=context.createBufferSource();node.buffer=buffer;node.connect(gain);playback.nodes.add(node);node.onended=()=>{playback.nodes.delete(node);node.disconnect();};
              next=Math.max(next,context.currentTime);playback.startedAt??=next;node.start(next);next+=length/resource.sampleRate;}
            if(part.eof){if(kind==="bgm")await playback.worker.request("reset");else eof=true;}}
          playback.timer=setTimeout(pump,25);
        }catch(error){if(!playback.stopped)this.onError(error.message);playback.stop();}
      };
      await pump();return playback.stopped?{ok:false,error:"audio_output_failed"}:{ok:true,playback};
    }catch(error){playback.stop();throw error;}
  }
  destroy(){this.pendingBgm=null;for(const p of [...this.playbacks])p.stop();this.context?.close();}
}
function validatePcm(pcm,rate){if(!(pcm instanceof Float32Array)||pcm.length%2||!Number.isInteger(rate)||rate<=0||pcm.some(v=>!Number.isFinite(v)))throw new Error("Invalid worker PCM");}
