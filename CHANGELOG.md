# [1.1.0](https://github.com/drillcoder/ethers-rpc-pool/compare/v1.0.0...v1.1.0) (2026-10-13)


### Features

* add parallel transaction broadcast ([36d741d](https://github.com/drillcoder/ethers-rpc-pool/commit/36d741dcf6a5d9c0d1edf972edf0884b66bb2633))

# Changelog

All notable changes to this project are documented in this file. Releases are generated automatically from
Conventional Commits by semantic-release.

## 1.0.0 (2026-09-21)

Initial public release.

- Full ethers v6 `JsonRpcProvider` API with explicit `executeOnce` and `executeWithRetry` modes.
- Endpoint selection based on latency and active operations, with 5% exploration.
- Chain ID verification, failure classification, cooldown and recovery.
- Operation deadlines, cancellation, persistent subscriptions and structured observability.
- ESM and TypeScript declarations for Node.js 22 or newer.
