import {digest} from "./io.js";

export class UsmPlayer {
  constructor(audio,{onFrame,onError=()=>{},onStatus=()=>{}}) {this.audio=audio;this.onFrame=onFrame;this.onError=onError;this.onStatus=onStatus;this.epoch=0;this.frames=[];}
  async prepare(blob,{keyHex,trustedKeys}={}) {
    this.stop();const epoch=this.epoch;this.worker=new Worker(new URL("./usm-worker.js",import.meta.url),{type:"module"});
    const info=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new Error("USM preparation timeout"));this.stop();},120000);this.pending={reject,timer};
      this.worker.onmessage=event=>{
        if(epoch!==this.epoch){event.data.frame?.close();return;}
        const message=event.data;
        if(message.id===1){clearTimeout(timer);this.pending=null;message.ok?resolve(message.value):reject(new Error(message.error));}
        else if(message.type==="frame"){
          if(this.frames.length>=8){message.frame.close();this.fail("USM display queue overflow");return;}
          this.frames.push(message.frame);this.frames.sort((a,b)=>a.timestamp-b.timestamp);
        }else if(message.type==="end")this.ended=true;
        else if(message.type==="error")this.fail(message.error);
      };
      this.worker.onerror=()=>{reject(new Error("USM worker failed"));this.fail("USM worker failed");};
      this.worker.onmessageerror=()=>this.fail("Invalid USM worker message");
      this.worker.postMessage({id:1,type:"open",blob,keyHex,trustedKeys});
    });
    if(epoch!==this.epoch)throw new Error("USM request cancelled");
    this.audioResource=null;this.audioStatus="absent";
    if(info.audio) {
      try {
        if(![2,4].includes(info.audio.codec))throw new Error("Unsupported USM audio codec");
        const bytes=await info.audio.blob.arrayBuffer();
        this.audioResource=await this.audio.prepareBytes(bytes,await digest(bytes),"usm-audio",info.audio.codec===2?"adx":"hca");if(this.audioResource.sampleRate!==info.audio.sampleRate||this.audioResource.channels!==info.audio.channels){
          this.audioResource.dispose();this.audioResource=null;throw new Error("USM audio metadata disagrees with decoded header");
        }
        this.audioStatus="ready";
      }catch(error){this.audioStatus="failed";this.onStatus({audio:"failed",reason:error.message});}
    }
    if(epoch!==this.epoch){this.audioResource?.dispose();throw new Error("USM request cancelled");}
    this.onStatus({audio:this.audioStatus,ignored:info.ignored});return info;
  }
  async play() {
    if(!this.worker)throw new Error("USM not prepared");const epoch=this.epoch;
    let clock=()=>performance.now()/1000;
    if(this.audioResource){
      try {await this.audio.unlock();const playback=await this.audio.play(this.audioResource,"video");
        if(playback.ok){this.audioPlayback=playback.playback;clock=()=>this.audio.context.currentTime;this.audioStatus="playing";}
        else throw new Error(playback.error);
      }catch(error){this.audioStatus="failed";this.onStatus({audio:"failed",reason:error.message});}
    }
    if(epoch!==this.epoch){this.audioPlayback?.stop();return;}
    const origin=this.audioPlayback?.startedAt??clock();this.worker.postMessage({type:"start"});
    const tick=()=>{
      if(epoch!==this.epoch)return;
      const elapsed=(clock()-origin)*1000000;
      while(this.frames.length&&this.frames[0].timestamp<=elapsed){const frame=this.frames.shift();
        try{this.onFrame(frame);}catch(error){this.fail(error.message);return;}finally{frame.close();}
        this.worker?.postMessage({type:"consumed"});}
      if(this.ended&&!this.frames.length){this.onStatus({video:"ended",audio:this.audioStatus});return;}
      this.raf=requestAnimationFrame(tick);
    };
    this.raf=requestAnimationFrame(tick);
  }
  fail(message){this.stop();this.onError(message);}
  stop(){this.epoch++;cancelAnimationFrame(this.raf);if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new Error("USM request cancelled"));this.pending=null;}this.worker?.terminate();this.worker=null;
    for(const frame of this.frames)frame.close();this.frames=[];this.ended=false;this.audioPlayback?.stop();this.audioPlayback=null;this.audioResource?.dispose();this.audioResource=null;}
}
