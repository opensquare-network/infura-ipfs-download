# Infura IPFS Downloader

Download all pinned CIDs from your Infura IPFS project to local disk.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- An [Infura](https://infura.io/) account with an active IPFS project

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create .env from template
cp .env.example .env
```

Edit `.env` with your Infura credentials:

```env
INFURA_PROJECT_ID=xxxxxxxx
INFURA_PROJECT_SECRET=xxxxxxxx

# Optional
INFURA_PROJECT_NAME=my-project   # folder name, defaults to project ID
CONCURRENCY=3                    # parallel downloads, default 3
IPFS_ENDPOINT=https://ipfs.infura.io/ipfs  # gateway override
```

## Usage

```bash
pnpm start
```

## How it works

1. Fetches all pinned CIDs from Infura via `/api/v0/pin/ls?stream=true` (streaming)
2. Downloads each file concurrently via the Infura IPFS gateway
3. Saves files to `downloads/<project-name>/`
4. On re-run, skips files already on disk (resume support)

## Project structure

```
├── index.js                # entry point
└── src/
    ├── config.js           # env vars, constants
    ├── download.js         # CID download via gateway
    ├── main.js             # orchestration
    ├── infura/
    │   ├── api.js          # Infura API helper
    │   └── pins.js         # fetch pinned CIDs
    └── utils/
        └── ndjson.js       # NDJSON stream parser
```
