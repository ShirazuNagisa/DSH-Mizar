import type { Context } from '../dsh.js';
/** Cordis 4 has no required/optional Inject syntax. Read optional services via
 * its documented ctx.get API, as the existing workspace and connection bridges do.
 * Direct property access is only a fallback for plain test/SDK context doubles. */
export declare function optionalService<K extends 'fileUploads' | 'attachments'>(ctx: Context, name: K): Context[K] | undefined;
