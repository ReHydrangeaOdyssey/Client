import {point, inversePoint, viewport, contains} from "./scene-geometry.js";

const VERTEX=`#version 300 es
in vec2 position; in vec2 uv; out vec2 texcoord;
void main(){gl_Position=vec4(position,0.,1.);texcoord=uv;}`;
const FRAGMENT=`#version 300 es
precision highp float; uniform sampler2D image; uniform vec4 patchUV;
uniform bool tiled; in vec2 texcoord; out vec4 color;
void main(){vec2 uv=tiled?mix(patchUV.xy,patchUV.zw,fract(texcoord)):texcoord;color=texture(image,uv);}`;
export class WebGLRenderer {
  constructor(canvas, onError=()=>{}) {
    this.canvas=canvas; this.onError=onError; this.nodes=[]; this.textures=new Map();
    this.gl=canvas.getContext("webgl2",{alpha:false,premultipliedAlpha:false});
    if(!this.gl) throw new Error("WebGL 2 is unavailable");
    this.lost=false;
    this.onLost=e=>{e.preventDefault();this.lost=true;onError("WebGL context lost; input paused");};
    this.onRestored=()=>{this.lost=false;this.textures.clear();this.initialize();this.draw();};
    canvas.addEventListener("webglcontextlost",this.onLost);
    canvas.addEventListener("webglcontextrestored",this.onRestored);
    this.initialize(); this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(canvas);
  }
  initialize() {
    const gl=this.gl, shaders=[];
    try {
      for(const [type,source] of [[gl.VERTEX_SHADER,VERTEX],[gl.FRAGMENT_SHADER,FRAGMENT]]) {
        const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      }
      this.program=gl.createProgram();for(const shader of shaders)gl.attachShader(this.program,shader);
      gl.linkProgram(this.program);
      if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(this.program));
    } finally { for(const shader of shaders)gl.deleteShader(shader); }
    this.buffer=gl.createBuffer(); this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    for(const [name,offset] of [["position",0],["uv",8]]) {
      const location=gl.getAttribLocation(this.program,name);gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location,2,gl.FLOAT,false,16,offset);
    }
    gl.useProgram(this.program);gl.uniform1i(gl.getUniformLocation(this.program,"image"),0);
    gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  }
  texture(image) {
    if(this.textures.has(image))return this.textures.get(image);
    const gl=this.gl, texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
    if(gl.getError()!==gl.NO_ERROR){gl.deleteTexture(texture);throw new Error("Texture upload failed");}
    this.textures.set(image,texture);return texture;
  }
  prepareImages(images) {if(this.lost)throw new Error("WebGL context lost");for(const image of images)this.texture(image);}
  release(image) {const texture=this.textures.get(image);if(texture)this.gl.deleteTexture(texture);this.textures.delete(image);}
  setNodes(nodes) {this.nodes=nodes;this.draw();}
  layout() {
    const rect=this.canvas.getBoundingClientRect(), style=getComputedStyle(this.canvas);
    const inset={};for(const side of ["left","right","top","bottom"])inset[side]=parseFloat(style.getPropertyValue("--safe-"+side))||0;
    this.view=viewport(rect.width,rect.height,inset);this.rect=rect;
    const dpr=window.devicePixelRatio||1;
    const width=Math.round(rect.width*dpr),height=Math.round(rect.height*dpr);
    if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;
  }
  clip(node) {
    const v=this.view;let r={x:v.left,y:v.top,width:v.width,height:v.height};
    if(node.clip){const c=node.clip;
      const x=Math.max(r.x,v.cx+(c.x)*v.scale),y=Math.max(r.y,v.cy-(c.y+c.height)*v.scale);
      const right=Math.min(r.x+r.width,v.cx+(c.x+c.width)*v.scale);
      const bottom=Math.min(r.y+r.height,v.cy-c.y*v.scale);r={x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};}
    return r;
  }
  draw() {
    if(this.lost)return;
    try {
      this.layout();const gl=this.gl;gl.viewport(0,0,this.canvas.width,this.canvas.height);
      gl.disable(gl.SCISSOR_TEST);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
      if(!this.view)return;
      gl.useProgram(this.program);gl.bindVertexArray(this.vao);gl.activeTexture(gl.TEXTURE0);
      for(const node of this.nodes)if(node.visible!==false)this.drawNode(node);
    } catch(error){this.onError(error.message);}
  }
  drawNode(node) {
    const gl=this.gl,v=this.view,clip=this.clip(node),dpr=this.canvas.width/this.rect.width;
    if(!clip.width||!clip.height)return;
    gl.enable(gl.SCISSOR_TEST);gl.scissor(Math.round(clip.x*dpr),Math.round((this.rect.height-clip.y-clip.height)*dpr),Math.round(clip.width*dpr),Math.round(clip.height*dpr));
    const g=node.geometry;
    gl.bindTexture(gl.TEXTURE_2D,this.texture(node.image));gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    for(const p of g.patches){
      const vertices=[];
      const u0=p.tiled?0:p.u0,v0=p.tiled?0:p.v0,u1=p.tiled?p.repeatX:p.u1,v1=p.tiled?p.repeatY:p.v1;
      const corners=[[p.x,p.y,u0,v0],[p.x+p.width,p.y,u1,v0],[p.x,p.y+p.height,u0,v1],[p.x+p.width,p.y+p.height,u1,v1]];
      for(const index of [0,2,1,1,2,3]){const [x,y,u,t]=corners[index];const s=point(node.matrix,x-g.width/2,g.height/2-y);
        // CSS -> clip: x'=2*x/width-1, y'=1-2*y/height. Texture UV remains top-down.
        vertices.push(2*(v.cx+s.x*v.scale)/this.rect.width-1,1-2*(v.cy-s.y*v.scale)/this.rect.height,u,t);}
      gl.uniform1i(gl.getUniformLocation(this.program,"tiled"),p.tiled?1:0);
      gl.uniform4f(gl.getUniformLocation(this.program,"patchUV"),p.u0,p.v0,p.u1,p.v1);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.DYNAMIC_DRAW);gl.drawArrays(gl.TRIANGLES,0,6);
    }
  }

  hit(node,clientX,clientY) {
    if(this.lost||!this.view||node.visible===false)return false;
    const rect=this.canvas.getBoundingClientRect(),x=clientX-rect.left,y=clientY-rect.top;
    if(!contains(this.clip(node),x,y))return false;
    const local=inversePoint(node.matrix,(x-this.view.cx)/this.view.scale,(this.view.cy-y)/this.view.scale);
    return !!local&&Math.abs(local.x)<=node.geometry.width/2&&Math.abs(local.y)<=node.geometry.height/2;
  }
  destroy() {
    this.observer.disconnect();this.canvas.removeEventListener("webglcontextlost",this.onLost);this.canvas.removeEventListener("webglcontextrestored",this.onRestored);
    for(const image of this.textures.keys())this.release(image);
    this.gl.deleteBuffer(this.buffer);this.gl.deleteVertexArray(this.vao);this.gl.deleteProgram(this.program);this.nodes=[];
  }
}
