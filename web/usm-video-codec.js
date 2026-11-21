export function vp9Frames(data,frameIndex,rate) {
  let at=0,scale=rate,frames=[];
  const v=new DataView(data.buffer,data.byteOffset,data.byteLength);
  if(data.length>=4&&String.fromCharCode(...data.subarray(0,4))==="DKIF") {
    if(data.length<32||v.getUint16(4,true)!==0||v.getUint16(6,true)!==32||String.fromCharCode(...data.subarray(8,12))!=="VP90")throw new Error("Invalid VP9 IVF header");
    const numerator=v.getUint32(16,true),denominator=v.getUint32(20,true);if(!numerator||!denominator)throw new Error("Invalid IVF frame rate");scale=numerator/denominator;at=32;
  }
  const records=[];let cursor=at;
  while(cursor+12<=data.length){const length=v.getUint32(cursor,true);if(!length||cursor+12+length>data.length)break;
    const ticks=v.getBigUint64(cursor+4,true);if(ticks>BigInt(Number.MAX_SAFE_INTEGER))break;
    records.push({data:data.subarray(cursor+12,cursor+12+length),timestamp:Math.round(Number(ticks)*1000000/scale)});cursor+=12+length;}
  if(records.length&&cursor===data.length)frames=records;
  else if(at)throw new Error("Truncated IVF frames");
  else frames=[{data,timestamp:Math.round(frameIndex*1000000/rate)}];
  return frames.map(frame=>({...frame,type:vp9Key(frame.data)?"key":"delta"}));
}
function vp9Key(data) {
  if(!data.length)throw new Error("Empty VP9 frame");let bit=0;
  const read=()=>{if(bit>=data.length*8)throw new Error("Truncated VP9 frame");const value=(data[bit>>3]>>(7-(bit&7)))&1;bit++;return value;};
  if(((read()<<1)|read())!==2)throw new Error("Invalid VP9 frame marker");
  const profile=read()|(read()<<1);if(profile===3)read();
  if(read())return false;return read()===0;
}
export function h264Packet(data) {
  const units=[];let start=-1;
  for(let i=0;i+3<data.length;i++)if(data[i]===0&&data[i+1]===0&&(data[i+2]===1||(data[i+2]===0&&data[i+3]===1))) {
    const prefix=data[i+2]===1?3:4;if(start>=0)units.push(data.subarray(start,i));start=i+prefix;i+=prefix-1;
  }
  if(start>=0&&start<data.length)units.push(data.subarray(start));if(!units.length)throw new Error("H264 Annex B NAL units missing");
  const sps=units.find(unit=>(unit[0]&31)===7),pps=units.some(unit=>(unit[0]&31)===8),key=units.some(unit=>(unit[0]&31)===5);
  if(sps&&sps.length<4)throw new Error("Truncated H264 SPS");
  return {key,pps,codec:sps?"avc1."+[...sps.subarray(1,4)].map(n=>n.toString(16).padStart(2,'0')).join(''):null};
}
