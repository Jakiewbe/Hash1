# HASH256 自动挖矿脚本

这个脚本按 `https://hash256.org/mine` 前端公开逻辑工作：读取合约状态，加载官方 wasm miner，在本机 CPU 上搜索 nonce。找到 nonce 后，如果配置了 `PRIVATE_KEY`，会调用合约 `mine(uint256)`；否则只打印 nonce，方便你自己提交。

当前页面显示 mining 尚未开放，脚本不会绕过这个状态。`KEEP_MINING=1` 时会定时等待开放。

## 使用

```powershell
npm install
Copy-Item .env.example .env
notepad .env
npm run mine
```

只检查合约状态：

```powershell
npm run check
```

## PFFT / pffthash.com

PFFT script reads the live `pffthash.com` contract state, computes PoW locally with CPU
workers, and optionally submits `freeMint(uint256 powNonce)` if you configure a
dedicated private key.

```powershell
npm run pfft:check
npm run pfft
npm run pfft:gpu
```

Relevant `.env` keys:

- `PFFT_RPC_URL`: mainnet RPC for reading state.
- `PFFT_SUBMIT_RPC_URL`: optional submission RPC, preferably a private relay.
- `PFFT_PRIVATE_KEY`: optional; when set, the script signs and submits `freeMint`.
- `PFFT_MINER_ADDRESS`: required if `PFFT_PRIVATE_KEY` is empty.
- `PFFT_KEEP_MINING=1`: keep restarting after success or stale challenge changes.
- `PFFT_WORKERS`: CPU workers, default `min(8, cores - 1)`.
- `PFFT_BATCH_SIZE`: per-worker attempts between progress yields.
- `PFFT_RETARGET_SECONDS`: refresh interval for challenge / target changes.
- `PFFT_PRIORITY_FEE_GWEI` / `PFFT_MAX_FEE_GWEI`: optional EIP-1559 overrides.
- `PFFT_GPU_PORT`: local WebGPU page port, default `8790`.
- `PFFT_GPU_NO_SUBMIT=1`: GPU mode only searches and verifies locally, without sending `freeMint`.

`npm run pfft:gpu` starts a local WebGPU miner page at `http://127.0.0.1:8790`.
Open it in current Chrome/Edge, click `Start GPU`, and the browser will search on
GPU while the local Node server handles state reads and optional tx submission.

## 配置

- `RPC_URL`: Ethereum mainnet RPC，建议使用自己的 Alchemy/Infura/QuickNode 等节点。
- `SUBMIT_RPC_URL`: 可选，专门用于广播 `mine()` 交易的私有 RPC，例如 `https://rpc.mevblocker.io/fast` 或 `https://rpc.flashbots.net/fast`。
- `PRIVATE_KEY`: 可选；填写后脚本会自动提交 `mine(nonce)` 交易。
- `MINER_ADDRESS`: 没有私钥时必填，用于读取 `getChallenge(address)`。
- `KEEP_MINING=1`: 持续等待开放，并在交易成功后继续下一轮。
- `WORKERS`: CPU worker 数，默认最多 8 个。
- `BATCH_SIZE`: 每个 worker 每批搜索次数，默认 `250000`。
- `RETARGET_SECONDS`: 搜索中检测链上 challenge/difficulty 是否变化的间隔，默认 `3` 秒。
- `FAST_SUBMIT=1`: 找到 nonce 后跳过最终 freshness 检查和 gas 估算，提交更快，但如果 nonce 已过期可能白烧 gas。
- `PRIORITY_FEE_GWEI` / `MAX_FEE_GWEI`: 可选 EIP-1559 手动费用，用于提高交易排序；竞争激烈时低 priority fee 很容易进块靠后。

## 安全说明

不要把主钱包私钥放进脚本。建议新建挖矿钱包，只保留够付 gas 的 ETH。

## H98 / h98hash.xyz

H98 script reads the public mining state from `https://www.h98hash.xyz/`, searches a
`bytes16 nonce` where `SHA-256(challengeFor(address) + nonce)` satisfies the
current leading-zero-bit difficulty, then submits `mint(bytes16)` for the winning
account.

```powershell
npm run h98:check
npm run h98
npm run h98:gpu
```

The H98 scripts live in `h98/`. `npm run h98:gpu` starts the local WebGPU miner at `http://127.0.0.1:8798`.
The browser searches proofs on the GPU, and the Node server submits the winning
`mint(bytes16)` transaction for the matching loaded account.

For multiple accounts, put one private key per line in `h98-accounts.txt`, or set
`H98_PRIVATE_KEYS` in `.env` with comma or space separated keys. The H98 script
only reads `H98_PRIVATE_KEYS` / `h98-accounts.txt`; it does not reuse the
HASH256 `PRIVATE_KEY`.

## Equium / equium.xyz

Equium uses Solana and Equihash 96,5. The scripts in `equium/` wrap the
official Rust CLI miner from `HannaPrints/equium`; they do not reimplement the
solver.

```powershell
npm run equium:setup
npm run equium
npm run equium:status
```

Add Solana keypair entries to `equium/keypairs.txt`; paths to Solana keypair
JSON files are preferred, and inline JSON arrays or base58 keypairs are also
accepted. For multi-account or multi-core mining, set
`EQUIUM_WORKERS_PER_KEYPAIR`; expected wins follow total CPU hashrate, not
account count by itself.
