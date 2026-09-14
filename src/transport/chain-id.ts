import { RpcEndpointDataError } from "../errors/errors.js";
import type { EndpointJsonRpcProvider } from "./provider.js";

export type ChainIdVerificationStatus = "unchecked" | "verified" | "excluded";

function createMismatchMessage(expectedChainId: number, actualChainId: number): string {
    return `RPC endpoint uses chain ID ${String(actualChainId)} instead of expected `
        + `chain ID ${String(expectedChainId)}`;
}

export class RpcChainIdMismatchError extends Error {
    public override readonly name = "RpcChainIdMismatchError";
    public readonly actualChainId: number;
    public readonly excludedReason = "chain-id-mismatch" as const;
    public readonly expectedChainId: number;

    public constructor(expectedChainId: number, actualChainId: number) {
        super(createMismatchMessage(expectedChainId, actualChainId));
        this.expectedChainId = expectedChainId;
        this.actualChainId = actualChainId;
    }
}

function parseChainId(value: unknown): number {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) {
        throw new RpcEndpointDataError("RPC endpoint returned an invalid eth_chainId");
    }

    const chainId = BigInt(value);
    if (chainId <= 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RpcEndpointDataError("RPC endpoint returned an invalid eth_chainId");
    }

    return Number(chainId);
}

export class EndpointChainIdVerifier {
    readonly #expectedChainId: number;
    readonly #provider: EndpointJsonRpcProvider;
    #mismatch: RpcChainIdMismatchError | undefined;
    #verification: Promise<void> | undefined;
    #verified = false;

    public constructor(provider: EndpointJsonRpcProvider, expectedChainId: number) {
        this.#provider = provider;
        this.#expectedChainId = expectedChainId;
    }

    public get status(): ChainIdVerificationStatus {
        if (this.#mismatch !== undefined) {
            return "excluded";
        }

        return this.#verified ? "verified" : "unchecked";
    }

    public async run<Result>(operation: (provider: EndpointJsonRpcProvider) => Promise<Result>): Promise<Result> {
        await this.verify();
        return await operation(this.#provider);
    }

    public async verify(): Promise<void> {
        if (this.#mismatch !== undefined) {
            throw this.#mismatch;
        }

        if (this.#verified) {
            return;
        }

        this.#verification ??= this.#check().catch((error: unknown) => {
            if (!(error instanceof RpcChainIdMismatchError)) {
                this.#verification = undefined;
            }

            throw error;
        });

        await this.#verification;
    }

    async #check(): Promise<void> {
        const actualChainId = parseChainId(await this.#provider.send("eth_chainId", []));
        if (actualChainId !== this.#expectedChainId) {
            this.#mismatch = new RpcChainIdMismatchError(this.#expectedChainId, actualChainId);
            throw this.#mismatch;
        }

        this.#verified = true;
    }
}
