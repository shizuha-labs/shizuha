import * as cp from 'node:child_process';
import * as vscode from 'vscode';
import { ChatSessionState } from './chat-state.js';
import { chatWebviewHtml } from './chat-webview.js';
import { deactivateWithCleanup, isCurrentCoreBinding, loadOrCreateCoreCapability, trustedLocalCoreEndpoint } from './lifecycle.js';
import { FileDiffHandler, type DiffActionResult } from './file-diff.js';
import { PROVIDER_LABELS, buildProviderConfigWrite, resolveProviderSecretValues, type ProviderSettingsInput } from './provider-settings.js';
import { RunMonitorState, formatStructuredError, type RunLogEntry, type RunMonitorSnapshot, type RunSummary } from './run-monitor.js';
import {
  DEFAULT_LOCAL_CORE_ENDPOINT,
  LOCAL_CORE_PROTOCOL_VERSION,
  LocalCoreClient,
  parseCoreStreamEvent,
  type ConnectionState,
  type LocalCoreMessageRequest,
  type StructuredCoreErrorPayload,
  type WebSocketLike,
} from '../../../src/local-core-protocol.js';

let statusItem: vscode.StatusBarItem | undefined;
let client: LocalCoreClient | undefined;
let sessionId: string | undefined;
let coreProcess: cp.ChildProcess | undefined;
let chatPanel: vscode.WebviewPanel | undefined;
let chatState = new ChatSessionState();
let streamSocket: WebSocketLike | undefined;
let coreCapability: string | undefined;
let connectionGeneration = 0;
let activeStreamAbort: AbortController | undefined;
let activeSubmission: Promise<void> | undefined;
const runMonitor = new RunMonitorState();
let runTree: RunTreeDataProvider | undefined;
const fileDiffHandler = new FileDiffHandler(async (result: DiffActionResult) => {
  // Report diff action result back to the core
  if (client && sessionId === result.sessionId && connectionGeneration === result.connectionGeneration) {
    try {
      await client.applyDiff(result.sessionId, result.filePath, result.action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(`Shizuha: Failed to report diff result to core: ${message}`);
    }
  }
  // Update chat state with the action
  chatState.handleDiffAction(result.diffId, result.action);
  postChatState();
}, () => sessionId, () => connectionGeneration);



type RunTreeNode =
  | { kind: 'section'; id: string; label: string; runs: RunSummary[] }
  | { kind: 'run'; run: RunSummary }
  | { kind: 'log'; entry: RunLogEntry };

class RunTreeDataProvider implements vscode.TreeDataProvider<RunTreeNode> {
  private readonly changed = new vscode.EventEmitter<RunTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private snapshot: RunMonitorSnapshot = runMonitor.snapshot();

  refresh(snapshot = runMonitor.snapshot()) {
    this.snapshot = snapshot;
    this.changed.fire(undefined);
  }

  getTreeItem(element: RunTreeNode): vscode.TreeItem {
    if (element.kind === 'section') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.runs.length}`;
      return item;
    }
    if (element.kind === 'run') {
      const item = new vscode.TreeItem(`${element.run.status} · ${element.run.sessionId}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = element.run.endedAt ? `ended ${element.run.endedAt}` : `started ${element.run.startedAt}`;
      item.tooltip = element.run.error ? formatStructuredError(element.run.error) : `Run ${element.run.id}`;
      item.contextValue = element.run.status === 'running' || element.run.status === 'cancelling' ? 'activeRun' : 'run';
      return item;
    }
    const item = new vscode.TreeItem(element.entry.message, vscode.TreeItemCollapsibleState.None);
    item.description = element.entry.level;
    item.tooltip = [element.entry.at, element.entry.request_id ? `request ${element.entry.request_id}` : '', stringifyDetails(element.entry.details)].filter(Boolean).join('\n');
    item.contextValue = `runLog.${element.entry.level}`;
    return item;
  }

  getChildren(element?: RunTreeNode): RunTreeNode[] {
    if (!element) {
      const active = this.snapshot.current ? [this.snapshot.current] : [];
      return [
        { kind: 'section', id: 'current', label: 'Current Run', runs: active },
        { kind: 'section', id: 'recent', label: 'Recent Runs', runs: this.snapshot.recent },
      ];
    }
    if (element.kind === 'section') return element.runs.map((run) => ({ kind: 'run', run }));
    if (element.kind === 'run') return element.run.logs.map((entry) => ({ kind: 'log', entry }));
    return [];
  }
}

