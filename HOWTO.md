# 🚀 Quick Start

This repository indexes on-chain users for Compound markets and generates **deterministic, on-chain–derived snapshots** (JSON + Markdown), such as protocol **owes** and a **markets overview**.

To keep the **public repo lightweight** (and avoid GitHub LFS bandwidth issues on forks/clones), **large artifacts are stored in a separate private “artifacts” repository** using **Git LFS** and synced in CI/local runs when needed.

---

## Install Dependencies

```bash
yarn install
```

---

## Environment Setup

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

## Artifacts Repository (Git LFS)

This repository (**code repo**) does **not** store large artifacts in Git LFS anymore.

Instead, heavy data lives in a separate **private artifacts repository** (example: `cryptease/compound-docs-artifacts`) with this structure:

- `storage/` — runtime/indexer DB snapshot (manifests + chunks)
  - `storage/**/manifest.json` (regular Git)
  - `storage/**/*.sqlite` (Git LFS)
- `snapshots/` — large detailed snapshots
  - `snapshots/owes-detailed-v2.json` (Git LFS)
  - `snapshots/owes-detailed-v3.json` (Git LFS)

CI and local runs **rsync** `artifacts/storage/` into `src/indexer/storage/` before running commands that need the indexed DB.

---

## ARTIFACTS_TOKEN (GitHub Actions)

Workflows that need the indexed DB or detailed snapshots must clone the **private artifacts repo**.

To do this, the code repo uses a GitHub Actions secret named:

- **`ARTIFACTS_TOKEN`** — a **fine-grained Personal Access Token (PAT)** with access to the private artifacts repository.

### How to create `ARTIFACTS_TOKEN`

1. GitHub → **Settings** → **Developer settings**
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. **Repository access** → _Only select repositories_ → select your private artifacts repo
4. **Repository permissions**:
   - **Contents: Read and write** (required)
5. Create token and copy it.

### How to add it to the code repo

In the **code repo** (this repo):

- **Settings → Secrets and variables → Actions → New repository secret**
- Name: `ARTIFACTS_TOKEN`
- Value: your PAT

> Keep this token only in GitHub Secrets (do not commit it, do not store it in `.env`).

---

## Local Setup (Optional)

If you only want to regenerate docs that don’t require the indexed DB (e.g. `cli:generate:md`), you can run locally without artifacts.

If you want to run the **indexer** or generate **owes**, you need the artifacts repo.

### Clone + pull artifacts (sqlite only)

```bash
# 1) Clone artifacts repo (private)
git clone git@github.com:cryptease/compound-docs-artifacts.git ../compound-docs-artifacts
cd ../compound-docs-artifacts

# 2) Pull ONLY sqlite chunks from LFS
git lfs install --local --skip-smudge
git config lfs.fetchinclude "storage/**/*.sqlite"
git config lfs.fetchexclude ""
git lfs pull

# 3) Overlay into the code repo
cd ../compound-docs-aggregator   # <- your code repo folder
mkdir -p src/indexer/storage
rsync -a ../compound-docs-artifacts/storage/ src/indexer/storage/
```

---

## Generate Documentation

Generate/update the repository documentation and the main `output.json` snapshot:

```bash
yarn cli:generate:md
```

This command will:

1. Build the NestJS application
2. Fetch market metadata from all supported networks
3. Generate/update `output.json` in the repository root
4. Create/update the generated Markdown documentation (README)

> This command does **not** require the indexed DB.

---

## Index On-Chain Users Database

Build and maintain the on-chain users database (used by the owes commands):

```bash
yarn cli:index
```

This command will:

1. Build the NestJS application
2. Assemble the DB snapshot into a working (runtime) database
3. Index all configured networks that should be indexed
4. Discover and persist users that appear on each network
5. Update the indexer cursor/state to support resumable runs
6. Write updated DB back to `src/indexer/storage/` (which CI then syncs to the artifacts repo)

### Full local sync with retries

For long-running local indexing (fresh sync / flaky RPC), use:

```bash
yarn full-index
```

---

## Generate Protocol Owes

Owes snapshots are generated **from the already indexed users database**.

### Compound v2 owes

```bash
yarn cli:generate:owes:v2
```

This command will:

1. Read previously indexed users from the local database
2. Compute current **Compound v2** owes for those users on each configured v2 network
3. Produce `owes-v2.json` in the repository root
4. Optionally produce a large detailed file `owes-detailed-v2.json` (stored in the artifacts repo)

> Note on v2 accrual (“heal”): this project does **not** rely on a state-changing “heal” flow to force accrual.  
> The snapshot is derived from **current on-chain state** available via `eth_call`.

### Compound v3 owes

```bash
yarn cli:generate:owes:v3
```

This command will:

1. Read all previously indexed users from the local database
2. For each configured v3 network, compute the current protocol owed amounts for those users
3. Produce `owes-v3.json` in the repository root
4. Optionally produce a large detailed file `owes-detailed-v3.json` (stored in the artifacts repo)

