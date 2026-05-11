import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  parseGwei,
} from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CONTRACT = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const MINER_JS_URL = "https://hash256.org/miner/hash_miner.js";
const MINER_WASM_URL = "https://hash256.org/miner/hash_miner_bg.wasm";
const CACHE_DIR = path.resolve(".hash256-miner");
const MINER_JS = path.join(CACHE_DIR, "hash_miner.js");
const MINER_WASM = path.join(CACHE_DIR, "hash_miner_bg.wasm");

const ABI = parseAbi([
  "function genesisState() view returns (uint256 minted, uint256 remaining, uint256 ethRaised, bool complete)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft)",
  "function getChallenge(address miner) view returns (bytes32)",
  "function balanceOf(address account) view returns (uint256)",
  "function mine(uint256 nonce)",
]);

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function loadDotEnv(file = ".env") {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToBytes(hex, expectedBytes) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== expectedBytes * 2) {
    throw new Error(`expected ${expectedBytes} bytes, got ${clean.length / 2}`);
  }
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function uint256Hex(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function shortHex(hex) {
  return `${hex.slice(0, 10)}...${hex.slice(-6)}`;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function optionalGweiEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  return parseGwei(value);
}

async function ensureMinerRuntime() {
  await mkdir(CACHE_DIR, { recursive: true });
  if (boolEnv("HASH256_UPDATE_MINER") || !existsSync(MINER_JS)) {
    await download(MINER_JS_URL, MINER_JS);
  }
  if (boolEnv("HASH256_UPDATE_MINER") || !existsSync(MINER_WASM)) {
    await download(MINER_WASM_URL, MINER_WASM);
  }
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${url}: ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeFile(dest, bytes);
}

async function readState(client, minerAddress) {
  const [genesis, mining, challenge, balance] = await Promise.all([
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "genesisState" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "miningState" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "getChallenge", args: [minerAddress] }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "balanceOf", args: [minerAddress] }),
  ]);
  return { genesis, mining, challenge, balance };
}

async function mineOnce({ challenge, difficulty, workers, batchSize, refreshTarget, retargetSeconds }) {
  await ensureMinerRuntime();

  const workerCount = Number(workers);
  const states = new Map();
  let finished = false;

  return await new Promise((resolve, reject) => {
    const children = [];
    const stopAll = () => {
      for (const child of children) child.postMessage({ type: "stop" });
    };
    const terminateAll = () => {
      for (const child of children) child.terminate().catch(() => {});
    };

    const statusTimer = setInterval(() => {
      if (finished) return;
      let hashes = 0n;
      let rate = 0;
      for (const state of states.values()) {
        hashes += BigInt(state.hashes || 0);
        rate += state.hashrate || 0;
      }
      process.stdout.write(`\rsearching ${rate.toFixed(0)} H/s | ${hashes.toLocaleString()} hashes`);
    }, 1000);
    const staleTimer = refreshTarget ? setInterval(async () => {
      if (finished) return;
      try {
        const latest = await refreshTarget();
        if (latest.challenge !== challenge || latest.difficulty !== difficulty) {
          finished = true;
          clearInterval(statusTimer);
          clearInterval(staleTimer);
          process.stdout.write("\n");
          stopAll();
          terminateAll();
          resolve({ type: "stale", reason: "challenge or difficulty changed during search" });
        }
      } catch {
        // Ignore transient RPC errors; the submit-time freshness check still protects correctness.
      }
    }, Math.max(5, Number(retargetSeconds || 12)) * 1000) : null;

    const cleanup = () => {
      clearInterval(statusTimer);
      if (staleTimer) clearInterval(staleTimer);
    };

    for (let i = 0; i < workerCount; i += 1) {
      const prefix = bytesToHex(randomBytes(24));
      const child = new Worker(new URL(import.meta.url), {
        workerData: { challenge, difficulty, prefix, batchSize, workerId: i },
      });
      children.push(child);
      states.set(i, { hashes: 0, hashrate: 0 });

      child.on("message", (msg) => {
        if (msg.type === "ready") {
          states.set(i, { ...states.get(i), version: msg.version });
          return;
        }
        if (msg.type === "progress") {
          states.set(i, { hashes: msg.hashes, hashrate: msg.hashrate });
          return;
        }
        if (msg.type === "found" && !finished) {
          finished = true;
          cleanup();
          process.stdout.write("\n");
          stopAll();
          terminateAll();
          resolve(msg);
        }
        if (msg.type === "error" && !finished) {
          finished = true;
          cleanup();
          terminateAll();
          reject(new Error(`worker ${i}: ${msg.message}`));
        }
      });

      child.on("error", (error) => {
        if (finished) return;
        finished = true;
        cleanup();
        terminateAll();
        reject(error);
      });
    }
  });
}

