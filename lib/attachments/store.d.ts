export declare const IMAGE_MEDIA_TYPES: readonly ["image/png", "image/jpeg", "image/webp", "image/gif"];
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export interface AttachmentInfo {
    readonly attachmentId: string;
    readonly name: string;
    readonly bytes: number;
    readonly kind: 'image' | 'file';
    readonly mediaType?: ImageMediaType;
}
export interface ReadyAttachment {
    readonly info: AttachmentInfo;
    /** Only available while withReady's callback holds the upload's lock. */
    imageData(): Promise<string>;
    stream(signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
export interface UploadStoreOptions {
    /** Trusted host/test configuration, NEVER taken from an RPC payload. */
    parent?: string;
    maxFileBytes?: number;
    maxImageBytes?: number;
    maxReservedBytes?: number;
    maxUploads?: number;
    maxDeviceUploads?: number;
    ttlMs?: number;
    cleanupIntervalMs?: number;
    now?: () => number;
    log?: (message: string) => void;
}
/** Reject path-bearing names, control/bidi characters and Windows special filenames. */
export declare function displayName(value: unknown): string;
export declare function boundedId(value: unknown, label: string): string;
export declare class UploadStore {
    #private;
    private constructor();
    static open(options?: UploadStoreOptions): Promise<UploadStore>;
    get signal(): AbortSignal;
    get capabilities(): {
        version: number;
        maxFileBytes: number;
        maxImageBytes: number;
        maxAttachments: number;
        chunkBytes: number;
        expiresSeconds: number;
        imageMediaTypes: ("image/png" | "image/jpeg" | "image/webp" | "image/gif")[];
    };
    begin(deviceId: string, payload: unknown): Promise<{
        uploadId: string;
        chunkBytes: number;
        offset: 0;
    }>;
    chunk(deviceId: string, payload: unknown): Promise<{
        offset: number;
    }>;
    finish(deviceId: string, payload: unknown): Promise<AttachmentInfo>;
    abort(deviceId: string, payload: unknown): Promise<{
        aborted: true;
    }>;
    /** Once DSH has durably accepted a prompt, its staging copy is no longer needed.
     * Keep failed admissions intact; successful replay is owned by the bridge ledger. */
    releaseAccepted(deviceId: string, sessionId: string, ids: readonly string[]): Promise<void>;
    /** Pin all referenced files until DSH admission finishes; sorted lock order prevents deadlock. */
    withReady<T>(deviceId: string, sessionId: string, ids: readonly string[], use: (items: ReadyAttachment[]) => Promise<T>): Promise<T>;
    cleanup(): Promise<void>;
    dispose(): Promise<void>;
}
