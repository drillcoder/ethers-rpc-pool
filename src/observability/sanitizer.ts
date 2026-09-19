const redacted = "[redacted]";
const sensitivePathSegment = /api[-_]?key|auth|credential|password|secret|token/iu;
const longOpaqueValue = /^(?=[a-z0-9_-]{16,}$)(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9_-]+$/iu;

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
