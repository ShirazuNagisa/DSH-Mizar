/**
 * Create (if needed) and secure one staging directory for the current user.
 *
 * The directory is created first when absent, because the ACL reset below is
 * what makes it private — creating it already-secured avoids a window in which
 * an inherited-ACL directory exists.
 *
 * @param path - the directory to create and secure.
 * @throws when the directory cannot be created or its ACL cannot be secured
 *   and verified; the caller must not write bytes into it afterwards.
 */
export declare function makePrivateDirectory(path: string): Promise<void>;
