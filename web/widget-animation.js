import {object,list,number,multiply} from "./sprite-animation.js";
const FIELDS={positionx:"x",positiony:"y",scalex:"sx",scaley:"sy",rotation:"rotation",opacity:"opacity"};
function visible(value=true){if([true,1,"True","true","1"].includes(value))return true;if([false,0,"False","false","0"].includes(value))return false;throw new Error("Invalid widget visibility");}
function identifiers(value,track=false){return [value.name===undefined?null:String(value.name),value[track?"ActionTag":"actiontag"]===undefined?null:"tag:"+value[track?"ActionTag":"actiontag"]].filter(v=>v);}
function reference(o) {
  for(const key of ["fileNameData","textureData","backGroundImageData","normalData","pressedData","disabledData","fileName","texture"]){
    const v=o[key],path=typeof v==="string"?v:v?.path;
    if(path&&path!=="None"){if(typeof path!=="string")throw new Error("Invalid widget image");return path;}
  }
  return null;
}
export function parseWidgets(root) {
  const nodes=[],identities=new Map();
  function visit(value,parent=null){
    object(value);const o=object(value.options??{}),kind=value.classname??"";
    if(!["Panel","ImageView","Button","LoadingBar"].includes(kind))throw new Error("Unsupported widget: "+kind);
    const n={parent,options:o,kind,children:[],image:reference(o),width:number(o.width,1),height:number(o.height,1),ax:number(o.anchorPointX,.5),ay:number(o.anchorPointY,.5),z:number(o.ZOrder),percent:number(o.percent,100)};
    n.base={x:number(o.x),y:number(o.y),sx:number(o.scaleX,1),sy:number(o.scaleY,1),rotation:number(o.rotation),opacity:number(o.opacity,255),visible:visible(o.visible)};
    if(n.width<=0||n.height<=0||n.base.opacity<0||n.base.opacity>255||n.percent<0||n.percent>100)throw new Error("Invalid widget bounds or opacity");
    for(const id of identifiers(o)){const matches=identities.get(id)??[];matches.push(n);identities.set(id,matches);}
    nodes.push(n);for(const child of list(value.children))n.children.push(visit(child,n));n.children.sort((a,b)=>a.z-b.z);return n;
  }
  const tree=visit(root.widgetTree),actions=new Map(),width=number(root.designWidth,1280),height=number(root.designHeight,720);
  if(width<=0||height<=0)throw new Error("Invalid widget design size");
  for(const raw of list(root.animation?.actionlist)) {
    object(raw);if(typeof raw.name!=="string"||!raw.name||actions.has(raw.name))throw new Error("Missing or duplicate UI action");
    const unit=number(raw.unittime,1/60);if(unit<1/240||unit>60)throw new Error("Invalid widget unittime");
    const action={duration:1,unit,loop:visible(raw.loop??false),tracks:new Map()};
    for(const t of list(raw.actionnodelist)){
      object(t);const matches=new Set();
      for(const id of identifiers(t,true))for(const n of identities.get(id)??[])matches.add(n);
      if(matches.size!==1)throw new Error("Missing or ambiguous widget track");
      const n=[...matches][0];if(action.tracks.has(n))throw new Error("Duplicate widget track");
      const seen=new Set(),frames=list(t.actionframelist).map(f=>{
        object(f);const v={frameid:number(f.frameid),tweenType:number(f.tweenType)};
        if(!Number.isSafeInteger(v.frameid)||v.frameid<0||seen.has(v.frameid))throw new Error("Invalid widget keyframe");seen.add(v.frameid);
        for(const k of Object.keys(FIELDS))if(f[k]!==undefined)v[k]=number(f[k]);
        if(v.opacity!==undefined&&(v.opacity<0||v.opacity>255))throw new Error("Invalid widget opacity");
        if(f.visible!==undefined)v.visible=visible(f.visible);
        action.duration=Math.max(action.duration,v.frameid+1);return v;
      }).sort((a,b)=>a.frameid-b.frameid);action.tracks.set(n,frames);
    }
    actions.set(raw.name,action);
  }
  return {tree,nodes,actions,width,height};
}
function sample(node,frames,frame) {
  const state={...node.base};if(!frames?.length)return state;
  let i=0;while(i+1<frames.length&&frames[i+1].frameid<=frame)i++;
  const a=frames[i],b=frames[i+1]??a,span=b.frameid-a.frameid;
  // UI tracks use their own unittime; unknown nonlinear tweenType holds the source value.
  const r=span>0&&a.tweenType===0?Math.max(0,Math.min(1,(frame-a.frameid)/span)):0;
  for(const [src,dst] of Object.entries(FIELDS))if(a[src]!==undefined)state[dst]=a[src]+((b[src]??a[src])-a[src])*r;
  if(a.visible!==undefined)state.visible=a.visible;return state;
}
export function widgetPose(model,action,elapsed) {
  const logical=Math.max(0,Math.floor(elapsed/action.unit)),frame=action.loop?logical%action.duration:Math.min(logical,action.duration-1),draw=[];
  function visit(n,parent,offset,alpha) {
    const v=sample(n,action.tracks.get(n),frame);if(!v.visible)return;
    // UI rotation is clockwise degrees; bones and Scene rotation use radians.
    const radians=-v.rotation*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
    const m=multiply(parent,[v.sx*c,v.sx*s,-v.sy*s,v.sy*c,v.x+offset[0],v.y+offset[1]]),opacity=alpha*v.opacity/255;
    const fraction=n.kind==="LoadingBar"?n.percent/100:1,width=n.width*fraction;
    if(n.sprite&&fraction>0)draw.push({node:n,matrix:multiply(m,[width/n.sprite.width,0,0,n.height/n.sprite.height,0,0]),fraction,tint:[1,1,1,opacity]});
    for(const child of n.children)visit(child,m,[-width*n.ax,-n.height*n.ay],opacity);
  }
  visit(model.tree,[1,0,0,1,-model.width/2,-model.height/2],[0,0],1);
  return {draw,finished:!action.loop&&logical>=action.duration};
}
