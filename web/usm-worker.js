import {demuxUsm} from "./usm-demux.js";
import {vp9Frames,h264Packet} from "./usm-video-codec.js";
import {unmaskVideo} from "./usm-video-mask.js";
let source=null,decoder=null,config=null,packet=0,pendingFrames=0,pumping=false,ended=false,key=null,generation=0;
function shutdown(){generation++;if(decoder&&decoder.state!=="closed")decoder.close();decoder=null;source=null;}
function failure(error){shutdown();self.postMessage({type:"error",error:error.message??"USM decode failed"});}
async function chunks(index) {
  const stream=source.video,p=stream.packets[index];let data=new Uint8Array(await source.blob.slice(p.start,p.end).arrayBuffer());
  if(key)data=unmaskVideo(data,key);
  const rate=stream.metadata.framerate_n/stream.metadata.framerate_d;
  if(stream.metadata.mpeg_codec===9)return vp9Frames(data,index,rate);
  const nal=h264Packet(data);return [{data,type:nal.key?"key":"delta",timestamp:Math.round(index*1000000/rate)}];
}
async function open(blob,keyHex) {
  shutdown();if(!globalThis.VideoDecoder)throw new Error("WebCodecs VideoDecoder unavailable");
  source=await demuxUsm(blob);key=keyHex??null;const m=source.video.metadata;
  config={codec:m.mpeg_codec===9?"vp09.00.10.08":"",codedWidth:m.width,codedHeight:m.height};
  const initial=await chunks(0);
  if(m.mpeg_codec===5){const nal=h264Packet(initial[0].data);if(!nal.codec||!nal.pps||!nal.key)throw new Error("H264 SPS/PPS/IDR required");config.codec=nal.codec;}
  const supported=await VideoDecoder.isConfigSupported(config);if(!supported.supported)throw new Error("USM video codec unavailable on this browser");config=supported.config;
  let proof=0,failed=null;const probe=new VideoDecoder({output:frame=>{proof++;frame.close();},error:error=>{failed=error;}});
  // An unchanged short packet cannot prove a mask key; include the first packet that the mask can affect.
  const maskedPacket=source.video.packets.findIndex(p=>p.end-p.start>=0x240),lastProbe=Math.max(0,maskedPacket);
  try{
    probe.configure(config);
    for(let index=0;index<=lastProbe;index++){
      const frames=index===0?initial:await chunks(index);
      for(const frame of frames){
        while(probe.decodeQueueSize>=4&&!failed)await new Promise(resolve=>probe.addEventListener("dequeue",resolve,{once:true}));
        if(failed)throw new Error("USM video packet/key verification failed");
        probe.decode(new EncodedVideoChunk(frame));
      }
    }
    await probe.flush();if(failed||!proof)throw new Error("USM video packet/key verification failed");
  }
  finally{if(probe.state!=="closed")probe.close();}
  let audio=null;
  if(source.audio?.metadata&&source.audio.packets.length){const a=source.audio;audio={codec:a.metadata.audio_codec,sampleRate:a.metadata.sampling_rate,channels:a.metadata.num_channels,blob:new Blob(a.packets.map(p=>source.blob.slice(p.start,p.end)))};}
  packet=0;pendingFrames=0;ended=false;
  return {width:m.width,height:m.height,audio,ignored:source.ignored,decrypted:key!==null&&maskedPacket>=0};
}
async function pump() {
  if(pumping||!decoder||ended)return;pumping=true;const epoch=generation;
  try {
    while(epoch===generation&&packet<source.video.packets.length&&pendingFrames<4&&decoder.decodeQueueSize<4) {
      const frames=await chunks(packet++);if(epoch!==generation)return;
      for(const frame of frames)decoder.decode(new EncodedVideoChunk(frame));
    }
    if(epoch===generation&&packet===source.video.packets.length){ended=true;await decoder.flush();if(epoch===generation)self.postMessage({type:"end"});}
  }catch(error){if(epoch===generation)failure(error);}finally{pumping=false;}
}
self.onmessage=async event=>{
  const {id,type}=event.data;
  try {
    if(type==="open") {
      if(event.data.trustedKeys!==undefined&&!Array.isArray(event.data.trustedKeys))throw new Error("Invalid trusted USM key candidates");
      const candidates=event.data.keyHex?[event.data.keyHex]:[null,...(event.data.trustedKeys??[])];
      if(!Array.isArray(candidates)||candidates.some(key=>key!==null&&!/^[a-fA-F0-9]{16}$/.test(key)))throw new Error("Invalid trusted USM key candidates");
      let value=null;
      for(const candidate of candidates){try{value=await open(event.data.blob,candidate);break;}catch{shutdown();}}
      if(!value)throw new Error("USM codec or key verification failed");
      self.postMessage({id,ok:true,value});
    }
    else if(type==="start"){
      decoder=new VideoDecoder({output:frame=>{if(pendingFrames>=8){frame.close();failure(new Error("USM frame queue overflow"));return;}pendingFrames++;self.postMessage({type:"frame",frame},[frame]);},error:failure});
      decoder.configure(config);decoder.ondequeue=()=>pump();pump();
    }else if(type==="consumed"){pendingFrames=Math.max(0,pendingFrames-1);pump();}
    else if(type==="close")shutdown();
  }catch(error){if(id)self.postMessage({id,ok:false,error:error.message});else failure(error);}
};
