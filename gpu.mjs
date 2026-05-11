import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  formatUnits,
  hexToBytes,
  http as viemHttp,
  keccak256,
  parseAbi,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const HOST = "127.0.0.1";
const PORT = Number(process.env.GPU_PORT || 8788);
const CONTRACT = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const ABI = parseAbi([
  "function genesisState() view returns (uint256 minted, uint256 remaining, uint256 ethRaised, bool complete)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft)",
  "function getChallenge(address miner) view returns (bytes32)",
  "function balanceOf(address account) view returns (uint256)",
  "function mine(uint256 nonce)",
]);

function loadDotEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function optionalGwei(name) {
  const value = process.env[name]?.trim();
  return value ? parseGwei(value) : undefined;
}

function uint256Hex(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

loadDotEnv();

const rpcUrl = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const submitRpcUrl = process.env.SUBMIT_RPC_URL || process.env.PRIVATE_RPC_URL || rpcUrl;
const privateKey = process.env.PRIVATE_KEY?.trim();
if (!privateKey) {
  console.error("GPU miner server needs PRIVATE_KEY in .env for submit.");
}
const account = privateKey ? privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) : null;
const publicClient = createPublicClient({ chain: mainnet, transport: viemHttp(rpcUrl) });
const walletClient = account ? createWalletClient({ account, chain: mainnet, transport: viemHttp(submitRpcUrl) }) : null;

async function target() {
  if (!account) throw new Error("PRIVATE_KEY missing");
  const [genesis, mining, challenge, balance] = await Promise.all([
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "genesisState" }),
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "miningState" }),
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "getChallenge", args: [account.address] }),
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "balanceOf", args: [account.address] }),
  ]);
  return {
    miner: account.address,
    contract: CONTRACT,
    complete: genesis[3],
    era: mining[0].toString(),
    reward: `${formatUnits(mining[1], 18)} HASH`,
    difficulty: uint256Hex(mining[2]),
    minted: `${formatUnits(mining[3], 18)} HASH`,
    remaining: `${formatUnits(mining[4], 18)} HASH`,
    epoch: mining[5].toString(),
    epochBlocksLeft: mining[6].toString(),
    challenge,
    balance: `${formatUnits(balance, 18)} HASH`,
    submitRpcUrl,
  };
}

function verifyProof(challenge, nonce, difficulty) {
  const hash = keccak256(concatHex([challenge, nonce]));
  return { hash, ok: BigInt(hash) < BigInt(difficulty) };
}

