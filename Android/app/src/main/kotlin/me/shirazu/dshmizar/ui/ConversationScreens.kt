package me.shirazu.dshmizar.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import me.shirazu.dshmizar.AppViewModel
import me.shirazu.dshmizar.Phase
import me.shirazu.dshmizar.R
import me.shirazu.dshmizar.UiState
import me.shirazu.mizar.kit.ApprovalOutcome
import me.shirazu.mizar.kit.ConversationItem
import me.shirazu.mizar.kit.ConversationTurn
import me.shirazu.mizar.kit.Markdown
import me.shirazu.mizar.kit.MarkdownStyle
import me.shirazu.mizar.kit.ModelSelection
import me.shirazu.mizar.kit.PendingApproval
import me.shirazu.mizar.kit.PendingQuestion
import me.shirazu.mizar.kit.QuestionAnswer
import me.shirazu.mizar.kit.QuestionItem

/**
 * One conversation: what was said, what is waiting for an answer, and the composer.
 *
 * The running-turn clock ticks here rather than being re-read from the host: an
 * elapsed time is arithmetic on a timestamp that has not changed, and asking the
 * host once a second would put a request behind every visible second.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(model: AppViewModel, state: UiState) {
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var draft by remember { mutableStateOf("") }
    var showingModelPicker by remember { mutableStateOf(false) }
    var showingPermissions by remember { mutableStateOf(false) }
    var showingContext by remember { mutableStateOf(false) }
    var showingCommands by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }

    BackHandler { model.selectSession(null) }

    // The catalogs behind the model and permission sheets. Loaded here rather than
    // when a sheet opens: a sheet that has to fetch before it can draw shows a spinner
    // for as long as the round trip takes, and on the device that looked like a sheet
    // that never loads at all. The model already skips a second fetch.
    LaunchedEffect(state.selectedSessionId) {
        if (state.selectedSessionId != null) model.loadCatalogs()
    }

    // One ticker for every running turn on screen, alive only while this is.
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }

    LaunchedEffect(state.conversation.size) {
        if (state.conversation.isNotEmpty()) listState.animateScrollToItem(state.conversation.size)
    }

    val running = state.sessions.firstOrNull { it.sessionId == state.selectedSessionId }?.running == true

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.stats?.title ?: stringResource(R.string.session)) },
                navigationIcon = {
                    IconButton(onClick = { model.selectSession(null) }) {
                        Icon(Icons.Default.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    IconButton(onClick = { showingPermissions = true }) {
                        Icon(Icons.Default.Lock, contentDescription = stringResource(R.string.permissions))
                    }
                },
            )
        },
        bottomBar = {
            Column(modifier = Modifier.imePadding()) {
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
                ComposerBar(
                    state = state,
                    onModel = { showingModelPicker = true },
                    onContext = { showingContext = true },
                    onCommands = { showingCommands = true },
                )
                Composer(
                    draft = draft,
                    onDraft = { draft = it },
                    running = running,
                    onSend = {
                        val text = draft
                        draft = ""
                        model.sendPrompt(text)
                    },
                    onStop = { model.cancelTurn() },
                )
            }
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when {
                state.loadingConversation && state.conversation.isEmpty() ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

                state.conversation.isEmpty() && state.conversationError != null ->
                    Message(stringResource(R.string.conversation_failed), state.conversationError)

                state.conversation.isEmpty() ->
                    Message(stringResource(R.string.nothing_yet), stringResource(R.string.nothing_yet_body))

                else -> ConversationList(
                    state = state,
                    listState = listState,
                    now = now,
                    onLoadOlder = { scope.launch { model.loadOlder() } },
                )
            }
        }
    }

    if (showingModelPicker) {
        ModelPickerSheet(
            state = state,
            onDismiss = { showingModelPicker = false },
            onChoose = { selection ->
                showingModelPicker = false
                model.setModel(selection)
            },
        )
    }
    if (showingPermissions) {
        PermissionSheet(
            state = state,
            onDismiss = { showingPermissions = false },
            onChoose = { preset ->
                showingPermissions = false
                model.setPermission(preset)
            },
        )
    }
    if (showingContext) {
        ContextSheet(state) { showingContext = false }
    }
    if (showingCommands) {
        CommandSheet(
            onDismiss = { showingCommands = false },
            onCommand = { slash ->
                // Into the draft, then closed: the operator finishes the sentence.
                draft = if (draft.isBlank()) "$slash " else "$draft $slash "
                showingCommands = false
            },
        )
    }
}

@Composable
private fun Message(title: String, body: String) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ConversationList(
    state: UiState,
    listState: androidx.compose.foundation.lazy.LazyListState,
    now: Long,
    onLoadOlder: () -> Unit,
) {
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
        if (!state.exhausted && state.oldestSeq != null) {
            item {
                TextButton(onClick = onLoadOlder, modifier = Modifier.fillMaxWidth()) {
                    if (state.loadingConversation) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(stringResource(R.string.load_earlier))
                }
            }
        }

        if (state.turns.isEmpty()) {
            items(state.conversation, key = { it.id }) { item -> ConversationRow(item) }
        } else {
            items(state.turns, key = { it.id }) { turn -> TurnSection(turn, now, state) }
        }
    }
}

/**
 * One turn.
 *
 * The prompt is always drawn; the steps fold behind a bar **except** for a failed
 * turn, whose failure is the thing the operator needs to see. A running turn shows
 * the bar and no answer, because an answer that has not been written does not exist.
 */