function stringifyDetails(details: unknown): string {
  if (details === undefined) return '';
  if (typeof details === 'string') return details;
  try { return JSON.stringify(details, null, 2); } catch { return String(details); }
}

function refreshRunMonitor(snapshot = runMonitor.snapshot()) {
  runTree?.refresh(snapshot);
}

function workspaceRootUri(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.toString();
}

function config() {
  const cfg = vscode.workspace.getConfiguration('shizuha');
  return {
    endpoint: cfg.get<string>('coreEndpoint') || DEFAULT_LOCAL_CORE_ENDPOINT,
    expectedProtocolVersion: cfg.get<string>('expectedProtocolVersion') || LOCAL_CORE_PROTOCOL_VERSION,
    defaultProvider: cfg.get<string>('defaultProvider') || '',
    defaultModel: cfg.get<string>('defaultModel') || '',
  };
}

function requireTrustedLocalCore(): ReturnType<typeof config> {
  const current = config();
  return {
    ...current,
    endpoint: trustedLocalCoreEndpoint(current.endpoint, vscode.workspace.isTrusted),
  };
}

function setStatus(text: string, tooltip?: string, command?: string) {
  if (!statusItem) return;
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.command = command;
  statusItem.show();
}

function surfaceState(state: ConnectionState) {
  if (state.kind === 'connected') {
    setStatus('$(plug) Shizuha: connected', `Core ${state.health.version}`, 'shizuha.openChat');
    return;
  }
  if (state.kind === 'upgrade_required') {
    setStatus('$(warning) Shizuha: upgrade required', `Extension expects ${state.expected}; core has ${state.actual}`, 'shizuha.retryConnect');
    void vscode.window.showWarningMessage(
      `Shizuha local core protocol mismatch: extension expects ${state.expected}, core reports ${state.actual}. Please upgrade the CLI/core or extension.`,
      'Retry',
    ).then((choice: string | undefined) => { if (choice === 'Retry') void connectOrStart(); });
    return;
  }
  if (state.kind === 'permanent_error') {
    setStatus('$(error) Shizuha: error', state.error.message, 'shizuha.retryConnect');
    void vscode.window.showErrorMessage(`Shizuha core error: ${state.error.message}`);
    return;
  }
  setStatus('$(circle-slash) Shizuha: not connected', state.message, 'shizuha.retryConnect');
}

function startInstalledCore(endpoint: string, capability: string) {
  if (coreProcess && !coreProcess.killed) return;
  const url = new URL(endpoint);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const host = url.hostname || '127.0.0.1';
  coreProcess = cp.spawn('shizuha', ['serve', '--port', port, '--host', host], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SHIZUHA_LOCAL_CORE_CAPABILITY: capability },
  });
  coreProcess.unref();
}

function coreErrorPayload(err: unknown, code = 'CORE_REQUEST_FAILED'): StructuredCoreErrorPayload {
  const maybe = err as Partial<StructuredCoreErrorPayload> & { requestId?: string };
  return {
    code: typeof maybe?.code === 'string' ? maybe.code : code,
    message: err instanceof Error ? err.message : String(err),
    retryable: typeof maybe?.retryable === 'boolean' ? maybe.retryable : true,
    details: maybe?.details,
    request_id: typeof maybe?.request_id === 'string' ? maybe.request_id : maybe?.requestId,
  };
}

function postChatState() {
  void chatPanel?.webview.postMessage({ type: 'state', state: chatState.snapshot() });
}

function closeStreamSocket() {
  if (!streamSocket) return;
  const socket = streamSocket;
  streamSocket = undefined;
  try { socket.close(); } catch { /* ignore close failures */ }
}

function bindingIsCurrent(binding: { generation: number; sessionId: string; rootUri: string }): boolean {
  return isCurrentCoreBinding(binding, {
    generation: connectionGeneration,
    sessionId: sessionId || '',
    rootUri: workspaceRootUri() || '',
  });
}

