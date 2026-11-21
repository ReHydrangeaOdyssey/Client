import {parsePlist,base64} from "./plist.js";
import {localPath} from "./io.js";
function numbers(value, count) {
  let result;
  if(typeof value==="string")result=value.replace(/[{}\s]/g,"").split(',').map(Number);
  else if(Array.isArray(value))result=value.flat(Infinity);
  else if(value&&typeof value==="object") {
    if(count===4&&value.origin&&value.size)result=[...numbers(value.origin,2),...numbers(value.size,2)];
    else result=count===4?[value.x,value.y,value.w??value.width,value.h??value.height]:[value.x??value.w??value.width,value.y??value.h??value.height];
  }
  if(!result||result.length!==count||!result.every(Number.isFinite))throw new Error("Invalid plist geometry");return result;
}
function frameRect(frame) {
  for(const key of ["textureRect","frame","rect","frameRect"])if(frame[key]!==undefined)return {rect:numbers(frame[key],4),key};
  if(frame.x!==undefined)return {rect:numbers(frame,4),key:"direct"};
  if(frame.position&&frame.size)return {rect:[...numbers(frame.position,2),...numbers(frame.size,2)],key:"position"};
  return null;
}
function collectFrames(frames) {
  const found=new Map();
  function visit(value,path){
    if(!value||typeof value!=="object")throw new Error("Invalid atlas frame entry");
    if(frameRect(value)){const name=value.name??path;if(typeof name!=="string"||!name||found.has(name))throw new Error("Duplicate or unnamed atlas frame");found.set(name,value);return;}
    for(const [key,child] of Object.entries(value)){const next=["frames","sprites"].includes(key)?path:(path?path+"/":"")+key;visit(child,next);}
  }
  visit(frames,"");if(!found.size)throw new Error("Empty atlas");return found;
}
async function embeddedImage(value) {
  let bytes=typeof value==="string"?base64(value):value instanceof Uint8Array?value:Uint8Array.from(value??[]);
  if(bytes[0]===31&&bytes[1]===139){if(!globalThis.DecompressionStream)throw new Error("gzip decoding unavailable");bytes=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());}
  return createImageBitmap(new Blob([bytes]),{premultiplyAlpha:"none",imageOrientation:"none"});
}
async function atlasImage(plist,source,assets) {
  let embedded;
  for(const container of [plist.metadata,plist])for(const key of ["textureImageData","textureData","imageData"])
    if(embedded===undefined&&container?.[key]!==undefined)embedded=container[key];
  if(source.texture==="embedded"||source.texture===undefined&&embedded!==undefined) {if(embedded===undefined)throw new Error("Embedded atlas image missing");return embeddedImage(embedded);}
  if(embedded!==undefined)throw new Error("Atlas storage disagrees with explicit external source");
  const name=source.image??plist.metadata?.realTextureFileName??plist.metadata?.textureFileName??source.plist.split("/").at(-1).replace(/\.plist$/,".png");
  if(typeof name!=="string"||!localPath(name))throw new Error("External atlas reference is unresolved");
  const directory=source.plist.slice(0,source.plist.lastIndexOf('/')+1);
  return assets.image({file:directory+name});
}
function geometry(frame) {
  const {rect,key}=frameRect(frame);
  const rotated=frame.textureRotated??frame.rotated??false;
  if(typeof rotated!=="boolean")throw new Error("Invalid atlas rotation");
  const [x,y,rw,rh]=rect;
  const [tw,th]=frame.spriteSize!==undefined?numbers(frame.spriteSize,2):rotated&&key==="frameRect"?[rh,rw]:[rw,rh];
  const sw=rotated?th:tw,sh=rotated?tw:th;
  const original=frame.spriteSourceSize??frame.sourceSize;
  const [width,height]=original!==undefined?numbers(original,2):frame.originalWidth!==undefined?[Math.abs(frame.originalWidth),Math.abs(frame.originalHeight)]:[tw,th];
  let ox,oy;
  const color=frame.spriteColorRect??frame.sourceColorRect??frame.sourceRect;
  if(color!==undefined){const bounds=numbers(color,4);[ox,oy]=bounds;if(bounds[2]!==tw||bounds[3]!==th)throw new Error("Inconsistent atlas trim rectangle");}
  else if(frame.cornerOffset!==undefined){[ox,oy]=numbers(frame.cornerOffset,2);}
  else {const [dx,dy]=frame.spriteOffset!==undefined||frame.offset!==undefined?numbers(frame.spriteOffset??frame.offset,2):[frame.offsetX??0,frame.offsetY??0];
    // Trim is centered in the original image, with Scene-positive Y offset subtracted in image space.
    ox=(width-tw)/2+dx;oy=(height-th)/2-dy;}
  if(![x,y,rw,rh,tw,th,width,height,ox,oy].every(Number.isInteger)||Math.min(rw,rh,tw,th,width,height)<=0||x<0||y<0||ox<0||oy<0||ox+tw>width||oy+th>height)throw new Error("Invalid atlas frame bounds");
  return {x,y,sw,sh,tw,th,width,height,ox,oy,rotated};
}
async function restore(image,g) {
  const {x,y,sw,sh,tw,th,width,height,ox,oy,rotated}=g;
  const canvas=new OffscreenCanvas(width,height),context=canvas.getContext("2d");
  if(!context)throw new Error("Atlas canvas unavailable");
  if(rotated){context.translate(ox,oy+th);context.rotate(-Math.PI/2);context.drawImage(image,x,y,sw,sh,0,0,sw,sh);}
  else context.drawImage(image,x,y,sw,sh,ox,oy,tw,th);
  return createImageBitmap(canvas,{premultiplyAlpha:"none"});
}
export async function loadPlistAtlas(source,assets) {
  const loaded=await assets.bytes(source.plist),plist=parsePlist(loaded.bytes);
  if(!plist.frames)throw new Error("Plist is not a sprite atlas");
  const frames=new Map([...collectFrames(plist.frames)].map(([name,f])=>[name,geometry(f)]));
  const image=await atlasImage(plist,source,assets);
  try{
    for(const g of frames.values())if(g.x+g.sw>image.width||g.y+g.sh>image.height)throw new Error("Atlas crop exceeds image");
    return {frames,async sprite(name){const g=frames.get(name);if(!g)throw new Error("Unknown atlas sprite");return restore(image,g);},dispose(){image.close();}};
  }catch(error){image.close();throw error;}
}
export async function decodePlistSprite(source,assets) {
  if(source.type!=="plist_sprite"||typeof source.sprite!=="string"||!["embedded","external"].includes(source.texture))throw new Error("Invalid plist source");
  const atlas=await loadPlistAtlas(source,assets);
  try{return await atlas.sprite(source.sprite);}finally{atlas.dispose();}
}
