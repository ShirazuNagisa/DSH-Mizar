package me.shirazu.dshmizar.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import me.shirazu.dshmizar.AppViewModel
import me.shirazu.dshmizar.Phase
import me.shirazu.dshmizar.R
import me.shirazu.dshmizar.UiState
import me.shirazu.mizar.kit.PairingTarget
import me.shirazu.mizar.kit.PairingUri
import me.shirazu.mizar.kit.SessionGrouping
import me.shirazu.mizar.kit.SessionRow

/**
 * The root: a switch on the connection's phase.
 *
 * There is no navigation graph behind this, deliberately. Which screen the operator
 * is on *is* a property of the connection — the app can be unpaired, connecting, or
 * unable to reach a Mac it knows — and modelling that as a route made the two
 * disagree the first time the socket dropped.
 */
@Composable
fun RootScreen(model: AppViewModel, incomingPairUri: String?, onPairUriHandled: () -> Unit) {
    val state by model.state.collectAsState()

    // A scanned or deep-linked URI is handled once, then cleared, so a rotation does
    // not pair a second time with a single-use code.
    if (incomingPairUri != null) {
        PairingUri.parse(incomingPairUri)?.let { target -> model.pair(target, "Android") }
        onPairUriHandled()
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            // Above both screens on purpose: a lost connection matters whether the
            // operator is reading a conversation or looking at the list, and it is
            // shown rather than navigated to so nothing on screen is thrown away.
            if (state.reconnecting) {
                ReconnectingBanner(state.disconnectReason)
            }
            Box(Modifier.weight(1f)) {
                when {
                    state.selectedSessionId != null -> SessionScreen(model, state)
                    else -> HomeScreen(model, state)
                }
            }
        }
    }
}

/**
 * One narrow line saying the socket is being dialled again.
 *
 * Kept to a line because the interesting part is that it goes away: the screen below it
 * is still readable, which is the whole point of retrying instead of failing.
 */
@Composable
private fun ReconnectingBanner(reason: String?) {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, tonalElevation = 3.dp) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
            Column {
                Text(
                    text = stringResource(R.string.reconnecting),
                    style = MaterialTheme.typography.labelLarge,
                )
                if (reason != null) {
                    Text(
                        text = reason,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/** The list, the settings and everything that is not one conversation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(model: AppViewModel, state: UiState) {
    var showingSettings by remember { mutableStateOf(false) }
    var showingNewSession by remember { mutableStateOf(false) }
    var showingPicker by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(state.host?.displayName ?: stringResource(R.string.app_name))
                        if (state.sessions.isNotEmpty()) {
                            Text(
                                text = stringResource(R.string.session_count, state.sessions.size),
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                },
                actions = {
                    if (state.phase == Phase.READY) {
                        IconButton(onClick = { model.refreshSessions() }) {
                            Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.refresh))
                        }
                    }
                    IconButton(onClick = { showingSettings = true }) {
                        Icon(Icons.Default.Settings, contentDescription = stringResource(R.string.settings))
                    }
                },
            )
        },
        bottomBar = {
            // The same card as the conversation draws, and here for a reason measured
            // on the device: an agent blocked on an approval or a question is stopped
            // until somebody answers, and an operator sitting on the session list --
            // which is where a phone spends most of its time -- used to see nothing at
            // all while that happened. The state was already arriving; only this screen
            // was not drawing it.
            state.pending?.let { pending ->
                if (!pending.isEmpty) {
                    InteractionsSection(
                        approvals = pending.approvals,
                        questions = pending.questions,
                        onApproval = { id, outcome -> model.answerApproval(id, outcome) },
                        onQuestions = { callId, answers -> model.answerQuestions(callId, answers) },
                    )
                }
            }
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (state.phase) {
                Phase.LAUNCHING -> Centered { CircularProgressIndicator() }
                Phase.UNPAIRED -> UnpairedScreen(model)
                Phase.CONNECTING -> Centered {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(12.dp))
                        Text(stringResource(R.string.connecting))
                    }
                }

                Phase.READY -> SessionList(
                    state = state,
                    onOpen = { model.selectSession(it) },
                    onNewSession = { showingNewSession = true },
                    onPickHost = { showingPicker = true },
                    onDismissProblem = { model.dismissProblem() },
                    onLoadTitles = { model.loadTitles(it) },
                )

                Phase.FAILED -> FailedScreen(state, onRetry = { model.retry() }, onPairAgain = { model.startPairing() })
            }
        }
    }

    if (showingSettings) {
        SettingsDialog(
            state = state,
            onDismiss = { showingSettings = false },
            onForget = { hostId ->
                showingSettings = false
                model.forget(hostId)
            },
            onAddHost = {
                showingSettings = false
                model.startPairing()
            },
        )
    }

    if (showingNewSession) {
        NewSessionDialog(
            state = state,
            onDismiss = { showingNewSession = false },
            onCreate = { cwd ->
                showingNewSession = false
                model.createSession(cwd)
            },
        )
    }

    if (showingPicker) {
        HostPickerDialog(
            state = state,
            onDismiss = { showingPicker = false },
            onOpen = { hostId ->
                showingPicker = false
                model.openHost(hostId)
            },
        )
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

/** Nothing paired yet: the one thing to do is scan the code on the Mac. */
@Composable
private fun UnpairedScreen(model: AppViewModel) {
    var authority by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var deviceName by remember { mutableStateOf("Android") }
    var scanning by remember { mutableStateOf(false) }

    var showManual by remember { mutableStateOf(false) }

    if (scanning) {
        ScannerScreen(
            onCode = { scanned ->
                scanning = false
                PairingUri.parse(scanned)?.let { target -> model.pair(target, deviceName) }
            },
            onCancel = { scanning = false },
        )
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.unpaired_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.unpaired_body), style = MaterialTheme.typography.bodyMedium)

        Button(onClick = { scanning = true }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Default.QrCodeScanner, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.scan_code))
        }

        TextButton(onClick = { showManual = !showManual }) {
            Text(if (showManual) stringResource(R.string.hide_manual) else stringResource(R.string.enter_manually))
        }

        if (showManual) {
            OutlinedTextField(
                value = authority,
                onValueChange = { authority = it },
                label = { Text(stringResource(R.string.host_label)) },
                placeholder = { Text("192.168.1.20:19390") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.uppercase() },
                label = { Text(stringResource(R.string.pairing_code)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text(stringResource(R.string.device_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = { model.pair(PairingTarget(authority = authority.trim(), code = code.trim(), hostName = null, protocolVersion = null, baseUrl = null), deviceName) },
                enabled = authority.isNotBlank() && code.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pair))
            }
        }
    }
}

/** A host that was known and did not answer, or one that no longer knows this phone. */
@Composable
private fun FailedScreen(state: UiState, onRetry: () -> Unit, onPairAgain: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(32.dp))
        Text(
            text = stringResource(
                if (state.needsPairing) R.string.cannot_recognise else R.string.cannot_reach,
            ),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(state.problem ?: stringResource(R.string.cannot_reach_body), style = MaterialTheme.typography.bodyMedium)
        // A refused credential is not something a retry can fix: the same token would be
        // rejected again. Offer the one action that works.
        if (state.needsPairing) {
            Button(onClick = onPairAgain) { Text(stringResource(R.string.pair_again)) }
        } else {
            Button(onClick = onRetry) { Text(stringResource(R.string.retry)) }
        }
        if (state.sessions.isNotEmpty()) {
            // Stored sessions stay readable: an unreachable Mac is not a reason to
            // hide what the phone already knows.
            Text(stringResource(R.string.stored_sessions_kept), style = MaterialTheme.typography.labelMedium)
            SessionList(state = state, onOpen = {}, onNewSession = {}, onPickHost = {}, onDismissProblem = {})
        }
    }
}

