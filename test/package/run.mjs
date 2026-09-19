import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = path.join(root, "test/package/.tmp");
const projectRoot = path.join(temporaryRoot, "consumer");
const cacheRoot = path.join(temporaryRoot, "npm-cache");
const npmEnvironment = { ...process.env, npm_config_cache: cacheRoot };
const packageName = "@drillcoder/ethers-rpc-pool";
const runtimeExports = [
    "NoUsableRpcEndpointError",
    "OperationTimeoutError",
    "RpcEndpointDataError",
    "RpcPoolClosedError",
    "RpcPoolManager",
    "UnknownNetworkError",
];

await rm(path.join(root, "dist"), { force: true, recursive: true });
await rm(temporaryRoot, { force: true, recursive: true });
await mkdir(projectRoot, { recursive: true });
execFileSync("npm", ["run", "build"], { cwd: root, env: npmEnvironment, stdio: "pipe" });
const stdout = execFileSync("npm", ["pack", "--json", "--pack-destination", temporaryRoot], {
    cwd: root,
    encoding: "utf8",
    env: npmEnvironment,
});
const packResults = JSON.parse(stdout);
assert.equal(packResults.length, 1);
const packResult = packResults[0];
const files = packResult.files.map(({ path: filePath }) => filePath).sort();
const allowedRootFiles = new Set(["LICENSE", "README.md", "README.ru.md", "package.json"]);
assert(files.every((filePath) => allowedRootFiles.has(filePath) || filePath.startsWith("dist/")));
for (const requiredFile of ["dist/index.js", "dist/index.d.ts", "dist/index.d.ts.map", "dist/index.js.map"]) {
    assert(files.includes(requiredFile), `Missing ${requiredFile} from package`);
}

const tarball = path.join(temporaryRoot, packResult.filename);
await writeJson(path.join(projectRoot, "package.json"), {
    name: "package-smoke-consumer",
    private: true,
    type: "module",
});
execFileSync("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball], {
    cwd: projectRoot,
    env: npmEnvironment,
    stdio: "pipe",
});
await symlink(path.join(root, "node_modules/ethers"), path.join(projectRoot, "node_modules/ethers"), "dir");

const installedPackageRoot = path.join(projectRoot, "node_modules/@drillcoder/ethers-rpc-pool");
const installedMetadata = JSON.parse(String(await readFile(path.join(installedPackageRoot, "package.json"), "utf8")));
assert.equal(installedMetadata.name, packageName);
assert.equal(installedMetadata.type, "module");
assert.equal(installedMetadata.main, "./dist/index.js");
assert.equal(installedMetadata.types, "./dist/index.d.ts");
assert.deepEqual(installedMetadata.files, ["dist"]);
assert.deepEqual(installedMetadata.exports, {
    ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
});
assert.equal(installedMetadata.publishConfig.access, "public");

await writeJson(path.join(projectRoot, "tsconfig.json"), {
    compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
    },
    include: ["index.ts"],
});
await writeFile(path.join(projectRoot, "index.ts"), `
import { RpcPoolManager } from "${packageName}";
import type {
    RetryableRpcClient,
    RpcExecutionOptions,
    RpcPoolLoggerEvent,
    RpcPoolManagerConfig,
    RpcPoolSnapshot,
    SingleAttemptRpcClient,
} from "${packageName}";

const config: RpcPoolManagerConfig = {
    networks: [{ chainId: 1, rpcUrls: ["https://rpc.example"] }],
    operationTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
};
const manager = new RpcPoolManager(config);
const values: [
    RetryableRpcClient?,
    RpcExecutionOptions?,
    RpcPoolLoggerEvent?,
    RpcPoolSnapshot?,
    SingleAttemptRpcClient?,
] = [];
void values;
await manager.close();
`);
execFileSync(path.join(root, "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], {
    cwd: projectRoot,
    stdio: "pipe",
});

const publicApi = await import(packageName);
assert.deepEqual(Object.keys(publicApi).sort(), runtimeExports);
const manager = new publicApi.RpcPoolManager({
    networks: [{ chainId: 1, rpcUrls: ["https://rpc.example"] }],
    operationTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
});
await manager.close();
await assert.rejects(
    import(`${packageName}/pool/manager.js`),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
);

const installedFiles = await listFiles(installedPackageRoot);
assert.deepEqual(installedFiles, files);
await rm(temporaryRoot, { force: true, recursive: true });

async function listFiles(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const relativePath = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listFiles(path.join(directory, entry.name), relativePath));
        } else {
            files.push(relativePath);
        }
    }
    return files.sort();
}

async function writeJson(filePath, value) {
    await writeFile(filePath, `${JSON.stringify(value, null, 4)}\n`);
}
