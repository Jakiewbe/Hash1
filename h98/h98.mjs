import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function optionalGwei(name, fallbackName) {
  const value = process.env[name]?.trim() || (fallbackName ? process.env[fallbackName]?.trim() : "");
  return value ? parseGwei(value) : undefined;
}

function shortHex(hex) {
  return `${hex.slice(0, 10)}...${hex.slice(-6)}`;
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
      const id = account.address.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      accounts.push({ account, privateKey });
    }
  }
  return accounts;
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

function sha256Proof(challenge, nonce) {
  return createHash("sha256")
    .update(Buffer.concat([hexToBuffer(challenge, 16), hexToBuffer(nonce, 16)]))
    .digest();
}

function field(value, name, index) {
  return value?.[name] ?? value?.[index];
}

async function readGlobalState(client) {
  const [config, stats, decimals, maxMintsPerWallet, blockNumber] = await Promise.all([
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "getConfig" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "getStats" }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "decimals" }).catch(() => 18),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "MAX_MINTS_PER_WALLET" }).catch(() => 0n),
    client.getBlockNumber(),
  ]);
  return {
    blockNumber,
    decimals: Number(decimals),
    maxMintsPerWallet,
    mintOpen: Boolean(field(config, "mintOpen", 0)),
    difficulty: BigInt(field(config, "difficulty", 6)),
    mintPrice: BigInt(field(config, "mintPrice", 7)),
    mintAmount: BigInt(field(config, "mintAmount", 8)),
    maxPublicMints: BigInt(field(config, "maxPublicMints", 9)),
    publicMinted: BigInt(field(stats, "publicMinted", 0)),
    totalSupply: BigInt(field(stats, "totalSupply", 2)),
  };
}

async function readAccountState(client, wallet, globalState) {
  const [challenge, mintNonce, balance] = await Promise.all([
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "challengeFor", args: [wallet.account.address] }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "mintNonce", args: [wallet.account.address] }),
    client.readContract({ address: CONTRACT, abi: ABI, functionName: "balanceOf", args: [wallet.account.address] }).catch(() => 0n),
  ]);
  const limitReached = globalState.maxMintsPerWallet > 0n && mintNonce >= globalState.maxMintsPerWallet;
  return { ...wallet, address: wallet.account.address, challenge, mintNonce, balance, limitReached };
}

function printGlobalState(state) {
  console.log(`H98 contract: ${CONTRACT}`);
  console.log(`Block: ${state.blockNumber}`);
  console.log(`Mint open: ${state.mintOpen ? "yes" : "no"}`);
  console.log(`Difficulty: ${state.difficulty.toString()} leading zero bits`);
  console.log(`Mint price: ${formatEther(state.mintPrice)} ETH`);
  console.log(`Mint amount: ${formatUnits(state.mintAmount, state.decimals)} H98`);
  console.log(`Public minted: ${state.publicMinted.toString()} / ${state.maxPublicMints.toString()}`);
  if (state.maxMintsPerWallet > 0n) console.log(`Wallet limit: ${state.maxMintsPerWallet.toString()} mints`);
}

async function printStatus(client, accounts) {
  const globalState = await readGlobalState(client);
  printGlobalState(globalState);
  if (!accounts.length) {
    console.log("No H98 accounts loaded. Set H98_PRIVATE_KEYS or create h98-accounts.txt.");
    return;
  }
  const states = await Promise.all(accounts.map((wallet) => readAccountState(client, wallet, globalState)));
  for (const state of states) {
    const limit = globalState.maxMintsPerWallet > 0n ? `/${globalState.maxMintsPerWallet}` : "";
    console.log(
      `${state.address} | nonce ${state.mintNonce}${limit} | balance ${formatUnits(state.balance, globalState.decimals)} H98 | challenge ${shortHex(state.challenge)}${state.limitReached ? " | limit reached" : ""}`,
    );
  }
}

