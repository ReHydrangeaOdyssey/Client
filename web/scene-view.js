import {multiply} from "./sprite-animation.js";
import {UsmPlayer} from "./usm-player.js";
import {boundary, fail, ok} from "./io.js";
import {transform, imageGeometry, windowGeometry} from "./scene-geometry.js";

export class SceneView {
  constructor(renderer, assets, {setLoading=()=>{},onError=()=>{},checkEntry=()=>ok(null),isCurrent=()=>true,audio=null}={}) {
    this.renderer=renderer;this.assets=assets;this.setLoadingUI=setLoading;this.onError=onError;
    this.checkEntry=checkEntry;this.isCurrent=isCurrent;this.current=null;this.loading=false;this.sequence=0;
    this.audio=audio;this.videos=new Set();this.dynamic=new Map();
    this.listeners=[];this.installInput();
  }
  setLoading(value){this.loading=value;this.cancelPointer();this.setLoadingUI(value);}
  async prepare(scene,ticket) {
    const state={scene,ticket,models:new Map(),ready:new Set(),images:new Set(),animations:new Set(),audio:new Map(),disposed:false,groups:new Map(),overrides:new Map()};
    try {
      if(Object.keys(scene.assets.bgm).length>1)throw new Error("Multiple simultaneous BGM entries are not defined");
      for(const [kind,values] of Object.entries(scene.assets.ui))for(const [name,data] of Object.entries(values))this.register(state,"ui."+kind+"."+name,kind,data);
      for(const [name,data] of Object.entries(scene.assets.animation))this.register(state,"animation."+name,"animation",data);
      for(const [name,data] of Object.entries(scene.scroll_groups??{})) {
        if(![data.px,data.py,data.width,data.height].every(Number.isFinite)||data.width<1||data.width>7680||data.height<1||data.height>4320
            ||typeof data.scroll_x!=="boolean"||typeof data.scroll_y!=="boolean"||!Array.isArray(data.members))throw new Error("Invalid scroll group: "+name);
        for(const ref of data.members){const model=state.models.get(ref);if(!model||model.group)throw new Error("Invalid scroll membership: "+ref);model.group=name;}
        state.groups.set(name,{...data,x:0,y:0});
      }
      this.validateEvents(state);
      const exclusive=new Map();
      for(const model of state.models.values())if(model.kind==="toggle button"&&model.data.group) {
        if(model.parent)throw new Error("Exclusive child toggle is invalid");
        const list=exclusive.get(model.data.group)??[];list.push(model);exclusive.set(model.data.group,list);
      }
      for(const list of exclusive.values())if(list.length<2||list.filter(m=>m.on).length!==1)throw new Error("Invalid exclusive toggle defaults");
      const order=scene.asset_order.map(ref=>state.models.get(ref));
      if(order.some(model=>!model)||new Set(scene.asset_order).size!==order.length)throw new Error("Invalid asset order");
      const children=[...state.models.values()].filter(m=>m.parent).sort((a,b)=>a.layer-b.layer);
      const layers=new Set();for(const child of children){if(!Number.isInteger(child.layer)||child.layer<0||child.layer>order.length||layers.has(child.layer))throw new Error("Invalid child layer");layers.add(child.layer);order.splice(child.layer,0,child);}
      state.order=order;
      if(scene.assets.background.main)this.register(state,"background.main","background",scene.assets.background.main);
      for(const model of state.models.values())model.pending=this.load(state,model);
      for(const kind of ["bgm","se"])for(const [name,data] of Object.entries(scene.assets[kind])) {
        const ref=kind+"."+name;
        state.audio.set(ref,this.assets.audio(data).then(value=>{if(state.disposed){value.dispose?.();return;}state.ready.add(ref);return value;}).catch(error=>{state.audioErrors??=new Map();state.audioErrors.set(ref,error.message);}));
      }
      for(const ref of scene.critical){await(state.models.get(ref)?.pending??state.audio.get(ref));if(!state.ready.has(ref))throw new Error(ref+": "+(state.models.get(ref)?.error??state.audioErrors?.get(ref)??"resource unavailable"));}
      return ok(state);
    }catch(error){await this.dispose(state);return fail(error.message);}
  }
  register(state,ref,kind,data,parent=null,depth=0,metadata={}) {
    if(depth>8||state.models.has(ref))throw new Error("Invalid nested asset reference: "+ref);
    if(!["image","button","toggle button","window","animation","background"].includes(kind))throw new Error("Unknown Scene asset kind");
    const model={ref,kind,data,parent,states:new Map(),...metadata};
    if(kind==="toggle button") {if(!["on","off"].includes(data.default))throw new Error("Invalid toggle default");model.on=data.default==="on";}
    model.matrix=kind==="background"?[1,0,0,1,0,0]:transform(data);state.models.set(ref,model);
    for(const event of data.events??[])if(event.type==="show") {
      if(kind!=="toggle button"||!event.asset)throw new Error("Invalid show event");
      const a=event.asset,childRef=a.group==="animation"?"animation."+a.name:"ui."+a.group+"."+a.name;
      this.register(state,childRef,a.group,a.data,ref,depth+1,{layer:a.layer,critical:a.critical===true});
    }
  }
  async load(state,model) {
    try {
      if(model.kind==="animation"){
        const animation=await this.assets.animation(model.data);
        if(state.disposed){animation.dispose();return;}
        state.animations.add(animation);this.renderer.prepareImages(animation.images);
        model.animation=animation;state.ready.add(model.ref);
        if(this.current===state)this.refresh();
        return;
      }
      const definitions=model.kind==="button"?["idle","on push"]:model.kind==="toggle button"?["off","on"]:["normal"];
      for(const key of definitions) {
        const source=key==="normal"?model.data:model.data.state?.[key];
        if(!source|| (key!=="normal"&&!source.source&&!source.uv))throw new Error("Missing image state: "+key);
        const image=await this.assets.image(source);
        if(state.disposed){image.close?.();return;}
        state.images.add(image);
        const geometry=model.kind==="window"?windowGeometry(image,model.data):imageGeometry(image,source);
        this.renderer.prepareImages([image]);model.states.set(key,{image,geometry});
      }
      state.ready.add(model.ref);
    }catch(error){model.error=error.message;if(this.current===state)this.onError(model.ref+": "+model.error);}
    if(this.current===state&&!state.disposed)this.refresh();
  }
  parentOn(state,model) {
    if(!model.parent)return true;
    const parent=state.models.get(model.parent);return parent.on&&this.parentOn(state,parent);
  }
  validateEvents(state) {
    for(const model of state.models.values()){
      const seen=new Set();
      if(model.data.se&&!Object.hasOwn(state.scene.assets.se,model.data.se))throw new Error("Unknown Scene SE");
      for(const event of model.data.events??[]){
        if(model.kind==="button"){
          if(!["show_scroll_group","hide_scroll_group","toggle_scroll_group"].includes(event.type)||!state.groups.has(event.group)||seen.has(event.group)
            ||model.group===event.group&&event.type!=="hide_scroll_group")throw new Error("Invalid button scroll event");
          seen.add(event.group);
        }else if(model.kind==="toggle button"){
          if(event.type==="hide"){const target=state.models.get(event.target);if(!target||target.parent||target===model)throw new Error("Invalid toggle hide target");}
          else if(event.type==="show_scroll_group"){if(!state.groups.has(event.group)||model.group===event.group)throw new Error("Invalid toggle scroll event");}
          else if(event.type!=="show")throw new Error("Invalid toggle event");
        }else throw new Error("Events require a button");
      }
    }
    this.presentation(state);
  }
  presentation(state) {
    const visible=new Map(),groups=new Map(),visiting=new Set(),hide=new Map(),show=new Map();
    for(const model of state.models.values())if(model.kind==="toggle button")for(const event of model.data.events??[]){
      const map=event.type==="hide"?hide:event.type==="show_scroll_group"?show:null;
      if(map){const key=event.target??event.group;const triggers=map.get(key)??[];triggers.push(model);map.set(key,triggers);}
    }
    const active=model=>model.on&&isVisible(model.ref);
    const groupVisible=name=>{
      if(groups.has(name))return groups.get(name);
      const key="group:"+name;if(visiting.has(key))throw new Error("Cyclic Scene visibility");visiting.add(key);
      const triggers=show.get(name),value=state.overrides.get(name)??(!triggers||triggers.some(active));
      visiting.delete(key);groups.set(name,value);return value;
    };
    const isVisible=ref=>{
      if(visible.has(ref))return visible.get(ref);
      if(visiting.has(ref))throw new Error("Cyclic Scene visibility");visiting.add(ref);
      const m=state.models.get(ref);
      const value=(!m.parent||active(state.models.get(m.parent)))&&!(hide.get(ref)??[]).some(active)&&(!m.group||groupVisible(m.group));
      visiting.delete(ref);visible.set(ref,value);return value;
    };
    for(const ref of state.models.keys())isVisible(ref);
    for(const name of state.groups.keys())groupVisible(name);
    state.groupVisibility=groups;return visible;
  }
  refresh() {
    const state=this.current;if(!state||state.disposed)return;
    const visible=this.presentation(state),nodes=[];let running=false;
    const background=state.models.get("background.main");
    for(const model of [background,...state.order].filter(Boolean)) {
      if(model.animation&&visible.get(model.ref)){
        if(model.started===undefined){
          model.started=performance.now();
          if(model.data.se)state.audio.get("se."+model.data.se)?.then(resource=>{
            if(resource&&this.current===state&&!state.disposed)this.audio?.play(resource,"se").catch(error=>this.onError(error.message));
          });
        }
        const evaluated=model.animation.evaluate((performance.now()-model.started)/1000);
        running||=!evaluated.finished;
        for(const part of evaluated.nodes){const node={...part,ref:model.ref,matrix:multiply(model.matrix,part.matrix)};
          this.applyScroll(state,model,node);nodes.push(node);}
        continue;
      }
      const key=model.kind==="button"?(this.pointer?.ref===model.ref?"on push":"idle"):model.kind==="toggle button"?(model.on?"on":"off"):"normal";
      const sprite=model.states.get(key);if(!sprite||!visible.get(model.ref))continue;
      const node={...sprite,ref:model.ref,matrix:[...model.matrix],interactive:["button","toggle button"].includes(model.kind)};
      this.applyScroll(state,model,node);
      nodes.push(node);
    }
    for(const [ref,item] of this.dynamic){nodes.splice(Math.min(item.layer,nodes.length),0,{...item.node,ref});}
    this.renderer.setNodes(nodes);
    if(running&&!this.animationFrame)this.animationFrame=requestAnimationFrame(()=>{this.animationFrame=null;try{this.refresh();}catch(error){this.onError(error.message);}});
    if(this.pointer&&!nodes.some(n=>n.ref===this.pointer.ref))this.cancelPointer();
  }
  applyScroll(state,model,node) {
    if(model.group){const g=state.groups.get(model.group);node.matrix[4]-=g.x;node.matrix[5]+=g.y;node.clip={x:g.px-g.width/2,y:g.py-g.height/2,width:g.width,height:g.height};}
  }
  commit(state) {
    if(state.disposed||this.renderer.lost)return fail("Scene is no longer drawable");
    const old=this.current,oldDynamic=this.dynamic;this.cancelPointer();this.current=state;this.dynamic=new Map();
    try{this.refresh();}catch(error){this.current=old;this.dynamic=oldDynamic;if(old)this.refresh();return fail(error.message);}
    for(const video of [...this.videos])video.stop();this.videos.clear();this.dynamic.clear();
    this.audio?.transition();
    if(old)this.dispose(old);
    const bgms=Object.keys(state.scene.assets.bgm);
    if(bgms.length===1)state.audio.get("bgm."+bgms[0])?.then(resource=>{
      if(resource&&this.current===state&&!state.disposed)this.audio?.play(resource,"bgm").catch(error=>this.onError(error.message));
    });
    for(const model of state.models.values())if(model.error)this.onError(model.ref+": "+model.error);
    return ok(null);
  }
  async dispose(state) {
    state.disposed=true;
    for(const image of state.images){this.renderer.release(image);image.close?.();}state.images.clear();
    for(const animation of state.animations){for(const image of animation.images)this.renderer.release(image);animation.dispose();}state.animations.clear();
    for(const promise of state.audio.values())promise.then(value=>value?.dispose?.());
  }
  applyEvents(events) {
    const state=this.current;if(!state)return fail("No active Scene");
    const pending=new Map(state.overrides),seen=new Set();
    for(const event of events){if(!state.groups.has(event.group)||seen.has(event.group))return fail("Invalid scroll event");seen.add(event.group);
      if(event.type==="show_scroll_group")pending.set(event.group,true);
      else if(event.type==="hide_scroll_group")pending.set(event.group,false);
      else if(event.type==="toggle_scroll_group")pending.set(event.group,!(pending.get(event.group)??state.groupVisibility.get(event.group)));
      else return fail("Unsupported button event: "+event.type);}
    state.overrides=pending;this.refresh();return ok(null);
  }
  async toggle(ref) {
    const state=this.current,model=state?.models.get(ref);if(!model||this.loading||this.toggleBusy)return fail("Toggle unavailable");
    this.toggleBusy=true;
    try{
      if(!model.on)for(const child of state.models.values())if(child.critical){
        let parent=child.parent;while(parent&&parent!==ref&&state.models.get(parent).on)parent=state.models.get(parent).parent;
        if(parent===ref){await child.pending;if(child.error)return fail(child.error);}
      }
      if(this.current!==state||state.disposed)return fail("Stale toggle activation");
      if(model.data.group){for(const other of state.models.values())if(other.data.group===model.data.group)other.on=other===model;}
      else model.on=!model.on;
      this.cancelPointer();this.refresh();return ok(null);
    }finally{this.toggleBusy=false;}
  }
  scroll(group,x,y) {
    const g=this.current?.groups.get(group);if(!g||!Number.isFinite(x)||!Number.isFinite(y))return fail("Invalid scroll request");
    // Explicit offsets preserve authored coordinates; no unspecified drag threshold or bounds are inferred.
    if(g.scroll_x)g.x=x;if(g.scroll_y)g.y=y;this.cancelPointer();this.refresh();return ok(null);
  }
  cancelPointer() {
    const pointer=this.pointer;this.pointer=null;
    if(pointer&&this.renderer.canvas.hasPointerCapture(pointer.id))this.renderer.canvas.releasePointerCapture(pointer.id);
    if(pointer&&this.current)this.refresh();
  }
  installInput() {
    const canvas=this.renderer.canvas;
    const listen=(type,handler)=>{canvas.addEventListener(type,handler);this.listeners.push([type,handler]);};
    listen("pointerdown",event=>{
      if(this.loading||this.toggleBusy||this.pointer||event.button!==0||this.renderer.lost)return;
      this.audio?.unlock().catch(error=>this.onError(error.message));
      const hits=this.renderer.nodes.filter(n=>n.interactive&&this.renderer.hit(n,event.clientX,event.clientY));
      if(hits.length!==1)return;
      this.pointer={id:event.pointerId,ref:hits[0].ref,state:this.current};
      canvas.setPointerCapture(event.pointerId);this.refresh();
    });
    listen("pointermove",event=>{if(this.pointer?.id!==event.pointerId)return;
      const node=this.renderer.nodes.find(n=>n.ref===this.pointer.ref);
      if(!node||!this.renderer.hit(node,event.clientX,event.clientY))this.cancelPointer();});
    listen("pointerup",event=>{
      const pointer=this.pointer;if(pointer?.id!==event.pointerId)return;
      const node=this.renderer.nodes.find(n=>n.ref===pointer.ref);
      const valid=!this.loading&&pointer.state===this.current&&node&&this.renderer.hit(node,event.clientX,event.clientY);
      this.cancelPointer();if(!valid)return;
      const model=this.current.models.get(pointer.ref),activationId=++this.sequence;
      const audioState=this.current;
      if(model.data.se)audioState.audio.get("se."+model.data.se)?.then(resource=>{
        if(resource&&this.current===audioState&&!audioState.disposed)this.audio?.play(resource,"se").catch(error=>this.onError(error.message));
      });
      const action=model.kind==="toggle button"?this.toggle(pointer.ref):this.activate?.(pointer.ref,activationId);
      Promise.resolve(action).then(result=>{if(result&&!result.ok)this.onError(result.error);}).catch(error=>this.onError(error.message));
    });
    listen("wheel",event=>{
      if(this.loading||!this.current||!this.renderer.view||event.deltaMode!==0)return;
      const v=this.renderer.view,r=canvas.getBoundingClientRect(),x=(event.clientX-r.left-v.cx)/v.scale,y=(v.cy-event.clientY+r.top)/v.scale;
      const groups=[...this.current.groups.entries()].filter(([name,g])=>this.current.groupVisibility.get(name)&&Math.abs(x-g.px)<=g.width/2&&Math.abs(y-g.py)<=g.height/2);
      if(groups.length!==1)return;const [name,g]=groups[0];
      this.scroll(name,g.x+event.deltaX/v.scale,g.y+event.deltaY/v.scale);event.preventDefault();
    });
    for(const type of ["pointercancel","lostpointercapture"])listen(type,event=>{if(this.pointer?.id===event.pointerId)this.cancelPointer();});
  }
  async playVideo(file,placement,layer,options={}) {
    if(!this.current||!this.audio||!Number.isInteger(layer)||layer<0)throw new Error("Video placement is required");
    const state=this.current,matrix=transform(placement),ref="video."+(++this.sequence);
    let surface=null;
    const player=new UsmPlayer(this.audio,{onError:this.onError,onStatus:options.onStatus,
      onFrame:frame=>{
        if(this.current!==state||state.disposed)return;
        if(!surface||surface.width!==frame.displayWidth||surface.height!==frame.displayHeight){if(surface)this.renderer.release(surface);surface=new OffscreenCanvas(frame.displayWidth,frame.displayHeight);}
        surface.getContext("2d").drawImage(frame,0,0);
        this.renderer.release(surface);
        this.dynamic.set(ref,{layer,node:{image:surface,geometry:imageGeometry(surface,{}),matrix,interactive:false}});this.refresh();
      }});
    const stop=player.stop.bind(player);
    player.stop=()=>{stop();if(surface)this.renderer.release(surface);surface=null;this.dynamic.delete(ref);this.videos.delete(player);if(this.current===state&&!state.disposed)this.refresh();};
    try{await player.prepare(await this.assets.file(file),options);this.videos.add(player);if(this.current!==state||state.disposed)throw new Error("Stale video request");await player.play();return player;}
    catch(error){player.stop();this.videos.delete(player);throw error;}
  }
  destroy(){cancelAnimationFrame(this.animationFrame);this.animationFrame=null;for(const video of [...this.videos])video.stop();this.videos.clear();this.dynamic.clear();this.cancelPointer();for(const [type,handler] of this.listeners)this.renderer.canvas.removeEventListener(type,handler);if(this.current)this.dispose(this.current);this.current=null;this.renderer.destroy();}
}