function attachStreamSocket(
  socket: WebSocketLike,
  binding: { generation: number; sessionId: string; rootUri: string },
) {
  const onMessage = (event: { data?: unknown }) => {
    if (!bindingIsCurrent(binding)) return;
    try {
      const parsed = parseCoreStreamEvent(event.data);
      const monitor = runMonitor.handleEvent(parsed);
      refreshRunMonitor(monitor);
      let state: ReturnType<typeof chatState.handleEvent>;
      if (parsed.type === 'diff_proposed') {
        // Reserve the authoritative diff ID from FileDiffHandler and pass it to
        // both the handler and chat state so they use the same ID.
        const diffId = fileDiffHandler.reserveDiffId();
        void fileDiffHandler.handleDiffProposed(parsed.diff, diffId, binding.sessionId, binding.generation);
        state = chatState.handleEvent(parsed, diffId);
      } else {
        state = chatState.handleEvent(parsed);
      }
      void chatPanel?.webview.postMessage({ type: 'state', state });
      if (!state.streaming && (state.runStatus === 'done' || state.runStatus === 'error' || state.runStatus === 'cancelled')) {
        setStatus('$(plug) Shizuha: connected', `Session ${binding.sessionId}`, 'shizuha.openChat');
      }
    } catch (err) {
      chatState.markSubmittingError(coreErrorPayload(err, 'CORE_BAD_STREAM_EVENT'));
      postChatState();
    }
  };
  const onErrorOrClose = (event: unknown) => {
    if (!bindingIsCurrent(binding)) return;
    if (!chatState.streaming) return;
    const error = coreErrorPayload(event, 'CORE_STREAM_CLOSED');
    chatState.markSubmittingError(error);
    refreshRunMonitor(runMonitor.handleEvent({ type: 'error', error }));
    postChatState();
  };
  if (socket.addEventListener) {
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onErrorOrClose);
    socket.addEventListener('close', onErrorOrClose);
  } else {
    socket.onmessage = onMessage;
    socket.onerror = onErrorOrClose;
    socket.onclose = onErrorOrClose;
  }
}

async function ensureStreamSocket() {
  if (!client || !sessionId || streamSocket) return;
  const binding = { generation: connectionGeneration, sessionId, rootUri: workspaceRootUri() || '' };
  const socket = await client.connectSessionSocket(sessionId);
  if (!bindingIsCurrent(binding)) {
    socket.close();
    return;
  }
  streamSocket = socket;
  attachStreamSocket(socket, binding);
}

async function ensureSession(): Promise<void> {
  if (client && sessionId) return;
  await connectOrStart();
  if (!client || !sessionId) throw new Error('Shizuha local core session is not connected.');
}

export async function connectOrStart() {
  const generation = ++connectionGeneration;
  activeStreamAbort?.abort();
  const priorSubmission = activeSubmission;
  if (priorSubmission) await priorSubmission.catch(() => undefined);
  closeStreamSocket();
  await fileDiffHandler.rejectAll();
  const priorClient = client;
  const priorSession = sessionId;
  client = undefined;
  sessionId = undefined;
  if (priorClient && priorSession) {
    await priorClient.deleteSession(priorSession).catch(() => undefined);
  }
  let trustedConfig: ReturnType<typeof config>;
  try {
    trustedConfig = requireTrustedLocalCore();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('$(shield) Shizuha: workspace trust required', message);
    return;
  }
  const { endpoint, expectedProtocolVersion } = trustedConfig;
  if (!coreCapability) throw new Error('Shizuha local core capability is unavailable');
  const nextClient = new LocalCoreClient({ endpoint, expectedProtocolVersion, capability: coreCapability });
  setStatus('$(sync~spin) Shizuha: connecting', endpoint);

  let state = await nextClient.connect();
  if (state.kind === 'not_connected') {
    startInstalledCore(endpoint, coreCapability);
    state = await nextClient.connectWithRetry(8, 500);
  }
  if (generation !== connectionGeneration) return;
  surfaceState(state);
  if (state.kind !== 'connected') return;

  const root = workspaceRootUri();
  if (!root) {
    setStatus('$(warning) Shizuha: no workspace', 'Open a workspace to create a Shizuha session', 'shizuha.retryConnect');
    return;
  }

  try {
    const session = await nextClient.createSession(root);
    if (generation !== connectionGeneration || root !== workspaceRootUri()) {
      await nextClient.deleteSession(session.session_id).catch(() => undefined);
      return;
    }
    client = nextClient;
    sessionId = session.session_id;
    setStatus('$(plug) Shizuha: connected', `Session ${sessionId} (${session.resumed ? 'resumed' : 'created'})`, 'shizuha.openChat');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('$(error) Shizuha: session failed', message, 'shizuha.retryConnect');
    void vscode.window.showErrorMessage(`Shizuha session failed: ${message}`);
  }
}

