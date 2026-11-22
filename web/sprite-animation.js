const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);
export function object(value,label="object") {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid "+label);return value;
}
export function list(value){if(value==null)return [];if(!Array.isArray(value))throw new Error("Invalid collection");return value;}
export function number(value,fallback=0){if(value===undefined)return fallback;if(typeof value!=="number"||!Number.isFinite(value))throw new Error("Invalid animation number");return value;}
function name(value){if(typeof value!=="string"||!value)throw new Error("Missing animation name");return value;}
function unique(values,key){const map=new Map();for(const v of values){const k=key(v);if(map.has(k))throw new Error("Duplicate animation reference: "+k);map.set(k,v);}return map;}
function bool(value,fallback){if(value===undefined)return fallback;if(typeof value!=="boolean"&&value!==0&&value!==1)throw new Error("Invalid animation boolean");return Boolean(value);}
export function components(v) {
  object(v);return {x:number(v.x),y:number(v.y),cX:number(v.cX,1),cY:number(v.cY,1),kX:number(v.kX),kY:number(v.kY)};
}
function frame(v) {
  object(v);const fi=number(v.fi);
  if(fi<0)throw new Error("Negative animation keyframe");
  const f={...components(v),fi,z:number(v.z),tweenFrame:bool(v.tweenFrame,true),twE:number(v.twE),color:[255,255,255,255]};
  if(v.color!==undefined){object(v.color);f.color=["r","g","b","a"].map(k=>number(v.color[k],255));}
  if(f.color.some(v=>v<0||v>255))throw new Error("Invalid animation color");
  for(const k of ["dI","bd_src","bd_dst"])if(own(v,k))f[k]=number(v[k]);
  if(f.dI!==undefined&&!Number.isInteger(f.dI))throw new Error("Invalid display index");
  for(const [key,max] of [["bd_src",776],["bd_dst",775]])if(own(f,key)&&![0,1].includes(f[key])&&!(Number.isInteger(f[key])&&f[key]>=768&&f[key]<=max))throw new Error("Unsupported blend factor");
  return f;
}
function bone(v) {
  object(v);const displays=list(v.display_data).map(d=>{
    object(d);const skins=list(d.skin_data).map(components);
    const type=number(d.displayType);
    if(!Number.isInteger(type)||type<0)throw new Error("Invalid display type");
    return {type,name:d.name,plist:d.plist,skin:skins[0]??components({})};
  });
  const dI=number(v.dI);if(!Number.isInteger(dI))throw new Error("Invalid display index");
  return {...components(v),name:name(v.name),parent:v.parent??"",z:number(v.z),dI,displays};
}
function movement(v,bones) {
  object(v);const timelines=unique(list(v.mov_bone_data).map(t=>{
    object(t);if(!bones.has(t.name))throw new Error("Unknown timeline bone");
    const frames=list(t.frame_data).map(frame).sort((a,b)=>a.fi-b.fi);unique(frames,f=>f.fi);
    return {name:t.name,frames};
  }),t=>t.name);
  let duration=number(v.dr);const latest=[...timelines.values()].reduce((latest,t)=>t.frames.reduce((max,f)=>Math.max(max,f.fi),latest),0);
  // ExportJson dr<=0 becomes max(1,floor(latest keyframe)+1); duration counts display frames.
  if(duration<=0)duration=Math.max(1,Math.floor(latest)+1);
  if(!Number.isSafeInteger(duration))throw new Error("Invalid movement duration");
  return {name:name(v.name),duration,loop:bool(v.lp,false),timelines};
}
export function parseExportJson(bytes) {
  const root=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/^\uFEFF/,"")),"ExportJson");
  if(!Array.isArray(root.armature_data)) {
    if(root.widgetTree&&typeof root.widgetTree==="object")return {kind:"widget",raw:root};
    throw new Error("Unsupported ExportJson structure");
  }
  number(root.content_scale);
  const armatures=unique(root.armature_data.map(a=>{
    object(a);const bones=unique(list(a.bone_data).map(bone),b=>b.name),ordered=[],visiting=new Set(),visited=new Set();
    function visit(b){if(visited.has(b.name))return;if(visiting.has(b.name))throw new Error("Cyclic bone parent");visiting.add(b.name);
      if(b.parent){if(!bones.has(b.parent))throw new Error("Unknown bone parent");visit(bones.get(b.parent));}
      visiting.delete(b.name);visited.add(b.name);ordered.push(b);}
    for(const b of bones.values())visit(b);
    return {name:name(a.name),bones,ordered,movements:new Map()};
  }),a=>a.name);
  const animations=unique(list(root.animation_data).map(a=>object(a)),a=>name(a.name));
  for(const [id,a] of animations){const armature=armatures.get(id);if(!armature)throw new Error("Unknown animation armature");
    armature.movements=unique(list(a.mov_data).map(m=>movement(m,armature.bones)),m=>m.name);}
  const textures=unique(list(root.texture_data).map(t=>{object(t);return {name:name(t.name),width:t.width===undefined?null:number(t.width),height:t.height===undefined?null:number(t.height),pX:number(t.pX,.5),pY:number(t.pY,.5),plist:t.plistFile};}),t=>t.name);
  return {kind:"armature",armatures,textures,raw:root};
}
export function multiply(p,m) {
  // Affine composition P*M, using [a,b,c,d,tx,ty] and column vectors.
  return [p[0]*m[0]+p[2]*m[1],p[1]*m[0]+p[3]*m[1],p[0]*m[2]+p[2]*m[3],p[1]*m[2]+p[3]*m[3],p[0]*m[4]+p[2]*m[5]+p[4],p[1]*m[4]+p[3]*m[5]+p[5]];
}
export function matrix(v) {
  // Cocos bone axes: first column uses kY, second column uses kX.
  return [v.cX*Math.cos(v.kY),v.cX*Math.sin(v.kY),v.cY*Math.sin(v.kX),v.cY*Math.cos(v.kX),v.x,v.y];
}
export function easing(code,r) {
  // Sine and polynomial EaseIn/Out/InOut; unknown codes are linear.
  if(code===1)return 1-Math.cos(r*Math.PI/2);
  if(code===2)return Math.sin(r*Math.PI/2);
  if(code===3)return (1-Math.cos(Math.PI*r))/2;
  if(!Number.isInteger(code)||code<4||code>12)return r;
  const power=2+Math.floor((code-4)/3),mode=(code-4)%3;
  if(mode===0)return r**power;
  if(mode===1)return 1-(1-r)**power;
  return r<.5?(2*r)**power/2:1-(2*(1-r))**power/2;
}
export function sample(frames,at) {
  if(!frames?.length)return null;
  let i=0;while(i+1<frames.length&&frames[i+1].fi<=at)i++;
  const a=frames[i],b=frames[i+1];if(!b||!a.tweenFrame)return a;
  // Interpolate values directly; skew differences are not wrapped to shortest angles.
  const r=easing(a.twE,Math.max(0,Math.min(1,(at-a.fi)/(b.fi-a.fi)))),v={...a};
  for(const k of ["x","y","cX","cY","kX","kY"])v[k]=a[k]+(b[k]-a[k])*r;
  v.color=a.color.map((value,i)=>value+(b.color[i]-value)*r);return v;
}
export function pose(armature,movement,elapsed) {
  // Logical 60 fps is independent of rendering cadence. Non-looping clips hold duration-1.
  const logical=Math.max(0,Math.floor(elapsed*60)),at=movement.loop?logical%movement.duration:Math.min(logical,movement.duration-1),world=new Map(),draw=[];
  for(const b of armature.ordered) {
    const f=sample(movement.timelines.get(b.name)?.frames,at),v={...b};
    if(f){for(const k of ["x","y","kX","kY"])v[k]+=f[k];for(const k of ["cX","cY"])v[k]+=f[k]-1;}
    if(b.parent){const p=world.get(b.parent),m=p.matrix,x=v.x,y=v.y;
      // Position uses the parent matrix; scales multiply and skews add before matrix reconstruction.
      v.x=m[0]*x+m[2]*y+m[4];v.y=m[1]*x+m[3]*y+m[5];v.cX*=p.cX;v.cY*=p.cY;v.kX+=p.kX;v.kY+=p.kY;}
    v.matrix=matrix(v);world.set(b.name,v);
    const display=b.displays[f?.dI??b.dI];
    if(display)draw.push({bone:b,display,matrix:multiply(v.matrix,matrix(display.skin)),z:b.z+(f?.z??0),tint:(f?.color??[255,255,255,255]).map(n=>n/255),blend:[f?.bd_src??770,f?.bd_dst??771]});
  }
  const order=new Map([...armature.bones.keys()].map((name,i)=>[name,i]));
  draw.sort((a,b)=>a.z-b.z||order.get(a.bone.name)-order.get(b.bone.name));
  return {draw,finished:!movement.loop&&logical>=movement.duration};
}
