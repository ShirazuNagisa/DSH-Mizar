/** What the local Tailscale installation is doing. */
export type TailscaleState = 
/** No CLI found anywhere. */
{
    readonly kind: 'absent';
}
/** Reachable and connected, with at least one IPv4 address. */
 | {
    readonly kind: 'running';
    readonly cli: string;
    readonly ipv4: readonly string[];
}
/** Daemon reachable, tunnel down. `tailscale up` fixes this silently. */
 | {
    readonly kind: 'disconnected';
    readonly cli: string;
    readonly backend: string;
}
/**
 * Reachable, but this node has never authenticated — or its key expired.
 *
 * Kept apart from `disconnected` because it is the one condition nothing
 * silent can fix. Measured behaviour: `tailscale up` against a NeedsLogin node
 * does not return — it waits for a browser sign-in that is never coming, so
 * running it merely stalls the host's startup and then reports a timeout that
 * explains nothing.
 */
 | {
    readonly kind: 'needs-login';
    readonly cli: string;
}
/** Daemon not answering: the app is not running. Needs a launch. */
 | {
    readonly kind: 'daemon-down';
    readonly cli: string;
    readonly detail: string;
}
/** The state could not be established. */
 | {
    readonly kind: 'unknown';
    readonly cli: string;
    readonly detail: string;
};
/**
 * What should be done about a state.
 *
 * The CLI path travels with the action rather than being read back off the
 * state, so a caller that switches on `action` gets a narrowed `cli` and cannot
 * accidentally pair the ramp-up with the wrong state.
 */
export type StartupAction = {
    readonly action: 'none';
    readonly reason: string;
} | {
    readonly action: 'install';
}
/** Run `tailscale up`. No user interface. */
 | {
    readonly action: 'cli-up';
    readonly cli: string;
}
/** Launch the app in the background. */
 | {
    readonly action: 'launch-app';
    readonly cli: string;
}
/** Nothing automatic helps; the operator has to sign in. */
 | {
    readonly action: 'sign-in';
};
/** Where the CLI lives on each platform, in probe order. */
export declare function tailscaleCliCandidates(platform?: NodeJS.Platform): readonly string[];
/** Finds an executable path, or reports that it is not there. */
export type ExistsProbe = (path: string) => boolean;
/** Runs a command and resolves with its stdout. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;
/**
 * The real probe.
 *
 * Bare command names are deliberately *not* treated as present: `existsSync`
 * cannot resolve a `PATH` lookup, and claiming a program exists because its name
 * looks plausible is how you report "installed but not connected" on a machine
 * that has never had it.
 */
export declare const defaultExists: ExistsProbe;
/**
 * The real runner: bounded, and it keeps the diagnostic text.
 *
 * `execFile`'s error message is only `Command failed: <command>`; the sentence
 * that says *why* is on stderr, and a timeout is a flag rather than a message.
 * Both are folded into the error here, because without them every daemon-down
 * case degrades to "state could not be read", which is far worse advice.
 *
 * Measured behaviour worth knowing: with the macOS app installed but not
 * running, `tailscale status --json` does not fail fast — it **hangs**, so the
 * timeout is the only thing that ends it.
 */
export declare const defaultRunner: CommandRunner;
/**
 * Locate the Tailscale CLI.
 * @param platform - the platform to probe for.
 * @param exists - the filesystem probe.
 * @returns the path, or `null` when none is found.
 */
export declare function findTailscaleCli(platform?: NodeJS.Platform, exists?: ExistsProbe): string | null;
/**
 * Read what Tailscale is doing.
 *
 * `status --json` answers in every state once the daemon is reachable, so it is
 * the only probe needed. A failure to run it splits into "daemon not answering"
 * and "something else", and the two are kept apart on purpose: conflating them
 * makes the plugin run `tailscale up` against a daemon that is not there, which
 * hangs rather than fails.
 *
 * @param cli - the CLI path.
 * @param run - the process runner.
 * @returns the observed state.
 */
