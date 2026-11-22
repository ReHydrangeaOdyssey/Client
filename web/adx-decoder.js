// Non-encrypted ADX; recurrence and filter derivation follow pinned vgmstream (see source-lock.json).
export class AdxStream {
  constructor(bytes) {
    this.bytes=new Uint8Array(bytes);this.view=new DataView(bytes);const v=this.view,b=this.bytes;
    if(b.length<20||v.getUint16(0)!==0x8000)throw new Error("Invalid ADX signature");
    this.start=v.getUint16(2)+4;this.encoding=b[4];this.channels=b[7];this.rate=v.getUint32(8);this.count=v.getUint32(12);this.version=v.getUint16(18);
    if(![2,3,4].includes(this.encoding)||b[5]!==18||b[6]!==4||![1,2].includes(this.channels)||!this.rate||!this.count
        ||![0x0300,0x0400,0x0500].includes(this.version)||this.start<26||this.start>b.length
        ||String.fromCharCode(...b.subarray(this.start-6,this.start))!=="(c)CRI")throw new Error("Unsupported or invalid ADX header");
    if(this.start+Math.ceil(this.count/32)*18*this.channels>b.length)throw new Error("Truncated ADX samples");
    const cutoff=v.getUint16(16);
    // c=(sqrt(2)-cos(2*pi*cutoff/rate)-sqrt((a+b)*(a-b)))/b; prediction coefficients are c*8192 and -c*c*4096.
    const z=Math.cos(2*Math.PI*cutoff/this.rate),a=Math.SQRT2-z,d=Math.SQRT2-1,c=(a-Math.sqrt((a+d)*(a-d)))/d;
    this.coefficients=[Math.trunc(c*8192),Math.trunc(-c*c*4096)];
    if(!this.coefficients.every(Number.isFinite))throw new Error("Invalid ADX filter");
    if(this.version===0x0400&&this.start<24+Math.max(8,4*this.channels)+6)throw new Error("Missing ADX histories");
    this.reset();
  }
  sample_rate(){return this.rate;}
  verified_key(){return "";}
  finished(){return this.position>=this.count;}
  free(){}
  reset(){this.position=0;this.at=this.start;this.history=Array.from({length:this.channels},(_,i)=>this.version===0x0400?[this.view.getInt16(24+i*4),this.view.getInt16(26+i*4)]:[0,0]);}
  next_pcm() {
    if(this.finished())return new Float32Array();const length=Math.min(32,this.count-this.position),result=new Float32Array(length*2);
    for(let channel=0;channel<this.channels;channel++){
      const at=this.at+channel*18,header=this.view.getUint16(at);let scale,c1,c2;
      if(this.encoding===2){const filters=[[0,0],[0xf00,0],[0x1cc0,-0xd00],[0x1880,-0xdc0]],index=header>>13;if(!filters[index])throw new Error("Invalid ADX predictor");[c1,c2]=filters[index];scale=(header&8191)+1;}
      else {[c1,c2]=this.coefficients;if(this.encoding===4){if(header>12)throw new Error("Invalid ADX exponent");scale=2**(12-header);}else{if(header>32767&&header!==0x8001)throw new Error("Encrypted ADX is unsupported");scale=header===0x8001?0:header+1;}}
      let [h1,h2]=this.history[channel];
      for(let i=0;i<length;i++) {
        const packed=this.bytes[at+2+(i>>1)];let nibble=i&1?packed&15:packed>>4;if(nibble>=8)nibble-=16;
        // ADX v3 rounds each prediction term; v4/v5 round their sum, then clamp to signed PCM16.
        const prediction=this.version===0x0300?Math.floor(c1*h1/4096)+Math.floor(c2*h2/4096):Math.floor((c1*h1+c2*h2)/4096);
        const value=Math.max(-32768,Math.min(32767,nibble*scale+prediction));h2=h1;h1=value;
        result[i*2+channel]=value/32768;if(this.channels===1)result[i*2+1]=result[i*2];
      }
      this.history[channel]=[h1,h2];
    }
    this.at+=18*this.channels;this.position+=length;return result;
  }
}