async function mineRound({ client, globalState, accountStates, workerCountPerAccount, batchSize, retargetSeconds }) {
  const difficultyBits = Number(globalState.difficulty);
  if (!Number.isInteger(difficultyBits) || difficultyBits < 0 || difficultyBits > 256) {
    throw new Error(`unsupported difficulty ${globalState.difficulty.toString()}`);
  }

  const workerStates = new Map();
  let finished = false;

  return await new Promise((resolve, reject) => {
    const children = [];

    const cleanup = () => {
      clearInterval(statusTimer);
      clearInterval(staleTimer);
    };
    const stopAll = () => {
      for (const child of children) child.postMessage({ type: "stop" });
    };
    const terminateAll = () => {
      for (const child of children) child.terminate().catch(() => {});
    };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      cleanup();
      process.stdout.write("\n");
      stopAll();
      terminateAll();
      resolve(result);
    };

    const statusTimer = setInterval(() => {
      let hashes = 0n;
      let rate = 0;
      for (const state of workerStates.values()) {
        hashes += BigInt(state.hashes || 0);
        rate += state.hashrate || 0;
      }
      process.stdout.write(
        `\rH98 searching ${rate.toFixed(0)} H/s | ${hashes.toLocaleString()} hashes | ${accountStates.length} accounts`,
      );
    }, 1000);

    const staleTimer = setInterval(async () => {
      if (finished) return;
      try {
        const latestGlobal = await readGlobalState(client);
        if (latestGlobal.difficulty !== globalState.difficulty || latestGlobal.mintOpen !== globalState.mintOpen) {
          finish({ type: "stale", reason: "global mining state changed" });
          return;
        }
        const challenges = await Promise.all(
          accountStates.map((state) =>
            client.readContract({ address: CONTRACT, abi: ABI, functionName: "challengeFor", args: [state.address] }),
          ),
        );
        for (let i = 0; i < challenges.length; i += 1) {
          if (challenges[i].toLowerCase() !== accountStates[i].challenge.toLowerCase()) {
            finish({ type: "stale", reason: `challenge changed for ${accountStates[i].address}` });
            return;
          }
        }
      } catch {
        // Transient RPC failures are ignored; submit-time checks still guard correctness.
      }
    }, Math.max(5, retargetSeconds) * 1000);

    let workerId = 0;
    for (const state of accountStates) {
      for (let i = 0; i < workerCountPerAccount; i += 1) {
        const id = workerId;
        workerId += 1;
        workerStates.set(id, { hashes: 0, hashrate: 0, address: state.address });
        const child = new Worker(new URL(import.meta.url), {
          workerData: {
            id,
            address: state.address,
            challenge: state.challenge,
            difficultyBits,
            batchSize,
            prefix: bufferToHex(randomBytes(8)),
          },
        });
        children.push(child);

        child.on("message", (message) => {
          if (message.type === "progress") {
            workerStates.set(id, { ...workerStates.get(id), hashes: message.hashes, hashrate: message.hashrate });
            return;
          }
          if (message.type === "found") {
            const accountState = accountStates.find((item) => item.address.toLowerCase() === message.address.toLowerCase());
            finish({ type: "found", ...message, accountState });
          }
          if (message.type === "error" && !finished) {
            finished = true;
            cleanup();
            terminateAll();
            reject(new Error(`worker ${id}: ${message.message}`));
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
    }
  });
}

async function submitProof({ publicClient, submitClient, accountState, nonce, digest, noSubmit, fastSubmit }) {
  const freshGlobal = await readGlobalState(publicClient);
  const freshChallenge = await publicClient.readContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "challengeFor",
    args: [accountState.address],
  });
  if (freshChallenge.toLowerCase() !== accountState.challenge.toLowerCase()) {
    return { submitted: false, stale: true, message: "challenge changed before submit" };
  }

  const localDigest = bufferToHex(sha256Proof(freshChallenge, nonce));
  if (localDigest.toLowerCase() !== digest.toLowerCase() || !proofOk(hexToBuffer(localDigest, 32), Number(freshGlobal.difficulty))) {
    return { submitted: false, stale: false, message: "local proof verification failed", digest: localDigest };
  }

  if (noSubmit) {
    return { submitted: false, stale: false, message: "no-submit mode", digest: localDigest };
  }

  const request = {
    account: accountState.account,
    address: CONTRACT,
    abi: ABI,
    functionName: "mint",
    args: [nonce],
    value: freshGlobal.mintPrice,
    ...(optionalGwei("H98_PRIORITY_FEE_GWEI", "PRIORITY_FEE_GWEI")
      ? { maxPriorityFeePerGas: optionalGwei("H98_PRIORITY_FEE_GWEI", "PRIORITY_FEE_GWEI") }
      : {}),
    ...(optionalGwei("H98_MAX_FEE_GWEI", "MAX_FEE_GWEI") ? { maxFeePerGas: optionalGwei("H98_MAX_FEE_GWEI", "MAX_FEE_GWEI") } : {}),
  };

  if (!fastSubmit) {
    const gasEstimate = await publicClient
      .estimateContractGas(request)
      .catch((error) => {
        throw new Error(error.shortMessage || error.message || "gas estimate failed");
      });
    request.gas = gasEstimate < 120000n ? 120000n : (gasEstimate * 3n) / 2n;
  }

  const tx = await submitClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  return { submitted: true, tx, receipt, digest: localDigest };
}

async function main() {
  loadDotEnv();

  const args = new Set(process.argv.slice(2));
  const noSubmit = args.has("--no-submit");
  const statusOnly = args.has("--status");
  const once = args.has("--once");

  const rpcUrl = process.env.H98_RPC_URL?.trim() || process.env.RPC_URL?.trim() || DEFAULT_RPC_URL;
  const submitRpcUrl =
    process.env.H98_SUBMIT_RPC_URL?.trim() ||
    process.env.SUBMIT_RPC_URL?.trim() ||
    process.env.PRIVATE_RPC_URL?.trim() ||
    rpcUrl;
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl, { timeout: 20_000 }) });
  const accounts = loadAccounts();

  if (statusOnly) {
    await printStatus(publicClient, accounts);
    return;
  }

  if (!accounts.length) {
    throw new Error("No H98 accounts loaded. Set H98_PRIVATE_KEYS or create h98-accounts.txt.");
  }

  const keepMining = boolEnv("H98_KEEP_MINING", true);
  const workerCountPerAccount = intEnv("H98_WORKERS_PER_ACCOUNT", 1, { min: 1, max: 32 });
  const batchSize = intEnv("H98_BATCH_SIZE", 50_000, { min: 1_000, max: 5_000_000 });
  const retargetSeconds = intEnv("H98_RETARGET_SECONDS", 15, { min: 5, max: 3600 });
  const fastSubmit = boolEnv("H98_FAST_SUBMIT", boolEnv("FAST_SUBMIT", false));

  const totalWorkers = accounts.length * workerCountPerAccount;
  const cpuHint = Math.max(1, availableParallelism() - 1);
  if (totalWorkers > cpuHint) {
    console.log(`Warning: configured ${totalWorkers} H98 workers on ${cpuHint} suggested CPU threads.`);
  }

  console.log(`Loaded ${accounts.length} H98 account(s). Submit RPC: ${submitRpcUrl}`);
  console.log(`Workers: ${workerCountPerAccount} per account, batch ${batchSize}, retarget ${retargetSeconds}s`);

  const submitClientByAddress = new Map(
    accounts.map(({ account }) => [
      account.address.toLowerCase(),
      createWalletClient({ account, chain: mainnet, transport: http(submitRpcUrl, { timeout: 20_000 }) }),
    ]),
  );

  for (;;) {
    const globalState = await readGlobalState(publicClient);
    printGlobalState(globalState);
    if (!globalState.mintOpen) {
      if (!keepMining && !once) return;
      console.log("Mint is closed; waiting 30s.");
      await sleep(30_000);
      continue;
    }

    const accountStates = (await Promise.all(accounts.map((wallet) => readAccountState(publicClient, wallet, globalState)))).filter(
      (state) => !state.limitReached,
    );
    if (!accountStates.length) {
      console.log("All loaded accounts reached the wallet mint limit.");
      return;
    }

    for (const state of accountStates) {
      const limit = globalState.maxMintsPerWallet > 0n ? `/${globalState.maxMintsPerWallet}` : "";
      console.log(`${state.address} | mintNonce ${state.mintNonce}${limit} | challenge ${shortHex(state.challenge)}`);
    }

    const result = await mineRound({
      client: publicClient,
      globalState,
      accountStates,
      workerCountPerAccount,
      batchSize,
      retargetSeconds,
    });

    if (result.type === "stale") {
      console.log(`Restarting: ${result.reason}`);
      continue;
    }

    console.log(`Proof found for ${result.address}: nonce ${result.nonce}, digest ${result.digest}`);
    const submitClient = submitClientByAddress.get(result.address.toLowerCase());
    try {
      const submitted = await submitProof({
        publicClient,
        submitClient,
        accountState: result.accountState,
        nonce: result.nonce,
        digest: result.digest,
        noSubmit,
        fastSubmit,
      });
      if (submitted.submitted) {
        console.log(`Mint tx sent: ${submitted.tx}`);
        console.log(`Mint confirmed in block ${submitted.receipt.blockNumber}, status ${submitted.receipt.status}`);
      } else {
        console.log(`Proof not submitted: ${submitted.message}`);
      }
    } catch (error) {
      console.log(`Mint submit failed: ${error.shortMessage || error.message}`);
    }

    if (once || !keepMining) return;
    await sleep(1000);
  }
}

