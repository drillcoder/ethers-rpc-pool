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
