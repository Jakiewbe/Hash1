# Equium Miner Wrapper

This folder contains a Windows PowerShell wrapper around Equium's official
Rust CLI miner from `HannaPrints/equium`.

It does not reimplement Equihash. The wrapper downloads the official source,
builds `equium-miner`, and starts one or more managed miner processes.

## Setup

Install Rust/Cargo first:

```powershell
winget install Rustlang.Rustup
```

Add one Solana keypair entry per line to `equium/keypairs.txt`. Paths to Solana
keypair JSON files are preferred. Inline Solana keypair JSON arrays and base58
keypairs are also accepted, but keep this file private.

```text
C:\Users\you\.config\solana\id.json
C:\wallets\eqm-2.json
```

Then build and run:

```powershell
npm run equium:setup
npm run equium
```

## Configuration

Set these in `.env` or the current PowerShell session:

```text
EQUIUM_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
EQUIUM_KEYPAIRS_FILE=equium/keypairs.txt
EQUIUM_WORKERS_PER_KEYPAIR=1
EQUIUM_MAX_BLOCKS=0
EQUIUM_MAX_NONCES_PER_ROUND=4096
EQUIUM_CU_LIMIT=1400000
EQUIUM_CACHE_DIR=D:\equium-miner-cache
```

Use a private Solana RPC for sustained mining. The default public endpoint is
rate-limited.

## Commands

```powershell
npm run equium
npm run equium:setup
npm run equium:status
npm run equium:stop
npm run equium:watch
```

For one foreground miner:

```powershell
powershell -ExecutionPolicy Bypass -File equium/run-equium.ps1 -Foreground
```

For unattended mining, use the watchdog:

```powershell
npm run equium:watch
```

It starts the miner wrapper, checks managed `equium-miner` processes every
minute, and restarts them if they exit. Logs are written under `.equium-watch/`.

## Multi Account

Equium solutions are bound to the miner public key, so multiple Solana keypairs
can mine at the same time. More accounts do not multiply your odds by
themselves; total expected wins follow total CPU hashrate.

The official CLI solver is single-threaded. To use more CPU cores, increase
`EQUIUM_WORKERS_PER_KEYPAIR`, or list multiple keypairs. Running many processes
can increase RPC usage and transaction races.
