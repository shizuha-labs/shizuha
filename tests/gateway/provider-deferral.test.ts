import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../src/state/store.js';
import { typedProviderDeferral } from '../../src/gateway/provider-deferral.js';
import type { InboundMessage } from '../../src/gateway/types.js';

vi.mock('../../src/platform/connect-dm.js', () => ({ sendConnectDm: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { AgentProcess } = await import('../../src/gateway/agent-process.js');
const { VLlmProvider } = await import('../../src/provider/vllm.js');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'provider-deferred-')); dirs.push(cwd);
  const config = { channels: [], model: 'fixture-model', cwd, permissionMode: 'autonomous' as const, agentId: 'provider-deferred-fixture' };
  const channel: any = { id: 'connect', type: 'connect', start: vi.fn(), stop: vi.fn(),
    sendEvent: vi.fn(async () => {}), sendComplete: vi.fn(), ackProcessed: vi.fn(async () => true) };
  const agent: any = new AgentProcess(config); agent.registerChannel(channel);
  agent.store = new StateStore(path.join(cwd, 'state.db')); agent.loadEternalSession();
  agent.running = true;
  return { agent, channel, config, cwd };
}
function message(id: string): InboundMessage { return { id, channelId: 'connect', channelType: 'connect', threadId: 'thread-'+id,
  userId: 'fixture-user', userName: 'fixture-user', content: 'Implement the requested change.', timestamp: Date.now(), source: 'user' }; }

