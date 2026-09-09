# Generate Period Rewards for a Merkl Airdrop

This guide covers period-reward generation and Merkl airdrop payloads (`result/*.merkl.json` + `result/*.audit.json`).

Indexer internals, CI, and owes snapshots: see [HOWTO-OPS.md](./HOWTO-OPS.md).

---

## Prerequisites

```bash
yarn install
```

Create a `.env` file in the project root with the following variables:

```env
# Full QuickNode HTTP RPC URLs (not API keys)
RPC_MAINNET=https://your-mainnet-endpoint.quiknode.pro/...
RPC_ARBITRUM=https://your-arbitrum-endpoint.quiknode.pro/...
RPC_BASE=https://your-base-endpoint.quiknode.pro/...
RPC_OPTIMISM=https://your-optimism-endpoint.quiknode.pro/...
RPC_POLYGON=https://your-polygon-endpoint.quiknode.pro/...
RPC_SCROLL=https://your-scroll-endpoint.quiknode.pro/...
RPC_LINEA=https://your-linea-endpoint.quiknode.pro/...
RPC_MANTLE=https://your-mantle-endpoint.quiknode.pro/...
RPC_UNICHAIN=https://your-unichain-endpoint.quiknode.pro/...
```

All nine values are required by the current production configuration. Historical reward
generation needs archive access at the selected boundary blocks and RPC support for
historical `eth_call`, `eth_getCode`, and `eth_getLogs`.

---

## Build the local users database

Rewards are generated from the local indexed users database. On a fresh clone, build the database from on-chain
logs:

```bash
yarn full-index
```

