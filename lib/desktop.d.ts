/** The desktop product this plugin extends. */
export declare const DESKTOP_CLIENT = "DSH";
/** The operating system's display name. */
export interface DesktopIdentity {
    /** The operating system, in the spelling its maker uses. */
    readonly os: string;
    /** The desktop product, in the spelling its maker uses. */
    readonly client: string;
}
/**
 * Map a Node platform name to something a person reads.
 *
 * Node's `win32` and `darwin` are build-time identifiers, not product names;
 * showing either under a computer's name would look like a leak. Platforms not
 * in the table pass through unchanged rather than being flattened to "Unknown":
 * an operator on FreeBSD is better served by `freebsd` than by a lie.
 *
 * @param value - a `process.platform` value; injected so tests need no OS.
 * @returns the display name.
 */
export declare function desktopOS(value?: string): string;
/**
 * This computer's identity, as `host.info` reports it.
 *
 * @returns the OS and the desktop product.
 */
export declare function desktopIdentity(): DesktopIdentity;
