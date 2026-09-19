import { JsonRpcProvider, Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import type { SingleAttemptRpcClient } from "../../src/index.js";
import { createSingleRpcAttempt, SingleRpcCallError } from "../../src/pool/single-attempt-client.js";
import { EndpointReservationUnavailableError } from "../../src/pool/attempt.js";
import { EndpointJsonRpcProvider } from "../../src/transport/provider.js";

function createProvider(): EndpointJsonRpcProvider {
    return new EndpointJsonRpcProvider("https://rpc.example", 1, { requestTimeoutMs: 1_000 });
}

describe("createSingleRpcAttempt", () => {
    it("preserves JsonRpcProvider and Signer compatibility", () => {
        const provider = createProvider();
        const { client } = createSingleRpcAttempt(provider);
        const signer = Wallet.createRandom().connect(client);

        expect(client).toBeInstanceOf(JsonRpcProvider);
        expect(client.provider).toBe(client);
        expect(signer.provider).toBe(client);

        provider.destroy();
    });

    it("guards standard, raw, and broadcast calls", async () => {
        const provider = createProvider();
        const send = vi.spyOn(provider, "send").mockResolvedValue("raw-result");
        const failure = new Error("broadcast failed");
        const broadcast = vi.spyOn(provider, "broadcastTransaction").mockRejectedValue(failure);
        const attempt = createSingleRpcAttempt(provider);

        await expect(attempt.client.send("debug_custom", [1])).resolves.toBe("raw-result");
        await expect(attempt.client.broadcastTransaction("0x01")).rejects.toEqual(new SingleRpcCallError(failure));
        expect(send).toHaveBeenCalledWith("debug_custom", [1]);
        expect(broadcast).toHaveBeenCalledWith("0x01");

        await attempt.deactivate();
        await expect(attempt.client.send("debug_custom", [])).rejects.toThrow(
            "RPC client attempt is no longer active",
        );
        provider.destroy();
    });

    it("rejects a call before transport when its endpoint reservation is stale", async () => {
        const provider = createProvider();
        const send = vi.spyOn(provider, "send");
        const { client } = createSingleRpcAttempt(provider, () => false);

        await expect(client.send("debug_custom", [])).rejects.toBeInstanceOf(EndpointReservationUnavailableError);
        expect(send).not.toHaveBeenCalled();
        provider.destroy();
    });

    it("keeps listeners local to the facade and removes them on deactivation", async () => {
        const provider = createProvider();
        const on = vi.spyOn(provider, "on").mockResolvedValue(provider);
        const off = vi.spyOn(provider, "off").mockResolvedValue(provider);
        const attempt = createSingleRpcAttempt(provider);
        const first = vi.fn();
        const second = vi.fn();

        await expect(attempt.client.on("block", first)).resolves.toBe(attempt.client);
        await expect(attempt.client.once("error", second)).resolves.toBe(attempt.client);
        expect(on).toHaveBeenCalledWith("block", first);

        await attempt.deactivate();
        expect(off).toHaveBeenCalledWith("block", first);
        expect(off).toHaveBeenCalledWith("error", second);
        provider.destroy();
    });

    it("supports facade-local listener removal and late registration cleanup", async () => {
        const provider = createProvider();
        let finishRegistration: (() => void) | undefined;
        const registration = new Promise<void>((resolve) => {
            finishRegistration = resolve;
        });
        const on = vi.spyOn(provider, "on")
            .mockResolvedValueOnce(provider)
            .mockResolvedValueOnce(provider)
            .mockImplementationOnce(async () => {
                await registration;
                return provider;
            });
        const off = vi.spyOn(provider, "off").mockResolvedValue(provider);
        const attempt = createSingleRpcAttempt(provider);
        const first = vi.fn();
        const second = vi.fn();

        await attempt.client.addListener("block", first);
        await attempt.client.removeListener("block", first);
        await attempt.client.off("block", first);
        await attempt.client.on("block", first);
        await attempt.client.removeAllListeners("block");

        const lateRegistration = attempt.client.addListener("error", second);
        const deactivation = attempt.deactivate();
        finishRegistration?.();
        await lateRegistration;
        await deactivation;
        await expect(attempt.client.on("block", first)).rejects.toThrow("RPC client attempt is no longer active");
        await expect(attempt.deactivate()).resolves.toBeUndefined();

        expect(on).toHaveBeenCalledTimes(3);
        expect(off).toHaveBeenCalledWith("error", second);
        provider.destroy();
    });

    it("makes destroy facade-local", async () => {
        const provider = createProvider();
        const destroy = vi.spyOn(provider, "destroy");
        const { client } = createSingleRpcAttempt(provider);

        client.destroy();
        expect(destroy).not.toHaveBeenCalled();
        await expect(client.getBlockNumber()).rejects.toThrow("RPC client attempt is no longer active");

        provider.destroy();
        expect(destroy).toHaveBeenCalledOnce();
    });

    it("wraps synchronous failures and preserves synchronous facade results", () => {
        const provider = createProvider();
        const failure = new Error("synchronous failure");
        const extensions = provider as EndpointJsonRpcProvider & {
            failSynchronously(): never;
            returnProvider(): EndpointJsonRpcProvider;
            returnValue(): number;
        };
        extensions.failSynchronously = () => {
            throw failure;
        };
        extensions.returnProvider = () => provider;
        extensions.returnValue = () => 42;
        const { client } = createSingleRpcAttempt(provider);
        const facade = client as SingleAttemptRpcClient & typeof extensions;

        expect(() => facade.failSynchronously()).toThrow(new SingleRpcCallError(failure));
        expect(facade.returnProvider()).toBe(client);
        expect(facade.returnValue()).toBe(42);
        provider.destroy();
    });

    it("replaces a provider resolved by a generic method with the facade", async () => {
        const provider = createProvider();
        const extensions = provider as EndpointJsonRpcProvider & {
            returnProviderAsync(): Promise<EndpointJsonRpcProvider>;
        };
        extensions.returnProviderAsync = () => Promise.resolve(provider);
        const { client } = createSingleRpcAttempt(provider);
        const facade = client as SingleAttemptRpcClient & typeof extensions;

        await expect(facade.returnProviderAsync()).resolves.toBe(client);
        provider.destroy();
    });
});
