import { invokeRemote } from './invoke.js';
import { MethodError } from './method-error.js';
/** Read a string field, or `undefined`. */
function str(source, key) {
    const value = source[key];
    return typeof value === 'string' ? value : undefined;
}
/**
 * Narrow one preset option.
 * @param value - the raw option.
 * @returns the option, or `null` when it carries no value.
 */
function toOption(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const id = str(record, 'value');
    if (id === undefined)
        return null;
    const description = str(record, 'description');
    return {
        value: id,
        name: str(record, 'name') ?? id,
        ...(description === undefined ? {} : { description }),
    };
}
/**
 * Read the permission catalog.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the catalog, normalised.
 */
export async function permissionCatalog(ctx) {
    const value = (await invokeRemote(ctx, {
        namespace: 'permissionPresets',
        method: 'catalog',
        args: {},
        signal: AbortSignal.timeout(30_000),
    }));
    const narrow = (input) => (input ?? []).map(toOption).filter((option) => option !== null);
    return {
        options: narrow(value?.options),
        defaults: narrow(value?.defaultOptions),
        defaultPreset: typeof value?.defaultPreset === 'string' ? value.defaultPreset : '',
    };
}
/**
 * Switch one session's permission preset.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - target session and preset id.
 * @returns the command's report.
 * @throws MethodError when the command reports a failure.
 */
export async function setPermissionPreset(ctx, options) {
    const value = (await invokeRemote(ctx, {
        namespace: 'commands',
        method: 'execute',
        args: {
            // `agentId` is a lookup parameter: the gateway resolves it to the session's
            // agent, which is why a SessionId is what travels on the wire.
            agentId: options.sessionId,
            line: `/permission ${options.preset}`,
            submittedAttachments: [],
        },
        signal: AbortSignal.timeout(30_000),
    }));
    const result = value?.result;
    if (typeof result !== 'object' || result === null) {
        throw new MethodError('REMOTE_ERROR', 'commands.execute returned no result');
    }
    const record = result;
    const kind = record['kind'];
    if (kind !== 'success' && kind !== 'error') {
        throw new MethodError('REMOTE_ERROR', 'commands.execute returned an unusable result');
    }
    const text = str(record, 'text');
    if (kind === 'error') {
        throw new MethodError('REMOTE_ERROR', text ?? `permission preset "${options.preset}" was refused`);
    }
    return { commandResult: { kind, ...(text === undefined ? {} : { text }) } };
}
