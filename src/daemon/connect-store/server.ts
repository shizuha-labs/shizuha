/**
 * HTTP + WSConn routes for the daemon's mini-Connect.
 *
 * Wire-format identical to shizuha-id (`/id/api/*`) and shizuha-connect
 * (`/connect/api/*`, `/connect/ws/connect/{user,agent}/`) so a single browser /
 * Kotlin / agent client can point at either backend with no code change.
 *
 * Mounted as part of the daemon's existing Fastify app on port 8015.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
// @ts-ignore — `ws` ships its own types but TS resolution sometimes misses them
// in this monorepo. Mirrors the pattern used in runner-proxy.ts and dashboard.ts.
import WSDefault, { WSConnServer } from 'ws';
import * as crypto from 'node:crypto';

// Resolve the WSConn value (constructor + readyState constants) regardless
// of how the `ws` module's default export is shaped at runtime.
const WS: any = WSDefault;
type WSConn = any;

import { ConnectStore, User, Conversation, DirectMessage, Participant } from './sqlite.js';
import { AuthService } from './auth.js';
import { ChannelLayer, ChannelLike, ChannelEvent } from './channel-layer.js';

export interface MiniConnectDeps {
  store: ConnectStore;
  auth: AuthService;
  channelLayer: ChannelLayer;
  /**
   * Optional upstream resolver. When provided AND it returns a non-null
   * value, the daemon's mini-Connect WS endpoint stops serving locally and
   * instead proxies the connection through to the upstream Connect (the real
   * platform). The daemon-facing browser keeps talking to the daemon's host
   * — no cross-origin, no JWT mismatch — while messages land in the real
   * platform's database.
   *
   * Return null in local-only mode (no platform link).
   */
  getUpstream?: () => Promise<{ wsUrl: string; accessToken: string } | null>;
}

// ── HTTP routes ───────────────────────────────────────────────────────────

