import { MethodError } from './method-error.js';
/**
 * Translate a thrown upstream failure into a wire-level {@link MethodError}.
 *
 * @param error - the value thrown by the bridge call.
 * @returns the error to surface to the client.
 */
export declare function toMethodError(error: unknown): MethodError;