@Composable
private fun TurnSection(turn: ConversationTurn, now: Long, state: UiState) {
    var open by remember(turn.id, turn.endedAtMillis) { mutableStateOf(false) }
    val answer = if (turn.isRunning) null else turn.steps.lastOrNull { it is ConversationItem.Message && it.role == ConversationItem.Role.ASSISTANT }
    val steps = if (answer == null) turn.steps else turn.steps - answer

    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        for (prompt in turn.prompts) ConversationRow(prompt)

        if (turn.isCollapsible) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { open = !open }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (turn.isRunning) {
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                } else {
                    Icon(
                        Icons.Default.Check,
                        contentDescription = null,
                        tint = if (turn.failed) MizarColors.Warning else MaterialTheme.colorScheme.outline,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(summary(turn, now), style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                Text(
                    stringResource(R.string.step_count, turn.steps.size),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }

        if (!turn.isCollapsible || open) {
            for (step in steps) ConversationRow(step, indent = true)
        }

        answer?.let { ConversationRow(it) }
    }
}

/** "Running for 12 s", "Completed in 1 min 4 s", "Unfinished after 3 s". */
@Composable
private fun summary(turn: ConversationTurn, now: Long): String {
    val spelled = Format.duration(turn.elapsedMillis(now))
    return when {
        turn.isRunning -> stringResource(R.string.running_for, spelled ?: "0 s")
        turn.failed -> spelled?.let { stringResource(R.string.unfinished_after, it) }
            ?: stringResource(R.string.unfinished)
        else -> spelled?.let { stringResource(R.string.completed_in, it) }
            ?: stringResource(R.string.completed)
    }
}

/** One item: a message, an activity marker or a failure card. */
@Composable
private fun ConversationRow(item: ConversationItem, indent: Boolean = false) {
    when (item) {
        is ConversationItem.Message -> MessageBubble(item, indent)
        is ConversationItem.Activity -> Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(4.dp).background(MaterialTheme.colorScheme.outline, CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(item.label, style = MaterialTheme.typography.labelSmall)
            Spacer(Modifier.weight(1f))
            item.atMillis?.let {
                Text(Format.clockTime(it), style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
            }
        }

        is ConversationItem.Failure -> Surface(
            color = MizarColors.FailureFill,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        ) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    stringResource(R.string.turn_failed),
                    style = MaterialTheme.typography.labelLarge,
                    color = MizarColors.Failure,
                )
                Spacer(Modifier.height(4.dp))
                SelectionContainer { Text(item.message, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

/** A user turn on the right, everything else on the left. */
@Composable
private fun MessageBubble(item: ConversationItem.Message, indent: Boolean) {
    val isUser = item.role == ConversationItem.Role.USER
    val bubble = if (isUser) {
        MaterialTheme.colorScheme.primary
    } else if (item.role == ConversationItem.Role.SYSTEM) {
        MaterialTheme.colorScheme.surfaceVariant
    } else {
        MaterialTheme.colorScheme.surfaceVariant
    }
    val textColor = if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Surface(color = bubble, shape = RoundedCornerShape(14.dp), modifier = Modifier.fillMaxWidth(0.92f)) {
            Column(Modifier.padding(10.dp)) {
                if (item.role == ConversationItem.Role.SYSTEM) {
                    Text(stringResource(R.string.system_label), style = MaterialTheme.typography.labelSmall, color = textColor)
                }
                SelectionContainer {
                    Text(
                        text = markdown(item.text),
                        style = MaterialTheme.typography.bodyMedium,
                        color = textColor,
                    )
                }
            }
        }
    }
}

/**
 * Markdown, as an `AnnotatedString`.
 *
 * The parser is in the protocol module and returns offsets, so it can be tested on
 * the JVM; this only maps its spans onto Compose styling. A document that could not
 * be parsed is drawn verbatim, which is the fallback that guarantees a half-streamed
 * answer is still readable.
 */
@Composable
private fun markdown(source: String): AnnotatedString {
    val document = remember(source) { Markdown.parse(source) }
    if (document.plain) return AnnotatedString(document.text)

    // Read here, outside the builder: the builder's lambda is not composable, so a
    // theme read inside it is a compile error rather than a styling bug.
    val codeColor = MaterialTheme.colorScheme.onSurface
    val headingSize = MaterialTheme.typography.titleMedium.fontSize
    return remember(document, codeColor, headingSize) {
        buildAnnotatedString {
            append(document.text)
            for (span in document.spans) {
                if (span.end > document.text.length) continue
                val style = when (span.style) {
                    MarkdownStyle.BOLD -> SpanStyle(fontWeight = FontWeight.Bold)
                    MarkdownStyle.ITALIC -> SpanStyle(fontStyle = FontStyle.Italic)
                    MarkdownStyle.CODE, MarkdownStyle.CODE_BLOCK ->
                        SpanStyle(fontFamily = FontFamily.Monospace, color = codeColor)

                    MarkdownStyle.HEADING -> SpanStyle(fontWeight = FontWeight.Bold, fontSize = headingSize)
                    MarkdownStyle.LIST_ITEM -> SpanStyle(fontWeight = FontWeight.Normal)
                    MarkdownStyle.QUOTE -> SpanStyle(fontStyle = FontStyle.Italic)
                    MarkdownStyle.LINK -> SpanStyle(textDecoration = TextDecoration.Underline)
                }
                addStyle(style, span.start, span.end)
            }
        }
    }
}

/** The two pills above the composer, and the command button. */
@Composable
private fun ComposerBar(
    state: UiState,
    onModel: () -> Unit,
    onContext: () -> Unit,
    onCommands: () -> Unit,
) {
    val selection = state.selectedSessionId?.let { state.modelChoice[it] }
    val model = selection?.model ?: state.stats?.model?.next?.model ?: state.stats?.model?.lastUsed?.model
    val effort = selection?.reasoningEffort ?: state.stats?.model?.next?.reasoningEffort
    val label = listOfNotNull(model, effort?.replaceFirstChar { it.uppercase() }).joinToString(" · ")

    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Pill(onClick = onModel, modifier = Modifier.weight(1f, fill = false)) {
            Text(label.ifEmpty { stringResource(R.string.model) }, maxLines = 1, style = MaterialTheme.typography.labelMedium)
        }

        val context = state.stats?.context
        val percent = context?.percent
        Pill(
            onClick = onContext,
            enabled = context != null,
            modifier = Modifier.weight(1f, fill = false),
        ) {
            // An em dash when the host reported no context figure. Rendering a missing
            // projection as `0%` is the one thing this protocol asks clients not to do
            // -- "absent means the capability is not composed, not that its value is
            // zero" -- and it is also just wrong: an empty context is not a full one.
            Text(
                text = if (context == null || percent == null) {
                    stringResource(R.string.context_unknown)
                } else {
                    stringResource(R.string.context_percent, percent)
                },
                style = MaterialTheme.typography.labelMedium,
            )
        }

        Pill(onClick = onCommands, modifier = Modifier.weight(1f, fill = false)) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(stringResource(R.string.commands), maxLines = 1, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun Pill(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(50),
        modifier = modifier.then(
            if (enabled) Modifier.clickable { onClick() } else Modifier,
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) { content() }
    }
}

/** The field, and the one button that is send, stop, or neither. */
@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    running: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(8.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraft,
            placeholder = { Text(stringResource(R.string.composer_hint)) },
            maxLines = 8,
            shape = RoundedCornerShape(19.dp),
            modifier = Modifier.weight(1f),
        )

        val showsStop = running && draft.isBlank()
        val sendEnabled = !showsStop && draft.isNotBlank()
        if (showsStop) {
            IconButton(
                onClick = onStop,
                modifier = Modifier.size(48.dp).background(MizarColors.Failure, CircleShape),
            ) {
                Icon(Icons.Default.Stop, contentDescription = stringResource(R.string.stop), tint = Color.White)
            }
        } else {
            IconButton(
                onClick = onSend,
                enabled = sendEnabled,
                modifier = Modifier
                    .size(48.dp)
                    .background(
                        if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                        CircleShape,
                    ),
            ) {
                Icon(
                    Icons.Default.Send,
                    contentDescription = stringResource(R.string.send),
                    tint = if (sendEnabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.outline,
                )
            }
        }
    }
}

/**
 * What is waiting for an answer.
 *
 * An approval has exactly two outcomes. There is no "always allow": a permission
 * that outlives the request it was granted for is a permission *change*, and that
 * belongs on the permission screen where it is visible and revocable.
 */
@Composable
internal fun InteractionsSection(
    approvals: List<PendingApproval>,
    questions: List<PendingQuestion>,
    onApproval: (String, ApprovalOutcome) -> Unit,
    onQuestions: (String, List<QuestionAnswer>) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        for (approval in approvals) {
            Surface(
                color = MizarColors.WarningFill,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp)
                    .border(1.dp, MizarColors.Warning.copy(alpha = 0.35f), RoundedCornerShape(12.dp)),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        text = stringResource(R.string.wants_to_run, approval.toolName),
                        style = MaterialTheme.typography.titleSmall,
                        color = MizarColors.Warning,
                    )
                    approval.reasonText(java.util.Locale.getDefault().language)?.let {
                        Spacer(Modifier.height(4.dp))
                        Text(it, style = MaterialTheme.typography.bodySmall)
                    }
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = { onApproval(approval.requestId, ApprovalOutcome.REJECTED) },
                            modifier = Modifier.weight(1f),
                        ) { Text(stringResource(R.string.reject)) }
                        Button(
                            onClick = { onApproval(approval.requestId, ApprovalOutcome.ALLOWED_ONCE) },
                            modifier = Modifier.weight(1f),
                        ) { Text(stringResource(R.string.allow_once)) }
                    }
                }
            }
        }

        for (question in questions) {
            QuestionCard(question, onQuestions)
        }
    }
}