export function registerMiniConnectRoutes(app: FastifyInstance, deps: MiniConnectDeps): void {
  const { store, auth } = deps;

  // ── Identity ─────────────────────────────────────────────────────────

  // Real shizuha-id mounts at /id/api/auth/login/. Trailing-slash variants
  // both registered for client-side flexibility.
  for (const p of ['/id/api/auth/login/', '/id/api/auth/login']) {
    app.post<{ Body: { username?: string; password?: string } }>(p, async (req, reply) => {
      const { username, password } = req.body ?? {};
      if (!username || !password) {
        return reply.status(400).send({ error: 'username and password required' });
      }
      const tokens = auth.login(username, password);
      if (!tokens) return reply.status(401).send({ error: 'invalid credentials' });
      return reply.send({
        access: tokens.access,
        refresh: tokens.refresh,
        user: serializeUser(tokens.user),
      });
    });
  }

  for (const p of ['/id/api/auth/refresh/', '/id/api/auth/refresh']) {
    app.post<{ Body: { refresh?: string } }>(p, async (req, reply) => {
      const { refresh } = req.body ?? {};
      if (!refresh) return reply.status(400).send({ error: 'refresh token required' });
      const tokens = auth.refresh(refresh);
      if (!tokens) return reply.status(401).send({ error: 'invalid refresh token' });
      return reply.send({ access: tokens.access, refresh: tokens.refresh });
    });
  }

  for (const p of ['/id/api/me/', '/id/api/me']) {
    app.get(p, async (req, reply) => {
      const user = requireBearer(req, deps);
      if (!user) return reply.status(401).send({ error: 'unauthorized' });
      return reply.send(serializeUser(user));
    });
  }

  // ── Conversations ────────────────────────────────────────────────────

  for (const p of ['/connect/api/conversations/', '/connect/api/conversations']) {
    app.get(p, async (req, reply) => {
      const user = requireBearer(req, deps);
      if (!user) return reply.status(401).send({ error: 'unauthorized' });
      const convs = store.listUserConversations(user.id);
      const results = convs.map(c => ({
        ...serializeConversation(c),
        participants: store.listParticipants(c.id).map(serializeParticipant),
      }));
      return reply.send({ count: results.length, results });
    });

    app.post<{ Body: { participant_user_ids?: number[]; type?: 'direct' | 'group'; name?: string } }>(p, async (req, reply) => {
      const user = requireBearer(req, deps);
      if (!user) return reply.status(401).send({ error: 'unauthorized' });
      const body = req.body ?? {};
      const others = (body.participant_user_ids ?? []).filter(uid => Number.isInteger(uid) && uid !== user.id);
      const type = body.type ?? (others.length === 1 ? 'direct' : 'group');

      if (type === 'direct') {
        if (others.length !== 1) return reply.status(400).send({ error: 'direct requires exactly one other participant' });
        const partTypes = participantTypeMap(store, [user.id, others[0]!]);
        const partAgentIds = participantAgentIdMap(store, [user.id, others[0]!]);
        const conv = store.findOrCreateDirectConversation(user.id, others[0]!, {
          creatorId: user.id,
          participantTypes: partTypes,
          agentIds: partAgentIds,
        });
        broadcastConversationCreated(deps, conv);
        return reply.status(201).send({
          ...serializeConversation(conv),
          participants: store.listParticipants(conv.id).map(serializeParticipant),
        });
      }
      if (!body.name) return reply.status(400).send({ error: 'group conversation requires name' });
      const allIds = [user.id, ...others];
      const conv = store.createGroupConversation({
        name: body.name,
        creatorId: user.id,
        participantUserIds: others,
        participantTypes: participantTypeMap(store, allIds),
        agentIds: participantAgentIdMap(store, allIds),
      });
      broadcastConversationCreated(deps, conv);
      return reply.status(201).send({
        ...serializeConversation(conv),
        participants: store.listParticipants(conv.id).map(serializeParticipant),
      });
    });
  }

  for (const p of ['/connect/api/conversations/:id/messages/', '/connect/api/conversations/:id/messages']) {
    app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(p, async (req, reply) => {
      const user = requireBearer(req, deps);
      if (!user) return reply.status(401).send({ error: 'unauthorized' });
      const { id } = req.params;
      if (!store.isParticipant(id, user.id)) return reply.status(403).send({ error: 'not a participant' });
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 200;
      const before = req.query.before ? parseInt(req.query.before, 10) : undefined;
      const messages = store.listMessages(id, { limit, before });
      return reply.send({ count: messages.length, results: messages.map(serializeMessage) });
    });
  }

  // ── Direct message any user ────────────────────────────────────────
  // Mirrors shizuha-connect's MessageUserView so the existing
  // `mcp__shizuha-connect__message_user` and `connect-dm.ts` POST helper
  // work against the daemon when BACKEND_URL points here. Resolves the
  // recipient via mini-Connect's own auth_users table (no separate id
  // service required), find-or-creates a direct DM, persists, and
  // broadcasts via the channel layer.
  for (const p of ['/connect/api/messaging/dm/', '/connect/api/messaging/dm']) {
    app.post<{ Body: {
      content?: string;
      recipient_username?: string;
      recipient_email?: string;
      client_message_id?: string;
    } }>(p, async (req, reply) => {
      const sender = requireBearer(req, deps);
      if (!sender) return reply.status(401).send({ error: 'unauthorized' });

      const content = (req.body?.content ?? '').trim();
      const recipientUsername = (req.body?.recipient_username ?? '').trim();
      const recipientEmail = (req.body?.recipient_email ?? '').trim();
      const clientMessageId = (req.body?.client_message_id ?? '').trim() || null;

      if (!content) return reply.status(400).send({ error: 'content is required' });
      if (!recipientUsername && !recipientEmail) {
        return reply.status(400).send({ error: 'recipient_username or recipient_email is required' });
      }

      // Resolve recipient.
      let recipient = recipientUsername
        ? store.getUserByUsername(recipientUsername)
        : null;
      if (!recipient && recipientEmail) {
        // Walk users to match email — small N (single-user + agents).
        recipient = store.listUsers().find(u => (u.email ?? '').toLowerCase() === recipientEmail.toLowerCase()) ?? null;
      }
      if (!recipient) {
        return reply.status(404).send({
          error: `No user found with ${recipientUsername ? 'username' : 'email'} ${recipientUsername || recipientEmail}`,
        });
      }
      if (recipient.id === sender.id) {
        return reply.status(400).send({ error: 'Cannot send a direct message to yourself' });
      }

      // Find or create the DM. Bootstrap participant types from the actual
      // users (so the agent gets `participant_type='agent'` correctly).
      const ptypes = participantTypeMap(store, [sender.id, recipient.id]);
      const aids = participantAgentIdMap(store, [sender.id, recipient.id]);
      const conv = store.findOrCreateDirectConversation(sender.id, recipient.id, {
        creatorId: sender.id,
        participantTypes: ptypes,
        agentIds: aids,
      });
      const isNewConversation = conv.messageCount === 0;
      if (isNewConversation) broadcastConversationCreated(deps, conv);

      // Persist message — store.createMessage is idempotent via
      // (conversation_id, client_message_id) uniqueness.
      const existingByCmi = clientMessageId
        ? store.listMessages(conv.id).find(m => m.clientMessageId === clientMessageId)
        : null;
      const idempotentReplay = !!existingByCmi;

      const msg = existingByCmi ?? store.createMessage({
        conversationId: conv.id,
        senderId: sender.id,
        senderIsAgent: sender.isAgent,
        agentId: sender.isAgent ? sender.agentId : null,
        content,
        clientMessageId,
      });

      // Broadcast (skip on idempotent replay — already broadcast on first POST).
      if (!idempotentReplay) {
        deps.channelLayer.groupSend(`chat_${conv.id}`, {
          type: 'new_message',
          message_data: serializeMessage(msg),
          origin_channel: '',
        });
      }

      return reply.status(idempotentReplay ? 200 : 201).send({
        message_id: msg.id,
        conversation_id: conv.id,
        created_new_conversation: isNewConversation,
        idempotent_replay: idempotentReplay,
        recipient: {
          user_id: recipient.id,
          email: recipient.email,
          name: recipient.displayName ?? recipient.username,
        },
      });
    });
  }
}

