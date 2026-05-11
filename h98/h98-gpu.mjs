import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http as viemHttp,
  parseAbi,
  parseGwei,
} from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const HOST = "127.0.0.1";
const CONTRACT = "0x1E5adF70321CA28b3Ead70Eac545E6055E969e6f";
const DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";

const ABI = parseAbi([
  "function getConfig() view returns ((bool mintOpen,bool marketOpen,bool listingOpen,bool buyingOpen,bool batchOpen,uint8 marketMode,uint256 difficulty,uint256 mintPrice,uint256 mintAmount,uint256 maxPublicMints,uint256 treasuryReserveMints,uint256 lotSize,uint256 minListingAmount,uint256 maxBatchSize,uint256 marketFeeBps,address feeRecipient))",
  "function getStats() view returns (uint256 publicMinted,uint256 treasuryReserved,uint256 totalSupply,uint256 activeListings,uint256 difficulty,bool mintOpen,bool marketOpen,bool listingOpen,bool buyingOpen,bool batchOpen,uint8 marketMode)",
  "function challengeFor(address account) view returns (bytes16)",
  "function mint(bytes16 nonce) payable returns (uint256 mintIndex)",
  "function mintNonce(address account) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function MAX_MINTS_PER_WALLET() view returns (uint256)",
]);

function loadDotEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
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

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function optionalGwei(name, fallbackName) {
  const value = process.env[name]?.trim() || (fallbackName ? process.env[fallbackName]?.trim() : "");
  return value ? parseGwei(value) : undefined;
}

function cleanPrivateKey(value) {
  const key = value.trim();
  if (!key || key.startsWith("#")) return "";
  const noComment = key.split("#", 1)[0].trim();
  const normalized = noComment.startsWith("0x") ? noComment : `0x${noComment}`;
  return /^0x[0-9a-fA-F]{64}$/.test(normalized) ? normalized : "";
}

function loadAccounts() {
  const chunks = [];
  if (process.env.H98_PRIVATE_KEYS?.trim()) chunks.push(process.env.H98_PRIVATE_KEYS);
  const file = process.env.H98_ACCOUNTS_FILE?.trim() || "h98-accounts.txt";
  if (existsSync(file)) chunks.push(readFileSync(file, "utf8"));

  const seen = new Set();
  const accounts = [];
  for (const chunk of chunks) {
    for (const item of chunk.split(/[\s,;]+/)) {
      const privateKey = cleanPrivateKey(item);
      if (!privateKey) continue;
      const account = privateKeyToAccount(privateKey);
      const key = account.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push({ account });
    }
  }
  return accounts;
}

function field(value, name, index) {
  return value?.[name] ?? value?.[index];
}

function hexToBuffer(hex, bytes) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== bytes * 2) throw new Error(`expected ${bytes} bytes, got ${clean.length / 2}`);
  return Buffer.from(clean, "hex");
}

function bufferToHex(buffer) {
  return `0x${Buffer.from(buffer).toString("hex")}`;
}

function proofOk(digest, difficultyBits) {
  const fullBytes = Math.floor(difficultyBits / 8);
  for (let i = 0; i < fullBytes; i += 1) {
    if (digest[i] !== 0) return false;
  }
  const rest = difficultyBits % 8;
  if (rest === 0) return true;
  return (digest[fullBytes] & (0xff << (8 - rest))) === 0;
}

function proofDigest(challenge, nonce) {
  return createHash("sha256")
    .update(Buffer.concat([hexToBuffer(challenge, 16), hexToBuffer(nonce, 16)]))
    .digest();
}

async function bodyJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

loadDotEnv();

const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.H98_GPU_PORT || 8798);
const noSubmit = args.has("--no-submit") || boolEnv("H98_GPU_NO_SUBMIT", false);
const rpcUrl = process.env.H98_RPC_URL?.trim() || process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
const submitRpcUrl =
  process.env.H98_SUBMIT_RPC_URL?.trim() ||
  process.env.SUBMIT_RPC_URL?.trim() ||
  process.env.PRIVATE_RPC_URL?.trim() ||
  rpcUrl;