function runWorker() {
  const challenge = hexToBuffer(workerData.challenge, 16);
  const prefix = hexToBuffer(workerData.prefix, 8);
  const message = Buffer.allocUnsafe(32);
  challenge.copy(message, 0);
  prefix.copy(message, 16);
  let stopped = false;
  let hashes = 0;
  let high = randomBytes(4).readUInt32BE(0);
  let low = randomBytes(4).readUInt32BE(0);
  let lastHashes = 0;
  let lastTime = Date.now();

  parentPort.on("message", (message) => {
    if (message.type === "stop") stopped = true;
  });

  try {
    while (!stopped) {
      for (let i = 0; i < workerData.batchSize; i += 1) {
        message.writeUInt32BE(high >>> 0, 24);
        message.writeUInt32BE(low >>> 0, 28);
        const digest = createHash("sha256").update(message).digest();
        hashes += 1;
        if (proofOk(digest, workerData.difficultyBits)) {
          parentPort.postMessage({
            type: "found",
            address: workerData.address,
            nonce: bufferToHex(message.subarray(16, 32)),
            digest: bufferToHex(digest),
            hashes,
          });
          return;
        }
        low = (low + 1) >>> 0;
        if (low === 0) high = (high + 1) >>> 0;
      }
      const now = Date.now();
      const elapsed = Math.max(1, now - lastTime) / 1000;
      parentPort.postMessage({
        type: "progress",
        hashes,
        hashrate: (hashes - lastHashes) / elapsed,
      });
      lastHashes = hashes;
      lastTime = now;
    }
  } catch (error) {
    parentPort.postMessage({ type: "error", message: error.message });
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.error(error.shortMessage || error.message);
    process.exitCode = 1;
  });
} else {
  runWorker();
}
