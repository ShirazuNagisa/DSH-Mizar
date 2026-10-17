package me.shirazu.dshmizar.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import me.shirazu.dshmizar.MainActivity
import java.util.concurrent.TimeUnit

/**
 * This device's FCM registration token.
 *
 * In plain `SharedPreferences`, deliberately, and **not** in the encrypted
 * credential store. A push token is not a secret — the host only needs to hand it to
 * the relay — and Keystore-backed storage survives a reinstall, so a token kept
 * there would be re-registered after the app was reinstalled and the old token had
 * already been retired. This mirrors the iOS client, which keeps it in
 * `UserDefaults` for the same reason.
 */
object PushTokens {

    private const val FILE = "mizar-push"
    private const val KEY = "token"

    /** The token, or `null` when push is not configured or not permitted. */
    fun current(context: Context): String? =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null)

    /** Remember a token, or forget it. */
    fun store(context: Context, token: String?) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().apply {
            if (token == null) remove(KEY) else putString(KEY, token)
        }.apply()
    }

    /**
     * Ask Firebase for this device's token, when a Firebase project is configured.
     *
     * Needed in addition to [MizarMessagingService.onNewToken]: that callback fires on
     * first install and on rotation, but an app whose token was stored before the
     * operator configured push — or whose stored copy was cleared — would otherwise
     * never register, and nothing on screen would say so.
     *
     * @returns the token, or `null` when this build has no Firebase project (no
     *   `google-services.json`), which is the normal case for a checkout built without
     *   one. Never throws: push is a feature, not a startup requirement.
     */
    suspend fun refresh(context: Context): String? {
        val configured = runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)
        if (!configured) return null

        return withContext(Dispatchers.IO) {
            runCatching {
                // `Tasks.await` rather than a Play Services coroutine helper: one
                // blocking call kept on an IO dispatcher beats a dependency for it.
                Tasks.await(FirebaseMessaging.getInstance().token, 15, TimeUnit.SECONDS)
            }.onSuccess { token ->
                if (token.isNotBlank()) store(context, token)
            }.getOrNull()
        }
    }
}

/** The notification channel the relay's `channelId` refers to. */
const val MIZAR_CHANNEL_ID = "mizar-alerts"

/** The extra a notification carries so a tap opens the session it is about. */
const val EXTRA_SESSION_ID = "me.shirazu.dshmizar.sessionId"

/** Notifications, and the channel Android 8+ requires before any can be posted. */
object Notifications {

    /** Create the channel. Idempotent, and safe to call on every launch. */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(MIZAR_CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                MIZAR_CHANNEL_ID,
                "Agent alerts",
                // High: an approval is a blocked agent, and a notification that waits
                // for the next idle moment is a notification that arrives too late.
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Approvals, questions and finished turns"
            },
        )
    }

    /** Show one notification, opening the session it names when tapped. */
    fun show(context: Context, title: String, body: String, sessionId: String?) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (sessionId != null) putExtra(EXTRA_SESSION_ID, sessionId)
        }
        val pending = PendingIntent.getActivity(
            context,
            sessionId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, MIZAR_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()

        // Permission may be refused; a refused notification is not an error worth
        // crashing over, and the in-app cards still show the same information.
        runCatching { NotificationManagerCompat.from(context).notify(sessionId?.hashCode() ?: 1, notification) }
    }
}

/**
 * The Firebase entry point.
 *
 * Firebase is optional at build time: without a `google-services.json` this class is
 * never called, because nothing ever initialises Firebase. It also never *asks*
 * Firebase for anything at startup — a token arrives here, and a token is only
 * useful once the socket is up.
 */
class MizarMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // Stored only. Registration happens on the next connection, which is what
        // makes a token rotation survivable while the app is closed.
        PushTokens.store(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["kind"] ?: "DSH-Mizar"
        val body = message.notification?.body ?: ""
        // Both keys are strings by protocol: FCM refuses a data payload whose values
        // are not, so the host stringifies them.
        val sessionId = message.data["sessionId"]?.takeIf { it.isNotEmpty() }
        Notifications.ensureChannel(this)
        Notifications.show(this, title, body, sessionId)
    }
}
