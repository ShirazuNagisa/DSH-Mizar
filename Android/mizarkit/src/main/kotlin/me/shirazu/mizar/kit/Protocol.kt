package me.shirazu.mizar.kit

/**
 * Protocol v1 constants.
 *
 * These mirror `src/protocol/frames.ts` on the host side. They are constants
 * rather than configuration because they are the contract: a client that lets
 * the paths be configured is a client that can be pointed at a host it cannot
 * speak to.
 */
const val MIZAR_PROTOCOL_VERSION: Int = 1

/** The WebSocket path, below the authority or the relay's room path. */
const val MIZAR_WEBSOCKET_PATH: String = "/mizar/v1/ws"

/** The HTTP prefix every unauthenticated route lives under. */
const val MIZAR_HTTP_PREFIX: String = "/mizar/v1"

/** `GET` — host identity; unauthenticated, used before pairing. */
const val MIZAR_HELLO_PATH: String = "$MIZAR_HTTP_PREFIX/hello"

/** `POST` — redeem a pairing code for a device token; single use. */
const val MIZAR_PAIR_PATH: String = "$MIZAR_HTTP_PREFIX/pair"

/**
 * Every error code the protocol defines.
 *
 * `RESPONSE_TOO_LARGE` was missing from the Swift client even though the host
 * emits it, which is exactly the kind of gap that turns "the reply vanished" into
 * a bug hunt — it is listed here.
 */
enum class MizarErrorCode(val wire: String) {
    PROTOCOL_VERSION_MISMATCH("PROTOCOL_VERSION_MISMATCH"),
    MALFORMED_FRAME("MALFORMED_FRAME"),
    UNAUTHENTICATED("UNAUTHENTICATED"),
    PAIRING_REQUIRED("PAIRING_REQUIRED"),
    PAIRING_CODE_INVALID("PAIRING_CODE_INVALID"),
    PAIRING_CODE_EXPIRED("PAIRING_CODE_EXPIRED"),
    PAIRING_CODE_UNKNOWN("PAIRING_CODE_UNKNOWN"),
    RATE_LIMITED("RATE_LIMITED"),
    DEVICE_REVOKED("DEVICE_REVOKED"),
    WRITER_HELD("WRITER_HELD"),
    MODEL_UNAVAILABLE("MODEL_UNAVAILABLE"),
    REMOTE_ERROR("REMOTE_ERROR"),
    NOT_IMPLEMENTED("NOT_IMPLEMENTED"),
    INTERNAL("INTERNAL"),
    RESPONSE_TOO_LARGE("RESPONSE_TOO_LARGE"),
    ;

    companion object {
        /** The code with this wire spelling, or `null` when it is one we do not know. */
        fun of(wire: String): MizarErrorCode? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * A protocol error, carrying the host's own code verbatim.
 *
 * The code is a plain `String` rather than the enum: a host that adds a code must
 * produce a client that reports it, not one that fails to decode the frame and
 * silently drops it.
 */
class MizarError(
    val code: String,
    override val message: String,
    val retryable: Boolean = false,
) : Exception(message) {
    /** The code as a known value, or `null` when this build has never heard of it. */
    val known: MizarErrorCode? get() = MizarErrorCode.of(code)

    /**
     * Whether the credential this client holds is no longer usable.
     *
     * The docs promise "clear the local token and go back to pairing" for both of
     * these; the iOS client declares them and never acts on it. Anything that
     * holds a credential is expected to branch on this.
     */
    val requiresRepairing: Boolean
        get() = known == MizarErrorCode.UNAUTHENTICATED || known == MizarErrorCode.DEVICE_REVOKED

    override fun toString(): String = "MizarError($code, $message, retryable=$retryable)"
}
