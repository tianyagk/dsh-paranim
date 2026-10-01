/**
 * 给归一后的 city.png 追加**原创补绘**的交通工具贴图(自行车×4 / 摩托×2 / 轮胎 / 手推车)。
 *
 * 为什么要有它:Kenney 那一套 Tiny / Roguelike 图集里**没有二轮自行车**(我按
 * "宽扁形 + 两端成圆 + 低占位"的特征把六张图集逐格筛过;city 里只有路面上的
 * 自行车道标线,那是道路 decal 不是物件)。而 house 沙盒里偏偏有"靠墙的自行车"
 * 这么件道具——之前它只能借用别的载具贴图,名字写着自行车、画出来却不是。
 *
 * 于是按 Kenney 的调色板观感自己画:轮子用近黑轮胎 + 中灰轮圈,车架复用 city 车系的
 * 灰/红/绿/蓝四色。产出直接写进 assets/pack/city.png 的第 38–41 列(原图 37 列),
 * 并同步更新 manifest 的列数,再跑 `npm run assets:snapshot` 落进 sheetData.ts。
 *
 * 幂等:可以反复跑。它每次从 style-preview 的原始数据重来,不会因为跑两次就把尾巴接长。
 * 用法:node scripts/gen-city-props.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync, deflateSync } from 'node:zlib'
function dec(buf){let pos=8,w=0,h=0,ct=6,plte=null,trns=null;const idat=[]
while(pos+8<=buf.length){const L=buf.readUInt32BE(pos),T=buf.subarray(pos+4,pos+8).toString('ascii'),D=buf.subarray(pos+8,pos+8+L)
if(T==='IHDR'){w=D.readUInt32BE(0);h=D.readUInt32BE(4);ct=D[9]}else if(T==='PLTE')plte=D;else if(T==='tRNS')trns=D;else if(T==='IDAT')idat.push(D);else if(T==='IEND')break
pos+=12+L}
const raw=inflateSync(Buffer.concat(idat));const ch=ct===6?4:ct===2?3:ct===0?1:ct===4?2:0
const stride=w*ch;const px=Buffer.alloc(w*h*4);let prev=Buffer.alloc(stride),q=0
for(let y=0;y<h;y++){const f=raw[q];q++;const l=Buffer.from(raw.subarray(q,q+stride));q+=stride
for(let x=0;x<stride;x++){const a=x>=ch?l[x-ch]:0,b=prev[x],c=x>=ch?prev[x-ch]:0
if(f===1)l[x]=(l[x]+a)&255;else if(f===2)l[x]=(l[x]+b)&255;else if(f===3)l[x]=(l[x]+((a+b)>>1))&255
else if(f===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);l[x]=(l[x]+(pa<=pb&&pa<=pc?a:pb<=pc?b:c))&255}}
for(let x=0;x<w;x++){const d=(y*w+x)*4,s2=x*ch
if(ch===4){px[d]=l[s2];px[d+1]=l[s2+1];px[d+2]=l[s2+2];px[d+3]=l[s2+3]}
else if(ch===3){px[d]=l[s2];px[d+1]=l[s2+1];px[d+2]=l[s2+2];px[d+3]=255}
else{px[d]=px[d+1]=px[d+2]=l[s2];px[d+3]=255}}
prev=l}
return {w,h,px}}
function crc32(buf){let c=~0;for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1))}return (~c)>>>0}
function chunk(type,data){const L=Buffer.alloc(4);L.writeUInt32BE(data.length);const T=Buffer.from(type);const C=Buffer.alloc(4);C.writeUInt32BE(crc32(Buffer.concat([T,data])));return Buffer.concat([L,T,data,C])}

// 字符画（16 宽）：F=车架色 a=点缀（座/把手）t=轮胎 r=轮圈 h=高光
const BIKE = [
  '................',
  '................',
  '................',
  '................',
  '..........aa....',
  '.........F......',
  '....F...F.......',
  '...F.F..F.......',
  '..F...FF........',
  '..F...F.F.......',
  '.t.....tt.......',
  'ttt...tttt......',
  '.ttt...ttt......',
  '................',
  '................',
  '................',
]
const MOTO = [
  '................',
  '................',
  '................',
  '................',
  '.......FF.......',
  '......FF........',
  '.FFFF.FF........',
  'FttFFFtF........',
  '.tttFFtF........',
  '..tttFF.........',
  '...tttF.........',
  '....tttt........',
  '................',
  '................',
  '................',
  '................',
]
// 上述草稿太随意,直接用"半手工圆"生成器:画正圆轮 + 折线车架,再校验占位
function drawBike(put, frame, accent) {
  const disc=(cx,cy,r,col,inner)=>{for(let y=0;y<16;y++)for(let x=0;x<16;x++){
    const d=Math.hypot(x-cx,y-cy)
    if(d<=r&&d>inner)put(x,y,col)}}
  // 后轮(3.5,11) r3 前轮(11.5,11) r3 —— 底部对齐,轮子触底
  disc(3.5,11,3.2,'#26282e',1.7)         // 胎
  disc(3.5,11,1.7,'#565e6a',0)           // 辐条盘
  disc(11.5,11,3.2,'#26282e',1.7)
  disc(11.5,11,1.7,'#565e6a',0)
  // 车架折线:后轴(3,11) → 五通(7,10) → 前轴(11,11);上管:座管顶(6,6) → 前轮顶(11,7)
  const line=(x0,y0,x1,y1,col)=>{const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0))
    for(let i=0;i<=n;i++)put(Math.round(x0+(x1-x0)*i/n),Math.round(y0+(y1-y0)*i/n),col)}
  line(3,11,7,9,frame); line(7,9,11,11,frame)        // 下管
  line(6,6,7,9,frame);  line(6,6,11,7,frame)          // 座管+上管
  line(11,7,11.5,11,frame)                             // 前叉
  // 座(5,5) 把手(12,5)
  put(5,5,accent);put(6,5,accent)
  put(12,5,accent);put(13,5,accent)
  put(12,6,frame);put(12,7,frame)
}
function drawMoto(put, body) {
  const disc=(cx,cy,r,col,inner)=>{for(let y=0;y<16;y++)for(let x=0;x<16;x++){
    const d=Math.hypot(x-cx,y-cy)
    if(d<=r&&d>inner)put(x,y,col)}}
  disc(3.5,11.5,3.6,'#26282e',2.2)
  disc(3.5,11.5,2.2,'#565e6a',0)
  disc(11.5,11.5,3.6,'#26282e',2.2)
  disc(11.5,11.5,2.2,'#565e6a',0)
  const line=(x0,y0,x1,y1,col)=>{const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0))
    for(let i=0;i<=n;i++)put(Math.round(x0+(x1-x0)*i/n),Math.round(y0+(y1-y0)*i/n),col)}
  line(3,11,7,9,body);line(7,9,11,11,body)           // 车架
  line(5,7,9,7,body);line(9,7,9,4,body)               // 油箱+立管
  put(9,3,'#26282e');put(10,3,'#26282e')               // 把手
  put(5,6,'#7a4a3a');put(6,6,'#7a4a3a')                // 座
  put(7,9,'#c7cdd4');put(8,9,'#c7cdd4')                // 发动机
}
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CITY = join(root, 'assets', 'pack', 'city.png')
let img = dec(readFileSync(CITY))
if (img.w / 16 !== 37) {
  // 已经补过(或被人改过):先按 style-preview 重归一,保证幂等。
  // 源图带 1px 边距,不能直接拿它当网格用——必须走 normalize。
  console.log(`  city.png 当前 ${img.w / 16} 列,先重归一到原始 ${37} 列再补绘`)
  execSync('node scripts/normalize-assets.mjs', { cwd: root, stdio: 'inherit' })
  img = dec(readFileSync(CITY))
}
const src = img
// 源图带 1px 边距,行数直接从 manifest 取,别用 h/16 去猜(会算出 29.6875 这种小数)
const manifestIn = JSON.parse(readFileSync(join(root, 'assets', 'pack', 'manifest.json'), 'utf8'))
const base = manifestIn.sheets.find((x) => x.file === 'city.png')
const COLS = 42, ROWS = base.rows
// 把补绘后的列数写回 manifest:这是"city 有几列"的唯一真相来源。
// assets:normalize 会按 style-preview 重写 manifest,所以补绘必须在 normalize **之后**跑。
for (const sheet of manifestIn.sheets) {
  if (sheet.file !== 'city.png') continue
  sheet.cols = COLS
  sheet.note = `${sheet.note} + 本仓补绘的交通工具 (第 38-41 列)`
}
writeFileSync(join(root, 'assets', 'pack', 'manifest.json'), JSON.stringify(manifestIn, null, 2) + '\n')
const px=Buffer.alloc(COLS*16*ROWS*16*4)
for(let y=0;y<src.h;y++)for(let x=0;x<src.w;x++){
  const s=(y*src.w+x)*4, d=(y*COLS*16+x)*4
  px[d]=src.px[s];px[d+1]=src.px[s+1];px[d+2]=src.px[s+2];px[d+3]=src.px[s+3]}
const mkPut=(c,r)=>(x,y,col)=>{const [R,G,B]=[parseInt(col.slice(1,3),16),parseInt(col.slice(3,5),16),parseInt(col.slice(5,7),16)]
  const d=((r*16+y)*COLS*16+c*16+x)*4
  px[d]=R;px[d+1]=G;px[d+2]=B;px[d+3]=255}
const VARIANTS=[[38,0,'#4f5866','#8a5a3a'],[39,0,'#8a4a44','#26282e'],[40,0,'#4a7d5e','#8a6a3a'],[41,0,'#4a6a8a','#26282e']]
for(const [c,r,f,a] of VARIANTS) drawBike(mkPut(c,r),f,a)
drawMoto(mkPut(38,1),'#6b5a8e')
drawMoto(mkPut(39,1),'#b06a3a')
// 轮胎靠墙(40,1)
{const put=mkPut(40,1)
 const disc=(cx,cy,r,col,inner)=>{for(let y=0;y<16;y++)for(let x=0;x<16;x++){
   const d=Math.hypot(x-cx,y-cy)
   if(d<=r&&d>inner)put(x,y,col)}}
 disc(8,8,5.5,'#26282e',4.6);disc(8,8,3.4,'#565e6a',2.6);disc(8,8,2.6,'#26282e',1.4)}
// (41,1) 备用:货车小推车
{const put=mkPut(41,1)
 const disc=(cx,cy,r,col,inner)=>{for(let y=0;y<16;y++)for(let x=0;x<16;x++){
   const d=Math.hypot(x-cx,y-cy)
   if(d<=r&&d>inner)put(x,y,col)}}
 disc(4,11,2.6,'#26282e',1.2);disc(11,11,2.6,'#26282e',1.2)
 const line=(x0,y0,x1,y1,col)=>{const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0))
   for(let i=0;i<=n;i++)put(Math.round(x0+(x1-x0)*i/n),Math.round(y0+(y1-y0)*i/n),col)}
 line(2,7,13,7,'#8a6a3a');line(2,7,2,10,'#8a6a3a');line(13,7,13,10,'#8a6a3a');line(2,10,13,10,'#8a6a3a')
 line(13,7,15,5,'#8a6a3a')
 for(let x=3;x<13;x++)put(x,8,'#a8865a')}
const raw=Buffer.alloc(ROWS*16*(1+COLS*16*4))
for(let y=0;y<ROWS*16;y++){raw[y*(1+COLS*16*4)]=0
  for(let x=0;x<COLS*16;x++){const s=(y*COLS*16+x)*4,t=y*(1+COLS*16*4)+1+x*4
    raw[t]=px[s];raw[t+1]=px[s+1];raw[t+2]=px[s+2];raw[t+3]=px[s+3]}}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(COLS*16,0);ihdr.writeUInt32BE(ROWS*16,4);ihdr[8]=8;ihdr[9]=6
writeFileSync('assets/pack/city.png',Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]))
console.log(`city.png → ${COLS}×${ROWS}: 自行车×4 (38-41,0) / 摩托×2 (38-39,1) / 轮胎 (40,1) / 手推车 (41,1)`)
