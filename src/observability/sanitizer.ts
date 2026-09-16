const redacted = "[redacted]";
const sensitivePathSegment = /api[-_]?key|auth|credential|password|secret|token/iu;
const longOpaqueValue = /^(?=[a-z0-9_-]{16,}$)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+$/iu;
const urlInText = /https?:\/\/[^\s"'<>]+/giu;
const bearerCredential = /\bbearer\s+[^\s,;]+/giu;
const authorizationCredential = /\bauthorization\b\s*[:=]\s*(?:(?:basic|bearer)\s+)?[^\s,;]+/giu;
const namedCredential = /\b(api[-_]?key|credential|password|secret|token)\b\s*[:=]\s*[^\s,;]+/giu;
const opaqueValueInText = /\b(?=[a-z0-9_-]{16,}\b)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/giu;

function decodePathSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

export function sanitizeEndpointUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return "[invalid-endpoint]";
    }

    const pathname = url.pathname
        .split("/")
        .map((segment) => {
            const decoded = decodePathSegment(segment);
            return sensitivePathSegment.test(decoded) || longOpaqueValue.test(decoded) ? redacted : segment;
        })
        .join("/");

    return `${url.origin}${pathname}`;
}

function sanitizeText(value: string): string {
    return value
        .replace(urlInText, (url) => sanitizeEndpointUrl(url))
        .replace(authorizationCredential, `Authorization=${redacted}`)
        .replace(bearerCredential, `Bearer ${redacted}`)
        .replace(namedCredential, (_match, name: string) => `${name}=${redacted}`)
        .replace(opaqueValueInText, redacted);
}

export interface SanitizedError {
    readonly message: string;
    readonly name: string;
}

export function sanitizeExternalError(error: unknown): Readonly<SanitizedError> {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({ message: sanitizeText(message), name: sanitizeText(name) });
}
