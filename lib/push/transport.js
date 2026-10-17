/**
 * Getting a notification off this machine.
 *
 * The plugin does not talk to Apple. It cannot: sending a push needs the
 * operator's APNs signing key, and a key that ships inside a plugin installed
 * from a public registry is not a key, it is a public string. So the key lives
 * on the relay, which already has one job -- being the address a phone can
 * always reach -- and the plugin's part is to tell it what happened.
 *
 * That is also why this file is a **transport** and not a policy. Deciding what
 * is worth waking somebody for belongs to {@link PushNotifier}; all that lives
 * here is how to say it out loud, and how to fail quietly when the relay is not
 * there.
 *
 * @module dsh-mizar/push/transport
 */
/** A transport that drops everything. The default when no relay is configured. */
export class NoopTransport {
    async register() {
        return false;
    }
    async unregister() { }
    async send() {
        return 0;
    }
}
/** Milliseconds before a push request is abandoned. */
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * The relay's push API.
 *
 * Every call is best-effort. A notification is an announcement about state that
 * is already durable, so a relay that is down must not fail the approval it was
 * announcing -- and it must not throw into a Cordis event handler, where an
 * exception is the plugin's problem rather than the caller's.
 */
export class RelayTransport {
    #options;
    /** Reported once per failure mode, not once per attempt. */
    #complained = new Set();
    constructor(options) {
        this.#options = options;
    }
    /**
     * Post one JSON body to the relay.
     *
     * @param path - the endpoint, from the base.
     * @param body - the JSON body.
     * @param what - a word for the log line when it fails.
     * @returns the decoded reply, or `null` when it could not be had.
     */
    async #post(path, body, what) {
        const base = this.#options.baseURL.replace(/\/+$/, '');
        const url = `${base}${path}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.#options.token}`,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            });
            if (!response.ok) {
                // A relay older than this plugin answers 404 for these paths, which is
                // the normal state during an upgrade and not something to report on
                // every notification.
                const key = `${what}:${response.status}`;
                if (!this.#complained.has(key)) {
                    this.#complained.add(key);
                    this.#options.log(response.status === 404
                        ? `push: this relay has no push API (${what} → 404) — notifications are off until it is updated`
                        : `push: relay refused ${what} with ${response.status}`);
                }
                return null;
            }
            this.#complained.delete(`${what}:${response.status}`);
            return await response.json().catch(() => null);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const key = `${what}:${message}`;
            if (!this.#complained.has(key)) {
                this.#complained.add(key);
                this.#options.log(`push: ${what} failed — ${message}`);
            }
            return null;
        }
    }
    async register(registration) {
        return (await this.#post('/push/v1/register', registration, 'register')) !== null;
    }
    async unregister(deviceId) {
        await this.#post('/push/v1/unregister', { deviceId }, 'unregister');
    }
    async send(message) {
        const reply = (await this.#post('/push/v1/notify', message, 'notify'));
        // A relay that speaks the API but has no signing key answers 200 with
        // `enabled: false`, and silence there is the worst kind: everything looks
        // configured, nothing arrives, and there is no line anywhere to say why.
        if (reply !== null && reply.enabled === false) {
            const key = 'notify:no-key';
            if (!this.#complained.has(key)) {
                this.#complained.add(key);
                this.#options.log('push: the relay has no APNs key or FCM service account configured — notifications are being dropped');
            }
            return 0;
        }
        const sent = reply?.sent;
        return typeof sent === 'number' && Number.isFinite(sent) ? sent : 0;
    }
}
