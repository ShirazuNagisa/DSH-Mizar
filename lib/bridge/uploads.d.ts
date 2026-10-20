/** Bytes per upload chunk. The app sends exactly this except for the last one. */
export declare const CHUNK_BYTES: number;
/** How long an upload or a finished attachment is kept, in milliseconds. */
export declare const UPLOAD_TTL_MS: number;
/** The size and count limits the protocol documents. */
export declare const UPLOAD_LIMITS: {
    /** Largest image, in bytes. */
    readonly imageBytes: number;
    /** Largest file, in bytes. */
    readonly fileBytes: number;
    /** Largest total of all attachments in one prompt, in bytes. */
    readonly promptBytes: number;
    /** Most attachments one prompt may carry. */
    readonly attachments: 8;
    /** Most images one prompt may carry. */
    readonly images: 4;
};
/**
 * Resource quotas the staging area enforces on top of the documented limits.
 *
 * The per-prompt limits bound one message; these bound the desktop. Ported
 * from XEPX2's PR #2. `reservedBytes` is the sum of what live uploads have
 * declared; the reservation ends when the upload completes (its bytes then
 * become an attachment, bounded at prompt time) or expires.
 */
export declare const UPLOAD_QUOTAS: {
    /** Largest total of declared-but-unreceived bytes across all live uploads. */
    readonly reservedBytes: number;
    /** Most uploads in flight, across every device. */
    readonly active: 100;
    /** Most uploads in flight for one device. */
    readonly perDevice: 10;
};
/**
 * Media types DSH accepts as image content.
 *
 * The durable prompt format is a raster image block, so anything else is not an
 * image as far as the model is concerned. Refusing at `upload.begin` costs the
 * phone one clear error; accepting and then failing at prompt time would cost it
 * an upload of up to 10 MiB first.
 */
export declare const IMAGE_MEDIA_TYPES: readonly ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** Whether an upload is a photograph or a document. */
export type UploadKind = 'image' | 'file';
/** `upload.begin` arguments after validation. */
export interface UploadBeginRequest {
    readonly sessionId: string;
    readonly kind: UploadKind;
    readonly name: string;
    readonly mediaType: string;
    readonly byteSize: number;
    /** Lowercase hex SHA-256 of the full payload, when the client declares it. */
    readonly sha256?: string;
}
/** `upload.chunk` arguments after validation. */
export interface UploadChunkRequest {
    readonly uploadId: string;
    readonly index: number;
    /** Canonical base64. */
    readonly data: string;
}
/** What `upload.begin` answers. */
export interface UploadBeginResult {
    readonly uploadId: string;
    readonly chunkBytes: number;
}
/** What `upload.finish` answers. */
export interface UploadFinishResult {
    readonly attachmentId: string;
    readonly kind: UploadKind;
    readonly name: string;
    readonly mediaType: string;
    readonly byteSize: number;
}
/** What `upload.capabilities` answers. */
export interface UploadCapabilities {
    readonly chunkBytes: number;
    readonly imageBytes: number;
    readonly fileBytes: number;
    readonly promptBytes: number;
    readonly attachments: number;
    readonly images: number;
    readonly expiresSeconds: number;
    readonly imageMediaTypes: readonly string[];
    /** Whether the host verifies a client-declared SHA-256. */
    readonly sha256: boolean;
}
/**
 * One finished upload, as the session bridge consumes it.
 *
 * `path` is where the staged bytes are; it disappears with the TTL, so a caller
 * that needs the file to outlive the staging area (the no-`fileUploads`
 * fallback) must call {@link saveFallback} instead of keeping the path.
 */
