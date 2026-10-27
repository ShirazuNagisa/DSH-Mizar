import { toWire } from './frames.js';
export class EventFeed {
    #send;
    #logEvents;
    #seq = 0;
    constructor(send, logEvents) {
        this.#send = send;
        this.#logEvents = logEvents;
    }
    /**
     * Subscribe to both feeds.
     *
     * @param ctx - the plugin context; subscriptions leave with it.
     * @returns a disposer, for a mount that stops before the plugin does.
     */
    bind(ctx) {
        const offEvent = ctx.on('session/event', ((session, event) => {
            this.#forward(session, 'session/event', { header: session.header, event });
        }));
        const offProjection = ctx.sessionProjections.onChanged((session, key, value, seq) => {
            this.#forward(session, 'projection/changed', { key, value, seq });
        });
        return () => {
            offEvent();
            offProjection();
        };
    }
    /** Forward one record, allocating its sequence number. */
    #forward(session, name, payload) {
        const frame = {
            v: 1,
            type: 'event',
            seq: (this.#seq += 1),
            at: new Date().toISOString(),
            sessionId: typeof session?.id === 'string' ? session.id : null,
            name,
            payload: toWire(payload),
        };
        if (this.#logEvents) {
            console.log(`[mizar] event ${frame.seq} ${name} ${frame.sessionId ?? '-'}`);
        }
        this.#send(frame);
    }
    /** The sequence number of the last forwarded record. Diagnostics only. */
    get sequence() {
        return this.#seq;
    }
}
