/**
 * Reading a delivered file off this computer, for the phone's preview page.
 *
 * The protocol had one direction for files — `upload.*`, phone to computer — and
 * a model that delivers a report produced a file the phone could name but never
 * read. This module is the other direction: `file.stat` says what a path is,
 * `file.read` returns a slice of it.
 *
 * Four decisions hold the safety of it:
 *
 *   - **The session's working directory is the fence.** A path is resolved
 *     against the session's own `cwd` (the tool that names deliverables says
 *     relative paths mean exactly that), normalised with `realpath`, and then
 *     required to sit inside the normalised root. That closes `..` and a symlink
 *     that points out of the workspace, in one check that happens *after* the
 *     filesystem has had its say.
 *   - **Outside is one answer, whatever the truth is.** A path that is not
 *     inside the workspace gets `FILE_FORBIDDEN` whether or not it exists:
 *     "there is no file there" and "there is a file you may not read" are the
 *     same sentence to anyone probing for one.
 *   - **A short list of names is refused even inside the workspace.** `.env`,
 *     private keys, `id_rsa`, npm and pip credentials. The model's output is
 *     not trustworthy input — a summary is prose, and prose can be talked into
 *     presenting `~/.ssh/id_ed25519` — so the fence is not only about
 *     directories.
 *   - **No state.** No open handles, no upload-style session, no temp copies:
 *     `file.read` is a pure function of (path, offset, length). A phone that
 *     loses its socket mid-file reconnects and asks for the next slice.
 *
 * Sizes: 32 MiB per file (the same ceiling `upload.begin` applies in the other
 * direction) and 256 KiB per slice, which is 341 KiB of base64 — under the
 * listener's 512 KiB frame budget with room for the envelope.
 *
 * @module dsh-mizar/bridge/files
 */
import type { Context } from '../dsh.js';
/** The largest file the phone may read. */
export declare const MAX_FILE_BYTES: number;
/**
 * The largest slice one `file.read` may ask for.
 *
 * 256 KiB of bytes becomes 341 KiB of base64; the listener refuses a frame over
 * 512 KiB, and the answer still has to fit beside its envelope.
 */
export declare const MAX_CHUNK_BYTES: number;
/** What `file.stat` answers. */
export interface FileStatResult {
    /** The path as the request named it, echoed so a client can match answers to asks. */
    readonly path: string;
    /** The file's name, without its directory. */
    readonly name: string;
    /** Size in bytes. */
    readonly byteSize: number;
    /** Last modification, epoch milliseconds. */
    readonly modifiedAt: number;
    /** The media type this host associates with the extension. */
    readonly mediaType: string;
    /** Whether the app has a viewer for this type. */
    readonly previewable: boolean;
}
/** What `file.read` answers. */
export interface FileReadResult {
    /** Where this slice starts. */
    readonly offset: number;
    /** How many bytes it holds. */
    readonly length: number;
    /** The whole file's size, so a client can show progress without a `stat`. */
    readonly byteSize: number;
    /** The slice, standard base64. */
    readonly data: string;
    /** Whether this slice ends the file. */
    readonly eof: boolean;
}
/**
 * Read one file's facts.
 *
 * @param ctx - a context observing the session gateway.
 * @param payload - `{sessionId, path}`.
 * @returns the file's name, size, modification time and type.
 * @throws MethodError `FILE_UNKNOWN`, `FILE_FORBIDDEN` or `FILE_TOO_LARGE`.
 */
export declare function fileStat(ctx: Context, payload: unknown): Promise<FileStatResult>;
/**
 * Read one slice of a file.
 *
 * @param ctx - a context observing the session gateway.
 * @param payload - `{sessionId, path, offset, length}`.
 * @returns the slice, base64, and whether it was the last one.
 * @throws MethodError `MALFORMED_FRAME` for a bad range, and everything `file.stat` throws.
 */
export declare function fileRead(ctx: Context, payload: unknown): Promise<FileReadResult>;
