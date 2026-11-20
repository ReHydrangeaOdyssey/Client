function xmlValue(node) {
  const children=[...node.children],text=node.textContent;
  switch(node.tagName) {
    case "dict": {
      if(children.length%2)throw new Error("Invalid plist dictionary");const value=Object.create(null);
      for(let i=0;i<children.length;i+=2){const key=children[i];if(key.tagName!=="key"||Object.hasOwn(value,key.textContent))throw new Error("Invalid plist key");value[key.textContent]=xmlValue(children[i+1]);}return value;
    }
    case "array":return children.map(xmlValue);
    case "string":return text;
    case "integer":case "real": {const n=Number(text);if(!text.trim()||!Number.isFinite(n)||(node.tagName==="integer"&&!Number.isSafeInteger(n)))throw new Error("Invalid plist number");return n;}
    case "true":return true;
    case "false":return false;
    case "data":return base64(text);
    default:throw new Error("Unsupported plist element: "+node.tagName);
  }
}
export function base64(text) {
  const decoded=atob(text.replace(/\s/g,""));return Uint8Array.from(decoded,c=>c.charCodeAt(0));
}
export function parsePlist(bytes) {
  const array=new Uint8Array(bytes);
  if(new TextDecoder().decode(array.subarray(0,8))==="bplist00")return binaryPlist(bytes);
  const document=new DOMParser().parseFromString(new TextDecoder("utf-8",{fatal:true}).decode(bytes),"application/xml");
  if(document.querySelector("parsererror")||document.documentElement.tagName!=="plist"||document.documentElement.children.length!==1)throw new Error("Invalid XML plist");
  return xmlValue(document.documentElement.firstElementChild);
}
function binaryPlist(bytes) {
  const data=new Uint8Array(bytes),view=new DataView(bytes);
  if(data.length<40)throw new Error("Invalid binary plist");
  const trailer=data.length-32,offsetSize=data[trailer+6],refSize=data[trailer+7];
  function uint(at,size) {
    if(!Number.isInteger(size)||size<1||size>8||at<0||at+size>data.length)throw new Error("Invalid plist integer bounds");
    let n=0n;for(let i=0;i<size;i++)n=(n<<8n)|BigInt(data[at+i]);
    if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("Plist integer exceeds safe range");return Number(n);
  }
  const count=uint(trailer+8,8),root=uint(trailer+16,8),table=uint(trailer+24,8);
  if(!count||root>=count||![1,2,4,8].includes(refSize)||![1,2,4,8].includes(offsetSize)||table<8||table+count*offsetSize>trailer)throw new Error("Invalid plist trailer");
  const memo=new Map(),visiting=new Set();
  function parse(id) {
    if(memo.has(id))return memo.get(id);
    if(!Number.isInteger(id)||id<0||id>=count||visiting.has(id))throw new Error("Invalid or cyclic plist reference");
    visiting.add(id);let at=uint(table+id*offsetSize,offsetSize);
    if(at<8||at>=table)throw new Error("Invalid plist object offset");
    const tag=data[at++],kind=tag>>4;let length=tag&15,value;
    function require(size){if(!Number.isSafeInteger(size)||size<0||at+size>table)throw new Error("Truncated plist object");}
    if([4,5,6,10,13].includes(kind)&&length===15){const marker=data[at++];if(marker>>4!==1)throw new Error("Invalid plist length");const size=2**(marker&15);require(size);length=uint(at,size);at+=size;}
    if(kind===0){if(tag===8)value=false;else if(tag===9)value=true;else if(tag===0)value=null;else throw new Error("Unsupported plist scalar");}
    else if(kind===1){const size=2**length;require(size);if(size===8&&data[at]>=128){const signed=view.getBigInt64(at);if(signed<BigInt(Number.MIN_SAFE_INTEGER))throw new Error("Plist integer out of range");value=Number(signed);}else value=uint(at,size);}
    else if(kind===2){const size=2**length;require(size);if(size!==4&&size!==8)throw new Error("Unsupported plist real");value=size===4?view.getFloat32(at):view.getFloat64(at);if(!Number.isFinite(value))throw new Error("Nonfinite plist real");}
    else if(kind===4){require(length);value=data.slice(at,at+length);}
    else if(kind===5||kind===6){const size=length*(kind===6?2:1);require(size);value=new TextDecoder(kind===6?"utf-16be":"utf-8",{fatal:true}).decode(data.subarray(at,at+size));}
    else if(kind===10){require(length*refSize);value=Array.from({length},(_,i)=>parse(uint(at+i*refSize,refSize)));}
    else if(kind===13){require(length*refSize*2);value=Object.create(null);for(let i=0;i<length;i++){const key=parse(uint(at+i*refSize,refSize));if(typeof key!=="string"||Object.hasOwn(value,key))throw new Error("Invalid plist dictionary key");value[key]=parse(uint(at+(length+i)*refSize,refSize));}}
    else throw new Error("Unsupported binary plist object");
    visiting.delete(id);memo.set(id,value);return value;
  }
  return parse(root);
}
