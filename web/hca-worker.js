import {AdxStream} from "./adx-decoder.js";
import initialize, {HcaStream} from "./pkg/reorsg_client.js";
const ready=initialize();let stream=null;
self.onmessage=async event=>{
  const {id,type}=event.data;
  try {
    await ready;
    if(type==="open") {
      if(event.data.codec!==undefined&&!["hca","adx"].includes(event.data.codec))throw new Error("Unsupported audio codec");
      stream?.free();stream=event.data.codec==="adx"?new AdxStream(event.data.bytes):new HcaStream(new Uint8Array(event.data.bytes),event.data.cachedKey??"",event.data.subkey??0);
      self.postMessage({id,ok:true,value:{sampleRate:stream.sample_rate(),channels:event.data.codec==="adx"?stream.channels:stream.channel_count(),verifiedKey:stream.verified_key()}});
    } else if(type==="pull") {
      if(!stream)throw new Error("HCA stream not open");
      const blocks=[];let length=0;
      // Bounded 500 ms stereo PCM look-ahead, rounded up to a codec frame.
      const wanted=Math.ceil(stream.sample_rate()*0.5)*2;
      while(length<wanted&&!stream.finished()){const block=stream.next_pcm();blocks.push(block);length+=block.length;}
      const pcm=new Float32Array(length);let offset=0;for(const block of blocks){pcm.set(block,offset);offset+=block.length;}
      self.postMessage({id,ok:true,value:{pcm,eof:stream.finished()}},[pcm.buffer]);
    } else if(type==="reset") {stream.reset();self.postMessage({id,ok:true,value:null});}
    else throw new Error("Unknown audio worker request");
  }catch{self.postMessage({id,ok:false,error:"HCA decoding or key verification failed"});}
};
