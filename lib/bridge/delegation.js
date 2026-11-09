import { toWire } from '../link/frames.js';
import { randomUUID } from 'node:crypto';
/** How many delegation→session mappings to keep. */
const MAX_LINKS = 128;
/** How many notice ids to remember for duplicate suppression. */
const MAX_SEEN = 512;
/** The marker the MCP tool writes on its first line. */
const MARKER = /AGI_MIZAR_DELEGATION\s+([A-Za-z0-9._:-]+)/;
export class DelegationBridge {
    #ctx;
    #log;
    #sessions = new Map();
    #seen = new Set();
    constructor(ctx, log) {
        this.#ctx = ctx;
        this.#log = log;
    }
    /**
     * Watch session events for tool results that carry the marker.
     *
     * The mapping is deliberately session→delegation, not the other way: the
     * marker arrives in a tool result before the notice can, and a notice that
     * lands while the parent is idle must still find its session.
     */
    bind() {
        const on = this.#ctx.on;
        if (typeof on !== 'function')
            return () => undefined;
        return on.call(this.#ctx, 'session/event', (session, event) => {
            const id = this.#sessionId(session);
            if (id === null)
                return;
            const match = MARKER.exec(JSON.stringify(toWire(event)));
            if (match === null)
                return;
            this.#remember(match[1], id);
        });
    }
    /** Deliver one notice from the desktop, if it maps to a live session. */
    deliver(notice) {
        if (this.#seen.has(notice.id))
            return;
        this.#seen.add(notice.id);
        while (this.#seen.size > MAX_SEEN) {
            const oldest = this.#seen.values().next().value;
            if (oldest === undefined)
                break;
            this.#seen.delete(oldest);
        }
        const session = this.#sessions.get(notice.delegationId);
        if (session === undefined) {
            this.#log(`delegation notice ${notice.id}: no parent session for ${notice.delegationId}`);
            return;
        }
        const agents = this.#ctx.get?.call(this.#ctx, 'agents');
        const agent = agents?.get?.(session);
        if (typeof agent?.followup !== 'function') {
            this.#log(`delegation notice ${notice.id}: the agents service cannot follow up`);
            return;
        }
        const summary = notice.text.split('\n').find((line) => line.trim() !== '') ?? notice.kind;
        try {
            // The agents service appends the object it receives as the durable
            // `user/message` event data without stamping identity, so the notice must
            // already be a complete identified user message. A bare `{content, source}`
            // fails current-format replay ("lacks an identified message") and makes the
            // whole parent Session unreadable.
            const answer = agent.followup({
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: notice.text }],
                source: {
                    kind: 'subagent-settled',
                    form: 'notice',
                    summary,
                    senderSessionId: notice.delegationId,
                },
            });
            if (answer !== null && typeof answer === 'object' && 'catch' in answer) {
                ;
                answer.catch((error) => {
                    this.#log(`delegation notice ${notice.id}: followup failed — ${String(error)}`);
                });
            }
        }
        catch (error) {
            this.#log(`delegation notice ${notice.id}: followup failed — ${String(error)}`);
        }
    }
    #remember(delegation, session) {
        if (this.#sessions.get(delegation) === session)
            return;
        this.#sessions.set(delegation, session);
        while (this.#sessions.size > MAX_LINKS) {
            const oldest = this.#sessions.keys().next().value;
            if (oldest === undefined)
                break;
            this.#sessions.delete(oldest);
        }
    }
    #sessionId(session) {
        if (session === null || typeof session !== 'object')
            return null;
        const id = session.id;
        return typeof id === 'string' && id !== '' ? id : null;
    }
}