### Generate owes Markdown

Generate a human-readable Markdown summary from the latest owes snapshots:

```bash
yarn cli:generate:owes:md
```

This command will:

1. Read the latest `owes-v2.json` / `owes-v3.json`
2. Produce/refresh `REWARDS.md`

### Important workflow note

In CI, GitHub Actions runs **`cli:index` before** any owes generation.  
When running locally, ensure `yarn cli:index` completed successfully first — otherwise owes output may be incomplete or stale.

---

## Generate Period Rewards for a Merkl Airdrop

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

Historical calls select Multicall3, Multicall2, or Multicall1 according to what was
deployed at the requested block. Calls use concurrent chunks and adaptively split
timed-out batches recursively down to five calls (for example,
`200 -> 100 -> 50 -> 25 -> 13 -> 7 -> 4/3`). Direct `eth_call` fallback starts only
when a batch of five or fewer calls still fails.

For V3, a non-empty `markets` list is an explicit selection. Indexed markets omitted
from that list are skipped, the run logs a `PARTIAL` warning, and the audit records
both `partial: true` and `omittedMarkets`. Keep every deployed V3 market in
`ranges.json` for a full production distribution; use a subset only for an intentional
partial/test calculation.

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

---

## GitHub Actions

There are two kinds of workflows:

### 1) Manually triggered workflows (`run-*`)

- `run-indexing.yml` — runs the user indexer (`yarn cli:index`)  
  **Requires** `ARTIFACTS_TOKEN` (to pull/push DB artifacts)
- `run-owes-v2.yml` — generates `owes-v2.json`  
  **Requires** `ARTIFACTS_TOKEN` (needs indexed DB; pushes detailed snapshot to artifacts repo)
- `run-owes-v3.yml` — generates `owes-v3.json`  
  **Requires** `ARTIFACTS_TOKEN`
- `run-owes-md.yml` — generates the owes Markdown summary (`REWARDS.md`)  
  Does **not** require `ARTIFACTS_TOKEN` (reads public `owes-*.json`)

### 2) Scheduled / maintenance workflows (`update-*`)

- `update-market-data.yml` — updates market metadata and docs (`output.json` + README)  
  Does **not** require `ARTIFACTS_TOKEN`
- `update-owes.yml` — updates index + owes + markdown  
  **Requires** `ARTIFACTS_TOKEN`

---

## Outputs

Artifacts committed in the **code repo** (this repo):

- `output.json` — markets / metadata snapshot used by the docs generator
- `owes-v2.json` — Compound v2 owes snapshot
- `owes-v3.json` — Compound v3 owes snapshot
- `REWARDS.md` — Markdown summary of owes (generated from the JSON snapshots)

Generated **local artifacts** (ignored by Git through `result/*`; review and publish
them through the chosen external airdrop process):

- `result/rewards-v2-*.merkl.json` / `result/rewards-v3-*.merkl.json` — Merkl airdrop payloads
- `result/rewards-v2-*.audit.json` / `result/rewards-v3-*.audit.json` — period attribution audit

Artifacts stored in the **private artifacts repo**:

- `storage/**/*.sqlite` — indexed DB chunks (Git LFS)
- `storage/**/manifest.json` — manifests (regular Git)
- `snapshots/owes-detailed-v2.json` — detailed owes v2 (Git LFS)
- `snapshots/owes-detailed-v3.json` — detailed owes v3 (Git LFS)

---

## Available Scripts

```bash
# Build the application
yarn build

# Run linting
yarn lint

# Format code
yarn format

# Generate documentation and market snapshot (README + output.json)
yarn cli:generate:md

# Index users across configured networks (writes updated DB into src/indexer/storage/)
yarn cli:index

# Generate owes snapshots
yarn cli:generate:owes:v2
yarn cli:generate:owes:v3

# Generate period rewards and Merkl airdrop files from ./ranges.json
yarn cli:generate:rewards:v2:merkl
yarn cli:generate:rewards:v3:merkl

# Generate Markdown summary for owes
yarn cli:generate:owes:md

# Retries cli:index (for local full sync)
yarn full-index
```

---

## Add Network

If a market is deployed on a new network/chain, you typically need to add:

1. **Provider entry** (RPC URL + chainId) in `network.config.ts`
2. **Protocol config** for that network (e.g., v2 `comptrollerV2` + reward token, v3 comets / rewards), depending on what your generators/indexer use

Provider entry example:

```ts
{
  network: string, // network name
  chainId: number, // chain ID
  url: string,     // provider URL
}
```

---

## Using This Repository

You can either:

- **Run the scripts locally** to regenerate snapshots and docs, or
- **Consume the committed snapshots** (`output.json`, `owes-*.json`, `REWARDS.md`) produced by GitHub Actions.

Typical local flow (with artifacts synced first if you need indexing/owes):

```bash
yarn cli:generate:md
yarn cli:index
yarn cli:generate:owes:v2
yarn cli:generate:owes:v3
yarn cli:generate:owes:md
```
