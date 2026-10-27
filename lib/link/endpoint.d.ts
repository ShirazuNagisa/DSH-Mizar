/** What the desktop publishes. */
export interface Endpoint {
    /** The loopback port its link server listens on. */
    readonly port: number;
    /** The token this launch accepts. */
    readonly token: string;
    /** The desktop's process id, when it wrote one. Advisory only. */
    readonly pid?: number;
}
/**
 * Resolve a leading `~` to the user's home directory.
 *
 * `node:fs` does not expand it, and the default configuration is written the way
 * a person writes a path.
 *
 * @param file - a path that may start with `~`.
 * @returns an absolute path.
 */
export declare function expandHome(file: string): string;
/**
 * Read and validate the endpoint file.
 *
 * Every failure — missing, unreadable, malformed, out of range — is the same
 * answer: `null`, meaning "there is no desktop to dial right now". The caller
 * retries; it must not distinguish these cases, because they are all transient
 * (the desktop is starting, restarting, or was never installed).
 *
 * @param file - the configured path, possibly with `~`.
 * @returns the endpoint, or `null` when there is not a usable one.
 */
export declare function readEndpoint(file: string): Promise<Endpoint | null>;
