/** The file holding this install's tunnel secret. */
export declare const IDENTITY_FILE = "tunnel.json";
/**
 * Read this install's tunnel secret, creating one on first run.
 *
 * Generated rather than configured, and generated here rather than by the relay,
 * because the relay must not be the one choosing secrets it will later trust.
 *
 * A file that cannot be written is not fatal: the identity is returned for this
 * process's lifetime, so the tunnel still works and the operator sees a working
 * plugin with a warning. The alternative -- refusing to start -- would turn a
 * read-only home directory into a plugin that does nothing at all.
 *
 * @param stateDir - Mizar's state directory.
 * @param log - where to report a failure to persist.
 * @returns the tunnel secret.
 */
export declare function loadOrCreateTunnelSecret(stateDir: string, log: (message: string) => void): Promise<string>;
