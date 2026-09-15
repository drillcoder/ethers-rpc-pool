export class EndpointReservationUnavailableError extends Error {
    public override readonly name = "EndpointReservationUnavailableError";

    public constructor() {
        super("Reserved RPC endpoint is no longer available");
    }
}
