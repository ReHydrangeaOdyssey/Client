import {parseExportJson,pose,multiply} from "./sprite-animation.js";
import {parseWidgets,widgetPose} from "./widget-animation.js";
import {loadPlistAtlas} from "./plist-sprite.js";
import {localPath} from "./io.js";
import {imageGeometry} from "./scene-geometry.js";

const stem=path=>path.split("/").at(-1).replace(/\.[^.]+$/,"").toLowerCase();
const directory=path=>path.slice(0,path.lastIndexOf("/")+1);
const RESOURCE_DIRS=new Set(["export","exportjson","json","armature","armatures","animation","animations","res","resources","texture","textures","atlas","atlases","image","images","sprites","assets"]);
function references(value){if(value==null)return [];const a=typeof value==="string"?[value]:value;if(!Array.isArray(a)||a.some(v=>typeof v!=="string"||!v))throw new Error("Invalid animation dependency");return a;}
export class AnimationDependencies {
  constructor(file,assets){this.file=file;this.assets=assets;this.atlases=new Map();this.images=new Map();this.paths=new Set();}
  async initialize(){
    for(const ext of ["plist","png","jpg"])for(const path of await this.assets.paths(ext,true))this.paths.add("./assets/"+path);
  }
  resolve(reference,base=this.file) {
    if(typeof reference!=="string")throw new Error("Invalid dependency reference");
    const ref=reference.replaceAll("\\","/");if(!localPath(ref)||/[\x00-\x1f\x7f]/.test(ref))throw new Error("Unsafe dependency reference");
    const dir=directory(base),folders=new Set([dir]);
    const addChildren=root=>{for(const path of this.paths)if(path.startsWith(root)){const rest=path.slice(root.length),slash=rest.indexOf("/");if(slash>=0)folders.add(root+rest.slice(0,slash+1));}};
    addChildren(dir);
    const parts=dir.slice(0,-1).split("/");
    if(RESOURCE_DIRS.has(parts.at(-1).toLowerCase())&&parts.length>2){const parent=parts.slice(0,-1).join("/")+"/";folders.add(parent);addChildren(parent);}
    for(const part of new Set([ref,ref.split("/").at(-1)])){
      const matches=[...folders].map(folder=>folder+part).filter(path=>this.paths.has(path));
      if(matches.length>1)throw new Error("Ambiguous animation dependency");
      if(matches.length===1)return matches[0];
    }
    return null;
  }
  async atlas(path) {
    if(this.atlases.has(path))return;
    const atlas=await loadPlistAtlas({plist:path},this.assets);this.atlases.set(path,atlas);
  }
  async sprite(name,plist=null) {
    if(typeof name!=="string"||!name)throw new Error("Missing display image");
    const scope=plist?this.resolve(plist):null;if(plist&&!scope)throw new Error("Unresolved display atlas");
    if(scope)await this.atlas(scope);
    const found=[];
    for(const [path,atlas] of this.atlases)if(!scope||scope===path)for(const frame of atlas.frames.keys())if(stem(frame)===stem(name))found.push({path,atlas,frame});
    if(found.length>1)throw new Error("Ambiguous animation sprite");
    if(found.length){const a=found[0],key=a.path+"#"+a.frame;if(!this.images.has(key))this.images.set(key,await a.atlas.sprite(a.frame));return this.images.get(key);}
    if(scope)throw new Error("Display missing from specified atlas");
    const candidates=/\.(png|jpg)$/.test(name)?[name]:[name+".png",name+".jpg"];
    for(const candidate of candidates){const file=this.resolve(candidate);if(file){if(!this.images.has(file))this.images.set(file,await this.assets.image({file}));return this.images.get(file);}}
    throw new Error("Unresolved animation image");
  }
  dispose(){for(const atlas of this.atlases.values())atlas.dispose();for(const image of this.images.values())image.close();this.atlases.clear();this.images.clear();}
}
function centered(matrix,image,px,py) {
  // Renderer quads are centered; authored pivot offset is ((.5-pX)*width,(.5-pY)*height).
  return multiply(matrix,[1,0,0,1,(.5-px)*image.width,(.5-py)*image.height]);
}
async function armatureRuntime(model,key,deps) {
  const candidates=[...model.armatures.values()].filter(a=>a.movements.has(key));
  if(candidates.length!==1)throw new Error("Missing or ambiguous animation key");
  // Validate all images in the set before publishing any part of it.
  for(const armature of model.armatures.values())for(const bone of armature.bones.values())for(const d of bone.displays) {
    if(d.type!==0)throw new Error("Unsupported animation display type: "+d.type);
    const textures=[...model.textures.values()].filter(t=>stem(t.name)===stem(d.name));
    if(textures.length>1)throw new Error("Ambiguous animation texture");
    const t=textures[0];d.image=await deps.sprite(d.name,d.plist??t?.plist);
    if(t&&(t.width!==null&&t.width!==d.image.width||t.height!==null&&t.height!==d.image.height))throw new Error("Animation texture dimensions disagree");
    d.pX=t?.pX??.5;d.pY=t?.pY??.5;
  }
  const armature=candidates[0],movement=armature.movements.get(key);
  return elapsed=>{
    const result=pose(armature,movement,elapsed);
    return {finished:result.finished,nodes:result.draw.map(d=>({image:d.display.image,geometry:imageGeometry(d.display.image,{}),matrix:centered(d.matrix,d.display.image,d.display.pX,d.display.pY),tint:d.tint,blend:d.blend,interactive:false}))};
  };
}
async function widgetRuntime(root,key,deps) {
  const model=parseWidgets(root),action=model.actions.get(key);if(!action)throw new Error("Unknown widget action key");
  for(const node of model.nodes)if(node.image)node.sprite=await deps.sprite(node.image);
  return elapsed=>{
    const result=widgetPose(model,action,elapsed);
    return {finished:result.finished,nodes:result.draw.map(d=>{
      const image=d.node.sprite,geometry=imageGeometry(image,{});
      for(const patch of geometry.patches)patch.u1*=d.fraction;
      return {image,geometry,matrix:centered(d.matrix,image,d.node.ax,d.node.ay),tint:d.tint,interactive:false};
    })};
  };
}
export async function decodeAnimation(data,assets) {
  if(typeof data.key!=="string"||!data.key)throw new Error("Animation key required");
  const loaded=await assets.bytes(data.file),model=parseExportJson(loaded.bytes),deps=new AnimationDependencies(data.file,assets);
  try {
    await deps.initialize();
    const paths=references(model.kind==="armature"?model.raw.config_file_path:model.raw.textures);
    if(model.kind==="armature"&&model.raw.config_file_path==null)paths.push(data.file.split("/").at(-1).replace(/\.ExportJson$/,"0.plist"));
    for(const ref of paths){const path=deps.resolve(ref);if(!path)throw new Error("Unresolved animation plist");await deps.atlas(path);}
    for(const ref of references(model.kind==="armature"?model.raw.config_png_path:model.raw.texturesPng))if(!deps.resolve(ref))throw new Error("Unresolved animation texture dependency");
    const evaluate=model.kind==="armature"?await armatureRuntime(model,data.key,deps):await widgetRuntime(model.raw,data.key,deps);
    return {evaluate,images:[...deps.images.values()],dispose:()=>deps.dispose()};
  }catch(error){deps.dispose();throw error;}
}