// ── WS upgrade handler ────────────────────────────────────────────────────

/**
 * Returns true if the request was handled (regardless of success). The caller
 * (dashboard.ts upgrade handler) should not fall through to other branches if
 * we returned true.
 *
 * Routes to either:
 *   - `ConnectChannel` — mini-Connect serves locally (daemon-only mode)
 *   - `UpstreamProxyChannel` — pipes browser ↔ real Connect (remote-linked)
 *
 * `deps.getUpstream` is the discriminator. If it resolves to a non-null
 * config, we proxy. If null/undefined, we serve locally. The choice is made
 * per-connection at upgrade time.
 */
export function handleMiniConnectUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WSConnServer,
  deps: MiniConnectDeps,
): boolean {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const path = url.pathname.replace(/\/$/, '');

  if (path !== '/connect/ws/connect/user' && path !== '/connect/ws/connect/agent') {
    return false;
  }

  const token = url.searchParams.get('token') ?? extractBearerFromHeader(request.headers.authorization);
  const claims = token ? deps.auth.verify(token) : null;
  if (!claims || claims.token_type !== 'access') {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }
  const user = deps.store.getUserById(claims.user_id);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }

  // The /agent/ alias requires is_agent=true on the JWT — same rule as real
  // Connect (see UserChatConsumer docstring).
  if (path === '/connect/ws/connect/agent' && !claims.is_agent) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return true;
  }

  // Async branch: resolve upstream config (if any) before completing the
  // upgrade. Local mode → resolves to null instantly; remote mode → returns
  // {wsUrl, accessToken} from the daemon's auth.json.
  const upstreamPromise = deps.getUpstream ? deps.getUpstream() : Promise.resolve(null);
  upstreamPromise
    .catch(() => null)
    .then((upstream) => {
      wss.handleUpgrade(request, socket, head, (ws: WSConn) => {
        if (upstream && path === '/connect/ws/connect/user') {
          // Browser/dashboard chat in remote mode — proxy to real Connect.
          new UpstreamProxyChannel(ws, upstream.wsUrl, upstream.accessToken).start();
        } else {
          // Local mode (mini-Connect serves directly) OR agent endpoint
          // (agents always talk to whichever Connect their BACKEND_URL
          // points at — they don't need the daemon proxy because they're
          // not browsers and don't have CORS issues).
          new ConnectChannel(ws, user, claims.is_agent, deps).start();
        }
      });
    });
  return true;
}

// ── Upstream Proxy Channel ────────────────────────────────────────────────
//
// Pipes a browser-facing WS to an upstream Connect WS. Used when the daemon
// is linked to a remote platform — the browser stays on the daemon's host
// (single origin, no CORS, no per-backend JWT mismatch) and the daemon
// transparently relays everything to/from real Connect.
//
// Failure modes are explicit: if the upstream WS dies (auth expired, network
// blip, real Connect restart), we close the browser WS too. The client's own
// reconnect logic then re-opens, the daemon fetches a fresh upstream JWT
// (auth.json refresh path), and we re-establish.
class UpstreamProxyChannel {
  private upstream: WSConn | null = null;
  private alive = true;

