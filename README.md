# ethers-rpc-pool

🇬🇧 English | [🇷🇺 Русский](README.ru.md)

A resilient TypeScript JSON-RPC endpoint pool for ethers v6 and Node.js.

## Local quality gate

The complete quality gate requires only Docker on the host. Build the pinned
toolchain image and run its canonical npm `quality` script:

```sh
docker build --tag ethers-rpc-pool-quality .
docker run --rm ethers-rpc-pool-quality
```

The image verifies the exact Node.js and npm versions before installing locked
dependencies with `npm ci`. The `quality` script is the single source of truth
for build, type checking, linting, hermetic tests, coverage, and the package
smoke-test.
