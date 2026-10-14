/** A method failure carrying the code to answer with. */
export class MethodError extends Error {
    code;
    cause;
    /**
     * @param code - the wire failure code.
     * @param message - a log-oriented description; never contains secrets.
     * @param cause - the upstream failure, kept for server-side diagnostics.
     */
    constructor(code, message, cause) {
        super(message);
        this.code = code;
        this.cause = cause;
        this.name = 'MethodError';
    }
}
/**
 * Assert a request payload is an object.
 * @param payload - the raw payload.
 * @param method - the method name, for the message.
 * @returns the payload as a record.
 * @throws MethodError when the payload is not an object.
 */
export function requireObject(payload, method) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new MethodError('MALFORMED_FRAME', `${method}: payload must be an object`);
    }
    return payload;
}
/**
 * Read a required non-empty string field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @param method - the method name, for the message.
 * @returns the value.
 * @throws MethodError when the field is missing or not a string.
 */
export function requireString(payload, key, method) {
    const record = requireObject(payload, method);
    const value = record[key];
    if (typeof value !== 'string' || value === '') {
        throw new MethodError('MALFORMED_FRAME', `${method}: payload."${key}" must be a non-empty string`);
    }
    return value;
}
/**
 * Assert a request payload is an object, or absent.
 *
 * For methods whose arguments are all optional, an absent payload is a valid
 * "use the defaults" call. A payload of the wrong *type* is not: silently
 * degrading garbage to "no arguments" turns a client bug into a real side
 * effect — a `session.create` with a string payload would otherwise create a
 * session instead of reporting the mistake.
 *
 * @param payload - the raw payload.
 * @param method - the method name, for the message.
 * @returns the payload as a record, or an empty record when it was absent.
 * @throws MethodError when the payload is present but not an object.
 */
export function optionalObject(payload, method) {
    if (payload === undefined || payload === null)
        return {};
    return requireObject(payload, method);
}
/**
 * Read an optional string field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent or not a string.
 */
export function optionalString(payload, key) {
    if (typeof payload !== 'object' || payload === null)
        return undefined;
    const value = payload[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/**
 * Read an optional boolean field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent.
 */
export function optionalBoolean(payload, key) {
    if (typeof payload !== 'object' || payload === null)
        return undefined;
    const value = payload[key];
    return typeof value === 'boolean' ? value : undefined;
}