export interface PromptAttachment {
    readonly attachmentId: string;
    readonly kind: UploadKind;
    readonly name: string;
    readonly mediaType: string;
    readonly byteSize: number;
    /** Absolute path to the staged bytes. */
    readonly path: string;
    /**
     * Copy the bytes under `<stateDir>/attachments` and return the durable path.
     *
     * Used only when the host has no `fileUploads` service: the prompt then names
     * the saved file instead of a receipt, and the path must not be deleted when
     * the staging area is cleaned up.
     */
    saveFallback(): Promise<string>;
}
/** What the store needs to know about where to put things. */
export interface UploadStoreOptions {
    /** `<stateDir>/uploads`; one directory per upload beneath it. */
    readonly root: string;
    /** `<stateDir>/attachments`; where fallback copies go. */
    readonly attachmentsRoot: string;
    /** Overridable for tests and for a deployment that wants a shorter TTL. */
    readonly ttlMs?: number;
    /** Chunk size override, used by tests to keep fixtures small. */
    readonly chunkBytes?: number;
    /** Clock override, used by tests to age an upload without sleeping. */
    readonly now?: () => number;
    /** Largest total of declared bytes across live uploads (tests shrink this). */
    readonly maxReservedBytes?: number;
    /** Most uploads in flight across every device (tests shrink this). */
    readonly maxActiveUploads?: number;
    /** Most uploads in flight for one device (tests shrink this). */
    readonly maxDeviceUploads?: number;
    /**
     * Whether `begin` secures the staging roots before writing (tests pass
     * `false` so a hundred cases do not each spawn the ACL tooling; the real
     * behavior has its own test).
     */
    readonly secureRoots?: boolean;
}
/**
 * Read `upload.begin`'s payload.
 *
 * The bytes are not validated here (only the shape is): whether the length is
 * allowed depends on the kind, which is `UploadStore.begin`'s answer to give so
 * that the code is `UPLOAD_TOO_LARGE` rather than a generic malformed frame.
 *
 * @param payload - the request payload.
 * @returns the parsed arguments.
 * @throws MethodError when the payload is not an object or a field is unusable.
 */
export declare function parseUploadBegin(payload: unknown): UploadBeginRequest;
/**
 * Read `upload.chunk`'s payload.
 *
 * `data` is checked for *type* here and for canonical base64 in the store, so a
 * client bug reports `UPLOAD_BAD_CHUNK` with the chunk's own vocabulary.
 *
 * @param payload - the request payload.
 * @returns the parsed arguments.
 * @throws MethodError when the payload is not an object or a field is unusable.
 */
export declare function parseUploadChunk(payload: unknown): UploadChunkRequest;
/**
 * Enforce the per-prompt size and count limits.
 *
 * A separate function because three places need the same answer: the store when
 * a prompt names attachments, the bridge before it builds content parts, and the
 * tests that pin the numbers. It is about the *declared* metadata only -- the
 * bytes themselves were already bounded at `upload.begin`.
 *
 * @param attachments - what the prompt would carry.
 * @throws MethodError with `ATTACHMENT_TOO_LARGE` when any limit is exceeded.
 */
export declare function enforcePromptLimits(attachments: readonly {
    readonly kind: UploadKind;
    readonly byteSize: number;
    readonly name?: string;
}[]): void;
/**
 * The display name of a content part's file, when it carries one.
 *
 * Durable user messages name the file on `attachment.name`; the request-shaped
 * block the client sent names it on `name`. Both are read so the summary
 * placeholder says `[File: report.pdf]` rather than `[File]` on either shape.
 *
 * @param part - one content part.
 * @returns the name, or `null` when the part carries none.
 */
export declare function filePartName(part: unknown): string | null;
/**
 * Assemble and remember the attachments one phone is uploading.
 *
 * The store is process-lifetime state: an upload is a conversation between one
 * socket and this process, and a restart is exactly the event that should throw
 * away the half-written bytes. The durable output of a finished attachment is
 * its receipt (or, without `fileUploads`, the fallback copy), never this map.
 *
 * Operations are serialized through one promise chain. The listener dispatches
 * each frame independently, so two chunks for one upload may be in flight at the
 * same time; serializing is what keeps the expected index, the byte count and
 * the bytes on disk in agreement.
 */