const publicClient = createPublicClient({ chain: mainnet, transport: viemHttp(rpcUrl, { timeout: 20_000 }) });
const accounts = loadAccounts();
const walletClients = new Map(
  accounts.map(({ account }) => [
    account.address.toLowerCase(),
    createWalletClient({ account, chain: mainnet, transport: viemHttp(submitRpcUrl, { timeout: 20_000 }) }),
  ]),
);

async function globalState() {
  const [config, stats, decimals, maxMintsPerWallet, blockNumber] = await Promise.all([
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "getConfig" }),
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "getStats" }),
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "decimals" }).catch(() => 18),
    publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "MAX_MINTS_PER_WALLET" }).catch(() => 0n),
    publicClient.getBlockNumber(),
  ]);
  return {
    contract: CONTRACT,
    blockNumber: blockNumber.toString(),
    decimals: Number(decimals),
    maxMintsPerWallet: maxMintsPerWallet.toString(),
    mintOpen: Boolean(field(config, "mintOpen", 0)),
    difficulty: BigInt(field(config, "difficulty", 6)).toString(),
    mintPrice: BigInt(field(config, "mintPrice", 7)).toString(),
    mintPriceEth: formatEther(BigInt(field(config, "mintPrice", 7))),
    mintAmount: BigInt(field(config, "mintAmount", 8)).toString(),
    mintAmountDisplay: `${formatUnits(BigInt(field(config, "mintAmount", 8)), Number(decimals))} H98`,
    maxPublicMints: BigInt(field(config, "maxPublicMints", 9)).toString(),
    publicMinted: BigInt(field(stats, "publicMinted", 0)).toString(),
    totalSupply: BigInt(field(stats, "totalSupply", 2)).toString(),
  };
}

async function targetState() {
  const state = await globalState();
  const accountStates = await Promise.all(
    accounts.map(async ({ account }) => {
      const [challenge, mintNonce, balance] = await Promise.all([
        publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "challengeFor", args: [account.address] }),
        publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "mintNonce", args: [account.address] }),
        publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "balanceOf", args: [account.address] }).catch(() => 0n),
      ]);
      const limit = BigInt(state.maxMintsPerWallet);
      return {
        address: account.address,
        challenge,
        mintNonce: mintNonce.toString(),
        balance: `${formatUnits(balance, state.decimals)} H98`,
        limitReached: limit > 0n && mintNonce >= limit,
      };
    }),
  );
  return { ...state, accounts: accountStates, submitRpcUrl, noSubmit };
}

async function submitProof(payload) {
  const address = String(payload.address || "");
  const nonce = String(payload.nonce || "");
  const claimedChallenge = String(payload.challenge || "");
  const claimedDifficulty = Number(payload.difficulty);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("invalid address");
  if (!/^0x[0-9a-fA-F]{32}$/.test(nonce)) throw new Error("invalid bytes16 nonce");
  if (!/^0x[0-9a-fA-F]{32}$/.test(claimedChallenge)) throw new Error("invalid challenge");
  if (!Number.isInteger(claimedDifficulty) || claimedDifficulty < 1 || claimedDifficulty > 256) {
    throw new Error("invalid difficulty");
  }

  const accountEntry = accounts.find(({ account }) => account.address.toLowerCase() === address.toLowerCase());
  if (!accountEntry) throw new Error("address is not loaded on this server");

  const state = await globalState();
  const freshDifficulty = Number(state.difficulty);
  const freshChallenge = await publicClient.readContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "challengeFor",
    args: [accountEntry.account.address],
  });
  if (freshChallenge.toLowerCase() !== claimedChallenge.toLowerCase() || freshDifficulty !== claimedDifficulty) {
    return { accepted: false, stale: true, message: "challenge or difficulty changed before submit" };
  }

  const digest = proofDigest(freshChallenge, nonce);
  if (!proofOk(digest, freshDifficulty)) {
    return { accepted: false, stale: false, message: "local proof verification failed", digest: bufferToHex(digest) };
  }

  if (noSubmit) return { accepted: true, submitted: false, message: "no-submit mode", digest: bufferToHex(digest) };

  const request = {
    account: accountEntry.account,
    address: CONTRACT,
    abi: ABI,
    functionName: "mint",
    args: [nonce],
    value: BigInt(state.mintPrice),
    ...(optionalGwei("H98_PRIORITY_FEE_GWEI", "PRIORITY_FEE_GWEI")
      ? { maxPriorityFeePerGas: optionalGwei("H98_PRIORITY_FEE_GWEI", "PRIORITY_FEE_GWEI") }
      : {}),
    ...(optionalGwei("H98_MAX_FEE_GWEI", "MAX_FEE_GWEI") ? { maxFeePerGas: optionalGwei("H98_MAX_FEE_GWEI", "MAX_FEE_GWEI") } : {}),
  };
  const gasEstimate = await publicClient.estimateContractGas(request).catch(() => 160000n);
  request.gas = gasEstimate < 120000n ? 120000n : (gasEstimate * 3n) / 2n;

  const walletClient = walletClients.get(address.toLowerCase());
  const tx = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  return {
    accepted: true,
    submitted: true,
    tx,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
    digest: bufferToHex(digest),
  };
}