/** The workspace-grouped session list. */
@Composable
private fun SessionList(
    state: UiState,
    onOpen: (String) -> Unit,
    onNewSession: () -> Unit,
    onPickHost: () -> Unit,
    onDismissProblem: () -> Unit,
    onLoadTitles: (List<String>) -> Unit = {},
) {
    var expanded by remember { mutableStateOf(setOf<String>()) }
    var limits by remember { mutableStateOf(mapOf<String, Int>()) }

    // Titles are learned one session at a time, and only for the rows about to be
    // drawn: the host reports none for most sessions, so asking about every row of
    // every workspace is a burst of requests for names nobody is looking at.
    val visibleIds = remember(state.groups, expanded, limits) {
        state.groups
            .filter { expanded.contains(it.path) }
            .flatMap { group -> group.sessions.take(limits[group.path] ?: PAGE_SIZE) }
            .map { it.sessionId }
    }
    LaunchedEffect(visibleIds) {
        if (visibleIds.isNotEmpty()) onLoadTitles(visibleIds)
    }

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        state.problem?.let { problem ->
            item {
                Surface(color = MizarColors.WarningFill, modifier = Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(problem, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                        TextButton(onClick = onDismissProblem) { Text(stringResource(R.string.dismiss)) }
                    }
                }
            }
        }

        item {
            ListItem(
                headlineContent = { Text(stringResource(R.string.new_session)) },
                leadingContent = { Icon(Icons.Default.Add, contentDescription = null) },
                modifier = Modifier.clickable { onNewSession() },
            )
        }

        if (state.groups.isEmpty()) {
            item {
                Box(modifier = Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text(stringResource(R.string.no_sessions), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }

        for (group in state.groups) {
            val key = group.path
            val isOpen = expanded.contains(key)
            item(key = "h-$key") {
                ListItem(
                    headlineContent = { Text(group.title, style = MaterialTheme.typography.titleSmall) },
                    supportingContent = { Text(stringResource(R.string.workspace_count, group.sessions.size)) },
                    trailingContent = {
                        Icon(
                            if (isOpen) Icons.Default.KeyboardArrowDown else Icons.Default.KeyboardArrowRight,
                            contentDescription = null,
                        )
                    },
                    modifier = Modifier.clickable {
                        expanded = if (isOpen) expanded - key else expanded + key
                    },
                )
            }
            if (!isOpen) continue

            val limit = limits[key] ?: PAGE_SIZE
            for (session in group.sessions.take(limit)) {
                item(key = session.sessionId) {
                    SessionRowItem(session, state.titles) { onOpen(session.sessionId) }
                }
            }
            if (group.sessions.size > limit) {
                item(key = "m-$key") {
                    TextButton(onClick = { limits = limits + (key to limit + PAGE_SIZE) }) {
                        Text(stringResource(R.string.show_more, group.sessions.size - limit))
                    }
                }
            }
        }

        if (state.hosts.size > 1) {
            item {
                TextButton(onClick = onPickHost) { Text(stringResource(R.string.choose_mac)) }
            }
        }
    }
}

@Composable
private fun SessionRowItem(session: SessionRow, titles: Map<String, String>, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(SessionGrouping.sessionTitle(session, titles)) },
        supportingContent = { Text(Format.relativeTime(session.updatedMillis)) },
        leadingContent = {
            if (session.running) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                Icon(Icons.Default.Computer, contentDescription = null)
            }
        },
        modifier = Modifier.clickable { onClick() },
    )
}