async function main() {
  loadDotEnv();

  const args = new Set(process.argv.slice(2));
  const statusOnly = args.has("--status");
  const rpcUrl = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
  const submitRpcUrl = process.env.SUBMIT_RPC_URL || process.env.PRIVATE_RPC_URL || rpcUrl;
  const keepMining = boolEnv("KEEP_MINING") && !args.has("--once");
  const noSubmit = args.has("--no-submit");
  const privateKey = process.env.PRIVATE_KEY?.trim();
  const account = privateKey ? privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) : null;
  const minerAddress = account?.address || process.env.MINER_ADDRESS?.trim() || (statusOnly ? "0x0000000000000000000000000000000000000001" : undefined);

  if (!minerAddress) {
    throw new Error("set PRIVATE_KEY or MINER_ADDRESS in .env");
  }

  const workers = Number(process.env.WORKERS || Math.max(1, Math.min(8, (availableParallelism?.() || 4) - 1)));
  const batchSize = Number(process.env.BATCH_SIZE || 250000);
  const retargetSeconds = Number(process.env.RETARGET_SECONDS || 3);
  const fastSubmit = boolEnv("FAST_SUBMIT");
  const priorityFee = optionalGweiEnv("PRIORITY_FEE_GWEI");
  const maxFee = optionalGweiEnv("MAX_FEE_GWEI");
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const walletClient = account && !noSubmit
    ? createWalletClient({ account, chain: mainnet, transport: http(submitRpcUrl) })
    : null;

  console.log(`contract ${CONTRACT}`);
  console.log(`miner   ${minerAddress}`);
  console.log(`rpc     ${rpcUrl}`);
  console.log(`submit  ${submitRpcUrl}`);
  console.log(`workers ${workers}, batch ${batchSize.toLocaleString()}`);

  while (true) {
    const { genesis, mining, challenge, balance } = await readState(publicClient, minerAddress);
    const [, , ethRaised, complete] = genesis;
    const [era, reward, difficulty, minted, remaining, epoch, epochBlocksLeft] = mining;

    console.log("");
    console.log(`genesis complete: ${complete} | raised ${formatEther(ethRaised)} ETH`);
    console.log(`era ${era + 1n} | reward ${formatUnits(reward, 18)} HASH | difficulty ${shortHex(uint256Hex(difficulty))}`);
    console.log(`minted ${formatUnits(minted, 18)} HASH | remaining ${formatUnits(remaining, 18)} HASH | epoch ${epoch} | ${epochBlocksLeft} blocks left`);
    console.log(`balance ${formatUnits(balance, 18)} HASH | challenge ${shortHex(challenge)}`);

    if (statusOnly) return;

    if (!complete) {
      console.log("mining is not open yet.");
      if (!keepMining) return;
      await sleep(30_000);
      continue;
    }

    const hit = await mineOnce({
      challenge,
      difficulty: uint256Hex(difficulty),
      workers,
      batchSize,
      retargetSeconds,
      refreshTarget: async () => {
        const latest = await readState(publicClient, minerAddress);
        return { challenge: latest.challenge, difficulty: uint256Hex(latest.mining[2]) };
      },
    });

    if (hit.type === "stale") {
      console.log(`${hit.reason}; restarting search.`);
      if (!keepMining) return;
      continue;
    }

    console.log(`found nonce ${hit.nonce}`);
    console.log(`result      ${hit.result}`);

    if (!fastSubmit) {
      const fresh = await readState(publicClient, minerAddress);
      if (fresh.challenge !== challenge || fresh.mining[2] !== difficulty) {
        console.log("challenge or difficulty changed before submit; restarting search.");
        if (!keepMining) return;
        continue;
      }
    }

    if (!walletClient) {
      console.log("PRIVATE_KEY is not set or --no-submit was used; nonce was not submitted.");
      return;
    }

    const nonce = BigInt(hit.nonce);
    const gas = fastSubmit ? 300000n : (() => null)();
    const gasEstimate = gas ?? await publicClient.estimateContractGas({
      account,
      address: CONTRACT,
      abi: ABI,
      functionName: "mine",
      args: [nonce],
    }).catch(() => 300000n);
    const gasLimit = gasEstimate < 200000n ? 200000n : gasEstimate > 400000n ? 400000n : (gasEstimate * 3n) / 2n;
    const tx = await walletClient.writeContract({
      address: CONTRACT,
      abi: ABI,
      functionName: "mine",
      args: [nonce],
      gas: gasLimit,
      ...(priorityFee ? { maxPriorityFeePerGas: priorityFee } : {}),
      ...(maxFee ? { maxFeePerGas: maxFee } : {}),
    });
    console.log(`submitted ${tx}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`receipt ${receipt.status} in block ${receipt.blockNumber}`);

    if (!keepMining) return;
  }
}

async function workerMain() {
  let stopped = false;
  parentPort.on("message", (msg) => {
    if (msg.type === "stop") stopped = true;
  });

  try {
    const minerModule = await import(pathToFileURL(MINER_JS).href);
    const wasmBytes = await readFile(MINER_WASM);
    minerModule.initSync({ module: wasmBytes });

    const challenge = hexToBytes(workerData.challenge, 32);
    const difficulty = hexToBytes(workerData.difficulty, 32);
    const prefix = hexToBytes(workerData.prefix, 24);
    const miner = new minerModule.Miner(challenge, difficulty, prefix);
    parentPort.postMessage({ type: "ready", version: minerModule.version() });

    let counter = 0n;
    let hashes = 0n;
    let ema = 0;
    let lastProgress = performance.now();
    const started = performance.now();
    const batch = BigInt(workerData.batchSize);

    while (!stopped) {
      const before = performance.now();
      const result = miner.search(counter, batch);
      const after = performance.now();
      counter += batch;
      hashes += batch;

      const instant = Number(batch) / ((after - before) / 1000);
      ema = ema === 0 ? instant : ema + 0.25 * (instant - ema);

      if (result) {
        parentPort.postMessage({
          type: "found",
          workerId: workerData.workerId,
          nonce: bytesToHex(result.nonce),
          result: bytesToHex(result.result),
          hashes: hashes.toString(),
          elapsedMs: Math.round(after - started),
        });
        miner.free();
        return;
      }

      if (after - lastProgress > 1000) {
        lastProgress = after;
        parentPort.postMessage({
          type: "progress",
          workerId: workerData.workerId,
          hashes: hashes.toString(),
          hashrate: ema,
          elapsedMs: Math.round(after - started),
        });
      }

      await new Promise((resolve) => setImmediate(resolve));
    }

    miner.free();
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      workerId: workerData?.workerId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
} else {
  workerMain();
}
