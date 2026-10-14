/**
 * A bridge failure that already knows its wire code.
 *
 * The listener treats any thrown value carrying a code from
 * {@link ERROR_CODES} as a deliberate answer and everything else as an internal
 * fault. Keeping the class in its own module lets the bridge and the error
 * translator use it without a cycle.
 *
 * @module dsh-mizar/bridge/method-error
 */
import type { ErrorCode } from '../protocol/frames.js';
/** A method failure carrying the code to answer with. */
export declare class MethodError extends Error {
    readonly code: ErrorCode;
    readonly cause?: unknown | undefined;
    /**
     * @param code - the wire failure code.
     * @param message - a log-oriented description; never contains secrets.
     * @param cause - the upstream failure, kept for server-side diagnostics.
     */
    constructor(code: ErrorCode, message: string, cause?: unknown | undefined);
}
/**
 * Assert a request payload is an object.
 * @param payload - the raw payload.
 * @param method - the method name, for the message.
 * @returns the payload as a record.
 * @throws MethodError when the payload is not an object.
 */
export declare function requireObject(payload: unknown, method: string): Record<string, unknown>;
/**
 * Read a required non-empty string field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @param method - the method name, for the message.
 * @returns the value.
 * @throws MethodError when the field is missing or not a string.
 */
export declare function requireString(payload: unknown, key: string, method: string): string;
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
export declare function optionalObject(payload: unknown, method: string): Record<string, unknown>;
/**
 * Read an optional string field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent or not a string.
 */
export declare function optionalString(payload: unknown, key: string): string | undefined;
/**
 * Read an optional boolean field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent.
 */
export declare function optionalBoolean(payload: unknown, key: string): boolean | undefined;
