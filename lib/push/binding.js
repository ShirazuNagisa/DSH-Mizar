/**
 * Build the binding.
 * @param options - the roster, the notifier and the relay.
 * @returns the binding the bridge calls.
 */
export function createPushBinding(options) {
    /** Every device's stored endpoint, as the transport last saw it. */
    const registrationOf = (deviceId) => {
        const device = options.store.state.devices.find((entry) => entry.deviceId === deviceId);
        const push = device?.push;
        if (device === undefined || push === undefined)
            return null;
        return {
            deviceId,
            token: push.token,
            platform: push.platform,
            environment: push.environment,
            locale: push.locale,
            ...(push.liveActivityToken === undefined ? {} : { liveActivityToken: push.liveActivityToken }),
        };
    };
    return {
        async register(deviceId, input) {
            const known = await options.store.setDevicePush(deviceId, {
                token: input.token,
                platform: input.platform,
                environment: input.environment,
                locale: input.locale,
                updatedAt: Date.now(),
                // Omitted when there is none, which is how `setDevicePush` is told to
                // clear it: this object is the whole record, not a patch.
                ...(input.liveActivityToken === null ? {} : { liveActivityToken: input.liveActivityToken }),
            });
            if (!known) {
                // A device that is not on the roster cannot have got here: every method
                // is behind authentication. Reaching this means the roster changed under
                // a live connection, which is worth saying out loud.
                options.log(`push: ${deviceId} asked to register but is not on the roster`);
                return false;
            }
            const accepted = await options.notifier.register({
                deviceId,
                token: input.token,
                platform: input.platform,
                environment: input.environment,
                locale: input.locale,
                ...(input.liveActivityToken === null ? {} : { liveActivityToken: input.liveActivityToken }),
            });
            // Whether a Live Activity token is held, never the token itself: it is a
            // notification credential, and this log is what support requests quote.
            const activity = input.liveActivityToken === null ? 'live-activity token: none' : 'live-activity token: held';
            // Only the first eight characters of the token, which is enough to tell
            // two registrations apart in a log and not enough to be one.
            options.log(accepted
                ? `push: ${deviceId} registered (${input.platform}, ${input.environment ?? 'no environment'}, ${input.locale}) — ${input.token.slice(0, 8)}…, ${activity}`
                : `push: the relay did not take ${deviceId}'s token (${input.platform}, ${input.environment ?? 'no environment'}) — this phone will not be woken, ${activity}`);
            // The roster keeps the token either way: the relay may be an older build
            // today and accept it after an upgrade, and `republish` hands it over
            // again on the next reconnect. What must not happen is telling the phone
            // its notifications are working when the relay refused them.
            return accepted;
        },
        presence(deviceId, foreground) {
            options.notifier.setForeground(deviceId, foreground);
        },
        async unregister(deviceId) {
            const known = await options.store.setDevicePush(deviceId, null);
            options.notifier.forget(deviceId);
            await options.transport.unregister(deviceId);
            return known;
        },
        async republish() {
            let count = 0;
            for (const device of options.store.state.devices) {
                if (device.revokedAt !== undefined)
                    continue;
                const registration = registrationOf(device.deviceId);
                if (registration === null)
                    continue;
                await options.transport.register(registration);
                count += 1;
            }
            return count;
        },
    };
}