  constructor(
    private downstream: WSConn,
    private upstreamUrl: string,
    private upstreamToken: string,
  ) {}

  start(): void {
    // Preserve the trailing slash on the upstream WS path — Django Channels
    // routes are slash-sensitive (`re_path(r'ws/connect/user/$')`) and stripping
    // it yields a silent route miss with no useful error.
    const base = this.upstreamUrl.endsWith('/')
      ? this.upstreamUrl
      : this.upstreamUrl + '/';
    const url = `${base}?token=${encodeURIComponent(this.upstreamToken)}`;
    let upstreamReady = false;
    const queued: (string | Buffer)[] = [];

    const upstream = new (WS as any)(url) as WSConn;
    this.upstream = upstream;

    // Converts a ws-library payload to a string for re-sending as a TEXT
    // frame. Django Channels' UserChatConsumer.receive only accepts
    // `text_data` — sending a Buffer creates a BINARY frame and Django
    // raises `TypeError: receive() got an unexpected keyword argument
    // 'bytes_data'`. Connect's WS protocol is JSON/text only, so this is
    // always safe.
    const toText = (data: Buffer | string): string =>
      typeof data === 'string' ? data : data.toString('utf-8');

    upstream.on('open', () => {
      upstreamReady = true;
      // Drain any messages the browser sent before upstream connected.
      for (const data of queued) {
        try { upstream.send(toText(data)); } catch { /* swallow */ }
      }
      queued.length = 0;
    });

    upstream.on('message', (data: Buffer | string) => {
      if (!this.alive) return;
      if (this.downstream.readyState !== WS.OPEN) return;
      try { this.downstream.send(toText(data)); } catch { /* swallow */ }
    });

    upstream.on('close', (code: number, reason: Buffer) => {
      this.alive = false;
      try {
        if (this.downstream.readyState === WS.OPEN || this.downstream.readyState === WS.CONNECTING) {
          this.downstream.close(code || 1011, (reason && reason.toString()) || 'upstream closed');
        }
      } catch { /* swallow */ }
    });

    upstream.on('error', (_err: Error) => {
      // `close` follows; logged at the daemon for ops triage.
    });

    this.downstream.on('message', (data: Buffer | string) => {
      if (!this.alive) return;
      if (!upstreamReady) {
        queued.push(data);
        return;
      }
      try { upstream.send(toText(data)); } catch { /* swallow */ }
    });

    this.downstream.on('close', () => {
      this.alive = false;
      try { upstream.close(1000, 'downstream closed'); } catch { /* swallow */ }
    });

    this.downstream.on('error', () => {
      this.alive = false;
      try { upstream.close(1011, 'downstream error'); } catch { /* swallow */ }
    });
  }
}

// ── Per-connection channel ────────────────────────────────────────────────

class ConnectChannel implements ChannelLike {
  readonly channelName = `connect.${crypto.randomUUID()}`;
  private conversationGroups = new Set<string>();
  private userInboxGroup: string;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private alive = true;

  constructor(
    private ws: WSConn,
    private user: User,
    private isAgent: boolean,
    private deps: MiniConnectDeps,
  ) {
    this.userInboxGroup = `user_inbox_${user.id}`;
  }

  start(): void {
    this.joinAllGroups();
    this.deps.channelLayer.groupAdd(this.userInboxGroup, this);

    this.ws.on('message', (data: Buffer | string) => this.onClientMessage(data.toString()));
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', () => this.onClose());

    // Server-initiated keepalive: ping every 30s + refresh group memberships
    // every 5 minutes (10 ticks). Mirrors UserChatConsumer._keepalive_loop.
    let tick = 0;
    this.keepaliveTimer = setInterval(() => {
      if (!this.alive) return;
      tick++;
      try { this.ws.send(JSON.stringify({ type: 'ping' })); }
      catch { this.onClose(); return; }
      if (tick % 10 === 0) {
        try { this.joinAllGroups(); } catch { /* best-effort */ }
      }
    }, 30_000);
  }

