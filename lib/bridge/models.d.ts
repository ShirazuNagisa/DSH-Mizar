/**
 * Model catalog and reasoning effort.
 *
 * The catalog the app renders comes from `session/modelCatalog`, which is the
 * same call the shipped web UI makes. One trap matters here: the client-facing
 * catalog carries **no context window**. Capacity is only known per session,
 * from the `contextPressure` projection, so the app must take the window from
 * the usage frame rather than from the model row — which is also why
 * `bridge/stats.ts` reports it there.
 *
 * @module dsh-mizar/bridge/models
 */
import type { Context } from '../dsh.js';
/** One reasoning level a model accepts. */
export interface ReasoningEffortOption {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
/** One selectable model. */
export interface ModelOption {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    /**
     * The reasoning levels this model accepts, in the provider's order.
     *
     * A model with no levels takes no `reasoningEffort`; sending one is a hard
     * error upstream, not something that gets clamped.
     */
    readonly efforts: readonly ReasoningEffortOption[];
    /** The level the provider applies when none is chosen. */
    readonly defaultEffort?: string;
}
/** One provider and its models. */
export interface ProviderGroup {
    readonly id: string;
    readonly name: string;
    readonly models: readonly ModelOption[];
}
/** A provider that could not be listed. */
export interface CatalogFailure {
    readonly id: string;
    readonly name: string;
    readonly message: string;
}
/** The complete catalog the app renders. */
export interface ModelCatalogView {
    /** The route a new session would use. */
    readonly default: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    } | null;
    /** Every provider with at least one model. */
    readonly providers: readonly ProviderGroup[];
    /** Providers that failed to enumerate; shown rather than hidden. */
    readonly failures: readonly CatalogFailure[];
}
/**
 * Read the model catalog.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the catalog, normalised.
 */
export declare function modelCatalog(ctx: Context): Promise<ModelCatalogView>;
/** The outcome of selecting a model for a session. */
export interface SelectModelResult {
    readonly sessionId: string;
    readonly selected: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
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
export declare function selectModel(ctx: Context, options: {
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
}): Promise<SelectModelResult>;
