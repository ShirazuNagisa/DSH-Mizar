/**
 * The delegation notice bridge.
 *
 * The desktop drives a remote DSH agent through MCP. The tool result's first
 * line is `AGI_MIZAR_DELEGATION <id>`, so this bridge can map a delegation back
 * to the session that started it without knowing anything about the MCP tool.
 * When the delegation settles, the desktop sends a `delegation_notice`; this
 * module hands it to the DSH agents service as a settlement follow-up, which is
 * what wakes an idle parent model in a new turn.
 *
 * Everything here is best-effort. A missing `agents` service, an unknown
 * delegation, or a follow-up that throws is logged and dropped; `remote_wait`
 * remains the fallback.
 *
 * @module dsh-mizar/bridge/delegation
 */
import type { Context } from '../dsh.js';
import type { DelegationNoticeFrame } from '../link/frames.js';
export declare class DelegationBridge {
    #private;
    constructor(ctx: Context, log: (message: string) => void);
    /**
     * Watch session events for tool results that carry the marker.
     *
     * The mapping is deliberately session→delegation, not the other way: the
     * marker arrives in a tool result before the notice can, and a notice that
     * lands while the parent is idle must still find its session.
     */
    bind(): () => void;
    /** Deliver one notice from the desktop, if it maps to a live session. */
    deliver(notice: DelegationNoticeFrame): void;
}