async function submitChat(context: vscode.ExtensionContext, content: string, model?: string, provider?: string) {
  try {
    requireTrustedLocalCore();
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  try {
    void chatPanel?.webview.postMessage({ type: 'state', state: chatState.beginUserMessage(content) });
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }

  try {
    await ensureSession();
    const boundClient = client!;
    const boundSessionId = sessionId!;
    const binding = {
      generation: connectionGeneration,
      sessionId: boundSessionId,
      rootUri: workspaceRootUri() || '',
    };
    if (!bindingIsCurrent(binding)) throw new Error('Core session changed before provider-secret resolution');
    const selectedModel = model || config().defaultModel;
    const selectedProvider = provider || config().defaultProvider;
    const providerConfig = await boundClient.getProviderConfig();
    if (!bindingIsCurrent(binding)) throw new Error('Core session changed before provider-secret resolution');
    const providerSecretValues = await resolveProviderSecretValues(
      providerConfig,
      selectedProvider,
      selectedModel,
      context.secrets,
      vscode.workspace.isTrusted,
    );
    const message: LocalCoreMessageRequest = {
      content,
      context_attachments: [],
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(selectedProvider ? { provider: selectedProvider } : {}),
      ...(providerSecretValues ? { provider_secret_values: providerSecretValues } : {}),
    };
    setStatus('$(sync~spin) Shizuha: streaming', 'Run in progress', 'shizuha.cancelRun');
    runMonitor.beginRun(boundSessionId);
    refreshRunMonitor();
    const abort = new AbortController();
    activeStreamAbort = abort;
    const submission = boundClient.submitMessage(boundSessionId, message, (event) => {
      if (!bindingIsCurrent(binding)) return;
      refreshRunMonitor(runMonitor.handleEvent(event));
      let state: ReturnType<typeof chatState.handleEvent>;
      if (event.type === 'diff_proposed') {
        const diffId = fileDiffHandler.reserveDiffId();
        void fileDiffHandler.handleDiffProposed(event.diff, diffId, boundSessionId, binding.generation);
        state = chatState.handleEvent(event, diffId);
      } else {
        state = chatState.handleEvent(event);
      }
      void chatPanel?.webview.postMessage({ type: 'state', state });
      if (!state.streaming && (state.runStatus === 'done' || state.runStatus === 'error' || state.runStatus === 'cancelled')) {
        setStatus('$(plug) Shizuha: connected', `Session ${boundSessionId}`, 'shizuha.openChat');
      }
    }, abort.signal);
    activeSubmission = submission;
    try {
      await submission;
    } finally {
      if (activeSubmission === submission) activeSubmission = undefined;
      if (activeStreamAbort === abort) activeStreamAbort = undefined;
    }
  } catch (err) {
    const error = coreErrorPayload(err);
    chatState.markSubmittingError(error);
    refreshRunMonitor(runMonitor.handleEvent({ type: 'error', error }));
    postChatState();
    setStatus('$(error) Shizuha: message failed', err instanceof Error ? err.message : String(err), 'shizuha.openChat');
  }
}


async function configureProviderModel(context: vscode.ExtensionContext) {
  try {
    requireTrustedLocalCore();
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  await ensureSession();
  const boundClient = client!;
  const binding = {
    generation: connectionGeneration,
    sessionId: sessionId!,
    rootUri: workspaceRootUri() || '',
  };
  const requireCurrentBinding = () => {
    if (!bindingIsCurrent(binding)) throw new Error('Core session changed while configuring the provider; retry.');
  };
  const current = await boundClient.getProviderConfig();
  requireCurrentBinding();
  const providerPick = await vscode.window.showQuickPick([
    { label: PROVIDER_LABELS.cortex, value: 'cortex' as const, description: 'Shizuha Cortex (OpenAI-compatible)' },
    { label: PROVIDER_LABELS.anthropic, value: 'anthropic' as const, description: 'Anthropic Messages API' },
    { label: PROVIDER_LABELS['openai-compatible'], value: 'openai-compatible' as const, description: 'OpenAI-compatible base URL' },
  ], { placeHolder: 'Choose the default provider for Shizuha runs' });
  if (!providerPick) return;

  const existing = current.providers.find((candidate) => candidate.provider === providerPick.value);
  const model = await vscode.window.showInputBox({
    title: 'Shizuha provider model',
    prompt: 'Model id to use for new Shizuha runs',
    value: existing?.model || current.default_model || config().defaultModel,
    ignoreFocusOut: true,
  });
  if (model === undefined) return;

  const needsBaseUrl = providerPick.value !== 'anthropic';
  const baseUrl = needsBaseUrl ? await vscode.window.showInputBox({
    title: 'Shizuha provider base URL',
    prompt: providerPick.value === 'cortex' ? 'Cortex/OpenAI-compatible base URL' : 'OpenAI-compatible base URL',
    value: existing?.base_url || (providerPick.value === 'cortex' ? 'https://cortex.shizuha.com/v1' : ''),
    ignoreFocusOut: true,
  }) : existing?.base_url;
  if (baseUrl === undefined) return;

  const apiKey = await vscode.window.showInputBox({
    title: 'Shizuha provider API key',
    prompt: 'Optional. Stored in VS Code SecretStorage; never sent through the webview.',
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) return;
  requireCurrentBinding();

  const input: ProviderSettingsInput = {
    provider: providerPick.value,
    model,
    baseUrl,
    apiKey,
  };
  const payload = await buildProviderConfigWrite(input, context.secrets);
  requireCurrentBinding();
  const state = await boundClient.setProviderConfig(payload);
  requireCurrentBinding();

  const cfg = vscode.workspace.getConfiguration('shizuha');
  await cfg.update('defaultProvider', providerPick.value, vscode.ConfigurationTarget.Global);
  await cfg.update('defaultModel', model.trim(), vscode.ConfigurationTarget.Global);

  const health = await boundClient.health();
  requireCurrentBinding();
  surfaceState({ kind: 'connected', health });
  setStatus('$(plug) Shizuha: provider configured', `${providerPick.label} / ${model.trim()}`, 'shizuha.openChat');
  void vscode.window.showInformationMessage(`Shizuha provider configured: ${providerPick.label} / ${model.trim()} (${state.providers.length} provider entr${state.providers.length === 1 ? 'y' : 'ies'} known to core).`);
}

async function cancelCurrentRun() {
  if (!chatState.streaming) return;
  chatState.markCancelling();
  refreshRunMonitor(runMonitor.markCancellationRequested());
  postChatState();
  try {
    await ensureSession();
    const ack = await client!.cancelRun(sessionId!);
    refreshRunMonitor(runMonitor.handleCancelAck(ack.message || `Cancel ${ack.status}`, ack.request_id, ack.status));
    if (ack.status === 'cancelled' || ack.status === 'not_running') {
      chatState.handleEvent({ type: 'run_status', status: 'cancelled' });
      postChatState();
      setStatus('$(plug) Shizuha: connected', `Session ${sessionId}`, 'shizuha.openChat');
    }
  } catch (err) {
    const error = coreErrorPayload(err, 'CORE_CANCEL_FAILED');
    chatState.markSubmittingError(error);
    refreshRunMonitor(runMonitor.handleCancelError(error));
    postChatState();
    void vscode.window.showWarningMessage(`Shizuha cancel failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function openChat(context: vscode.ExtensionContext) {
  try {
    requireTrustedLocalCore();
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
    return;
  }
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Beside);
    postChatState();
    return;
  }
  chatPanel = vscode.window.createWebviewPanel(
    'shizuhaChat',
    'Shizuha Chat',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      retainContextWhenHidden: true,
    },
  );
  const scriptUri = chatPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.js')).toString();
  const styleUri = chatPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.css')).toString();
  chatPanel.webview.html = chatWebviewHtml({ scriptUri, styleUri, cspSource: chatPanel.webview.cspSource });
  chatPanel.onDidDispose(() => {
    chatPanel = undefined;
  }, null, context.subscriptions);
  chatPanel.webview.onDidReceiveMessage((message: unknown) => {
    const row = message && typeof message === 'object' ? message as Record<string, unknown> : {};
    const type = typeof row['type'] === 'string' ? row['type'] : '';
    if (type === 'ready') {
      postChatState();
    } else if (type === 'submit') {
      void submitChat(context, String(row['content'] || ''), String(row['model'] || '').trim(), String(row['provider'] || '').trim());
    } else if (type === 'cancel') {
      void cancelCurrentRun();
    } else if (type === 'retry') {
      void submitChat(context, chatState.lastUserContent);
    } else if (type === 'acceptDiff') {
      const diffId = String(row['diffId'] || '');
      if (diffId) void fileDiffHandler.acceptDiff(diffId);
    } else if (type === 'rejectDiff') {
      const diffId = String(row['diffId'] || '');
      if (diffId) void fileDiffHandler.rejectDiff(diffId);
    }
  }, null, context.subscriptions);
  postChatState();
}

export async function disconnect() {
  // Invalidate immutable callback/proposal ownership synchronously, then abort
  // and await the old SSE work before any new binding can exist.
  connectionGeneration += 1;
  activeStreamAbort?.abort();
  closeStreamSocket();
  const submission = activeSubmission;
  if (submission) await submission.catch(() => undefined);
  activeSubmission = undefined;
  activeStreamAbort = undefined;
  const oldClient = client;
  const current = sessionId;
  client = undefined;
  sessionId = undefined;
  await fileDiffHandler.rejectAll();
  if (oldClient && current) {
    try {
      await oldClient.deleteSession(current);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(`Shizuha disconnect failed: ${message}`);
    }
  }
  chatState = new ChatSessionState();
  postChatState();
  setStatus('$(circle-slash) Shizuha: not connected', 'Disconnected', 'shizuha.retryConnect');
}

export async function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusItem);
  if (!vscode.workspace.isTrusted) {
    setStatus('$(shield) Shizuha: workspace trust required', 'Trust this workspace before Shizuha can connect, resolve provider secrets, or edit files.');
    return;
  }
  coreCapability = await loadOrCreateCoreCapability(context.globalStorageUri.fsPath);
  context.subscriptions.push(vscode.commands.registerCommand('shizuha.retryConnect', connectOrStart));
  context.subscriptions.push(vscode.commands.registerCommand('shizuha.disconnect', disconnect));
  context.subscriptions.push(vscode.commands.registerCommand('shizuha.openChat', () => openChat(context)));
  context.subscriptions.push(vscode.commands.registerCommand('shizuha.configureProviderModel', () => configureProviderModel(context)));
  context.subscriptions.push(vscode.commands.registerCommand('shizuha.cancelRun', cancelCurrentRun));
  context.subscriptions.push(vscode.commands.registerCommand('shizuha.showRuns', () => { refreshRunMonitor(); void vscode.window.showInformationMessage('Shizuha run monitor is available in the Explorer sidebar.'); }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    // A first-root reorder/removal changes the file-ownership boundary. Reject
    // every proposal through the old session, delete it, then create a fresh
    // session for the new root. Never carry pending edits across this event.
    void (async () => {
      await disconnect();
      await connectOrStart();
    })();
  }));
  runTree = new RunTreeDataProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('shizuhaRuns', runTree));
  setStatus('$(circle-slash) Shizuha: not connected', 'Connecting...', 'shizuha.retryConnect');
  void connectOrStart();
}

export function deactivate(): Promise<void> {
  closeStreamSocket();
  return deactivateWithCleanup(disconnect);
}