async function submitNonce(payload) {
  if (!account || !walletClient) throw new Error("PRIVATE_KEY missing");
  const nonce = payload.nonce;
  const claimedChallenge = payload.challenge;
  const claimedDifficulty = payload.difficulty;
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("invalid nonce");

  const fresh = await target();
  if (fresh.challenge.toLowerCase() !== claimedChallenge.toLowerCase() || fresh.difficulty.toLowerCase() !== claimedDifficulty.toLowerCase()) {
    return { accepted: false, stale: true, message: "challenge or difficulty changed before submit" };
  }

  const proof = verifyProof(fresh.challenge, nonce, fresh.difficulty);
  if (!proof.ok) return { accepted: false, stale: false, message: "local proof verification failed", hash: proof.hash };

  const nonceBig = BigInt(nonce);
  const gasEstimate = await publicClient.estimateContractGas({
    account,
    address: CONTRACT,
    abi: ABI,
    functionName: "mine",
    args: [nonceBig],
  }).catch(() => 300000n);
  const gas = gasEstimate < 200000n ? 200000n : gasEstimate > 450000n ? 450000n : (gasEstimate * 3n) / 2n;
  const priorityFee = optionalGwei("PRIORITY_FEE_GWEI");
  const maxFee = optionalGwei("MAX_FEE_GWEI");
  const tx = await walletClient.writeContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "mine",
    args: [nonceBig],
    gas,
    ...(priorityFee ? { maxPriorityFeePerGas: priorityFee } : {}),
    ...(maxFee ? { maxFeePerGas: maxFee } : {}),
  });
  return { accepted: true, tx, hash: proof.hash, gas: gas.toString() };
}

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HASH256 WebGPU Miner</title>
  <style>
    :root { color-scheme: dark; --bg:#070807; --fg:#eef8ef; --muted:#8fa091; --line:rgba(119,255,155,.2); --accent:#57ff8a; --bad:#ff6b6b; --amber:#ffd56d; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    header { height:64px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 24px; border-bottom:1px solid var(--line); }
    h1 { margin:0; color:var(--accent); font-size:18px; letter-spacing:.08em; }
    main { width:min(1100px,100%); margin:0 auto; padding:24px; display:grid; gap:18px; }
    .panel { border:1px solid var(--line); background:#0d100d; padding:20px; }
    .hero { display:grid; grid-template-columns:1fr auto; gap:20px; align-items:end; }
    .rate { color:var(--accent); font-size:clamp(40px,8vw,92px); line-height:.9; font-weight:700; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .kv { border-top:1px solid var(--line); padding-top:10px; min-width:0; }
    .kv span { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
    .kv strong { display:block; margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    button { border:1px solid var(--line); background:transparent; color:var(--fg); padding:9px 12px; font:inherit; cursor:pointer; }
    button:hover { border-color:var(--accent); color:var(--accent); }
    button.stop:hover { border-color:var(--bad); color:var(--bad); }
    pre { margin:0; white-space:pre-wrap; max-height:280px; overflow:auto; color:#c8d9cb; }
    .ok { color:var(--accent); } .bad { color:var(--bad); } .warn { color:var(--amber); }
    @media (max-width:800px) { header,.hero { display:block; height:auto; } header { padding:16px; } .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>$HASH WEBGPU</h1>
    <div class="muted" id="wallet">loading</div>
  </header>
  <main>
    <section class="panel hero">
      <div>
        <div class="muted" id="status">idle</div>
        <div class="rate" id="rate">0</div>
        <div class="muted">hashes per second · browser GPU</div>
      </div>
      <div>
        <button id="start">Start GPU</button>
        <button class="stop" id="stop">Stop</button>
      </div>
    </section>
    <section class="panel grid">
      <div class="kv"><span>gpu</span><strong id="gpu">--</strong></div>
      <div class="kv"><span>hashes</span><strong id="hashes">0</strong></div>
      <div class="kv"><span>reward</span><strong id="reward">--</strong></div>
      <div class="kv"><span>difficulty</span><strong id="difficulty">--</strong></div>
      <div class="kv"><span>challenge</span><strong id="challenge">--</strong></div>
      <div class="kv"><span>last tx</span><strong id="tx">--</strong></div>
    </section>
    <section class="panel"><pre id="log"></pre></section>
  </main>
<script type="module">
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("en-US");
const fmtRate = (n) => n >= 1e9 ? (n/1e9).toFixed(2)+"G" : n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(2)+"K" : String(Math.round(n || 0));
const log = (m, cls="") => { const p = $("log"); const t = new Date().toLocaleTimeString(); p.innerHTML += (cls ? '<span class="'+cls+'">' : '') + "["+t+"] " + String(m).replace(/[<&]/g, c => c === "<" ? "&lt;" : "&amp;") + (cls ? "</span>" : "") + "\n"; p.scrollTop = p.scrollHeight; };
</script>
<script id="shader" type="x-shader/wgsl">
const ITERATIONS: u32 = 16u;
const RC: array<vec2<u32>, 24> = array<vec2<u32>, 24>(
  vec2<u32>(0x00000001u,0x00000000u), vec2<u32>(0x00008082u,0x00000000u), vec2<u32>(0x0000808au,0x80000000u), vec2<u32>(0x80008000u,0x80000000u),
  vec2<u32>(0x0000808bu,0x00000000u), vec2<u32>(0x80000001u,0x00000000u), vec2<u32>(0x80008081u,0x80000000u), vec2<u32>(0x00008009u,0x80000000u),
  vec2<u32>(0x0000008au,0x00000000u), vec2<u32>(0x00000088u,0x00000000u), vec2<u32>(0x80008009u,0x00000000u), vec2<u32>(0x8000000au,0x00000000u),
  vec2<u32>(0x8000808bu,0x00000000u), vec2<u32>(0x0000008bu,0x80000000u), vec2<u32>(0x00008089u,0x80000000u), vec2<u32>(0x00008003u,0x80000000u),
  vec2<u32>(0x00008002u,0x80000000u), vec2<u32>(0x00000080u,0x80000000u), vec2<u32>(0x0000800au,0x00000000u), vec2<u32>(0x8000000au,0x80000000u),
  vec2<u32>(0x80008081u,0x80000000u), vec2<u32>(0x00008080u,0x80000000u), vec2<u32>(0x80000001u,0x00000000u), vec2<u32>(0x80008008u,0x80000000u)
);
fn rotl64(v: vec2<u32>, n: u32) -> vec2<u32> { let nn=n&63u; if(nn==0u){return v;} if(nn==32u){return vec2<u32>(v.y,v.x);} if(nn<32u){let m=32u-nn; return vec2<u32>((v.x<<nn)|(v.y>>m),(v.y<<nn)|(v.x>>m));} let s=nn-32u; let m=32u-s; return vec2<u32>((v.y<<s)|(v.x>>m),(v.x<<s)|(v.y>>m)); }
fn xor64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return vec2<u32>(a.x^b.x,a.y^b.y); }
fn andnot64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { return vec2<u32>((~a.x)&b.x,(~a.y)&b.y); }
fn bswap32(v:u32)->u32{return ((v&0x000000ffu)<<24u)|((v&0x0000ff00u)<<8u)|((v&0x00ff0000u)>>8u)|((v&0xff000000u)>>24u);}
fn keccak_f1600(s: ptr<function, array<vec2<u32>,25>>) {
  for(var r:u32=0u;r<24u;r=r+1u){
    let C0=xor64(xor64(xor64(xor64((*s)[0],(*s)[5]),(*s)[10]),(*s)[15]),(*s)[20]); let C1=xor64(xor64(xor64(xor64((*s)[1],(*s)[6]),(*s)[11]),(*s)[16]),(*s)[21]); let C2=xor64(xor64(xor64(xor64((*s)[2],(*s)[7]),(*s)[12]),(*s)[17]),(*s)[22]); let C3=xor64(xor64(xor64(xor64((*s)[3],(*s)[8]),(*s)[13]),(*s)[18]),(*s)[23]); let C4=xor64(xor64(xor64(xor64((*s)[4],(*s)[9]),(*s)[14]),(*s)[19]),(*s)[24]);
    let D0=xor64(C4,rotl64(C1,1u)); let D1=xor64(C0,rotl64(C2,1u)); let D2=xor64(C1,rotl64(C3,1u)); let D3=xor64(C2,rotl64(C4,1u)); let D4=xor64(C3,rotl64(C0,1u));
    let b00=xor64((*s)[0],D0); let b10=rotl64(xor64((*s)[1],D1),1u); let b20=rotl64(xor64((*s)[2],D2),62u); let b05=rotl64(xor64((*s)[3],D3),28u); let b15=rotl64(xor64((*s)[4],D4),27u); let b16=rotl64(xor64((*s)[5],D0),36u); let b01=rotl64(xor64((*s)[6],D1),44u); let b11=rotl64(xor64((*s)[7],D2),6u); let b21=rotl64(xor64((*s)[8],D3),55u); let b06=rotl64(xor64((*s)[9],D4),20u); let b07=rotl64(xor64((*s)[10],D0),3u); let b17=rotl64(xor64((*s)[11],D1),10u); let b02=rotl64(xor64((*s)[12],D2),43u); let b12=rotl64(xor64((*s)[13],D3),25u); let b22=rotl64(xor64((*s)[14],D4),39u); let b23=rotl64(xor64((*s)[15],D0),41u); let b08=rotl64(xor64((*s)[16],D1),45u); let b18=rotl64(xor64((*s)[17],D2),15u); let b03=rotl64(xor64((*s)[18],D3),21u); let b13=rotl64(xor64((*s)[19],D4),8u); let b14=rotl64(xor64((*s)[20],D0),18u); let b24=rotl64(xor64((*s)[21],D1),2u); let b09=rotl64(xor64((*s)[22],D2),61u); let b19=rotl64(xor64((*s)[23],D3),56u); let b04=rotl64(xor64((*s)[24],D4),14u);
    (*s)[0]=xor64(b00,andnot64(b01,b02)); (*s)[1]=xor64(b01,andnot64(b02,b03)); (*s)[2]=xor64(b02,andnot64(b03,b04)); (*s)[3]=xor64(b03,andnot64(b04,b00)); (*s)[4]=xor64(b04,andnot64(b00,b01)); (*s)[5]=xor64(b05,andnot64(b06,b07)); (*s)[6]=xor64(b06,andnot64(b07,b08)); (*s)[7]=xor64(b07,andnot64(b08,b09)); (*s)[8]=xor64(b08,andnot64(b09,b05)); (*s)[9]=xor64(b09,andnot64(b05,b06)); (*s)[10]=xor64(b10,andnot64(b11,b12)); (*s)[11]=xor64(b11,andnot64(b12,b13)); (*s)[12]=xor64(b12,andnot64(b13,b14)); (*s)[13]=xor64(b13,andnot64(b14,b10)); (*s)[14]=xor64(b14,andnot64(b10,b11)); (*s)[15]=xor64(b15,andnot64(b16,b17)); (*s)[16]=xor64(b16,andnot64(b17,b18)); (*s)[17]=xor64(b17,andnot64(b18,b19)); (*s)[18]=xor64(b18,andnot64(b19,b15)); (*s)[19]=xor64(b19,andnot64(b15,b16)); (*s)[20]=xor64(b20,andnot64(b21,b22)); (*s)[21]=xor64(b21,andnot64(b22,b23)); (*s)[22]=xor64(b22,andnot64(b23,b24)); (*s)[23]=xor64(b23,andnot64(b24,b20)); (*s)[24]=xor64(b24,andnot64(b20,b21)); (*s)[0]=xor64((*s)[0],RC[r]);
  }
}
struct Uniforms { challenge: array<vec4<u32>,2>, difficulty: array<vec4<u32>,2>, nonce_base_lo:u32, nonce_base_hi:u32, _pad0:u32, _pad1:u32 };
struct ResultBuffer { found: atomic<u32>, nonce_lo:u32, nonce_hi:u32, _pad:u32, hash: array<vec4<u32>,2> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read_write> result: ResultBuffer;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let thread_start=gid.x*ITERATIONS;
  for(var k:u32=0u;k<ITERATIONS;k=k+1u){
    let offset=thread_start+k; let added=u.nonce_base_lo+offset; let carry=select(0u,1u,added<u.nonce_base_lo); let n_lo=added; let n_hi=u.nonce_base_hi+carry;
    var st: array<vec2<u32>,25>; st[0]=vec2<u32>(u.challenge[0].x,u.challenge[0].y); st[1]=vec2<u32>(u.challenge[0].z,u.challenge[0].w); st[2]=vec2<u32>(u.challenge[1].x,u.challenge[1].y); st[3]=vec2<u32>(u.challenge[1].z,u.challenge[1].w); st[4]=vec2<u32>(0u,0u); st[5]=vec2<u32>(0u,0u); st[6]=vec2<u32>(0u,0u); st[7]=vec2<u32>(bswap32(n_hi),bswap32(n_lo)); st[8]=vec2<u32>(0x00000001u,0u); for(var i:u32=9u;i<16u;i=i+1u){st[i]=vec2<u32>(0u,0u);} st[16]=vec2<u32>(0u,0x80000000u); for(var i:u32=17u;i<25u;i=i+1u){st[i]=vec2<u32>(0u,0u);}
    keccak_f1600(&st);
    let h0=bswap32(st[0].x); let h1=bswap32(st[0].y); let h2=bswap32(st[1].x); let h3=bswap32(st[1].y); let h4=bswap32(st[2].x); let h5=bswap32(st[2].y); let h6=bswap32(st[3].x); let h7=bswap32(st[3].y);
    let d0=u.difficulty[0].x; let d1=u.difficulty[0].y; let d2=u.difficulty[0].z; let d3=u.difficulty[0].w; let d4=u.difficulty[1].x; let d5=u.difficulty[1].y; let d6=u.difficulty[1].z; let d7=u.difficulty[1].w;
    var lt=false; var settled=false; if(h0<d0){lt=true;settled=true;}else if(h0>d0){settled=true;} if(!settled){if(h1<d1){lt=true;settled=true;}else if(h1>d1){settled=true;}} if(!settled){if(h2<d2){lt=true;settled=true;}else if(h2>d2){settled=true;}} if(!settled){if(h3<d3){lt=true;settled=true;}else if(h3>d3){settled=true;}} if(!settled){if(h4<d4){lt=true;settled=true;}else if(h4>d4){settled=true;}} if(!settled){if(h5<d5){lt=true;settled=true;}else if(h5>d5){settled=true;}} if(!settled){if(h6<d6){lt=true;settled=true;}else if(h6>d6){settled=true;}} if(!settled){if(h7<d7){lt=true;}}
    if(lt){let prior=atomicAdd(&result.found,1u); if(prior==0u){result.nonce_lo=n_lo; result.nonce_hi=n_hi; result.hash[0]=vec4<u32>(h0,h1,h2,h3); result.hash[1]=vec4<u32>(h4,h5,h6,h7);} break;}
  }
</script>
<script type="module">
const wgsl = document.getElementById("shader").textContent;
function hexBytes(hex){ const h=hex.startsWith("0x")?hex.slice(2):hex; const out=new Uint8Array(h.length/2); for(let i=0;i<out.length;i++) out[i]=parseInt(h.slice(i*2,i*2+2),16); return out; }
function bytesHex(bytes){ return "0x"+Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""); }
function challengeWords(bytes){ const out=new Uint32Array(8); for(let i=0;i<8;i++) out[i]=(bytes[4*i]|(bytes[4*i+1]<<8)|(bytes[4*i+2]<<16)|(bytes[4*i+3]<<24))>>>0; return out; }
function difficultyWords(bytes){ const out=new Uint32Array(8); for(let i=0;i<8;i++) out[i]=((bytes[4*i]<<24)|(bytes[4*i+1]<<16)|(bytes[4*i+2]<<8)|bytes[4*i+3])>>>0; return out; }
function decodeResult(words){ const found=words[0]>0; const nonce=new Uint8Array(32); if(found){ const lo=words[1]>>>0, hi=words[2]>>>0; nonce[24]=(hi>>>24)&255; nonce[25]=(hi>>>16)&255; nonce[26]=(hi>>>8)&255; nonce[27]=hi&255; nonce[28]=(lo>>>24)&255; nonce[29]=(lo>>>16)&255; nonce[30]=(lo>>>8)&255; nonce[31]=lo&255; } const hash=new Uint8Array(32); for(let i=0;i<8;i++){ const v=words[4+i]>>>0; hash[4*i]=(v>>>24)&255; hash[4*i+1]=(v>>>16)&255; hash[4*i+2]=(v>>>8)&255; hash[4*i+3]=v&255; } return {found, nonce, hash}; }
class Miner {
  constructor(){ this.running=false; this.workgroups=16384; this.total=0; this.ema=0; }
  async init(){
    if(!navigator.gpu) throw new Error("WebGPU not available. Use current Chrome/Edge and open http://127.0.0.1:8788");
    const adapter=await navigator.gpu.requestAdapter({powerPreference:"high-performance"});
    if(!adapter) throw new Error("no GPU adapter");
    $("gpu").textContent = adapter.info?.device || adapter.info?.architecture || adapter.info?.vendor || "WebGPU adapter";
    this.device=await adapter.requestDevice();
    this.pipeline=await this.device.createComputePipelineAsync({layout:"auto", compute:{module:this.device.createShaderModule({code:wgsl}), entryPoint:"main"}});
    this.uniform=this.device.createBuffer({size:80, usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.result=this.device.createBuffer({size:48, usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
    this.staging=this.device.createBuffer({size:48, usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    this.bind=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0), entries:[{binding:0, resource:{buffer:this.uniform}}, {binding:1, resource:{buffer:this.result}}]});
  }
  async run(){
    this.running=true; this.total=0; this.ema=0;
    let target=await fetch("/api/target").then(r=>r.json());
    $("wallet").textContent=target.miner; $("reward").textContent=target.reward; $("difficulty").textContent=target.difficulty.slice(0,10)+"..."+target.difficulty.slice(-6); $("challenge").textContent=target.challenge.slice(0,10)+"..."+target.challenge.slice(-6);
    log("target loaded · "+target.challenge);
    const ch=challengeWords(hexBytes(target.challenge)); const diff=difficultyWords(hexBytes(target.difficulty));
    const uniform=new Uint32Array(20); uniform.set(ch,0); uniform.set(diff,8);
    const seed=new Uint32Array(2); crypto.getRandomValues(seed); let lo=seed[0]>>>0, hi=seed[1]>>>0;
    let last=performance.now();
    while(this.running){
      uniform[16]=lo; uniform[17]=hi; uniform[18]=0; uniform[19]=0;
      this.device.queue.writeBuffer(this.uniform,0,uniform);
      this.device.queue.writeBuffer(this.result,0,new Uint32Array(12));
      const enc=this.device.createCommandEncoder(); const pass=enc.beginComputePass(); pass.setPipeline(this.pipeline); pass.setBindGroup(0,this.bind); pass.dispatchWorkgroups(this.workgroups); pass.end(); enc.copyBufferToBuffer(this.result,0,this.staging,0,48); this.device.queue.submit([enc.finish()]);
      await this.staging.mapAsync(GPUMapMode.READ); const words=new Uint32Array(this.staging.getMappedRange().slice(0)); this.staging.unmap();
      const now=performance.now(); const batch=64*this.workgroups*16; this.total+=batch; const rate=batch/((now-last)/1000); this.ema=this.ema?this.ema+.2*(rate-this.ema):rate; last=now;
      $("rate").textContent=fmtRate(this.ema); $("hashes").textContent=fmt.format(this.total); $("status").textContent="searching";
      const r=decodeResult(words);
      if(r.found){
        this.running=false; const nonce=bytesHex(r.nonce); const hash=bytesHex(r.hash);
        log("found nonce "+nonce, "ok"); log("shader hash "+hash);
        $("status").textContent="submitting";
        const submit=await fetch("/api/submit", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({nonce, hash, challenge:target.challenge, difficulty:target.difficulty})}).then(r=>r.json());
        if(submit.accepted){ $("tx").innerHTML='<a class="ok" href="https://etherscan.io/tx/'+submit.tx+'" target="_blank">'+submit.tx.slice(0,10)+"..."+submit.tx.slice(-6)+"</a>"; log("submitted "+submit.tx, "ok"); }
        else { log(submit.message || "submit rejected", submit.stale ? "warn" : "bad"); }
        if(this.running) continue;
        break;
      }
      const next=(lo+batch)>>>0; if(next<lo) hi=(hi+1)>>>0; lo=next;
    }
  }
  stop(){ this.running=false; $("status").textContent="stopped"; }
}
let miner=null;
$("start").onclick=async()=>{ try{ if(!miner){ miner=new Miner(); await miner.init(); } miner.run(); } catch(e){ log(e.message || e, "bad"); } };
$("stop").onclick=()=>miner?.stop();
fetch("/api/target").then(r=>r.json()).then(t=>{ $("wallet").textContent=t.miner || "no wallet"; $("reward").textContent=t.reward || "--"; $("difficulty").textContent=t.difficulty ? t.difficulty.slice(0,10)+"..."+t.difficulty.slice(-6) : "--"; $("challenge").textContent=t.challenge ? t.challenge.slice(0,10)+"..."+t.challenge.slice(-6) : "--"; }).catch(e=>log(e.message,"bad"));
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/target") {
      json(res, 200, await target());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/submit") {
      json(res, 200, await submitNonce(await bodyJson(req)));
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HASH256 WebGPU miner: http://${HOST}:${PORT}`);
  console.log(`read rpc: ${rpcUrl}`);
  console.log(`submit rpc: ${submitRpcUrl}`);
});
