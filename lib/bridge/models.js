import { invokeRemote } from './invoke.js';
import { MethodError } from './method-error.js';
/** Read a string field, or `undefined`. */
function str(source, key) {
    const value = source[key];
    return typeof value === 'string' ? value : undefined;
}
/**
 * Narrow one model row.
 * @param value - the raw catalog entry.
 * @returns the option, or `null` when it carries no id.
 */
function toModel(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const id = str(record, 'id');
    if (id === undefined)
        return null;
    const reasoning = record['reasoning'];
    const rawEfforts = Array.isArray(reasoning?.['efforts']) ? reasoning?.['efforts'] : [];
    const efforts = rawEfforts
        .map((entry) => {
        if (typeof entry !== 'object' || entry === null)
            return null;
        const item = entry;
        const effortId = str(item, 'id');
        if (effortId === undefined)
            return null;
        return {
            id: effortId,
            name: str(item, 'name') ?? effortId,
            ...(str(item, 'description') === undefined ? {} : { description: str(item, 'description') }),
        };
    })
        .filter((entry) => entry !== null);
    const defaultEffort = reasoning === undefined ? undefined : str(reasoning, 'defaultEffort');
    const description = str(record, 'description');
    return {
        id,
        name: str(record, 'name') ?? id,
        ...(description === undefined ? {} : { description }),
        efforts,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
    };
}
/**
 * Read the model catalog.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the catalog, normalised.
 */
export async function modelCatalog(ctx) {
    const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'modelCatalog',
        args: {},
        signal: AbortSignal.timeout(30_000),
    }));
    const fallback = value?.default;
    const defaultSelection = typeof fallback === 'object' && fallback !== null
        ? (() => {
            const record = fallback;
            const provider = str(record, 'provider');
            const model = str(record, 'model');
            if (provider === undefined || model === undefined)
                return null;
            const effort = str(record, 'reasoningEffort');
            return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
        })()
        : null;
    const providers = (value?.groups ?? [])
        .map((group) => {
        if (typeof group !== 'object' || group === null)
            return null;
        const record = group;
        const id = str(record, 'id');
        if (id === undefined)
            return null;
        const models = (Array.isArray(record['models']) ? record['models'] : [])
            .map(toModel)
            .filter((model) => model !== null);
        return { id, name: str(record, 'name') ?? id, models };
    })
        .filter((group) => group !== null);
    const failures = (value?.failures ?? [])
        .map((entry) => {
        if (typeof entry !== 'object' || entry === null)
            return null;
        const record = entry;
        const id = str(record, 'id');
        if (id === undefined)
            return null;
        return {
            id,
            name: str(record, 'name') ?? id,
            message: str(record, 'message') ?? 'unavailable',
        };
    })
        .filter((entry) => entry !== null);
    return { default: defaultSelection, providers, failures };
}
/**
 * Select the model and reasoning effort for one session.
 *
 * The host validates an explicit effort against the exact model before any
 * provider I/O and rejects a bad one rather than clamping it, so the app should
 * only offer efforts the catalog listed for that model.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - target session and the requested route.
 * @returns what the host recorded as selected.
 */
export async function selectModel(ctx, options) {
    const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'selectModel',
        args: {
            request: {
                sessionId: options.sessionId,
                provider: options.provider,
                model: options.model,
                ...(options.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: options.reasoningEffort }),
            },
        },
        signal: AbortSignal.timeout(30_000),
    }));
    const selected = value?.selected;
    if (typeof selected !== 'object' || selected === null) {
        throw new MethodError('REMOTE_ERROR', 'session.selectModel returned no selection');
    }
    const record = selected;
    const provider = str(record, 'provider');
    const model = str(record, 'model');
    if (provider === undefined || model === undefined) {
        throw new MethodError('REMOTE_ERROR', 'session.selectModel returned an unusable selection');
    }
    const effort = str(record, 'reasoningEffort');
    return {
        sessionId: options.sessionId,
        selected: { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    };
}