@Composable
private fun QuestionCard(question: PendingQuestion, onSubmit: (String, List<QuestionAnswer>) -> Unit) {
    val selected = remember(question.callId) { mutableStateMapOf<String, Set<String>>() }
    val custom = remember(question.callId) { mutableStateMapOf<String, String>() }

    // A question with one option is a confirmation, so it starts answered.
    LaunchedEffect(question.callId) {
        for (item in question.questions) {
            if (item.options.size == 1 && selected[item.id] == null) {
                selected[item.id] = setOf(item.options.first().label)
            }
        }
    }

    val complete = question.questions.all { item ->
        !(selected[item.id].isNullOrEmpty()) || !custom[item.id].isNullOrBlank()
    }
    val planReview = question.questions.any { it.intent?.isPlanReview == true }

    Surface(
        color = MizarColors.InfoFill,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .border(1.dp, MizarColors.Info.copy(alpha = 0.3f), RoundedCornerShape(12.dp)),
    ) {
        Column(Modifier.padding(12.dp)) {
            for (item in question.questions) {
                QuestionBody(
                    item = item,
                    chosen = selected[item.id].orEmpty(),
                    customText = custom[item.id].orEmpty(),
                    onChoose = { label ->
                        val current = selected[item.id].orEmpty()
                        selected[item.id] = when {
                            item.multiSelect && label in current -> current - label
                            item.multiSelect -> current + label
                            label in current -> emptySet()
                            else -> setOf(label)
                        }
                    },
                    onCustom = { custom[item.id] = it },
                )
                Spacer(Modifier.height(8.dp))
            }

            Button(
                onClick = {
                    val answers = question.questions.map { item ->
                        QuestionAnswer(
                            id = item.id,
                            selected = selected[item.id]?.toList().orEmpty(),
                            custom = custom[item.id]?.trim()?.takeIf { it.isNotEmpty() },
                        )
                    }
                    onSubmit(question.callId, answers)
                },
                enabled = complete,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (planReview) stringResource(R.string.approve_plan) else stringResource(R.string.send_answers))
            }
        }
    }
}

