/**
 * How this computer describes itself to a phone.
 *
 * The app's computer list shows two small facts under each machine's name: the
 * operating system it runs, and the desktop product the plugin belongs to. Both
 * are known here rather than guessed by the phone, which cannot tell a Windows
 * host from a Linux one once the pairing is offline -- and a plugin is the only
 * side that knows which agent it bridges.
 *
 * The strings are display names, not protocol enums: `macOS`, `Windows`, `DSH`.
 * A value the app does not recognise is still safe to render -- it is one short
 * label in a capsule -- and a new desktop product can appear without a protocol
 * version bump.
 *
 * @module dsh-mizar/desktop
 */
import { platform } from 'node:os'

/** The desktop product this plugin extends. */
export const DESKTOP_CLIENT = 'DSH'

/** The operating system's display name. */
export interface DesktopIdentity {
  /** The operating system, in the spelling its maker uses. */
  readonly os: string
  /** The desktop product, in the spelling its maker uses. */
  readonly client: string
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
export function desktopOS(value: string = platform()): string {
  switch (value) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return value
  }
}

/**
 * This computer's identity, as `host.info` reports it.
 *
 * @returns the OS and the desktop product.
 */
export function desktopIdentity(): DesktopIdentity {
  return { os: desktopOS(), client: DESKTOP_CLIENT }
}
