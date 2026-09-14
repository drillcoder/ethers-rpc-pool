import { describe, expect, it, vi } from "vitest";

import { RpcEndpointDataError } from "../../src/errors/errors.js";
import { EndpointChainIdVerifier, RpcChainIdMismatchError } from "../../src/transport/chain-id.js";
import { classifyRpcTransportError } from "../../src/transport/classification.js";
import { EndpointJsonRpcProvider } from "../../src/transport/provider.js";
import type { HttpRequest } from "../../src/transport/provider.js";

const rpcUrl = "https://rpc.example/";

function createProvider(request: HttpRequest): EndpointJsonRpcProvider {
    return new EndpointJsonRpcProvider(rpcUrl, 1, { request, requestTimeoutMs: 1_000 });
}

function responseForRequest(init: RequestInit, chainId = "0x1"): Response {
    const payload = JSON.parse(init.body as string) as { id: number; method: string };
    const result = payload.method === "eth_chainId" ? chainId : "0x2a";
    return Response.json({ id: payload.id, jsonrpc: "2.0", result });
}

describe("EndpointChainIdVerifier", () => {
    it("checks before use and caches a successful chain ID match", async () => {
        const methods: string[] = [];
        const request = vi.fn<HttpRequest>((_input, init) => {
            const payload = JSON.parse(init.body as string) as { method: string };
            methods.push(payload.method);
            return Promise.resolve(responseForRequest(init));
        });
        const provider = createProvider(request);
        const verifier = new EndpointChainIdVerifier(provider, 1);

        expect(verifier.status).toBe("unchecked");
        await expect(verifier.run(async (verified) => await verified.getBlockNumber())).resolves.toBe(42);
        await expect(verifier.run(async (verified) => await verified.getBlockNumber())).resolves.toBe(42);

        expect(methods).toEqual(["eth_chainId", "eth_blockNumber"]);
        expect(verifier.status).toBe("verified");
        provider.destroy();
    });

    it("shares one in-flight check between concurrent first users", async () => {
        let requestId = 0;
        let resolveRequest: (response: Response) => void = () => undefined;
        const request = vi.fn<HttpRequest>(
            (_input, init) =>
                new Promise((resolve) => {
                    const payload = JSON.parse(init.body as string) as { id: number; method: string };
                    requestId = payload.id;
                    resolveRequest = resolve;
                    expect(payload.method).toBe("eth_chainId");
                }),
        );
        const provider = createProvider(request);
        const verifier = new EndpointChainIdVerifier(provider, 1);

        const first = verifier.verify();
        const second = verifier.verify();
        await vi.waitFor(() => {
            expect(request).toHaveBeenCalledOnce();
        });
        resolveRequest(Response.json({ id: requestId, jsonrpc: "2.0", result: "0x1" }));

        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(request).toHaveBeenCalledOnce();
        provider.destroy();
    });

    it("permanently excludes a mismatched endpoint without another request", async () => {
        const request = vi.fn<HttpRequest>((_input, init) => Promise.resolve(responseForRequest(init, "0x2")));
        const operation = vi.fn<() => Promise<void>>(() => Promise.resolve());
        const provider = createProvider(request);
        const verifier = new EndpointChainIdVerifier(provider, 1);
        const mismatch = new RpcChainIdMismatchError(1, 2);

        await expect(verifier.run(operation)).rejects.toEqual(mismatch);
        await expect(verifier.verify()).rejects.toEqual(mismatch);

        expect(mismatch.excludedReason).toBe("chain-id-mismatch");
        expect(verifier.status).toBe("excluded");
        expect(operation).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledOnce();
        provider.destroy();
    });

    it("does not cache a temporary check failure and exposes it to normal classification", async () => {
        const failure = new TypeError("connection reset");
        const request = vi
            .fn<HttpRequest>()
            .mockRejectedValueOnce(failure)
            .mockImplementationOnce((_input, init) => Promise.resolve(responseForRequest(init)));
        const provider = createProvider(request);
        const verifier = new EndpointChainIdVerifier(provider, 1);

        await expect(verifier.verify()).rejects.toBe(failure);
        expect(classifyRpcTransportError(failure)).toMatchObject({
            action: "cooldown",
            category: "network",
        });
        expect(verifier.status).toBe("unchecked");
        await expect(verifier.verify()).resolves.toBeUndefined();

        expect(verifier.status).toBe("verified");
        expect(request).toHaveBeenCalledTimes(2);
        provider.destroy();
    });

    it.each([null, 1, "1", "0x", "0x0", "0x20000000000000"])(
        "rejects invalid eth_chainId value %s without caching it",
        async (chainId) => {
            const request = vi.fn<HttpRequest>((_input, init) =>
                Promise.resolve(responseForRequest(init, chainId as string)),
            );
            const provider = createProvider(request);
            const verifier = new EndpointChainIdVerifier(provider, 1);

            await expect(verifier.verify()).rejects.toBeInstanceOf(RpcEndpointDataError);
            expect(verifier.status).toBe("unchecked");

            provider.destroy();
        },
    );
});
