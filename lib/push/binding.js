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
            environment: push.environment,
            locale: push.locale,
        };
    };
    return {
        async register(deviceId, input) {
            const known = await options.store.setDevicePush(deviceId, {
                token: input.token,
                environment: input.environment,
                locale: input.locale,
                updatedAt: Date.now(),
            });
            if (!known) {
                // A device that is not on the roster cannot have got here: every method
                // is behind authentication. Reaching this means the roster changed under
                // a live connection, which is worth saying out loud.
                options.log(`push: ${deviceId} asked to register but is not on the roster`);
                return false;
            }
            await options.notifier.register({
                deviceId,
                token: input.token,
                environment: input.environment,
                locale: input.locale,
            });
            // Only the first eight characters of the token, which is enough to tell
            // two registrations apart in a log and not enough to be one.
            options.log(`push: ${deviceId} registered (${input.environment}, ${input.locale}) — ${input.token.slice(0, 8)}…`);
            return true;
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
