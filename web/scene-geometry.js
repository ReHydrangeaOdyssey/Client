export function transform(data) {
  const {px, py, sx, sy, rotate} = data;
  if (![px, py, sx, sy, rotate].every(Number.isFinite)
      || [data.flip_x, data.flip_y].some(v => v !== undefined && typeof v !== "boolean"))
    throw new Error("scene_definition_error: invalid transform");
  const x = sx * (data.flip_x ? -1 : 1), y = sy * (data.flip_y ? -1 : 1);
  const c = Math.cos(rotate), s = Math.sin(rotate);
  // M = T R S F; X=a*x+c*y+e, Y=b*x+d*y+f.
  return [c*x, s*x, -s*y, c*y, px, py];
}
export function point(m, x, y) {
  return {x: m[0]*x + m[2]*y + m[4], y: m[1]*x + m[3]*y + m[5]};
}
export function inversePoint(m, x, y) {
  const determinant = m[0]*m[3] - m[1]*m[2];
  if (determinant === 0) return null;
  // Inverse affine transform uses the adjugate divided by det(M).
  x -= m[4]; y -= m[5];
  return {x: (m[3]*x-m[2]*y)/determinant, y: (-m[1]*x+m[0]*y)/determinant};
}
export function viewport(width, height, inset = {}) {
  const left=inset.left??0, top=inset.top??0;
  const w=width-left-(inset.right??0), h=height-top-(inset.bottom??0);
  if (!(w > 0 && h > 0)) return null;
  // Scene -> Client = 2/3; landscape q=h/720, portrait q=min(w/1280,h/720).
  const portrait=h>w, q=portrait ? Math.min(w/1280,h/720) : h/720;
  const scale=q*2/3, cx=left+w/2, cy=portrait ? top+h-360*q : top+h/2;
  return {scale,cx,cy,left,top:portrait ? top+h-720*q : top,width:w,height:portrait ? 720*q : h};
}
export function contains(rect, x, y) {
  return x >= rect.x && x <= rect.x+rect.width && y >= rect.y && y <= rect.y+rect.height;
}
export function imageGeometry(image, data) {
  const uv=data.uv??{u0:0,v0:0,u1:1,v1:1};
  const {u0,v0,u1,v1}=uv;
  if (![u0,v0,u1,v1].every(Number.isFinite) || u0<0 || v0<0 || u1>1 || v1>1 || u1<=u0 || v1<=v0)
    throw new Error("scene_definition_error: invalid UV");
  const width=image.width*(u1-u0), height=image.height*(v1-v0);
  return {width,height,patches:[{x:0,y:0,width,height,...uv}]};
}
export function windowGeometry(image, data) {
  const {width,height}=data.size??{}, {left,right,top,bottom}=data.slice??{};
  if (![width,height,left,right,top,bottom].every(v=>Number.isInteger(v)&&v>0)
      || width>8192 || height>8192 || left+right>=Math.min(image.width,width)
      || top+bottom>=Math.min(image.height,height) || !["repeat","stretch"].includes(data.fill)
      || data.alpha!=="source" || data.source || data.uv)
    throw new Error("scene_definition_error: invalid nine-slice");
  const xs=[0,left,image.width-right,image.width], ys=[0,top,image.height-bottom,image.height];
  const dx=[0,left,width-right,width], dy=[0,top,height-bottom,height], patches=[];
  for(let row=0;row<3;row++) for(let col=0;col<3;col++) {
    const sw=xs[col+1]-xs[col], sh=ys[row+1]-ys[row];
    const dw=dx[col+1]-dx[col], dh=dy[row+1]-dy[row];
    // One quad per patch; the shader repeats its UV, so tiny tiles do not allocate millions of vertices.
    patches.push({x:dx[col],y:dy[row],width:dw,height:dh,
      u0:xs[col]/image.width,v0:ys[row]/image.height,
      u1:xs[col+1]/image.width,v1:ys[row+1]/image.height,
      repeatX:data.fill==="repeat"&&col===1 ? dw/sw : 1,
      repeatY:data.fill==="repeat"&&row===1 ? dh/sh : 1,
      tiled:data.fill==="repeat"});
  }
  return {width,height,patches};
}