  // Channel layer → us
  onEvent(event: ChannelEvent): void {
    if (!this.alive) return;
    try {
      switch (event.type) {
        case 'new_message':
          this.onNewMessage(event);
          break;
        case 'agent_stream_event':
          this.send({
            type: 'agent_stream',
            conversation_id: event.conversation_id,
            event_type: event.event_type,
            agent_id: event.agent_id,
            data: event.data,
          });
          break;
        case 'typing_indicator':
          if (event.user_id === this.user.id) return;
          this.send({
            type: 'typing',
            conversation_id: event.conversation_id,
            user_id: event.user_id,
            is_typing: event.is_typing,
          });
          break;
        case 'message_read_receipt':
          this.send({
            type: 'message_read',
            conversation_id: event.conversation_id,
            user_id: event.user_id,
            message_id: event.message_id,
          });
          break;
        case 'conversation_created':
          // Only forward if THIS user is a participant.
          if (Array.isArray(event.participant_user_ids)
              && (event.participant_user_ids as number[]).includes(this.user.id)) {
            const convId = event.conversation_id as string;
            const groupName = `chat_${convId}`;
            if (!this.conversationGroups.has(groupName)) {
              this.deps.channelLayer.groupAdd(groupName, this);
              this.conversationGroups.add(groupName);
            }
            this.send({
              type: 'conversation_created',
              conversation_id: convId,
              conversation: event.conversation,
            });
          }
          break;
      }
    } catch { /* don't break the broadcast */ }
  }

  private onNewMessage(event: ChannelEvent): void {
    // Self-echo suppression: same connection that sent the message.
    if (event.origin_channel === this.channelName) return;
    const msg = event.message_data as Record<string, unknown>;
    // Agent self-echo: agent receives broadcasts from any other path that
    // originated from itself (e.g. HTTP-posted DMs). Filter by sender_id.
    if (this.isAgent && msg && Number(msg.sender_id) === this.user.id) return;
    this.send({
      type: 'new_message',
      conversation_id: msg.conversation_id,
      message: msg,
    });
  }