export declare class UploadStore {
    #private;
    /**
     * @param options - where uploads live and how long they last.
     */
    constructor(options: UploadStoreOptions);
    /**
     * The limits a client should obey, as this store enforces them.
     * @returns the capability record `upload.capabilities` answers with.
     */
    capabilities(): UploadCapabilities;
    /**
     * Begin one upload.
     *
     * The size is checked against the kind's limit here rather than at finish:
     * a phone that picked a 40 MiB video as a "file" learns that before sending
     * forty megabytes, and the answer names the same limit the protocol documents.
     *
     * @param deviceId - the authenticated device starting the upload.
     * @param request - the validated `upload.begin` arguments.
     * @returns the upload id and the exact chunk size to send.
     * @throws MethodError `UPLOAD_TOO_LARGE`, `ATTACHMENT_UNSUPPORTED` or `ATTACHMENT_FAILED`.
     */
    begin(deviceId: string, request: UploadBeginRequest): Promise<UploadBeginResult>;
    /**
     * Accept one chunk.
     *
     * Ordering is part of the contract: the index must be the next one, or one
     * already accepted (idempotent retry). A gap cannot be repaired later because
     * the offsets are the index times the chunk size, so a chunk after a gap would
     * write at a hole that `finish` would then count as received.
     *
     * @param deviceId - the authenticated device sending the chunk.
     * @param request - the validated `upload.chunk` arguments.
     * @returns how many chunks have been received up to and including this index.
     * @throws MethodError `UPLOAD_UNKNOWN`, `UPLOAD_BAD_CHUNK`, `UPLOAD_TOO_LARGE` or `ATTACHMENT_FAILED`.
     */
    chunk(deviceId: string, request: UploadChunkRequest): Promise<{
        received: number;
    }>;
    /**
     * Finish one upload and mint the attachment id a prompt refers to.
     *
     * The byte count is checked rather than the chunk count: a client that sent
     * the right chunks in a different size than declared gets `UPLOAD_INCOMPLETE`,
     * which is the same answer as a dropped tail and the same fix (send it again).
     *
     * @param deviceId - the authenticated device finishing the upload.
     * @param uploadId - the id `upload.begin` returned.
     * @returns the attachment identity.
     * @throws MethodError `UPLOAD_UNKNOWN` or `UPLOAD_INCOMPLETE`.
     */
    finish(deviceId: string, uploadId: string): Promise<UploadFinishResult>;
    /**
     * Discard one unfinished upload.
     *
     * Aborting something already gone is answered as unknown rather than
     * `{aborted: true}`: a client that believes it cleaned up an upload it did not
     * is one that will not investigate a stale file. The bytes go away before the
     * answer, so the next `begin` does not see them.
     *
     * @param deviceId - the authenticated device aborting the upload.
     * @param uploadId - the upload to discard.
     * @returns the acknowledgement.
     * @throws MethodError `UPLOAD_UNKNOWN`.
     */
    abort(deviceId: string, uploadId: string): Promise<{
        aborted: true;
    }>;
    /**
     * Resolve the attachments one prompt names.
     *
     * Every id must belong to this device and this session, and still be within
     * its lifetime. The checks are deliberately indistinguishable from "unknown
     * id": the phone can only react by picking the attachment again, and knowing
     * that another device holds that id would be a fact it must not have.
     *
     * @param deviceId - the authenticated device sending the prompt.
     * @param sessionId - the session receiving the prompt.
     * @param attachmentIds - the ids from the payload, in order.
     * @returns the attachments, in the order given.
     * @throws MethodError `MALFORMED_FRAME`, `ATTACHMENT_UNKNOWN`, `ATTACHMENT_TOO_LARGE` or `ATTACHMENT_UNSUPPORTED`.
     */
    resolveForPrompt(deviceId: string, sessionId: string, attachmentIds: readonly string[]): Promise<PromptAttachment[]>;
}
/**
 * Refuses a `requestId` reused for a different attachment prompt.
 *
 * DSH deduplicates prompts by session and request id: the same key always
 * returns the first answer. For a text prompt that is the client's own
 * idempotency choice; for a prompt that carries attachments, the key plus the
 * content is the contract — the same retry must carry the same text, the same
 * attachments in the same order, the same mode and timezone, from the same
 * device. Anything else is either a client bug or an attempt to borrow another
 * request's acceptance, and it is refused rather than second-guessed.
 *
 * The ledger is memory-only and bounded: at most 1000 keys globally, 100 per
 * device, each forgotten 30 minutes after it was last seen — the same bounds
 * XEPX2's PR #2 chose, for the same reason: a restart is allowed to forget,
 * because DSH's own persistence is the final guard against duplicates.
 */
export declare class PromptReplayGuard {
    #private;
    /**
     * @param now - the clock, overridable for tests.
     */
    constructor(now?: () => number);
    /**
     * Record one attachment prompt, refusing a key reused with different content.
     *
     * @param deviceId - the authenticated device.
     * @param sessionId - the target session.
     * @param requestId - the client's idempotency key.
     * @param content - everything that makes this prompt this prompt.
     * @throws MethodError `ATTACHMENT_INVALID` when the key was seen with a
     *   different device or content.
     * @throws MethodError `UPLOAD_LIMIT_REACHED` when the ledger is full.
     */
    check(deviceId: string, sessionId: string, requestId: string, content: {
        readonly text?: string;
        readonly mode: 'queue' | 'steer';
        readonly clientTimeZone?: string;
        readonly attachmentIds: readonly string[];
    }): void;
}
