import {decodePlistSprite} from "./plist-sprite.js";
import {digest, localPath, opfsDirectory} from "./io.js";

const HASH=/^[a-f0-9]{64}$/;
const EXTENSIONS=["png","jpg","hca","usm","plist","ExportJson"];
function safeAsset(path) {
  return localPath(path)&&!/[\x00-\x1f\x7f]/.test(path)&&!path.startsWith("assets/")
    && !["scene","master_data","fallback_assets",".scene_generated"].includes(path.split("/")[0]);
}
export function dictionaryPaths(data, extension) {
  if(!data||typeof data!=="object"||Array.isArray(data)||!Object.keys(data).length)throw new Error("Invalid or empty AssetDictionary");
  const paths=new Set();
  for(const [name,entry] of Object.entries(data)) {
    if(!new RegExp("^[A-Za-z0-9_()\\-]+\\."+extension+"$").test(name)
        || !entry||typeof entry.path!=="string"||!entry.paths||typeof entry.paths!=="object"||Array.isArray(entry.paths)
        || (entry.sha256!==undefined&&!HASH.test(entry.sha256)))throw new Error("Invalid AssetDictionary entry");
    const groups=Object.entries(entry.paths);let allowed=[];
    if(entry.path){if(groups.length)throw new Error("Ambiguous AssetDictionary path");allowed=[entry.path];}
    else {
      if(!groups.length)throw new Error("Empty AssetDictionary paths");
      for(const [hash,values] of groups){if(!HASH.test(hash)||!Array.isArray(values)||!values.length)throw new Error("Invalid AssetDictionary group");allowed.push(...values);}
    }
    for(const path of allowed){
      if(!safeAsset(path)||!path.endsWith("."+extension)||paths.has(path))throw new Error("Invalid or duplicate AssetDictionary path");
      paths.add(path);
    }
  }
  return paths;
}
export class SceneAssets {
  constructor({spriteDecoder,animationDecoder,audioDecoder}={}) {
    this.spriteDecoder=spriteDecoder??decodePlistSprite;this.animationDecoder=animationDecoder;this.audioDecoder=audioDecoder;
    this.dictionaries=new Map();
  }
  async readFile(parts) {
    const directory=await opfsDirectory(parts.slice(0,-1));
    return (await directory.getFileHandle(parts.at(-1))).getFile();
  }
  async bytes(file) {
    if(typeof file!=="string"||!file.startsWith("./assets/")||!safeAsset(file.slice(9)))throw new Error("Unsafe Scene asset path");
    const path=file.slice(9), extension=path.split('.').at(-1);
    if(!EXTENSIONS.includes(extension))throw new Error("Unsupported asset extension: "+extension);
    if(!this.dictionaries.has(extension)) {
      let dictionary;
      try {dictionary=await this.readFile(["asset_dictionary",extension,"assets_dict.json"]);}
      catch(error){throw new Error("AssetDictionary unavailable: "+extension+" ("+error.name+")");}
      this.dictionaries.set(extension,dictionaryPaths(JSON.parse(await dictionary.text()),extension));
    }
    if(!this.dictionaries.get(extension).has(path))throw new Error("Asset path is not allowed by dictionary: "+file);
    const blob=await this.readFile(["assets",...path.split('/')]);
    if(!blob.size)throw new Error("Empty asset: "+file);
    const bytes=await blob.arrayBuffer();return {bytes,hash:await digest(bytes),extension};
  }
  async image(data) {
    if(data.source) {
      if(data.file!==undefined||data.uv!==undefined)throw new Error("Mixed file and plist source");
      if(!this.spriteDecoder)throw new Error("unsupported_format: plist sprite decoder is not connected");
      return this.spriteDecoder(data.source,this);
    }
    const {bytes,extension}=await this.bytes(data.file),signature=new Uint8Array(bytes);
    const png=extension==="png"&&[137,80,78,71,13,10,26,10].every((v,i)=>signature[i]===v);
    const jpg=extension==="jpg"&&signature[0]===255&&signature[1]===216&&signature[2]===255;
    if(!png&&!jpg)throw new Error("Invalid PNG/JPG signature: "+data.file);
    return createImageBitmap(new Blob([bytes],{type:png?"image/png":"image/jpeg"}),{premultiplyAlpha:"none",imageOrientation:"none"});
  }
  async animation(data) {
    if(!this.animationDecoder)throw new Error("unsupported_format: ExportJson decoder is not connected");
    return this.animationDecoder(data,this);
  }
  async audio(data) {
    if(!this.audioDecoder)throw new Error("unsupported_format: HCA decoder is not connected");
    return this.audioDecoder(data,this);
  }
}
