import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
import { keccak_256 } from "@noble/hashes/sha3";

const CONTRACT = "0xEFAd2Eab7172dDEbE5Ce7a41f5Ddf8fCcE4Ca0CB";
const ABI = parseAbi([
  "function getInfo() view returns (uint256 totalMinted, uint256 remainingSupply, uint256 decayBps, uint256 nextMintAmount)",
  "function BASE_MINT_AMOUNT() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function MIN_MINT_AMOUNT() view returns (uint256)",
  "function POW_TARGET() view returns (uint256)",
  "function currentPowChallenge(address miner) view returns (bytes32)",
  "function minted(address account) view returns (uint256)",
  "function calculateActualMint(uint256 baseAmount) view returns (uint256)",
  "function currentPowStage() view returns (uint256)",
  "function currentPowHexZeros() view returns (uint256)",
  "function freeMint(uint256 powNonce)",
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToBytes(hex, expectedBytes) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (expectedBytes != null && clean.length !== expectedBytes * 2) {
    throw new Error(`expected ${expectedBytes} bytes, got ${clean.length / 2}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
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

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

function formatHashrate(value) {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GH/s`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} MH/s`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)} kH/s`;
  return `${value.toFixed(0)} H/s`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function countLeadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      if (byte & mask) return bits;
      bits += 1;
    }
  }
  return bits;
}

function incrementBytesBE(bytes, step) {
  let carry = step;
  for (let i = bytes.length - 1; i >= 0 && carry > 0; i -= 1) {
    const sum = bytes[i] + (carry & 0xff);
    bytes[i] = sum & 0xff;
    carry = (carry >> 8) + (sum >> 8);
  }
}

function compareBytesBE(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

async function readState(client, minerAddress) {
  const [info, powTarget, powStage, powHexZeros, baseMintAmount, actualMintAmount, mintedByAddress, challenge] = await Promise.all([
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "getInfo" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "POW_TARGET" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "currentPowStage" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "currentPowHexZeros" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "BASE_MINT_AMOUNT" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "BASE_MINT_AMOUNT" }).then((base) =>
      client.readContract({ address: CONTRACT, abi: ABI, functionName: "calculateActualMint", args: [base] }),
    ),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "minted", args: [minerAddress] }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "currentPowChallenge", args: [minerAddress] }),
  ]);
  return { info, powTarget, powStage, powHexZeros, baseMintAmount, actualMintAmount, mintedByAddress, challenge };
}

