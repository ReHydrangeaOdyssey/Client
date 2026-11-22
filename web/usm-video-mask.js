// CRI packet mask derivation follows cridecoder 0.3.6 (MIT); see third-party-licenses.txt.
export function unmaskVideo(packet,keyHex) {
  if(!/^[a-fA-F0-9]{16}$/.test(keyHex))throw new Error("Invalid USM key representation");
  const data=packet.slice();if(data.length<0x240)return data;
  const key=BigInt("0x"+keyHex),k1=Number(key&0xffffffffn),k2=Number(key>>32n),t=new Uint8Array(32);
  // All mask arithmetic is modulo 256; key parsing remains lossless u64.
  t[0]=k1;t[1]=k1>>>8;t[2]=k1>>>16;t[3]=(k1>>>24)-0x34;t[4]=(k2&15)+0xf9;t[5]=(k2>>>8)^0x13;t[6]=(k2>>>16)+0x61;t[7]=t[0]^255;
  t[8]=t[2]+t[1];t[9]=t[1]-t[7];t[10]=t[2]^255;t[11]=t[1]^255;t[12]=t[11]+t[9];t[13]=t[8]-t[3];t[14]=t[13]^255;t[15]=t[10]-t[11];
  t[16]=t[8]-t[15];t[17]=t[16]^t[7];t[18]=t[15]^255;t[19]=t[3]^0x10;t[20]=t[4]-0x32;t[21]=t[5]+0xed;t[22]=t[6]^0xf3;t[23]=t[19]-t[15];
  t[24]=t[21]+t[7];t[25]=0x21-t[19];t[26]=t[20]^t[23];t[27]=t[22]+t[22];t[28]=t[23]+0x44;t[29]=t[3]+t[4];t[30]=t[5]-t[22];t[31]=t[29]^t[19];
  const inverse=t.map(n=>n^255),mask=inverse.slice();
  for(let i=0x140;i<data.length;i++){const lane=(i-0x140)&31;data[i]^=mask[lane];mask[lane]=data[i]^inverse[lane];}
  for(let i=0;i<256;i++){const lane=i&31;t[lane]^=data[0x140+i];data[0x40+i]^=t[lane];}
  return data;
}
