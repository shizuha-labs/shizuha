export const LOCAL_CORE_PROTOCOL_VERSION = 'scli-133.v1';
export const DEFAULT_LOCAL_CORE_ENDPOINT = 'http://127.0.0.1:8015';
export const LOCAL_CORE_NONCE_HEADER = 'x-shizuha-local-core-nonce';
export const LOCAL_CORE_AUTH_HEADER = 'x-shizuha-local-core-auth';

export type AuthStatus = 'local' | 'authenticated' | 'unauthenticated' | 'unknown';

export interface LocalCoreHealth {
  version: string;
  protocol_version: string;
  auth_status: AuthStatus | string;
  available_providers: string[];
  capabilities: Record<string, unknown>;
  server_proof?: string;
}

export const LOCAL_PROVIDER_CONFIG_SCOPE = 'durable-local-core';
export const LOCAL_PROVIDER_SECRET_REF_CONTRACT = 'core-runtime-secret-ref-resolution';

export interface StructuredCoreErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
  request_id?: string;
}

export class StructuredCoreError extends Error {
  code: string;
  retryable: boolean;
  details?: unknown;
  requestId?: string;
  status?: number;

  constructor(payload: StructuredCoreErrorPayload, status?: number) {
    super(payload.message);
    this.name = 'StructuredCoreError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.details = payload.details;
    this.requestId = payload.request_id;
    this.status = status;
  }
}

export type ConnectionState =
  | { kind: 'connected'; health: LocalCoreHealth }
  | { kind: 'not_connected'; message: string; retryable: true; request_id?: string }
  | { kind: 'upgrade_required'; expected: string; actual: string; health: LocalCoreHealth }
  | { kind: 'permanent_error'; error: StructuredCoreError };

export interface LocalCoreSession {
  session_id: string;
  workspace_root_uri: string;
  protocol_version: string;
  resumed: boolean;
}

export interface LocalCoreMessageRequest {
  content: string;
  model?: string;
  provider?: string;
  /** Secret values resolved by a trusted local UI host at run time. Never persisted by the core. */
  provider_secret_values?: Record<string, string>;
  context_attachments: unknown[];
}

export interface DiffProposedPayload {
  file_path: string;
  original_content?: string;
  proposed_content: string;
  description?: string;
  /** MIME type or language hint for the diff display. */
  language?: string;
  /** If true, the file is too large or binary for diff preview. */
  unsupported?: boolean;
  /** Human-readable reason when unsupported. */
  unsupported_reason?: string;
}

export type CoreStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name?: string; content?: unknown }
  | { type: 'tool_result'; id: string; name?: string; content?: unknown }
  | { type: 'diff_proposed'; diff: DiffProposedPayload }
  | { type: 'run_status'; status: string }
  | { type: 'error'; error: StructuredCoreErrorPayload }
  | { type: 'done' };

export type ProviderConfigKind = 'cortex' | 'anthropic' | 'openai-compatible';


export interface LocalCoreCancelAck {
  ok: boolean;
  status: 'cancelled' | 'cancelling' | 'not_running' | string;
  message?: string;
  request_id?: string;
}

export interface DiffApplyResult {
  ok: boolean;
  file_path: string;
  action: 'accepted' | 'rejected' | 'partial';
  message?: string;
  request_id?: string;
}

export interface LocalCoreProviderConfig {
  provider: ProviderConfigKind;
  model: string;
  base_url?: string;
  api_key_secret_ref?: string;
  has_api_key?: boolean;
}

export interface LocalCoreProviderConfigState {
  default_provider?: ProviderConfigKind;
  default_model?: string;
  providers: LocalCoreProviderConfig[];
  capabilities: Record<string, unknown>;
}

export interface LocalCoreProviderConfigWrite {
  provider: ProviderConfigKind;
  model: string;
  base_url?: string;
  api_key_secret_ref?: string;
}

export interface LocalCoreClientOptions {
  endpoint?: string;
  expectedProtocolVersion?: string;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
  /** Per-install capability shared only with the extension-spawned core. */
  capability?: string;
}

