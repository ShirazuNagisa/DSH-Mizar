import type { Context } from '../dsh.js';
import { type PromptResult } from '../bridge/sessions.js';
import { UploadStore } from './store.js';
/** One instance per plugin mount. Reconnection does not discard uploads or request identity. */
export declare class AttachmentBridge {
    #private;
    readonly uploads: UploadStore;
    constructor(ctx: Context, uploads: UploadStore, now?: () => number);
    capabilities(): unknown;
    begin(deviceId: string, payload: unknown): Promise<unknown>;
    prompt(deviceId: string, payload: unknown, mode: 'queue' | 'steer'): Promise<PromptResult>;
    dispose(): Promise<void>;
}