`yarn cli:index` is the same command without automatic retries. Use `yarn full-index`
for a long first sync (RPC timeouts are common). `yarn cli:index` also accepts
`--BLOCK_STEP=<blocks>` to widen the default 1000-block indexing window — see
[block step](./HOWTO-OPS.md#block-step---block_step) in the ops guide.

With no prior cursor, each `indexingEnabled` network in
`src/config/networks.config.ts` starts at that network's `startBlock`
(mainnet Compound v2: `7710671`). Markets and users are discovered from
logs and written to `src/indexer/storage/`. Cursors advance as chunks
complete, so a crashed run can be resumed by running the same command
again.

Keep indexing until every network in your ranges file has
`cursor >= endBlock`. The rewards commands refuse to run on a stale cursor.

A first-time mainnet sync is long. Use a stable RPC. The indexer needs
reliable `eth_getLogs`; archive access is required later for the historical
reward `eth_call`s.

To index only the networks in your ranges file, set `indexingEnabled: false`
on the others in `src/config/networks.config.ts` before the first run.

To throw away a leftover store and start over:

```bash
rm -rf .runtime src/indexer/storage/users src/indexer/storage/meta.sqlite
```

---

## Range file

The period reward commands read `ranges.json` from the repository root by default.
Passing `--test` selects `ranges-test.json`; there is no arbitrary `--ranges-file`
option. V2 and V3 have independent range sections. Each V3
network has an inclusive envelope and can define a different start block per Comet:

```json
{
  "v2": [
    {
      "network": "mainnet",
      "chainId": 1,
      "startBlock": 7710671,
      "endBlock": 24996368
    }
  ],
  "v3": [
    {
      "network": "mainnet",
      "chainId": 1,
      "startBlock": 15331586,
      "endBlock": 24996368,
      "markets": [
        {
          "symbol": "cUSDCv3",
          "address": "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
          "startBlock": 15331586
        },
        {
          "symbol": "cWETHv3",
          "address": "0xA17581A9E3356d9A858b789D68B4d866e593aE94",
          "startBlock": 16400710
        }
      ]
    }
  ]
}
```

Only include the networks that should be processed in the relevant section. The
command verifies `chainId`, requires `startBlock >= 1`, treats both ends as inclusive,
records block hashes and timestamps, and rejects an `endBlock` inside the configured
reorg window. When `markets` is present, the network `startBlock` must equal the
earliest market start. For V3, each listed market can have its own start block. For
V2, `markets` acts as a partial/test filter, every listed market must use the network
`startBlock`, and only those markets are processed. Filtered V2 output is explicitly
named `*.partial.merkl.json` and its audit contains `partial: true` plus
`selectedMarkets`. Remove the V2 `markets` field before a production all-market run.
V2 ignores the V3 section and V3 ignores the V2 section.

---

## Generate files

Run the indexer through every selected `endBlock` first, then generate the files:

```bash
yarn cli:index
yarn cli:generate:rewards:v2:merkl
yarn cli:generate:rewards:v3:merkl
```

For a test run using `./ranges-test.json`:

```bash
yarn cli:generate:rewards:v2:merkl --test
yarn cli:generate:rewards:v3:merkl --test
```

By default, the Merkl payload allocates the full `remaining` debt at the end block.
Pass `--period` to allocate only FIFO-attributed `remainingForPeriod`. The flag can
be combined with `--test`:

```bash
yarn cli:generate:rewards:v2:merkl --period
yarn cli:generate:rewards:v3:merkl --test --period
```

---

## V2 attribution

V2 currently applies to Ethereum mainnet. Its attribution is strict per cToken and per
side (`supply` / `borrow`): distributed rewards inside the range plus the change in
uncheckpointed rewards between `startBlock - 1` and `endBlock`. It does not allocate
the Comptroller-wide `compAccrued` balance heuristically. The audit keeps this strict
market-level breakdown for `earned`. User/network totals additionally report
`earned`, `claimed`, and `remaining`; `claimed` is reconciled as
`debtBeforeStart + earned - debtAtEnd`, while `remaining` is the actual end debt
(`compAccrued` plus pending rewards across all processed V2 markets).
`remainingForPeriod = min(earned, remaining)` applies FIFO attribution: claims first
pay debt that existed before the period. With `--period`, the V2 Merkl payload
distributes `remainingForPeriod`; without it, the payload distributes full
`remaining`.

If a V2 supply or borrow reward index is unchanged across both boundaries, that
side's period earnings are zero. This also prevents harmless integer-rounding drift
in `borrowBalanceStored / borrowIndex` from appearing as a negative reward; negative
results with a changed reward index remain hard errors.

A V2 `markets` filter is only a partial smoke test. Because `compAccrued` is global,
the filtered audit reports `claimed: null` and its remaining amount is incomplete;
never use a `*.partial.merkl.json` file for a real airdrop.

---

## V3 attribution

V3 attributes rewards to the individual Comet market. It calculates the change in
`claimed + owed` between that market's `startBlock - 1` and the network `endBlock`.
The audit uses the same fields as V2: each market reports `earned`, while user and
network totals report `earned`, `claimed`, and `remaining`. For V3, `claimed` is the
change in `rewardsClaimed`, and `remaining` is the actual `getRewardOwed` amount at
the end block. `remainingForPeriod = min(earned, remaining)` is calculated separately
for each Comet. With `--period`, the V3 Merkl payload distributes this FIFO-attributed
period debt per market; without it, the payload distributes full end debt.
Start snapshots are requested only for users whose indexed `created_at` is not later
than the boundary timestamp; all users still receive the required end snapshot. The
same user-level pruning is applied to V2 start snapshots.

For V3, a non-empty `markets` list is an explicit selection. Indexed markets omitted
from that list are skipped, the run logs a `PARTIAL` warning, and the audit records
both `partial: true` and `omittedMarkets`. Keep every deployed V3 market in
`ranges.json` for a full production distribution; use a subset only for an intentional
partial/test calculation.

---

## Historical RPC calls

Historical calls select Multicall3, Multicall2, or Multicall1 according to what was
deployed at the requested block. Calls use concurrent chunks and adaptively split
timed-out batches recursively down to five calls (for example,
`200 -> 100 -> 50 -> 25 -> 13 -> 7 -> 4/3`). Direct `eth_call` fallback starts only
when a batch of five or fewer calls still fails.

---

## Outputs

For every network and reward token with a positive result, the generator writes:

- `result/rewards-v2-<network>-<token>-<start>-<end>.merkl.json`, or the V3 equivalent —
  the Merkl airdrop payload with checksummed addresses and raw integer amounts;
- the matching `result/*.audit.json` — range block hashes/timestamps, per-market and
  per-recipient totals, each market's effective range, plus the funding estimate
  including Merkl's 0.5% fee.

One output file represents one Merkl campaign on one chain for one reward token. V2
uses one `compound-v2` reason per recipient because actual debt is global rather than
market-attributed; its audit still contains cToken supply/borrow earnings. V3 reason
keys include the Comet address. The exporter verifies that reason, recipient, market,
and network totals match before publishing any file. All Merkl/audit groups are first
serialized to temporary files and then promoted together; an in-process failure rolls
back the whole export and restores any previous files.

Generated **local artifacts** (ignored by Git through `result/*`; review and publish
them through the chosen external airdrop process):

- `result/rewards-v2-*.merkl.json` / `result/rewards-v3-*.merkl.json` — Merkl airdrop payloads
- `result/rewards-v2-*.audit.json` / `result/rewards-v3-*.audit.json` — period attribution audit

---

## Available Scripts

```bash
# Index users across configured networks (writes updated DB into src/indexer/storage/)
yarn cli:index

# Generate period rewards and Merkl airdrop files from ./ranges.json
yarn cli:generate:rewards:v2:merkl
yarn cli:generate:rewards:v3:merkl

# Test run using ./ranges-test.json
yarn cli:generate:rewards:v2:merkl --test
yarn cli:generate:rewards:v3:merkl --test

# Allocate only FIFO-attributed remainingForPeriod
yarn cli:generate:rewards:v2:merkl --period
yarn cli:generate:rewards:v3:merkl --test --period
```
