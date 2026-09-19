import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RpcServerRequest {
    readonly headers: IncomingHttpHeaders;
    readonly payload: unknown;
}

export interface RpcServerResponse {
    disconnect(): void;
    hang(): void;
    json(payload: unknown, options?: RpcServerResponseOptions): void;
}

export interface RpcServerResponseOptions {
    readonly headers?: Readonly<Record<string, string>>;
    readonly status?: number;
}

export type RpcServerHandler = (
    request: RpcServerRequest,
    response: RpcServerResponse,
) => Promise<void> | void;

export interface RpcTestServer {
    readonly requests: readonly RpcServerRequest[];
    readonly url: string;
    close(): Promise<void>;
    enqueue(handler: RpcServerHandler): void;
}

class ResponseController implements RpcServerResponse {
    readonly #request: IncomingMessage;
    readonly #response: ServerResponse;

    constructor(request: IncomingMessage, response: ServerResponse) {
        this.#request = request;
        this.#response = response;
    }

    disconnect(): void {
        this.#request.socket.destroy();
    }

    hang(): void {
        // Intentionally leave the response open until the client aborts or the server closes.
    }

    json(payload: unknown, options: RpcServerResponseOptions = {}): void {
        this.#response.writeHead(options.status ?? 200, {
            "content-type": "application/json",
            ...options.headers,
        });
        this.#response.end(JSON.stringify(payload));
    }
}

class LocalRpcTestServer implements RpcTestServer {
    readonly #handlers: RpcServerHandler[] = [];
    readonly #requests: RpcServerRequest[] = [];
    readonly #server: Server;
    readonly #sockets = new Set<Socket>();
    readonly url: string;

    constructor(server: Server, port: number) {
        this.#server = server;
        this.url = `http://127.0.0.1:${String(port)}/`;

        server.on("connection", (socket) => {
            this.#sockets.add(socket);
            socket.once("close", () => this.#sockets.delete(socket));
        });
        server.on("request", (request, response) => {
            void this.#handle(request, response);
        });
    }

    get requests(): readonly RpcServerRequest[] {
        return this.#requests;
    }

    close(): Promise<void> {
        for (const socket of this.#sockets) {
            socket.destroy();
        }
        return new Promise((resolve, reject) => {
            this.#server.close((error) => {
                if (error === undefined) {
                    resolve();
                } else {
                    reject(error);
                }
            });
        });
    }

    enqueue(handler: RpcServerHandler): void {
        this.#handlers.push(handler);
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            const payload = JSON.parse(await readBody(request)) as unknown;
            const recordedRequest = Object.freeze({ headers: request.headers, payload });
            this.#requests.push(recordedRequest);
            const handler = this.#handlers.shift();
            if (handler === undefined) {
                new ResponseController(request, response).json(
                    { error: "No RPC server handler was queued" },
                    { status: 500 },
                );
                return;
            }
            await handler(recordedRequest, new ResponseController(request, response));
        } catch (error) {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
    }
}

export async function createRpcTestServer(): Promise<RpcTestServer> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return new LocalRpcTestServer(server, address.port);
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString("utf8");
}