/** Paired Macs, notification state, and the way out. */
@Composable
private fun SettingsDialog(
    state: UiState,
    onDismiss: () -> Unit,
    onForget: (String) -> Unit,
    onAddHost: () -> Unit,
) {
    DialogShell(title = stringResource(R.string.settings), onDismiss = onDismiss) {
        for (host in state.hosts) {
            ListItem(
                headlineContent = { Text(host.displayName) },
                supportingContent = { Text(host.authority ?: host.baseUrl.orEmpty()) },
                trailingContent = {
                    TextButton(onClick = { onForget(host.hostId) }) { Text(stringResource(R.string.forget)) }
                },
            )
        }
        Text(
            text = stringResource(R.string.settings_note),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(16.dp),
        )
        TextButton(onClick = onAddHost, modifier = Modifier.padding(horizontal = 8.dp)) {
            Text(stringResource(R.string.add_mac))
        }
    }
}

/** Pick the machine to open. */
@Composable
private fun HostPickerDialog(state: UiState, onDismiss: () -> Unit, onOpen: (String) -> Unit) {
    DialogShell(title = stringResource(R.string.choose_mac), onDismiss = onDismiss) {
        for (host in state.hosts) {
            ListItem(
                headlineContent = { Text(host.displayName) },
                supportingContent = { Text(host.hostName) },
                trailingContent = {
                    if (host.hostId == state.host?.hostId) {
                        Icon(Icons.Default.Check, contentDescription = null)
                    }
                },
                modifier = Modifier.clickable { onOpen(host.hostId) },
            )
        }
    }
}

/** Start a session in a directory, which the host turns into a workspace. */
@Composable
private fun NewSessionDialog(state: UiState, onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var path by remember { mutableStateOf("") }
    val recent = remember(state.sessions) {
        state.sessions.mapNotNull { it.cwd }.distinct()
    }

    DialogShell(title = stringResource(R.string.new_session), onDismiss = onDismiss) {
        LazyColumn {
            for (directory in recent) {
                item(key = directory) {
                    ListItem(
                        headlineContent = { Text(SessionGrouping.lastComponent(directory)) },
                        supportingContent = {
                            Text(directory, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                        },
                        modifier = Modifier.clickable { onCreate(directory) },
                    )
                }
            }
        }
        OutlinedTextField(
            value = path,
            onValueChange = { path = it },
            label = { Text(stringResource(R.string.directory_label)) },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
        )
        Text(
            text = stringResource(R.string.new_session_note),
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        Button(
            onClick = { onCreate(path.trim()) },
            enabled = path.isNotBlank() && !state.busy,
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            Text(stringResource(R.string.start_session))
        }
    }
}

/** A bottom sheet, with the title and a close button every dialog here wants. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DialogShell(title: String, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = null) }
        }
        content()
        Spacer(Modifier.height(24.dp))
    }
}

/** The QR scanner, or a plain explanation when the camera permission is refused. */
@Composable
private fun ScannerScreen(onCode: (String) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        granted = allowed
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) {
            CameraScanner(onCode = onCode)
        } else {
            Column(
                modifier = Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = stringResource(R.string.camera_needed),
                    color = Color.White,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Spacer(Modifier.height(16.dp))
                Button(onClick = { request.launch(Manifest.permission.CAMERA) }) {
                    Text(stringResource(R.string.allow_camera))
                }
            }
        }

        OutlinedButton(
            onClick = onCancel,
            modifier = Modifier.align(Alignment.TopStart).padding(16.dp),
        ) {
            Icon(Icons.Default.ArrowBack, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.cancel))
        }
    }
}

/** How many rows a workspace shows before it asks. */
private const val PAGE_SIZE = 10