  // Client → us
  private onClientMessage(text: string): void {
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { return; }
    const type = data.type;

    if (type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (type === 'send_message') {
      this.handleSendMessage(data);
      return;
    }
    if (type === 'stream_event') {
      // Only agents may send stream events (ephemeral, broadcast as agent_stream)
      if (!this.isAgent) return;
      this.handleStreamEvent(data);
      return;
    }
    if (type === 'typing_start' || type === 'typing_stop') {
      const convId = data.conversation_id as string | undefined;
      if (!convId) return;
      this.deps.channelLayer.groupSend(`chat_${convId}`, {
        type: 'typing_indicator',
        conversation_id: convId,
        user_id: this.user.id,
        is_typing: type === 'typing_start',
      });
      return;
    }
    if (type === 'message_read') {
      const convId = data.conversation_id as string | undefined;
      const messageId = data.message_id as string | undefined;
      if (!convId || !messageId) return;
      const newlyRead = this.deps.store.markAsRead(convId, this.user.id, messageId);
      const ids = newlyRead.length ? newlyRead : [messageId];
      for (const mid of ids) {
        this.deps.channelLayer.groupSend(`chat_${convId}`, {
          type: 'message_read_receipt',
          conversation_id: convId,
          user_id: this.user.id,
          message_id: mid,
        });
      }
      return;
    }
  }

  private handleSendMessage(data: Record<string, unknown>): void {
    const convId = data.conversation_id as string | undefined;
    const content = typeof data.content === 'string' ? data.content.trim() : '';
    const clientMessageId = (data.client_message_id as string) ?? null;

    if (!convId || !content) {
      this.send({
        type: 'send_error',
        conversation_id: convId ?? '',
        client_message_id: clientMessageId,
        error: 'conversation_id and content are required',
      });
      return;
    }
    if (!this.deps.store.isParticipant(convId, this.user.id)) {
      this.send({
        type: 'send_error',
        conversation_id: convId,
        client_message_id: clientMessageId,
        error: 'conversation_not_found_or_not_participant',
      });
      return;
    }

    const msg = this.deps.store.createMessage({
      conversationId: convId,
      senderId: this.user.id,
      senderIsAgent: this.isAgent,
      agentId: this.isAgent ? this.user.agentId : null,
      content,
      clientMessageId,
    });
    this.deps.channelLayer.groupSend(`chat_${convId}`, {
      type: 'new_message',
      message_data: serializeMessage(msg),
      origin_channel: this.channelName,
    });
  }

  private handleStreamEvent(data: Record<string, unknown>): void {
    const convId = data.conversation_id as string | undefined;
    const eventType = data.event_type as string | undefined;
    if (!convId || !eventType) return;

    // `complete` persists as a DirectMessage; everything else is broadcast
    // ephemerally as agent_stream.
    if (eventType === 'complete') {
      const payload = (data.data as Record<string, unknown>) ?? {};
      const content = typeof payload.content === 'string' ? payload.content : '';
      if (!content) return;
      if (!this.deps.store.isParticipant(convId, this.user.id)) return;
      const msg = this.deps.store.createMessage({
        conversationId: convId,
        senderId: this.user.id,
        senderIsAgent: true,
        agentId: this.user.agentId,
        content,
        clientMessageId: (payload.client_message_id as string) ?? null,
      });
      this.deps.channelLayer.groupSend(`chat_${convId}`, {
        type: 'new_message',
        message_data: serializeMessage(msg),
        origin_channel: this.channelName,
      });
      return;
    }

    // session_start / content / reasoning / tool_start / tool_complete / error
    this.deps.channelLayer.groupSend(`chat_${convId}`, {
      type: 'agent_stream_event',
      conversation_id: convId,
      event_type: eventType,
      agent_id: this.user.agentId,
      data: data.data ?? {},
    });
  }

  private joinAllGroups(): void {
    const conversations = this.deps.store.listUserConversations(this.user.id);
    for (const c of conversations) {
      const group = `chat_${c.id}`;
      this.deps.channelLayer.groupAdd(group, this);
      this.conversationGroups.add(group);
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws.readyState !== WS.OPEN) return;
    try { this.ws.send(JSON.stringify(payload)); } catch { /* swallow */ }
  }

  private onClose(): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    this.deps.channelLayer.removeChannel(this);
    try { this.ws.close(); } catch { /* swallow */ }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Look up `participant_type` ('human' | 'agent' | 'system') for each user. */
function participantTypeMap(store: ConnectStore, userIds: number[]): Record<number, 'human' | 'agent' | 'system'> {
  const out: Record<number, 'human' | 'agent' | 'system'> = {};
  for (const uid of userIds) {
    const u = store.getUserById(uid);
    out[uid] = u?.isAgent ? 'agent' : 'human';
  }
  return out;
}

/** Look up `agent_id` (UUID) for each user that's an agent. */
function participantAgentIdMap(store: ConnectStore, userIds: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const uid of userIds) {
    const u = store.getUserById(uid);
    if (u?.isAgent && u.agentId) out[uid] = u.agentId;
  }
  return out;
}

function broadcastConversationCreated(deps: MiniConnectDeps, conv: Conversation): void {
  const participants = deps.store.listParticipants(conv.id);
  const participantUserIds = participants.map(p => p.userId);
  const payload = {
    type: 'conversation_created',
    conversation_id: conv.id,
    conversation: {
      ...serializeConversation(conv),
      participants: participants.map(serializeParticipant),
    },
    participant_user_ids: participantUserIds,
  };
  for (const p of participants) {
    deps.channelLayer.groupSend(`user_inbox_${p.userId}`, payload);
  }
}

function requireBearer(req: FastifyRequest, deps: MiniConnectDeps): User | null {
  const token = extractBearerFromHeader(req.headers.authorization);
  if (!token) return null;
  const claims = deps.auth.verify(token);
  if (!claims || claims.token_type !== 'access') return null;
  return deps.store.getUserById(claims.user_id);
}

function extractBearerFromHeader(header: string | string[] | undefined): string | null {
  if (!header || Array.isArray(header)) return null;
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function serializeUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    is_agent: u.isAgent,
    agent_id: u.agentId,
    display_name: u.displayName,
  };
}

function serializeConversation(c: Conversation) {
  return {
    id: c.id,
    conversation_type: c.conversationType,
    name: c.name,
    direct_key: c.directKey,
    created_by_id: c.createdById,
    message_count: c.messageCount,
    last_message_at: c.lastMessageAt,
    last_message_preview: c.lastMessagePreview,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

function serializeParticipant(p: Participant) {
  return {
    id: p.id,
    conversation_id: p.conversationId,
    user_id: p.userId,
    participant_type: p.participantType,
    agent_id: p.agentId,
    is_admin: p.isAdmin,
    last_read_at: p.lastReadAt,
    unread_count: p.unreadCount,
    has_left: p.hasLeft,
    joined_at: p.joinedAt,
  };
}

function serializeMessage(m: DirectMessage) {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    sender_id: m.senderId,
    sender_is_agent: m.senderIsAgent,
    agent_id: m.agentId,
    content: m.content,
    client_message_id: m.clientMessageId,
    seq_num: m.seqNum,
    created_at: m.createdAt,
    edited_at: m.editedAt,
    is_deleted: m.isDeleted,
  };
}