export declare function readTailscaleState(cli: string, run?: CommandRunner): Promise<TailscaleState>;
/**
 * Decide what to do about a state.
 *
 * Pure, so the decision is testable independently of running anything. The
 * mapping is the point of the module:
 *
 *   - `disconnected` → `tailscale up`, which touches no user interface.
 *   - `daemon-down`  → launch the app, in the background.
 *   - `running` / `unknown` → do nothing. Starting something already running
 *     cannot help, and acting on an unreadable state is guessing.
 *
 * @param state - the observed state.
 * @returns the action to take.
 */
export declare function planStartup(state: TailscaleState): StartupAction;
/**
 * Run `tailscale up`.
 *
 * A pure daemon call: no window, no menu bar, no focus change. This is the
 * correct action whenever the daemon is reachable — and the reason the module
 * separates `disconnected` from `daemon-down`.
 *
 * @param cli - the CLI path.
 * @param run - the process runner.
 * @returns whether it succeeded.
 */
export declare function runTailscaleUp(cli: string, run?: CommandRunner): Promise<{
    ok: boolean;
    detail: string;
}>;
/**
 * Launch the Tailscale app in the background.
 *
 * `open -g` is the whole point on macOS: without it the app is brought to the
 * foreground, which is a visible interruption every time DSH starts. Tailscale
 * is a menu-bar-only app, so even a foreground launch shows no window — but it
 * still takes focus, and that is exactly what "silent" has to mean.
 *
 * @param cli - the CLI path, used where the CLI is itself the entry point.
 * @param run - the process runner.
 * @param platform - the platform to act on.
 * @returns whether the launch was accepted.
 */
export declare function launchTailscaleApp(cli: string, run?: CommandRunner, platform?: NodeJS.Platform): Promise<{
    ok: boolean;
    detail: string;
}>;
/**
 * Carry out a startup plan.
 *
 * @param state - the observed state.
 * @param run - the process runner.
 * @param platform - the platform to act on.
 * @returns whether something was started, so the caller knows to wait again.
 */
export declare function applyStartupPlan(state: TailscaleState, run?: CommandRunner, platform?: NodeJS.Platform): Promise<{
    started: boolean;
    detail: string;
}>;
/** The macOS preferences domain the Tailscale app writes. */
export declare const TAILSCALE_PREF_DOMAIN = "io.tailscale.ipn.macsys";
/** The macOS preference key behind "Launch Tailscale at Login". */
export declare const TAILSCALE_START_ON_LOGIN_KEY = "TailscaleStartOnLogin";
/**
 * Read whether Tailscale is set to start at login.
 *
 * This is the setting that makes later starts genuinely invisible, so it is
 * worth knowing and worth saying out loud. macOS-only: no other platform has the
 * equivalent, and Windows keeps Tailscale in the user session anyway.
 *
 * @param run - the process runner.
 * @param platform - the platform to read on.
 * @returns whether it is enabled, or `null` when it cannot be determined.
 */
export declare function readStartOnLogin(run?: CommandRunner, platform?: NodeJS.Platform): Promise<boolean | null>;
/**
 * Turn on "Launch Tailscale at Login".
 *
 * This modifies another application's preferences, which is a real side effect
 * and the reason the caller has to opt in. It is worth the trade: it is the
 * difference between a menu-bar icon appearing on some mornings and never having
 * to think about Tailscale again.
 *
 * The app reads the setting when it starts, so it takes effect from the next
 * launch — including the one the plugin is about to cause.
 *
 * @param run - the process runner.
 * @param platform - the platform to act on.
 * @returns whether it was written.
 */
export declare function enableStartOnLogin(run?: CommandRunner, platform?: NodeJS.Platform): Promise<{
    ok: boolean;
    detail: string;
}>;
/**
 * A one-line, actionable description of the state.
 * @param state - the observed state.
 * @returns operator-facing text.
 */
export declare function describeTailscaleState(state: TailscaleState): string;
