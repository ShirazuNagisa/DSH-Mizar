import { invokeRemote, streamRemote } from '../bridge/invoke.js';
import { upstreamFailure } from '../bridge/errors.js';
import { callService } from '../bridge/service.js';
/** Split `session/list` into its two halves, or `null` when it is not one. */
function splitEndpoint(endpoint) {
    const slash = endpoint.indexOf('/');
    if (slash <= 0 || slash === endpoint.length - 1)
        return null;
    return { namespace: endpoint.slice(0, slash), method: endpoint.slice(slash + 1) };
}
export class Dispatcher {
    #options;
    #streams = new Map();
    #drop = new Set();
    constructor(options) {
        this.#options = options;
    }
    /**
     * Handle one frame from the desktop.
     *
     * Fire-and-forget: a frame that fails produces a `result` frame with `ok:
     * false`, never an exception out of the socket handler.
     *
     * @param frame - a parsed desktop frame.
     */
    handle(frame) {
        switch (frame.type) {
            case 'welcome':
                return;
            case 'invoke':
                void this.#invoke(frame);
                return;
            case 'service':
                void this.#service(frame);
                return;
            case 'cancel': {
                const controller = this.#streams.get(frame.id);
                if (controller === undefined)
                    return;
                controller.abort();
                return;
            }
            case 'answer':
                try {
                    this.#options.broker.answer(frame.id, frame);
                }
                catch (error) {
                    const failure = upstreamFailure(error);
                    this.#options.log(`answer ${frame.id} refused: ${failure.message}`);
                }
                return;
            case 'filter':
                this.#drop = new Set(frame.drop);
                return;
        }
    }
    /** Whether an event name is being filtered out by the desktop. */
    drops(name) {
        return this.#drop.has(name);
    }
    /** Abort every running stream. */
    dispose() {
        for (const controller of this.#streams.values())
            controller.abort();
        this.#streams.clear();
    }
    /** One endpoint call, unary or streamed. */
    async #invoke(frame) {
        const split = splitEndpoint(frame.endpoint);
        if (split === null) {
            this.#failure(frame.id, {
                code: 'MALFORMED_FRAME',
                message: `invoke: "${frame.endpoint}" is not namespace/method`,
            });
            return;
        }
        const args = typeof frame.args === 'object' && frame.args !== null
            ? frame.args
            : {};
        if (frame.mode === 'stream') {
            await this.#stream(frame.id, split, args);
            return;
        }
        try {
            const value = await invokeRemote(this.#options.ctx, {
                namespace: split.namespace,
                method: split.method,
                args,
            });
            this.#options.send({ v: 1, type: 'result', id: frame.id, ok: true, value: value ?? null });
        }
        catch (error) {
            this.#failure(frame.id, upstreamFailure(error));
        }
    }
    /** One streamed endpoint call, pumped until it ends or is cancelled. */
    async #stream(id, split, args) {
        const controller = new AbortController();
        this.#streams.set(id, controller);
        let reason = 'done';
        try {
            const iterable = await streamRemote(this.#options.ctx, {
                namespace: split.namespace,
                method: split.method,
                args,
                signal: controller.signal,
            });
            for await (const item of iterable) {
                if (controller.signal.aborted) {
                    reason = 'cancelled';
                    break;
                }
                this.#options.send({ v: 1, type: 'stream.item', id, value: item ?? null });
            }
            if (controller.signal.aborted)
                reason = 'cancelled';
        }
        catch (error) {
            reason = 'failed';
            this.#failure(id, upstreamFailure(error));
        }
        finally {
            this.#streams.delete(id);
            this.#options.send({ v: 1, type: 'stream.end', id, reason });
        }
    }
    /** One in-process service call. */
    async #service(frame) {
        try {
            const value = await callService(this.#options.ctx, frame.service, frame.method, frame.args, this.#options.services);
            this.#options.send({ v: 1, type: 'result', id: frame.id, ok: true, value: value ?? null });
        }
        catch (error) {
            this.#failure(frame.id, upstreamFailure(error));
        }
    }
    /** Write one failure frame. */
    #failure(id, failure) {
        this.#options.send({
            v: 1,
            type: 'result',
            id,
            ok: false,
            code: failure.code,
            message: failure.message,
            ...(failure.details === undefined ? {} : { details: failure.details }),
        });
    }
}