describe('Gateway typed provider admission deferral', () => {
  it('retains and does not acknowledge a real temporary residency refusal', async () => {
    const { agent, channel } = fixture();
    const requests: any[] = [];
    let failing = true;
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({data:[]})); return; }
      let text=''; for await (const part of req) text += part;
      requests.push({body:JSON.parse(text), at:Date.now()});
      if (!failing) { res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: '+JSON.stringify({choices:[{delta:{content:'healthy'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'); return; }
      res.writeHead(503, { 'content-type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: { type: 'residency_full', code: 'residency_ttl_protected', message: 'Fixture residency occupied' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const provider = new VLlmProvider(`http://127.0.0.1:${(server.address() as any).port}`, 128000, 'fixture', 'cortex');
    agent.provider = provider;
    agent.executeTurns = async () => { for await (const _ of provider.chat([{ role:'user', content:'fixture' }], { model:'fixture-model', maxTokens:100 })) {} return false; };
    const input=message('first');
    try {
      await agent.processInboxMessage(input);
      expect(requests).toHaveLength(1);
      expect(channel.ackProcessed).not.toHaveBeenCalled();
      expect(agent.store.inboundProcessingCompleted(agent.sessionId,input.id)).toBe(false);
      expect(agent.inbox.queued()).toContainEqual(input);
      expect(agent.messages.filter((m:any) => m.operationalEvent)).toHaveLength(0);
      expect(channel.sendComplete).not.toHaveBeenCalled();
      const deadline=agent.store.providerDeferral(agent.providerDeferralOwner(),provider.name,'fixture-model').notBefore;
      failing=false;
      agent.inbox.push(message('second'));
      const replay=agent.processNextInboxMessage();
      await new Promise(resolve=>setTimeout(resolve,40));
      expect(requests).toHaveLength(1); // no queued row bypasses the advertised bound
      expect(channel.ackProcessed).not.toHaveBeenCalled();
      expect(agent.isBusy()).toBe(false);
      await replay;
      expect(requests[1].at).toBeGreaterThanOrEqual(deadline);
      expect(channel.ackProcessed.mock.calls.map((call:any[])=>call[0])).toEqual(['first']);
      await agent.processNextInboxMessage();
      expect(requests).toHaveLength(3);
      expect(channel.ackProcessed.mock.calls.map((call:any[])=>call[0])).toEqual(['first','second']);
      expect(agent.messages.filter((m:any)=>m.role==='user'&&m.id==='first')).toHaveLength(1);
      expect(agent.store.pendingProviderInputs(agent.providerDeferralOwner())).toEqual([]);

    } finally { agent.store.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('resumes an admitted routine notification before cron and heartbeat can displace it', async () => {
    const {agent,channel}=fixture();agent.provider={name:'fixture-provider'};
    agent.registerChannel({...channel,id:'http-default',type:'http',ackProcessed:undefined});
    const original={...message('routine-pending'),content:'[system] [Task Assigned] FIX-123',
      metadata:{schedulerClass:'routine-task',schedulerTaskKey:'FIX-123'}};
    const attempts:string[]=[];let refuse=true;
    agent.executeTurns=vi.fn(async(msg:InboundMessage)=>{attempts.push(msg.id);
      if(refuse)throw Object.assign(new Error('fixture residency occupied'),{status:503,residencyFull:true,retryInMs:1});
      return false;
    });
    try {
      agent.inbox.push(original);await agent.processNextInboxMessage();
      const cron={...message('queued-cron'),source:'cron',channelId:'http-default',channelType:'http'};
      agent.inbox.push(cron);
      await expect(agent.processNextInboxMessage()).resolves.toBeUndefined();
      expect(attempts).toEqual(['routine-pending','routine-pending']);
      expect(channel.ackProcessed).not.toHaveBeenCalled();
      agent.inbox.push({...message('queued-heartbeat'),source:'heartbeat',channelId:'http-default',channelType:'http'});
      refuse=false;await agent.processNextInboxMessage();
      expect(attempts).toEqual(['routine-pending','routine-pending','routine-pending']);
      expect(channel.ackProcessed.mock.calls.map((call:any[])=>call[0])).toEqual(['routine-pending']);
      expect(agent.store.pendingProviderInputs(agent.providerDeferralOwner())).toEqual([]);
      await agent.processNextInboxMessage();await agent.processNextInboxMessage();
      expect(attempts.slice(3)).toEqual(['queued-heartbeat','queued-cron']);
      expect(agent.messages.filter((m:any)=>m.role==='user'&&m.id===original.id)).toHaveLength(1);
    } finally {agent.store.close();}
  });

  it('preserves a restored admitted notification across same-task coalescing and heartbeat drop', async () => {
    const original=fixture();const first=original.agent;first.provider={name:'fixture-provider'};
    const input={...message('restored-routine'),content:'[system] [Task Assigned] FIX-456',
      metadata:{schedulerClass:'routine-task',schedulerTaskKey:'FIX-456'}};
    first.executeTurns=vi.fn().mockRejectedValue(Object.assign(new Error('fixture pause'),
      {status:503,residencyFull:true,retryInMs:20}));
    await first.processInboxMessage(input);first.store.close();
    const current:any=new AgentProcess(original.config);current.registerChannel(original.channel);
    current.store=new StateStore(path.join(original.cwd,'state.db'));current.loadEternalSession();
    current.provider={name:'fixture-provider'};current.running=true;current.executeTurns=vi.fn(async()=>false);
    current.registerChannel({...original.channel,id:'http-default',type:'http',ackProcessed:undefined});
    try {
      current.restoreProviderDeferredInputs();
      current.inbox.push({...input,id:'new-unadmitted-hint'});
      current.inbox.push({...message('restart-heartbeat'),source:'heartbeat',channelId:'http-default',channelType:'http'});
      expect(current.inbox.peek().id).toBe(input.id);
      expect(current.inbox.queued().map((row:InboundMessage)=>row.id)).toContain(input.id);
      expect(current.inbox.queued().map((row:InboundMessage)=>row.id)).toContain('new-unadmitted-hint');
      await current.processNextInboxMessage();
      expect(current.executeTurns.mock.calls[0][0].id).toBe(input.id);
      expect(original.channel.ackProcessed.mock.calls.map((call:any[])=>call[0])).toEqual([input.id]);
      await current.processNextInboxMessage();
      expect(current.executeTurns.mock.calls.map((call:any[])=>call[0].id)).toEqual([input.id,'restart-heartbeat']);
      expect(current.inbox.depth).toBe(0); // only the unadmitted hint was dropped
      expect(current.store.pendingProviderInputs(current.providerDeferralOwner())).toEqual([]);
    } finally {current.store.close();}
  });

  it('pins a maintenance-refused admitted row and re-arms it after drain without admitting cron', async () => {
    const {agent,channel}=fixture();agent.provider={name:'fixture-provider'};
    agent.registerChannel({...channel,id:'http-default',type:'http',ackProcessed:undefined});
    const original={...message('maintenance-routine'),content:'[system] [Task Assigned] FIX-789',
      metadata:{schedulerClass:'routine-task',schedulerTaskKey:'FIX-789'}};
    let refuse=true;
    agent.refreshStaleFirstTurnPrewarmBeforeWork=vi.fn(async()=>{
      if(!refuse)return true;
      agent.store.deferProviderAdmission(agent.providerDeferralOwner(),'fixture-provider','fixture-model',
        Date.now()+50,'residency_full');return false;
    });
    agent.executeTurns=vi.fn(async()=>false);
    try {
      await agent.processInboxMessage(original);
      agent.inbox.push({...message('after-drain-cron'),source:'cron',channelId:'http-default',channelType:'http'});
      const waiting=agent.processNextInboxMessage();
      agent.armRuntimeRollDrain({requestId:'fixture-drain',targetImage:'fixture:next',leaseMs:1000});
      await waiting;
      expect(agent.executeTurns).not.toHaveBeenCalled();expect(channel.ackProcessed).not.toHaveBeenCalled();
      expect(agent.store.pendingProviderInputs(agent.providerDeferralOwner())[0].messageId).toBe(original.id);
      agent.runtimeRollDrain.dispose();refuse=false;
      await agent.processNextInboxMessage();
      expect(agent.executeTurns.mock.calls[0][0].id).toBe(original.id);
      expect(channel.ackProcessed.mock.calls.map((call:any[])=>call[0])).toEqual([original.id]);
      await agent.processNextInboxMessage();
      expect(agent.executeTurns.mock.calls[1][0].id).toBe('after-drain-cron');
      expect(agent.store.pendingProviderInputs(agent.providerDeferralOwner())).toEqual([]);
    } finally {agent.store.close();}
  });

  it('rehydrates exact pending input/deadline and deduplicates upstream replay in a fresh process', async () => {
    const original=fixture(); let first=original.agent;
    const input=message('restart-pending');
    const retry=Object.assign(new Error('fixture temporary'),{status:503,residencyFull:true,retryInMs:250});
    first.provider={name:'fixture-provider'};
    first.executeTurns=vi.fn().mockRejectedValue(retry);
    await first.processInboxMessage(input);
    const saved=first.store.providerDeferral(first.providerDeferralOwner(),'fixture-provider','fixture-model');
    expect(original.channel.ackProcessed).not.toHaveBeenCalled();
    first.store.close();
    const current:any=new AgentProcess(original.config);current.registerChannel(original.channel);
    current.store=new StateStore(path.join(original.cwd,'state.db'));current.loadEternalSession();
    current.provider={name:'fixture-provider'};current.running=true;current.executeTurns=vi.fn(async()=>false);
    current.inbox.push({...input}); // natural unacknowledged Connect replay
    current.restoreProviderDeferredInputs();
    try {
      const run=current.processNextInboxMessage();
      await new Promise(resolve=>setTimeout(resolve,20));
      expect(current.executeTurns).not.toHaveBeenCalled();
      await run;
      expect(Date.now()).toBeGreaterThanOrEqual(saved.notBefore);
      await current.processNextInboxMessage();
      expect(current.executeTurns).toHaveBeenCalledTimes(1);
      expect(original.channel.ackProcessed).toHaveBeenCalledTimes(2);
      expect(current.store.inboundProcessingCompleted(current.sessionId,input.id)).toBe(true);
      expect(current.messages.filter((m:any)=>m.role==='user'&&m.id===input.id)).toHaveLength(1);
    } finally {current.store.close();}
  });

  it('stop interrupts the wait without completing or deleting durable input', async () => {
    const {agent,channel,cwd}=fixture();agent.provider={name:'fixture-provider'};
    agent.executeTurns=vi.fn().mockRejectedValue(Object.assign(new Error('fixture pause'),{status:503,maintenance:true,retryInMs:300_000}));
    const input=message('stop-pending');await agent.processInboxMessage(input);
    const owner=agent.providerDeferralOwner();const waiting=agent.processNextInboxMessage();
    await new Promise(resolve=>setTimeout(resolve,10));await agent.stop();await waiting;
    expect(channel.ackProcessed).not.toHaveBeenCalled();
    const store=new StateStore(path.join(cwd,'state.db'));
    try {expect(JSON.parse(store.pendingProviderInputs(owner)[0]!.payload)).toEqual(input);
      expect(store.providerDeferral(owner,'fixture-provider','fixture-model')!.notBefore).toBeGreaterThan(Date.now());
    } finally {store.close();}
  });

  it('drain interrupts an idle wait and allows normal release to re-arm the same deadline', async () => {
    const {agent}=fixture();agent.provider={name:'fixture-provider'};
    agent.executeTurns=vi.fn().mockRejectedValue(Object.assign(new Error('fixture pause'),{status:503,providerPoolDry:true,retryInMs:150}));
    await agent.processInboxMessage(message('drain-pending'));
    const waiting=agent.processNextInboxMessage();await new Promise(resolve=>setTimeout(resolve,10));
    agent.armRuntimeRollDrain({requestId:'fixture-drain',targetImage:'fixture:next',leaseMs:1000});
    await waiting;expect(agent.inbox.depth).toBe(1);expect(agent.isBusy()).toBe(false);
    agent.runtimeRollDrain.dispose();
    agent.executeTurns=vi.fn(async()=>false);await agent.processNextInboxMessage();
    expect(agent.executeTurns).toHaveBeenCalledTimes(1);agent.store.close();
  });

  it('keeps model scopes separate and preserves the old deadline through a healthy different model', async () => {
    const {agent,channel}=fixture();agent.provider={name:'fixture-provider'};
    agent.executeTurns=vi.fn().mockRejectedValue(Object.assign(new Error('fixture pause'),{status:503,modelLeased:true,retryInMs:300_000}));
    await agent.processInboxMessage(message('scope-pending'));
    const saved=agent.store.providerDeferral(agent.providerDeferralOwner(),'fixture-provider','fixture-model');
    agent.model='different-model';agent.executeTurns=vi.fn(async()=>false);await agent.processNextInboxMessage();
    expect(channel.ackProcessed).toHaveBeenCalledTimes(1);
    expect(agent.store.pendingProviderInputs(agent.providerDeferralOwner())).toEqual([]);
    expect(agent.store.providerDeferral(agent.providerDeferralOwner(),'fixture-provider','fixture-model').notBefore).toBe(saved.notBefore);
    agent.store.close();
  });

  it('re-arms a new provider deadline after healthy completion', async () => {
    const {agent,channel}=fixture();agent.provider={name:'fixture-provider'};
    agent.executeTurns=vi.fn().mockRejectedValueOnce(Object.assign(new Error('first pause'),{status:503,residencyFull:true,retryInMs:20})).mockResolvedValueOnce(false)
      .mockRejectedValueOnce(Object.assign(new Error('second pause'),{status:503,residencyFull:true,retryInMs:80})).mockResolvedValueOnce(false);
    await agent.processInboxMessage(message('first-bound'));await agent.processNextInboxMessage();
    agent.inbox.push(message('second-bound'));await agent.processNextInboxMessage();
    const saved=agent.store.providerDeferral(agent.providerDeferralOwner(),'fixture-provider','fixture-model');
    expect(saved.messageId).toBe('second-bound');expect(channel.ackProcessed).toHaveBeenCalledTimes(1);
    await agent.processNextInboxMessage();expect(Date.now()).toBeGreaterThanOrEqual(saved.notBefore);
    expect(channel.ackProcessed).toHaveBeenCalledTimes(2);agent.store.close();
  });

  it('does not turn generic, authentication, or malformed failures into automatic retries', async () => {
    for (const error of [Object.assign(new Error('residency_full text is not authority'),{status:503,retryInMs:100}),
      Object.assign(new Error('authentication denied'),{status:401,residencyFull:true,retryInMs:100}),
      Object.assign(new Error('malformed delay'),{status:503,residencyFull:true,retryInMs:NaN})]) {
      const {agent,channel}=fixture();agent.provider={name:'fixture-provider'};agent.executeTurns=vi.fn().mockRejectedValue(error);
      await agent.processInboxMessage(message('terminal'));
      expect(channel.ackProcessed).toHaveBeenCalledTimes(1);
      expect(agent.store.pendingProviderInputs(agent.providerDeferralOwner())).toEqual([]);
      expect(agent.messages.some((m:any)=>m.operationalEvent)).toBe(true);agent.store.close();
    }
    for (const retryInMs of [undefined,'100',0,-1,Infinity,NaN]) {
      expect(typedProviderDeferral({status:503,residencyFull:true,retryInMs})).toBeNull();
    }
  });

  it('persists an opt-in startup warmup refusal before allowing the first queued input', async () => {
    const {agent,channel}=fixture();const before={...process.env};
    process.env.SHIZUHA_PREWARM_ENABLE='1';process.env.SHIZUHA_PREWARM_MIN_TOKENS='1';
    agent.model='GLM-5.3-Flash';agent.messages.push({role:'user',content:'Existing retained context. '.repeat(1500)});
    let calls=0;
    const provider={name:'cortex',supportsTools:true,maxContextWindow:500000,async *chat(){calls++;
      throw Object.assign(new Error('warmup refused'),{status:503,residencyFull:true,retryInMs:120});yield {type:'done'};
    }};
    agent.provider=provider;
    try {
      expect(await agent.prewarmPrefixCache(agent.model,provider,{reason:'restart'})).toBe(false);
      const saved=agent.store.providerDeferral(agent.providerDeferralOwner(),'cortex',agent.model);
      expect(saved.notBefore).toBeGreaterThan(Date.now());expect(saved.payload).toBeNull();
      agent.executeTurns=vi.fn(async()=>false);agent.inbox.push(message('after-warmup'));
      const work=agent.processNextInboxMessage();await new Promise(resolve=>setTimeout(resolve,10));
      expect(agent.executeTurns).not.toHaveBeenCalled();await work;
      expect(Date.now()).toBeGreaterThanOrEqual(saved.notBefore);expect(calls).toBe(1);
      expect(channel.ackProcessed).toHaveBeenCalledTimes(1);
    } finally { process.env=before;agent.store.close(); }
  });

  it('fails closed on malformed durable payload and refuses overwriting a pending different input', () => {
    const {agent}=fixture();const owner=agent.providerDeferralOwner();
    try {
      agent.store.deferProviderInput(owner,'fixture','fixture-model',Date.now()+1000,'residency_full','original','{malformed');
      expect(()=>agent.restoreProviderDeferredInputs()).toThrow();expect(agent.inbox.depth).toBe(0);
      expect(()=>agent.store.deferProviderInput(owner,'fixture','fixture-model',Date.now()+1000,'residency_full','different',JSON.stringify(message('different')))).toThrow('Another provider input');
      expect(agent.store.pendingProviderInputs(owner)[0].messageId).toBe('original');
    } finally {agent.store.close();}
  });

});