@Composable
private fun QuestionBody(
    item: QuestionItem,
    chosen: Set<String>,
    customText: String,
    onChoose: (String) -> Unit,
    onCustom: (String) -> Unit,
) {
    Column {
        item.header?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MizarColors.Info)
        }
        Text(item.question, style = MaterialTheme.typography.titleSmall)
        item.detail?.let {
            Spacer(Modifier.height(2.dp))
            Text(it, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(4.dp))
        for (option in item.options) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { onChoose(option.label) }.padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (item.multiSelect) {
                    Checkbox(checked = option.label in chosen, onCheckedChange = { onChoose(option.label) })
                } else {
                    RadioButton(selected = option.label in chosen, onClick = { onChoose(option.label) })
                }
                Column {
                    Text(option.label, style = MaterialTheme.typography.bodyMedium)
                    option.description?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
                }
            }
        }
        OutlinedTextField(
            value = customText,
            onValueChange = onCustom,
            placeholder = { Text(stringResource(R.string.or_type_your_own)) },
            maxLines = 4,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Choose a model, and then its reasoning effort. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ModelPickerSheet(state: UiState, onDismiss: () -> Unit, onChoose: (ModelSelection) -> Unit) {
    val catalog = state.modelCatalog
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            stringResource(R.string.model),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(16.dp),
        )
        if (catalog == null) {
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            return@ModalBottomSheet
        }
        LazyColumn {
            for (provider in catalog.providers) {
                item(key = "p-${provider.id}") {
                    Text(
                        provider.name,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                items(provider.models, key = { "${provider.id}-${it.id}" }) { option ->
                    ListItem(
                        headlineContent = { Text(option.name) },
                        supportingContent = option.description?.let { { Text(it) } },
                        modifier = Modifier.clickable {
                            onChoose(
                                ModelSelection(
                                    provider = provider.id,
                                    model = option.id,
                                    reasoningEffort = option.defaultEffort ?: option.efforts.firstOrNull()?.id,
                                ),
                            )
                        },
                    )
                }
            }
            // A provider that could not be listed is shown, not hidden: an empty
            // picker with no explanation is a bug report nobody can act on.
            if (catalog.failures.isNotEmpty()) {
                item(key = "failures") {
                    Text(
                        stringResource(R.string.unavailable),
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
                items(catalog.failures, key = { it.id }) { failure ->
                    ListItem(
                        headlineContent = { Text(failure.name) },
                        supportingContent = { Text(failure.message) },
                    )
                }
            }
        }
    }
}

/** Choose a permission preset, with a warning in front of the dangerous one. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PermissionSheet(state: UiState, onDismiss: () -> Unit, onChoose: (String) -> Unit) {
    var confirming by remember { mutableStateOf<String?>(null) }
    val catalog = state.permissionCatalog

    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            stringResource(R.string.permissions),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(16.dp),
        )
        if (catalog == null) {
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@ModalBottomSheet
        }
        LazyColumn {
            items(catalog.options, key = { it.value }) { option ->
                ListItem(
                    headlineContent = { Text(option.name) },
                    supportingContent = option.description?.let { { Text(it) } },
                    leadingContent = {
                        if (option.isDangerous) {
                            Icon(Icons.Default.Lock, contentDescription = null, tint = MizarColors.Failure)
                        }
                    },
                    modifier = Modifier.clickable {
                        if (option.isDangerous) confirming = option.value else onChoose(option.value)
                    },
                )
            }
        }
        Text(
            stringResource(R.string.permission_note),
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(16.dp),
        )
        confirming?.let { preset ->
            Button(
                onClick = { onChoose(preset) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            ) {
                Text(stringResource(R.string.allow_full_access))
            }
        }
    }
}

/** The context breakdown, with an em dash for everything the host did not send. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContextSheet(state: UiState, onDismiss: () -> Unit) {
    val context = state.stats?.context
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            stringResource(R.string.context),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(16.dp),
        )
        if (context == null) {
            Text(
                stringResource(R.string.no_context_figure),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(16.dp),
            )
            return@ModalBottomSheet
        }
        Column(Modifier.padding(horizontal = 16.dp)) {
            Labelled(stringResource(R.string.window), Format.countOrDash(context.window))
            Labelled(stringResource(R.string.pressure), Format.countOrDash(context.pressureTokens))
            Labelled(stringResource(R.string.projected), Format.countOrDash(context.projectedTokens))
            Labelled(stringResource(R.string.percent_full), context.percent?.let { "$it%" } ?: "—")
            context.breakdown?.let { breakdown ->
                Spacer(Modifier.height(8.dp))
                Labelled(stringResource(R.string.system), Format.count(breakdown.systemTokens))
                Labelled(stringResource(R.string.tools), Format.count(breakdown.toolsTokens))
                Labelled(stringResource(R.string.messages), Format.count(breakdown.messageTokens))
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Labelled(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/** The four commands the composer offers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CommandSheet(onDismiss: () -> Unit, onCommand: (String) -> Unit) {
    val commands = listOf(
        "/goal" to R.string.command_goal,
        "/plan" to R.string.command_plan,
        "/compact" to R.string.command_compact,
        "/model" to R.string.command_model,
    )
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            stringResource(R.string.commands),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(16.dp),
        )
        for ((slash, label) in commands) {
            ListItem(
                headlineContent = { Text(stringResource(label)) },
                supportingContent = { Text(slash, fontFamily = FontFamily.Monospace) },
                modifier = Modifier.clickable { onCommand(slash) },
            )
        }
        Spacer(Modifier.height(24.dp))
    }
}
