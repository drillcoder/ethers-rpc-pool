import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

const readmes = await Promise.all([
    readFile(path.join(installedPackageRoot, "README.md"), "utf8"),
    readFile(path.join(installedPackageRoot, "README.ru.md"), "utf8"),
]);
const readmeExamples = readmes.map(extractTypeScriptExamples);
assert(readmeExamples.every((examples) => examples.length > 0));
for (const examples of readmeExamples) {
    for (const { code } of examples) {
        const result = ts.transpileModule(code, {
            compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
            reportDiagnostics: true,
        });
        assert.equal(
            result.diagnostics?.filter(({ category }) => category === ts.DiagnosticCategory.Error).length ?? 0,
            0,
        );
    }
}
const runnableExamples = readmeExamples.map((examples) => examples.filter(({ runnable }) => runnable));
assert(runnableExamples.every((examples) => examples.length === 1));
assert.equal(runnableExamples[0][0].code, runnableExamples[1][0].code);

await writeJson(path.join(projectRoot, "tsconfig.json"), {
    compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        outDir: "compiled",
        strict: true,
        target: "ES2022",
    },
    include: ["*.ts"],
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
const readmeServer = createReadmeRpcServer();
readmeServer.listen(0, "127.0.0.1");
await once(readmeServer, "listening");
const readmeAddress = readmeServer.address();
assert(readmeAddress !== null && typeof readmeAddress === "object");
const readmeExample = runnableExamples[0][0].code.replace(
    "http://127.0.0.1:8545",
    `http://127.0.0.1:${String(readmeAddress.port)}`,
);
await writeFile(path.join(projectRoot, "readme-example.ts"), readmeExample);
execFileSync(path.join(root, "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], {
    cwd: projectRoot,
    stdio: "pipe",
});
try {
    await runReadmeExample();
} finally {
    await new Promise((resolve, reject) => readmeServer.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
    }));
}

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

function extractTypeScriptExamples(readme) {
    return [...readme.matchAll(/^```ts( runnable)?\n([\s\S]*?)^```$/gmu)].map((match) => ({
        code: match[2],
        runnable: match[1] !== undefined,
    }));
}

function createReadmeRpcServer() {
    /**
     * @param {import("node:http").IncomingMessage} request
     * @param {import("node:http").ServerResponse} response
     */
    const handleRequest = (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => {
            const payload = JSON.parse(body);
            const result = payload.method === "eth_chainId" ? "0x1" : "0x2a";
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result }));
        });
    };
    return createServer(handleRequest);
}

async function runReadmeExample() {
    await new Promise((resolve, reject) => {
        execFile(process.execPath, ["compiled/readme-example.js"], { cwd: projectRoot }, (error) => {
            if (error === null) resolve();
            else reject(error);
        });
    });
}
