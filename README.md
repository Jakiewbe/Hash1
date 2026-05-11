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

## 配置

- `RPC_URL`: Ethereum mainnet RPC，建议使用自己的 Alchemy/Infura/QuickNode 等节点。
- `PRIVATE_KEY`: 可选；填写后脚本会自动提交 `mine(nonce)` 交易。
- `MINER_ADDRESS`: 没有私钥时必填，用于读取 `getChallenge(address)`。
- `KEEP_MINING=1`: 持续等待开放，并在交易成功后继续下一轮。
- `WORKERS`: CPU worker 数，默认最多 8 个。
- `BATCH_SIZE`: 每个 worker 每批搜索次数，默认 `250000`。
- `RETARGET_SECONDS`: 搜索中检测链上 challenge/difficulty 是否变化的间隔，默认 `3` 秒。
- `FAST_SUBMIT=1`: 找到 nonce 后跳过最终 freshness 检查和 gas 估算，提交更快，但如果 nonce 已过期可能白烧 gas。

## 安全说明

不要把主钱包私钥放进脚本。建议新建挖矿钱包，只保留够付 gas 的 ETH。
