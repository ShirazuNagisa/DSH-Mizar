package me.shirazu.dshmizar

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import me.shirazu.dshmizar.push.EXTRA_SESSION_ID
import me.shirazu.dshmizar.push.Notifications
import me.shirazu.dshmizar.ui.MizarTheme
import me.shirazu.dshmizar.ui.RootScreen

/**
 * The single activity.
 *
 * Two entry points land here besides the launcher: a `mizar://pair?...` deep link,
 * which is the same parse path the scanner uses, and a notification tap carrying a
 * session id.
 */
class MainActivity : ComponentActivity() {

    private val model: AppViewModel by viewModels()

    /** A pairing URI the UI has not consumed yet. */
    private var incomingPairUri by mutableStateOf<String?>(null)

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* refused is fine */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Notifications.ensureChannel(this)
        askForNotificationPermission()

        // Only on a cold start: a rotation must not reconnect a second time.
        if (savedInstanceState == null) {
            model.start()
            readIntent(intent)
        }

        setContent {
            MizarTheme {
                RootScreen(
                    model = model,
                    incomingPairUri = incomingPairUri,
                    onPairUriHandled = { incomingPairUri = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readIntent(intent)
    }

    /** Foreground, so the host stops notifying this device about what it is looking at. */
    override fun onStart() {
        super.onStart()
        model.setPresence(true)
    }

    override fun onStop() {
        model.setPresence(false)
        super.onStop()
    }

    private fun readIntent(intent: Intent?) {
        when {
            intent?.dataString?.startsWith("mizar://") == true -> incomingPairUri = intent.dataString
            else -> intent?.getStringExtra(EXTRA_SESSION_ID)?.let { model.selectSession(it) }
        }
    }

    /**
     * Ask for notification permission once, where the operator can see why.
     *
     * Below Android 13 there is nothing to ask: the permission is granted at install
     * time, and the app already declares it.
     */
    private fun askForNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
}