export type CoreStreamEventHandler = (event: CoreStreamEvent) => void;

export interface WebSocketLike {
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  addEventListener?(type: 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void;
  onmessage?: ((event: { data?: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(capability: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(capability), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function signLocalCoreServerProof(
  capability: string,
  nonce: string,
  protocolVersion = LOCAL_CORE_PROTOCOL_VERSION,
): Promise<string> {
  return hmacHex(capability, `server-proof\n${nonce}\n${protocolVersion}`);
}

export async function signLocalCoreRequest(
  capability: string,
  method: string,
  pathname: string,
  nonce: string,
  body = '',
): Promise<string> {
  return hmacHex(capability, `${method.toUpperCase()}\n${pathname}\n${nonce}\n${await sha256Hex(body)}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseHealthResponse(value: unknown): LocalCoreHealth {
  const row = asRecord(value);
  if (!row) throw new Error('health response must be an object');

  const version = row['version'];
  const protocolVersion = row['protocol_version'];
  const authStatus = row['auth_status'];
  const availableProviders = row['available_providers'];
  const capabilities = row['capabilities'];

  const missing = [
    ['version', typeof version === 'string'],
    ['protocol_version', typeof protocolVersion === 'string'],
    ['auth_status', typeof authStatus === 'string'],
    ['available_providers', Array.isArray(availableProviders)],
    ['capabilities', !!asRecord(capabilities)],
  ]
    .filter(([, ok]) => !ok)
    .map(([key]) => key as string);

  if (missing.length > 0) {
    throw new Error(`health response missing/invalid field(s): ${missing.join(', ')}`);
  }

  return {
    version: version as string,
    protocol_version: protocolVersion as string,
    auth_status: authStatus as string,
    available_providers: [...availableProviders as string[]],
    capabilities: { ...(capabilities as Record<string, unknown>) },
    server_proof: typeof row['server_proof'] === 'string' ? row['server_proof'] as string : undefined,
  };
}

export function protocolCompatible(actual: string, expected = LOCAL_CORE_PROTOCOL_VERSION): boolean {
  return actual === expected;
}

function parseStructuredError(value: unknown, fallbackStatus?: number): StructuredCoreError {
  const row = asRecord(value);
  const code = typeof row?.['code'] === 'string' ? row['code'] as string : 'CORE_HTTP_ERROR';
  const message = typeof row?.['message'] === 'string'
    ? row['message'] as string
    : `Local core returned HTTP ${fallbackStatus ?? 'error'}`;
  const retryable = typeof row?.['retryable'] === 'boolean'
    ? row['retryable'] as boolean
    : !!fallbackStatus && fallbackStatus >= 500;
  return new StructuredCoreError({
    code,
    message,
    retryable,
    details: row?.['details'],
    request_id: typeof row?.['request_id'] === 'string' ? row['request_id'] as string : undefined,
  }, fallbackStatus);
}

export function structuredErrorPayload(value: unknown): StructuredCoreErrorPayload {
  const row = asRecord(value) || {};
  return {
    code: typeof row['code'] === 'string' ? row['code'] as string : 'CORE_STREAM_ERROR',
    message: typeof row['message'] === 'string' ? row['message'] as string : 'Local core stream returned an error',
    retryable: typeof row['retryable'] === 'boolean' ? row['retryable'] as boolean : false,
    details: row['details'],
    request_id: typeof row['request_id'] === 'string' ? row['request_id'] as string : undefined,
  };
}


function parseProviderKind(value: unknown): ProviderConfigKind | undefined {
  if (value === 'cortex' || value === 'anthropic' || value === 'openai-compatible') return value;
  return undefined;
}

function parseProviderConfig(value: unknown): LocalCoreProviderConfig {
  const row = asRecord(value);
  if (!row) throw new Error('provider config must be an object');
  const provider = parseProviderKind(row['provider']);
  const model = typeof row['model'] === 'string' ? row['model'].trim() : '';
  if (!provider || !model) throw new Error('provider config missing provider/model');
  return {
    provider,
    model,
    base_url: typeof row['base_url'] === 'string' ? row['base_url'] : undefined,
    api_key_secret_ref: typeof row['api_key_secret_ref'] === 'string' ? row['api_key_secret_ref'] : undefined,
    has_api_key: typeof row['has_api_key'] === 'boolean' ? row['has_api_key'] : undefined,
  };
}

export function parseProviderConfigState(value: unknown): LocalCoreProviderConfigState {
  const row = asRecord(value);
  if (!row) throw new Error('provider config response must be an object');
  const providers = row['providers'];
  if (!Array.isArray(providers)) throw new Error('provider config response missing providers');
  return {
    default_provider: parseProviderKind(row['default_provider']),
    default_model: typeof row['default_model'] === 'string' ? row['default_model'] : undefined,
    providers: providers.map(parseProviderConfig),
    capabilities: asRecord(row['capabilities']) ?? {},
  };
}

export function parseCoreStreamEvent(value: unknown): CoreStreamEvent {
  const row = typeof value === 'string' ? asRecord(JSON.parse(value)) : asRecord(value);
  if (!row || typeof row['type'] !== 'string') {
    throw new Error('stream event must be an object with a type');
  }
  const type = row['type'];
  if (type === 'token') {
    return { type, text: typeof row['text'] === 'string' ? row['text'] as string : String(row['content'] ?? '') };
  }
  if (type === 'tool_call' || type === 'tool_result') {
    return {
      type,
      id: typeof row['id'] === 'string' ? row['id'] as string : `${type}-unknown`,
      name: typeof row['name'] === 'string' ? row['name'] as string : undefined,
      content: row['content'] ?? row['payload'],
    };
  }
  if (type === 'run_status') {
    return { type, status: typeof row['status'] === 'string' ? row['status'] as string : 'running' };
  }
  if (type === 'error') {
    return { type, error: structuredErrorPayload(row['error'] ?? row) };
  }
  if (type === 'diff_proposed') {
    const diff = (row['diff'] ?? row) as Record<string, unknown>;
    return {
      type,
      diff: {
        file_path: typeof diff['file_path'] === 'string' ? diff['file_path'] as string : 'unknown',
        original_content: typeof diff['original_content'] === 'string' ? diff['original_content'] as string : undefined,
        proposed_content: typeof diff['proposed_content'] === 'string' ? diff['proposed_content'] as string : '',
        description: typeof diff['description'] === 'string' ? diff['description'] as string : undefined,
        language: typeof diff['language'] === 'string' ? diff['language'] as string : undefined,
        unsupported: diff['unsupported'] === true,
        unsupported_reason: typeof diff['unsupported_reason'] === 'string' ? diff['unsupported_reason'] as string : undefined,
      },
    };
  }

  if (type === 'done') return { type };

  // Local core /v1/query/stream emits AgentEvent names. Normalize them to the
  // compact VS Code chat event contract so the extension can consume the real
  // implemented SSE route instead of the unimplemented session-message socket.
  if (type === 'content' || type === 'reasoning_text') {
    return { type: 'token', text: typeof row['text'] === 'string' ? row['text'] as string : '' };
  }
  if (type === 'tool_start') {
    return {
      type: 'tool_call',
      id: typeof row['toolCallId'] === 'string' ? row['toolCallId'] as string : 'tool-start-unknown',
      name: typeof row['toolName'] === 'string' ? row['toolName'] as string : undefined,
      content: row['input'],
    };
  }
  if (type === 'tool_progress' || type === 'tool_complete') {
    return {
      type: 'tool_result',
      id: typeof row['toolCallId'] === 'string' ? row['toolCallId'] as string : 'tool-result-unknown',
      name: typeof row['toolName'] === 'string' ? row['toolName'] as string : undefined,
      content: row['result'] ?? row['output'] ?? row['metadata'],
    };
  }
  if (type === 'session_start' || type === 'turn_start' || type === 'turn_complete' || type === 'thinking' || type === 'reasoning') {
    return { type: 'run_status', status: type === 'turn_complete' ? 'running' : 'running' };
  }
  if (type === 'complete') return { type: 'done' };

  throw new Error(`unsupported stream event type: ${type}`);
}


function parseCancelAck(value: unknown): LocalCoreCancelAck {
  const row = asRecord(value) || {};
  const status = typeof row['status'] === 'string'
    ? row['status'] as string
    : (row['cancelled'] === true || row['ok'] === true ? 'cancelled' : 'cancelling');
  return {
    ok: row['ok'] === undefined ? status === 'cancelled' || status === 'cancelling' || status === 'not_running' : row['ok'] !== false,
    status,
    message: typeof row['message'] === 'string' ? row['message'] as string : undefined,
    request_id: typeof row['request_id'] === 'string' ? row['request_id'] as string : undefined,
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { code: 'CORE_INVALID_JSON', message: text, retryable: false };
  }
}

async function consumeSse(response: Response, onEvent?: CoreStreamEventHandler): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data && onEvent) onEvent(parseCoreStreamEvent(data));
      boundary = buffer.indexOf('\n\n');
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    flush(decoder.decode(value, { stream: true }));
  }
  flush(decoder.decode());
}

export class LocalCoreClient {
  readonly endpoint: string;
  readonly expectedProtocolVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory?: (url: string) => WebSocketLike;
  private readonly capability?: string;

  constructor(options: LocalCoreClientOptions = {}) {
    this.endpoint = trimEndpoint(options.endpoint ?? process.env['SHIZUHA_CORE_URL'] ?? DEFAULT_LOCAL_CORE_ENDPOINT);
    this.expectedProtocolVersion = options.expectedProtocolVersion ?? LOCAL_CORE_PROTOCOL_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory
      ?? (typeof WebSocket !== 'undefined' ? ((url: string) => new WebSocket(url) as unknown as WebSocketLike) : undefined);
    this.capability = options.capability;
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : '';
    const headers = new Headers(init.headers);
    if (this.capability) {
      const nonce = crypto.randomUUID();
      headers.set(LOCAL_CORE_NONCE_HEADER, nonce);
      headers.set(LOCAL_CORE_AUTH_HEADER, await signLocalCoreRequest(this.capability, method, pathname, nonce, body));
    }
    return this.fetchImpl(`${this.endpoint}${pathname}`, { ...init, method, headers });
  }

  async health(): Promise<LocalCoreHealth> {
    const nonce = this.capability ? crypto.randomUUID() : undefined;
    const response = await this.fetchImpl(`${this.endpoint}/health`, nonce ? {
      headers: { [LOCAL_CORE_NONCE_HEADER]: nonce },
    } : undefined);
    const payload = await responseJson(response);
    if (!response.ok) throw parseStructuredError(payload, response.status);
    const health = parseHealthResponse(payload);
    if (this.capability) {
      const expected = await signLocalCoreServerProof(this.capability, nonce!, health.protocol_version);
      if (!health.server_proof || health.server_proof !== expected) {
        throw new StructuredCoreError({
          code: 'CORE_IDENTITY_UNVERIFIED',
          message: 'Loopback listener did not prove the per-install Shizuha core capability',
          retryable: false,
        }, 401);
      }
    }
    return health;
  }

  async connect(): Promise<ConnectionState> {
    try {
      const health = await this.health();
      if (!protocolCompatible(health.protocol_version, this.expectedProtocolVersion)) {
        return {
          kind: 'upgrade_required',
          expected: this.expectedProtocolVersion,
          actual: health.protocol_version,
          health,
        };
      }
      return { kind: 'connected', health };
    } catch (err) {
      if (err instanceof StructuredCoreError && !err.retryable) {
        return { kind: 'permanent_error', error: err };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'not_connected', message, retryable: true };
    }
  }

  async connectWithRetry(attempts = 3, delayMs = 250): Promise<ConnectionState> {
    let last: ConnectionState | null = null;
    for (let i = 0; i < Math.max(1, attempts); i++) {
      last = await this.connect();
      if (last.kind !== 'not_connected') return last;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return last ?? { kind: 'not_connected', message: 'Local core unavailable', retryable: true };
  }

  async getProviderConfig(): Promise<LocalCoreProviderConfigState> {
    const response = await this.request('/config/providers');
    const payload = await responseJson(response);
    if (!response.ok) throw parseStructuredError(payload, response.status);
    return parseProviderConfigState(payload);
  }

  async setProviderConfig(config: LocalCoreProviderConfigWrite): Promise<LocalCoreProviderConfigState> {
    const response = await this.request('/config/providers/default', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    const payload = await responseJson(response);
    if (!response.ok) throw parseStructuredError(payload, response.status);
    return parseProviderConfigState(payload);
  }

  async createSession(workspaceRootUri: string, resumeSessionId?: string): Promise<LocalCoreSession> {
    const response = await this.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_root_uri: workspaceRootUri, session_id: resumeSessionId }),
    });
    const payload = await responseJson(response);
    if (!response.ok) throw parseStructuredError(payload, response.status);
    const row = asRecord(payload);
    if (!row || typeof row['session_id'] !== 'string' || typeof row['workspace_root_uri'] !== 'string') {
      throw new StructuredCoreError({
        code: 'CORE_BAD_SESSION_RESPONSE',
        message: 'Local core returned an invalid session response',
        retryable: false,
        details: payload,
      }, response.status);
    }
    return {
      session_id: row['session_id'] as string,
      workspace_root_uri: row['workspace_root_uri'] as string,
      protocol_version: typeof row['protocol_version'] === 'string'
        ? row['protocol_version'] as string
        : this.expectedProtocolVersion,
      resumed: row['resumed'] === true,
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    if (!response.ok) throw parseStructuredError(await responseJson(response), response.status);
  }

  async submitMessage(
    sessionId: string,
    message: LocalCoreMessageRequest,
    onEvent?: CoreStreamEventHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request('/v1/query/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        prompt: message.content,
        sessionId,
        extension_mode: true,
        permissionMode: 'plan',
        ...(message.model ? { model: message.model } : {}),
        ...(message.provider ? { provider: message.provider } : {}),
        ...(message.provider_secret_values ? { provider_secret_values: message.provider_secret_values } : {}),
      }),
    });
    if (!response.ok) throw parseStructuredError(await responseJson(response), response.status);
    await consumeSse(response, onEvent);
  }

  async cancelRun(sessionId: string): Promise<LocalCoreCancelAck> {
    const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await responseJson(response);
    if (!response.ok) throw parseStructuredError(payload, response.status);
    return parseCancelAck(payload);
  }

  async applyDiff(sessionId: string, filePath: string, action: 'accepted' | 'rejected' | 'partial'): Promise<DiffApplyResult> {
    const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}/diffs/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_path: filePath, action }),
    });
    const payload = await responseJson(response);
    if (!response.ok) throw parseStructuredError(payload, response.status);
    const row = payload as Record<string, unknown>;
    return {
      ok: row['ok'] !== false,
      file_path: typeof row['file_path'] === 'string' ? row['file_path'] as string : filePath,
      action: (row['action'] === 'accepted' || row['action'] === 'rejected' || row['action'] === 'partial')
        ? row['action'] as 'accepted' | 'rejected' | 'partial' : action,
      message: typeof row['message'] === 'string' ? row['message'] as string : undefined,
      request_id: typeof row['request_id'] === 'string' ? row['request_id'] as string : undefined,
    };
  }

  async connectSessionSocket(sessionId: string): Promise<WebSocketLike> {
    if (!this.webSocketFactory) {
      throw new StructuredCoreError({
        code: 'WEBSOCKET_UNAVAILABLE',
        message: 'No WebSocket implementation is available for the local core client',
        retryable: false,
      });
    }
    const wsEndpoint = this.endpoint.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    const pathname = `/sessions/${encodeURIComponent(sessionId)}/events`;
    if (!this.capability) return this.webSocketFactory(`${wsEndpoint}${pathname}`);
    const nonce = crypto.randomUUID();
    const auth = await signLocalCoreRequest(this.capability, 'GET', pathname, nonce);
    return this.webSocketFactory(`${wsEndpoint}${pathname}?nonce=${encodeURIComponent(nonce)}&auth=${encodeURIComponent(auth)}`);
  }
}
