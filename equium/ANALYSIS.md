# Equium Speed And Multi Account Notes

Sources checked:

- `https://www.equium.xyz/`
- `https://www.equium.xyz/mine`
- `https://github.com/HannaPrints/equium`
- Official protocol docs in the upstream repository.

## Mining Model

Equium is a Solana program at `ZKGMUfxiRCXFPnqz9zgqAnuqJy15jk7fKbR4o6FuEQM`.
It uses Equihash 96,5. The proof input includes:

- Equihash parameter bytes
- current 32-byte challenge
- miner public key
- block height

The submitted proof is `nonce: [u8; 32]` plus compressed Equihash solution
indices. The program verifies the Equihash solution and then checks
`sha256(soln_indices || I-block) < current_target`.

## Speed

Equihash 96,5 is memory-bound. The official docs explicitly position it as
CPU-friendly, with limited GPU advantage.

The official Rust CLI miner is the fastest practical base here. The browser
miner runs WebAssembly workers and is documented as roughly 2-3x slower per core
than native. The current CLI solver is single-threaded, so this wrapper uses
multiple miner processes to use more CPU cores.

Use a private Solana RPC for sustained mining. Public Solana RPC endpoints are
rate-limited and will hurt submission reliability.

## Multi Account

Multi-account mining is technically supported because each solution is bound to
the signer public key. A solution found for wallet A cannot be submitted by
wallet B.

More accounts do not increase expected rewards by themselves. Expected wins
follow total valid attempts per second. On one machine, splitting the same CPU
across multiple wallets mostly splits ownership of the same hashrate.

Practical uses for multiple accounts:

- separate risk and balances
- run distinct machines under distinct wallets
- isolate stuck or low-SOL wallets

For pure speed on one machine, increase `EQUIUM_WORKERS_PER_KEYPAIR` first. Use
multiple keypairs only when there is an operational reason.