const shader = String.raw`
struct Params {
  step: u32,
  w4: u32,
  w5: u32,
  mask0: u32,
  mask1: u32,
  w0: u32,
  w1: u32,
  w2: u32,
  w3: u32,
};

@group(0) @binding(0) var<uniform> input: Params;
@group(0) @binding(1) var<storage, read_write> output: array<u32, 5>;

const K = array<u32, 64>(
  0x428A2F98u, 0x71374491u, 0xB5C0FBCFu, 0xE9B5DBA5u, 0x3956C25Bu, 0x59F111F1u, 0x923F82A4u, 0xAB1C5ED5u,
  0xD807AA98u, 0x12835B01u, 0x243185BEu, 0x550C7DC3u, 0x72BE5D74u, 0x80DEB1FEu, 0x9BDC06A7u, 0xC19BF174u,
  0xE49B69C1u, 0xEFBE4786u, 0x0FC19DC6u, 0x240CA1CCu, 0x2DE92C6Fu, 0x4A7484AAu, 0x5CB0A9DCu, 0x76F988DAu,
  0x983E5152u, 0xA831C66Du, 0xB00327C8u, 0xBF597FC7u, 0xC6E00BF3u, 0xD5A79147u, 0x06CA6351u, 0x14292967u,
  0x27B70A85u, 0x2E1B2138u, 0x4D2C6DFCu, 0x53380D13u, 0x650A7354u, 0x766A0ABBu, 0x81C2C92Eu, 0x92722C85u,
  0xA2BFE8A1u, 0xA81A664Bu, 0xC24B8B70u, 0xC76C51A3u, 0xD192E819u, 0xD6990624u, 0xF40E3585u, 0x106AA070u,
  0x19A4C116u, 0x1E376C08u, 0x2748774Cu, 0x34B0BCB5u, 0x391C0CB3u, 0x4ED8AA4Au, 0x5B9CCA4Fu, 0x682E6FF3u,
  0x748F82EEu, 0x78A5636Fu, 0x84C87814u, 0x8CC70208u, 0x90BEFFFAu, 0xA4506CEBu, 0xBEF9A3F7u, 0xC67178F2u
);

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn big0(x: u32) -> u32 { return rotr(x, 2u) ^ rotr(x, 13u) ^ rotr(x, 22u); }
fn big1(x: u32) -> u32 { return rotr(x, 6u) ^ rotr(x, 11u) ^ rotr(x, 25u); }
fn small0(x: u32) -> u32 { return rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u); }
fn small1(x: u32) -> u32 { return rotr(x, 17u) ^ rotr(x, 19u) ^ (x >> 10u); }
fn ch(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ ((~x) & z); }
fn maj(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (x & z) ^ (y & z); }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let thread_id = gid.x;
  for (var n = 0u; n < input.step; n = n + 1u) {
    var W: array<u32, 64>;
    W[0] = input.w0; W[1] = input.w1; W[2] = input.w2; W[3] = input.w3;
    W[4] = input.w4; W[5] = input.w5; W[6] = thread_id; W[7] = n;
    W[8] = 0x80000000u;
    for (var i = 9u; i < 15u; i = i + 1u) { W[i] = 0u; }
    W[15] = 256u;
    for (var i = 16u; i < 64u; i = i + 1u) {
      W[i] = small1(W[i - 2u]) + W[i - 7u] + small0(W[i - 15u]) + W[i - 16u];
    }

    var a = 0x6A09E667u; var b = 0xBB67AE85u; var c = 0x3C6EF372u; var d = 0xA54FF53Au;
    var e = 0x510E527Fu; var f = 0x9B05688Cu; var g = 0x1F83D9ABu; var h = 0x5BE0CD19u;
    for (var i = 0u; i < 64u; i = i + 1u) {
      let t1 = h + big1(e) + ch(e, f, g) + K[i] + W[i];
      let t2 = big0(a) + maj(a, b, c);
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    let h0 = a + 0x6A09E667u;
    let h1 = b + 0xBB67AE85u;
    if (((h0 & input.mask0) == 0u) && ((h1 & input.mask1) == 0u)) {
      output[0] = 1u;
      output[1] = input.w4;
      output[2] = input.w5;
      output[3] = thread_id;
      output[4] = n;
      return;
    }
  }
}
`;

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>H98 WebGPU Miner</title>
  <style>
    :root { color-scheme: dark; --bg:#080a0b; --panel:#101315; --line:#273036; --fg:#f0f5f7; --muted:#8b9aa3; --accent:#55d6be; --warn:#f5b85a; --bad:#ff6b6b; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--fg); font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    header { height:64px; padding:0 22px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); background:#0b0e10; }
    h1 { margin:0; font-size:18px; color:var(--accent); letter-spacing:.08em; }
    main { display:grid; grid-template-columns:minmax(0,1fr) 360px; min-height:calc(100vh - 64px); }
    section { padding:22px; }
    aside { border-left:1px solid var(--line); padding:22px; background:#0d1012; }
    .rate { font-size:clamp(46px,9vw,110px); line-height:.9; font-weight:800; color:var(--accent); margin:26px 0 8px; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-top:24px; }
    .kv { border-top:1px solid var(--line); padding-top:10px; min-width:0; }
    .kv span { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; }
    .kv strong { display:block; margin-top:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .controls { display:flex; gap:10px; flex-wrap:wrap; margin-top:22px; }
    button { min-height:38px; border:1px solid var(--line); background:transparent; color:var(--fg); padding:8px 13px; font:inherit; cursor:pointer; }
    button:hover { border-color:var(--accent); color:var(--accent); }
    button.stop:hover { border-color:var(--bad); color:var(--bad); }
    label { display:block; color:var(--muted); margin-top:18px; font-size:12px; }
    input { width:100%; margin-top:8px; accent-color:var(--accent); }
    ol { margin:16px 0 0; padding:0; list-style:none; display:grid; gap:8px; }
    li { border-top:1px solid var(--line); padding-top:10px; min-width:0; }
    li strong, li span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    pre { margin:16px 0 0; max-height:330px; overflow:auto; white-space:pre-wrap; color:#c6d2d7; }
    .ok { color:var(--accent); } .warn { color:var(--warn); } .bad { color:var(--bad); }
    @media (max-width:900px) { main { grid-template-columns:1fr; } aside { border-left:0; border-top:1px solid var(--line); } .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  </style>
</head>
<body>
  <header>
    <h1>H98 WEBGPU</h1>
    <div class="muted" id="gpu">checking gpu</div>
  </header>
  <main>
    <section>
      <div class="muted" id="active">waiting for target</div>
      <div class="rate"><span id="rate">0</span> H/s</div>
      <div class="muted" id="total">0 hashes</div>
      <div class="controls">
        <button id="start">Start</button>
        <button class="stop" id="stop">Stop</button>
        <button id="refresh">Refresh</button>
      </div>
      <label>GPU step <span id="stepText">512</span></label>
      <input id="step" type="range" min="64" max="2048" value="512" step="64" />
      <label>Workgroups <span id="groupsText">2048</span></label>
      <input id="groups" type="range" min="128" max="4096" value="2048" step="128" />
      <div class="grid">
        <div class="kv"><span>Status</span><strong id="status">idle</strong></div>
        <div class="kv"><span>Difficulty</span><strong id="difficulty">-</strong></div>
        <div class="kv"><span>Mint</span><strong id="mint">-</strong></div>
        <div class="kv"><span>Accounts</span><strong id="accountsCount">0</strong></div>
      </div>
      <pre id="log"></pre>
    </section>
    <aside>
      <div class="kv"><span>Contract</span><strong id="contract">-</strong></div>
      <div class="kv"><span>Block</span><strong id="block">-</strong></div>
      <div class="kv"><span>Public minted</span><strong id="minted">-</strong></div>
      <div class="kv"><span>Submit mode</span><strong id="submitMode">-</strong></div>
      <ol id="accounts"></ol>
    </aside>
  </main>
  <script type="module">
    const shader = ${JSON.stringify(shader)};
    const $ = (id) => document.getElementById(id);
    let device, pipeline, bindGroupLayout;
    let running = false;
    let target = null;
    let accountIndex = 0;
    let totalHashes = 0;
    let lastHashes = 0;
    let lastTime = performance.now();

    function log(message, cls = "") {
      const line = "[" + new Date().toLocaleTimeString() + "] " + message;
      $("log").innerHTML += (cls ? '<span class="' + cls + '">' + line + "</span>" : line) + "\\n";
      $("log").scrollTop = $("log").scrollHeight;
    }
    function wordHex(word) { return (word >>> 0).toString(16).padStart(8, "0"); }
    function bytesToWords(hex) {
      const clean = hex.slice(2);
      const words = [];
      for (let i = 0; i < 4; i++) words.push(Number.parseInt(clean.slice(i * 8, i * 8 + 8), 16) >>> 0);
      return words;
    }
    function masks(bits) {
      if (bits <= 32) return [bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0, 0];
      return [0xffffffff, (0xffffffff << (64 - bits)) >>> 0];
    }
    function nonceFrom(words) {
      return "0x" + Array.from(words, wordHex).join("");
    }
    function rateTick() {
      const now = performance.now();
      const elapsed = Math.max(1, now - lastTime) / 1000;
      const rate = (totalHashes - lastHashes) / elapsed;
      $("rate").textContent = rate.toFixed(0);
      $("total").textContent = totalHashes.toLocaleString() + " hashes";
      lastHashes = totalHashes;
      lastTime = now;
    }
    setInterval(rateTick, 1000);

    async function initGpu() {
      if (!navigator.gpu) throw new Error("WebGPU is not available in this browser");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No high-performance WebGPU adapter found");
      device = await adapter.requestDevice();
      pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: device.createShaderModule({ code: shader }), entryPoint: "main" },
      });
      bindGroupLayout = pipeline.getBindGroupLayout(0);
      $("gpu").textContent = adapter.info?.description || "WebGPU ready";
    }

    async function refreshTarget() {
      const res = await fetch("/api/target", { cache: "no-store" });
      target = await res.json();
      if (!res.ok) throw new Error(target.error || "target failed");
      $("contract").textContent = target.contract;
      $("block").textContent = target.blockNumber;
      $("difficulty").textContent = target.difficulty + " bits";
      $("mint").textContent = target.mintOpen ? target.mintAmountDisplay : "closed";
      $("minted").textContent = target.publicMinted + " / " + target.maxPublicMints;
      $("accountsCount").textContent = target.accounts.length;
      $("submitMode").textContent = target.noSubmit ? "no-submit" : "auto-submit";
      $("accounts").innerHTML = target.accounts.map((a, i) =>
        '<li><strong>' + (i + 1) + ". " + a.address + '</strong><span class="' + (a.limitReached ? "warn" : "muted") + '">mintNonce ' + a.mintNonce + " | " + a.balance + (a.limitReached ? " | limit reached" : "") + "</span></li>"
      ).join("");
      log("Target refreshed: mintOpen=" + target.mintOpen + ", accounts=" + target.accounts.length);
    }

    async function mineAccount(account) {
      const difficulty = Number(target.difficulty);
      const [mask0, mask1] = masks(difficulty);
      const challengeWords = bytesToWords(account.challenge);
      const step = Number($("step").value);
      const groups = Number($("groups").value);
      const uniformBuffer = device.createBuffer({ size: 36, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const resultBuffer = device.createBuffer({ size: 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const readBuffer = device.createBuffer({ size: 20, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }, { binding: 1, resource: { buffer: resultBuffer } }],
      });

      let w4 = crypto.getRandomValues(new Uint32Array(1))[0];
      for (let w5 = 0; running && w5 < 0xffffffff; w5++) {
        const params = new Uint32Array([step, w4, w5 >>> 0, mask0, mask1, ...challengeWords]);
        device.queue.writeBuffer(uniformBuffer, 0, params);
        device.queue.writeBuffer(resultBuffer, 0, new Uint32Array(5));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(groups);
        pass.end();
        encoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, 20);
        device.queue.submit([encoder.finish()]);
        await readBuffer.mapAsync(GPUMapMode.READ);
        const found = new Uint32Array(readBuffer.getMappedRange()).slice();
        readBuffer.unmap();
        totalHashes += groups * 64 * step;
        if (found[0]) {
          return { address: account.address, challenge: account.challenge, difficulty, nonce: nonceFrom([found[1], found[2], found[3], found[4]]) };
        }
        if ((w5 & 31) === 31) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return null;
    }

    async function submitProof(proof) {
      log("Proof found for " + proof.address + " nonce " + proof.nonce, "ok");
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proof),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "submit failed");
      if (body.submitted) log("Mint confirmed block " + body.blockNumber + " tx " + body.tx, "ok");
      else log(body.message || "proof accepted without submit", body.stale ? "warn" : "ok");
      return body;
    }

    async function loop() {
      if (!device) await initGpu();
      await refreshTarget();
      while (running) {
        $("status").textContent = target.mintOpen ? "running" : "waiting";
        const active = target.accounts.filter((a) => !a.limitReached);
        if (!target.mintOpen || active.length === 0) {
          $("active").textContent = target.mintOpen ? "no account can mint" : "mint is closed";
          await new Promise((resolve) => setTimeout(resolve, 15000));
          await refreshTarget();
          continue;
        }
        const account = active[accountIndex % active.length];
        accountIndex += 1;
        $("active").textContent = account.address + " | challenge " + account.challenge;
        const proof = await mineAccount(account);
        if (!running || !proof) break;
        const result = await submitProof(proof);
        if (result.stale || result.submitted || result.accepted) await refreshTarget();
      }
      $("status").textContent = "idle";
    }

    $("step").addEventListener("input", () => $("stepText").textContent = $("step").value);
    $("groups").addEventListener("input", () => $("groupsText").textContent = $("groups").value);
    $("refresh").addEventListener("click", () => refreshTarget().catch((e) => log(e.message, "bad")));
    $("start").addEventListener("click", async () => {
      if (running) return;
      running = true;
      try { await loop(); } catch (e) { running = false; log(e.message, "bad"); $("status").textContent = "error"; }
    });
    $("stop").addEventListener("click", () => { running = false; log("Stopping"); });

    initGpu().then(refreshTarget).catch((e) => { $("gpu").textContent = "WebGPU unavailable"; log(e.message, "bad"); refreshTarget().catch(() => {}); });
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
      json(res, 200, await targetState());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/submit") {
      json(res, 200, await submitProof(await bodyJson(req)));
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error.shortMessage || error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`H98 WebGPU miner: http://${HOST}:${PORT}`);
  console.log(`Loaded ${accounts.length} account(s). Submit RPC: ${submitRpcUrl}${noSubmit ? " (no-submit)" : ""}`);
});
