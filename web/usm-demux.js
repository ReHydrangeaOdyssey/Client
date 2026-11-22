const text=new TextDecoder("utf-8",{fatal:true});
function magic(bytes,at=0){return String.fromCharCode(...bytes.subarray(at,at+4));}
export function utfTable(buffer) {
  const b=new Uint8Array(buffer),v=new DataView(buffer);
  if(b.length<32||magic(b)!=="@UTF")throw new Error("Invalid USM UTF header");
  const end=v.getUint32(4)+8,version=v.getUint16(8),rowsAt=v.getUint16(10)+8,strings=v.getUint32(12)+8,dataAt=v.getUint32(16)+8;
  const columns=v.getUint16(24),rowSize=v.getUint16(26),rows=v.getUint32(28);
  if(version>1||!columns||!rows||rowsAt<32||rowsAt+rows*rowSize>strings||strings>dataAt||dataAt>end||end>b.length)throw new Error("Invalid USM UTF bounds");
  const string=offset=>{const start=strings+offset;if(start<strings||start>=dataAt)throw new Error("Invalid UTF string offset");let end=start;while(end<dataAt&&b[end])end++;if(end===dataAt)throw new Error("Unterminated UTF string");return text.decode(b.subarray(start,end));};
  let schema=32,row=rowsAt;const result=Object.create(null);
  function value(type,cursor,limit) {
    const size=[1,1,2,2,4,4,8,8,4,8,4,8][type];if(!size||cursor+size>limit)throw new Error("Invalid UTF value");
    let output;
    switch(type){
      case 0:output=v.getUint8(cursor);break;case 1:output=v.getInt8(cursor);break;
      case 2:output=v.getUint16(cursor);break;case 3:output=v.getInt16(cursor);break;
      case 4:output=v.getUint32(cursor);break;case 5:output=v.getInt32(cursor);break;
      case 6:output=v.getBigUint64(cursor);break;case 7:output=v.getBigInt64(cursor);break;
      case 8:output=v.getFloat32(cursor);break;case 9:output=v.getFloat64(cursor);break;
      case 10:output=string(v.getUint32(cursor));break;
      case 11:{const start=dataAt+v.getUint32(cursor),length=v.getUint32(cursor+4);if(start+length>end)throw new Error("Invalid UTF data bounds");output=b.slice(start,start+length);break;}
    }
    if(typeof output==="bigint"){if(output>BigInt(Number.MAX_SAFE_INTEGER)||output<BigInt(Number.MIN_SAFE_INTEGER))throw new Error("UTF integer exceeds safe range");output=Number(output);}
    if(typeof output==="number"&&!Number.isFinite(output))throw new Error("Invalid UTF number");return {output,size};
  }
  for(let i=0;i<columns;i++){
    if(schema+5>rowsAt)throw new Error("Truncated UTF schema");const flags=b[schema++],name=string(v.getUint32(schema));schema+=4;
    if(Object.hasOwn(result,name))throw new Error("Duplicate UTF column");const storage=flags&240,type=flags&15;
    if(storage===16){if(type>11)throw new Error("Invalid UTF zero type");result[name]=type===10?"":type===11?new Uint8Array():0;}
    else if(storage===48||storage===112){const item=value(type,schema,rowsAt);schema+=item.size;result[name]=item.output;}
    else if(storage===80){const item=value(type,row,rowsAt+rowSize);row+=item.size;result[name]=item.output;}
    else throw new Error("Unsupported UTF storage");
  }
  return result;
}
export async function demuxUsm(blob) {
  if(!(blob instanceof Blob)||blob.size<32)throw new Error("Invalid USM input");
  const videos=new Map(),audios=new Map(),ignored=new Set();let at=0,first=true;
  while(at<blob.size) {
    if(blob.size-at<32)throw new Error("Truncated USM chunk header");
    const raw=await blob.slice(at,at+32).arrayBuffer(),v=new DataView(raw),bytes=new Uint8Array(raw),tag=magic(bytes);
    if(first&&tag!=="CRID")throw new Error("USM CRID header missing");first=false;
    const size=v.getUint32(4),offset=v.getUint16(8),padding=v.getUint16(10),channel=bytes[12],type=bytes[15]&3;
    const next=at+8+size,start=at+8+offset,end=next-padding;
    if(size<24||offset<24||next>blob.size||start>end||end<at+32)throw new Error("Invalid USM chunk bounds");
    if(tag==="@SFV"||tag==="@SFA") {
      const map=tag==="@SFV"?videos:audios;
      if(!map.has(channel))map.set(channel,{channel,metadata:null,packets:[]});const stream=map.get(channel);
      if(type===0)stream.packets.push({start,end,time:v.getUint32(16),rate:v.getUint32(20)});
      else if(type===1){const info=utfTable(await blob.slice(start,end).arrayBuffer());if(stream.metadata)throw new Error("Duplicate USM stream header");stream.metadata=info;}
    }else if(tag==="CRID") {if(type===1||at===0)utfTable(await blob.slice(start,end).arrayBuffer());}
    else ignored.add(tag);
    at=next;
  }
  const select=map=>map.get(0)??map.values().next().value;
  const video=select(videos),audio=select(audios);
  if(!video?.metadata||!video.packets.length)throw new Error("USM video stream unavailable");
  const m=video.metadata;
  if(![5,9].includes(m.mpeg_codec))throw new Error("Unsupported USM video codec: "+m.mpeg_codec);
  if(![m.width,m.height,m.framerate_n,m.framerate_d].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error("Invalid USM video dimensions or frame rate");
  return {blob,video,audio,ignored:[...ignored],videoChannels:videos.size,audioChannels:audios.size};
}