async function mineOnce({ challenge, target, workers, batchSize, refreshTarget, retargetSeconds }) {
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
      process.stdout.write(`\rsearching ${formatHashrate(rate)} | ${hashes.toLocaleString()} attempts`);
    }, 1000);

    const staleTimer = refreshTarget
      ? setInterval(async () => {
          if (finished) return;
          try {
            const latest = await refreshTarget();
            if (latest.challenge !== challenge || latest.target !== target) {
              finished = true;
              clearInterval(statusTimer);
              clearInterval(staleTimer);
              process.stdout.write("\n");
              stopAll();
              terminateAll();
              resolve({ type: "stale", reason: "challenge or target changed during search" });
            }
          } catch {
            // Ignore transient RPC failures and keep searching.
          }
        }, Math.max(3, Number(retargetSeconds || 12)) * 1000)
      : null;

    const cleanup = () => {
      clearInterval(statusTimer);
      if (staleTimer) clearInterval(staleTimer);
    };

    for (let i = 0; i < workerCount; i += 1) {
      const seed = randomBytes(32);
      seed[31] = (seed[31] + i) & 0xff;
      const child = new Worker(new URL(import.meta.url), {
        workerData: {
          workerId: i,
          challenge,
          target,
          batchSize,
          startNonce: bytesToHex(seed),
          step: workerCount,
        },
      });
      children.push(child);
      states.set(i, { hashes: 0, hashrate: 0 });

      child.on("message", (msg) => {
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
          return;
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
  const noSubmit = args.has("--no-submit");
  const rpcUrl = process.env.PFFT_RPC_URL || process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
  const submitRpcUrl = process.env.PFFT_SUBMIT_RPC_URL || process.env.SUBMIT_RPC_URL || rpcUrl;
  const keepMining = boolEnv("PFFT_KEEP_MINING", boolEnv("KEEP_MINING")) && !args.has("--once");
  const privateKey = process.env.PFFT_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
  const account = privateKey
    ? privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`)
    : null;
  const minerAddress = account?.address
    || process.env.PFFT_MINER_ADDRESS?.trim()
    || process.env.MINER_ADDRESS?.trim()
    || (statusOnly ? "0x0000000000000000000000000000000000000001" : undefined);

  if (!minerAddress) throw new Error("set PFFT_PRIVATE_KEY/PFFT_MINER_ADDRESS or PRIVATE_KEY/MINER_ADDRESS in .env");

  const workers = Number(process.env.PFFT_WORKERS || Math.max(1, Math.min(8, (availableParallelism?.() || 4) - 1)));
  const batchSize = Number(process.env.PFFT_BATCH_SIZE || 20000);
  const retargetSeconds = Number(process.env.PFFT_RETARGET_SECONDS || 5);
  const fastSubmit = boolEnv("PFFT_FAST_SUBMIT", boolEnv("FAST_SUBMIT"));
  const priorityFee = optionalGweiEnv("PFFT_PRIORITY_FEE_GWEI") ?? optionalGweiEnv("PRIORITY_FEE_GWEI");
  const maxFee = optionalGweiEnv("PFFT_MAX_FEE_GWEI") ?? optionalGweiEnv("MAX_FEE_GWEI");
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
    const state = await readState(publicClient, minerAddress);
    const [totalMinted, remainingSupply, decayBps, nextMintAmount] = state.info;
    const targetHex = uint256Hex(state.powTarget);

    console.log("");
    console.log(`minted ${formatUnits(totalMinted, 18)} PFFT | remaining ${formatUnits(remainingSupply, 18)} PFFT`);
    console.log(`next quote ${formatUnits(nextMintAmount, 18)} PFFT | actual ${formatUnits(state.actualMintAmount, 18)} PFFT`);
    console.log(`decay ${(Number(decayBps) / 100).toFixed(2)}% | wallet minted ${formatUnits(state.mintedByAddress, 18)} PFFT`);
    console.log(`pow stage ${state.powStage + 1n}/5 | hex zeros ${state.powHexZeros} | target ${shortHex(targetHex)}`);
    console.log(`challenge ${shortHex(state.challenge)}`);

    if (statusOnly) return;

    const hit = await mineOnce({
      challenge: state.challenge,
      target: targetHex,
      workers,
      batchSize,
      retargetSeconds,
      refreshTarget: async () => {
        const latest = await readState(publicClient, minerAddress);
        return { challenge: latest.challenge, target: uint256Hex(latest.powTarget) };
      },
    });

    if (hit.type === "stale") {
      console.log(`${hit.reason}; restarting search.`);
      if (!keepMining) return;
      continue;
    }

    console.log(`found nonce ${hit.nonce}`);
    console.log(`hash       ${hit.hash}`);
    console.log(`leading0   ${hit.leadingZeroBits} bits`);
    console.log(`speed      ${formatHashrate(hit.hashrate)} after ${formatDuration(hit.elapsedMs)}`);

    if (!fastSubmit) {
      const fresh = await readState(publicClient, minerAddress);
      if (fresh.challenge !== state.challenge || fresh.powTarget !== state.powTarget) {
        console.log("challenge or target changed before submit; restarting search.");
        if (!keepMining) return;
        continue;
      }
    }

    if (!walletClient) {
      console.log("private key not set or --no-submit used; nonce not submitted.");
      return;
    }

    const nonce = BigInt(hit.nonce);
    const gasEstimate = await publicClient.estimateContractGas({
      account,
      address: CONTRACT,
      abi: ABI,
      functionName: "freeMint",
      args: [nonce],
    }).catch(() => 220000n);
    const gasLimit = gasEstimate < 180000n ? 180000n : gasEstimate > 350000n ? 350000n : (gasEstimate * 3n) / 2n;
    const tx = await walletClient.writeContract({
      address: CONTRACT,
      abi: ABI,
      functionName: "freeMint",
      args: [nonce],
      gas: gasLimit,
      ...(priorityFee ? { maxPriorityFeePerGas: priorityFee } : {}),
      ...(maxFee ? { maxFeePerGas: maxFee } : {}),
    });
    console.log(`submitted ${tx}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`receipt ${receipt.status} in block ${receipt.blockNumber}`);

    if (!keepMining) return;
    await sleep(2000);
  }
}

async function workerMain() {
  let stopped = false;
  parentPort.on("message", (msg) => {
    if (msg.type === "stop") stopped = true;
  });

  try {
    const challenge = hexToBytes(workerData.challenge, 32);
    const target = hexToBytes(workerData.target, 32);
    const nonce = hexToBytes(workerData.startNonce, 32);
    const input = new Uint8Array(64);
    input.set(challenge, 0);
    input.set(nonce, 32);

    let attempts = 0n;
    let ema = 0;
    let lastProgress = performance.now();
    const started = performance.now();
    const batch = BigInt(workerData.batchSize);

    while (!stopped) {
      const before = performance.now();
      for (let i = 0n; i < batch && !stopped; i += 1n) {
        const hashBytes = keccak_256(input);
        attempts += 1n;
        if (compareBytesBE(hashBytes, target) <= 0) {
          const after = performance.now();
          const elapsedMs = after - started;
          const hashrate = elapsedMs > 0 ? Number(attempts) / (elapsedMs / 1000) : 0;
          parentPort.postMessage({
            type: "found",
            workerId: workerData.workerId,
            nonce: bytesToHex(nonce),
            hash: bytesToHex(hashBytes),
            leadingZeroBits: countLeadingZeroBits(hashBytes),
            hashes: attempts.toString(),
            elapsedMs: Math.round(elapsedMs),
            hashrate,
          });
          return;
        }
        incrementBytesBE(nonce, workerData.step);
        input.set(nonce, 32);
      }

      const after = performance.now();
      const instant = Number(batch) / ((after - before) / 1000);
      ema = ema === 0 ? instant : ema + 0.25 * (instant - ema);

      if (after - lastProgress > 1000) {
        lastProgress = after;
        parentPort.postMessage({
          type: "progress",
          workerId: workerData.workerId,
          hashes: attempts.toString(),
          hashrate: ema,
          nonce: bytesToHex(nonce),
        });
      }

      await new Promise((resolve) => setImmediate(resolve));
    }
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
