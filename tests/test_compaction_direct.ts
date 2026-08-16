/**
 * Direct compaction integration test.
 * Feeds a pre-built oversized conversation to compactMessages()
 * using the LlamaCpp provider pointed at the phone's llama-server.
 *
 * Run: LLAMACPP_BASE_URL=http://127.0.0.1:18080 npx tsx /tmp/test_compaction_direct.ts
 */

import { LlamaCppProvider } from '../src/provider/llamacpp.js';
import { compactMessages } from '../src/state/compaction.js';
import { estimateTokens, needsCompaction, getSafetyFactor } from '../src/prompt/context.js';
import type { Message } from '../src/agent/types.js';

const LLAMA_URL = process.env['LLAMACPP_BASE_URL'] ?? 'http://127.0.0.1:18080';

// Context size: override via env or default to 8K
const CTX_SIZE = process.env['CTX_SIZE'] ? parseInt(process.env['CTX_SIZE'], 10) : 8192;
const MODEL = 'llamacpp/local';

async function main() {
  console.log('='.repeat(60));
  console.log('  Direct Compaction Integration Test');
  console.log('  LlamaCpp @', LLAMA_URL, '| Context:', CTX_SIZE);
  console.log('='.repeat(60));
  console.log();

  // 1. Verify safety factor
  const sf = getSafetyFactor(MODEL);
  console.log(`Safety factor for "${MODEL}": ${sf} (expected 1.2)`);
  if (sf !== 1.2) {
    console.error('FAIL: Wrong safety factor!');
    process.exit(1);
  }

  // 2. Create provider
  const provider = new LlamaCppProvider(LLAMA_URL, CTX_SIZE);
  console.log(`Provider: maxContextWindow=${provider.maxContextWindow}`);

  // 3. Build a conversation that exceeds 90% of 8K context
  // We need messages totaling > 7373 tokens (90% of 8192)
  // Tool overhead is 0 since we're calling compactMessages directly (no tools)
  // So we just need raw message tokens > 7373
  const messages: Message[] = [];

  // Add enough conversation to exceed threshold
  const topics = [
    { q: 'Explain how Python garbage collection works with reference counting and generational GC.',
      a: 'Python uses a combination of reference counting and generational garbage collection. Reference counting tracks how many references point to each object - when the count drops to zero, memory is freed immediately. However, reference counting cannot detect circular references (A references B, B references A). To handle these, Python employs a generational garbage collector that periodically scans objects in three generations. New objects start in generation 0. Objects that survive a collection cycle are promoted to the next generation. Generation 0 is collected most frequently, while generation 2 is collected rarely. The gc module allows you to control collection thresholds and manually trigger collection cycles.' },
    { q: 'How does the TCP three-way handshake work and why is it necessary?',
      a: 'The TCP three-way handshake establishes a reliable connection between client and server through three steps. First, the client sends a SYN (synchronize) packet with an initial sequence number to the server. Second, the server responds with a SYN-ACK packet that acknowledges the client sequence number and provides its own initial sequence number. Third, the client sends an ACK acknowledging the server sequence number. This process is necessary because TCP provides reliable, ordered delivery of data. Both sides need to agree on initial sequence numbers to track data segments and detect lost packets. Without this handshake, either side could start sending data before the other is ready, leading to lost data or connection confusion.' },
    { q: 'Describe the differences between B-trees and B+ trees for database indexing.',
      a: 'B-trees and B+ trees are both balanced search trees used in database indexing, but they have key structural differences. In a B-tree, both internal nodes and leaf nodes can store actual data records alongside keys. In a B+ tree, only leaf nodes contain data records - internal nodes only store keys used for routing. B+ trees have all leaf nodes linked together in a doubly-linked list, enabling efficient range queries by simply traversing the leaf level. This linked list structure is absent in standard B-trees. B+ trees typically have a higher branching factor because internal nodes only store keys, making the tree shorter and reducing disk I/O. For point queries, B-trees might be slightly faster if the key is found in an internal node. But for range scans and sequential access patterns common in databases, B+ trees are significantly more efficient.' },
    { q: 'Explain the CAP theorem and give examples of systems that prioritize different properties.',
      a: 'The CAP theorem states that a distributed system can only guarantee two out of three properties: Consistency (all nodes see the same data at the same time), Availability (every request receives a response), and Partition tolerance (the system continues operating despite network partitions). Since network partitions are inevitable in distributed systems, the real choice is between consistency and availability during a partition. CP systems prioritize consistency - examples include HBase, MongoDB with majority write concern, and ZooKeeper. During a partition, they may reject requests to maintain consistency. AP systems prioritize availability - examples include Cassandra, DynamoDB, and CouchDB. They continue serving requests during partitions but may return stale data. The PACELC extension adds that even without partitions, systems must choose between latency and consistency.' },
    { q: 'How does the Linux kernel scheduler work with CFS and process priorities?',
      a: 'The Linux Completely Fair Scheduler (CFS) uses a red-black tree to manage runnable processes, with the key being virtual runtime (vruntime). Each process accumulates vruntime as it runs, weighted by its nice value. Lower nice values (higher priority) accumulate vruntime more slowly, giving them more actual CPU time. CFS always picks the process with the smallest vruntime to run next, ensuring fairness. The scheduler maintains a minimum granularity to prevent excessive context switching. For real-time tasks, Linux provides SCHED_FIFO and SCHED_RR policies that preempt CFS tasks. SCHED_FIFO runs until completion or voluntary yield. SCHED_RR adds time slicing among equal-priority real-time tasks. Control groups (cgroups) allow hierarchical CPU allocation, where each group gets a fair share of CPU time distributed among its processes.' },
    { q: 'Explain how hash tables handle collisions using chaining and open addressing.',
      a: 'Hash tables handle collisions through two main strategies. Chaining (separate chaining) stores colliding entries in a linked list (or other data structure) at each bucket. When a collision occurs, the new entry is appended to the list. Lookup requires traversing the list to find the matching key. The load factor can exceed 1.0 since lists can grow indefinitely. Open addressing stores all entries directly in the array. When a collision occurs, it probes for the next empty slot using a probing sequence. Linear probing checks consecutive slots, which is cache-friendly but causes clustering. Quadratic probing uses a quadratic function to spread entries more evenly. Double hashing uses a second hash function for the probe step size. Open addressing requires the load factor to stay below 1.0 and typically triggers rehashing at 0.7-0.8. Rehashing creates a larger array and reinserts all entries, an O(n) operation amortized over many insertions.' },
    { q: 'Describe how modern CPUs use branch prediction and speculative execution.',
      a: 'Modern CPUs predict the outcome of conditional branches before they are resolved to keep the pipeline full. Static prediction uses simple heuristics like always predicting backward branches as taken (for loops). Dynamic prediction uses hardware structures: the Branch Target Buffer (BTB) caches target addresses of recent branches, and pattern history tables track branch outcomes. Two-level adaptive predictors correlate branch behavior with global or local history, achieving 95-97% accuracy. When a branch is predicted, the CPU speculatively executes instructions along the predicted path. The reorder buffer (ROB) tracks these speculative instructions. If the prediction was correct, results are committed in order. If wrong, all speculative work is flushed and execution restarts from the correct path - this is called a pipeline flush or branch misprediction penalty, typically 15-25 cycles on modern processors. The Spectre vulnerability exploited speculative execution to leak data through cache side channels.' },
    { q: 'How does TLS 1.3 improve upon TLS 1.2 in terms of the handshake and security?',
      a: 'TLS 1.3 dramatically improves upon TLS 1.2 in both performance and security. The handshake is reduced from two round trips to one: the client sends a ClientHello with key shares for supported groups, and the server responds with its key share and encrypted extensions in a single flight. This enables 1-RTT handshakes, and with pre-shared keys, even 0-RTT resumption (though 0-RTT data is vulnerable to replay attacks). Security improvements include removing weak algorithms: no more RC4, DES, 3DES, static RSA key exchange, or CBC mode ciphers. Only AEAD cipher suites are allowed (AES-GCM, ChaCha20-Poly1305). Forward secrecy is mandatory - all key exchanges use ephemeral Diffie-Hellman. The handshake is encrypted earlier, with server certificates now encrypted. Compression is removed to prevent CRIME-style attacks. The renegotiation feature is eliminated, closing a class of vulnerabilities. Session tickets are encrypted to prevent tracking.' },
  ];

  for (const { q, a } of topics) {
    messages.push({ role: 'user', content: q });
    messages.push({ role: 'assistant', content: a });
  }

  // 4. Check token counts
  const rawTokens = estimateTokens(messages, MODEL);
  const adjustedTokens = Math.ceil(rawTokens * sf);
  const threshold = CTX_SIZE * 0.90;
  console.log();
  console.log(`Messages: ${messages.length} (${topics.length} Q&A pairs)`);
  console.log(`Raw tokens: ${rawTokens}`);
  console.log(`Adjusted tokens (×${sf}): ${adjustedTokens}`);
  console.log(`Threshold (90% of ${CTX_SIZE}): ${threshold}`);
  console.log(`Needs compaction: ${adjustedTokens > threshold}`);
  console.log();

  if (adjustedTokens <= threshold) {
    console.log('WARNING: Messages below threshold, adding padding...');
    const filler = 'The implementation involves careful consideration of memory allocation strategies, thread synchronization primitives, lock-free data structures, cache coherence protocols, and various optimization techniques including loop unrolling, branch prediction hints, SIMD vectorization, and profile-guided optimization. Modern systems employ sophisticated algorithms for resource management, scheduling, and load balancing across heterogeneous computing units. ';
    let padIdx = 0;
    while (estimateTokens(messages, MODEL) < threshold + 500) {
      padIdx++;
      messages.push({ role: 'user', content: `Explain more about advanced topic ${padIdx}: distributed computing patterns, consensus algorithms, and performance optimization across heterogeneous clusters.` });
      messages.push({ role: 'assistant', content: filler.repeat(8) });
    }
    const newRaw = estimateTokens(messages, MODEL);
    console.log(`After padding: ${messages.length} msgs, ${newRaw} raw tokens`);
  }

  // 5. Verify needsCompaction returns true
  const shouldCompact = needsCompaction(messages, CTX_SIZE, MODEL, 0);
  console.log(`needsCompaction() = ${shouldCompact}`);
  if (!shouldCompact) {
    console.error('FAIL: needsCompaction should be true!');
    process.exit(1);
  }

  // 6. Run compactMessages — THIS IS THE REAL TEST
  console.log();
  console.log('─'.repeat(60));
  console.log('  Calling compactMessages() — this sends to llama-server');
  console.log('  Expected: LLM generates a summary, returns compacted messages');
  console.log('─'.repeat(60));
  console.log();

  const startTime = Date.now();
  try {
    const result = await compactMessages(
      messages,
      provider,
      MODEL,
      CTX_SIZE,
      { force: false, overheadTokens: 0 },
    );

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`\nCompaction completed in ${elapsed.toFixed(1)}s`);
    console.log(`Compacted: ${result.compacted}`);
    console.log(`Original messages: ${messages.length}`);
    console.log(`Compacted messages: ${result.messages.length}`);

    if (result.compacted) {
      // Show the summary
      const summaryMsg = result.messages[0];
      const summaryText = typeof summaryMsg?.content === 'string'
        ? summaryMsg.content
        : JSON.stringify(summaryMsg?.content);
      console.log(`\nSummary message (first ${Math.min(500, summaryText.length)} chars):`);
      console.log(summaryText.slice(0, 500));

      // Check post-compaction token count
      const compactedTokens = estimateTokens(result.messages, MODEL);
      console.log(`\nPost-compaction tokens: ${compactedTokens} (was ${rawTokens})`);
      console.log(`Reduction: ${((1 - compactedTokens / rawTokens) * 100).toFixed(0)}%`);

      const stillNeedsCompaction = needsCompaction(result.messages, CTX_SIZE, MODEL, 0);
      console.log(`Still needs compaction: ${stillNeedsCompaction} (should be false)`);

      console.log('\n✅ COMPACTION WORKS END-TO-END!');
    } else {
      console.error('\n❌ FAIL: compactMessages returned compacted=false');
    }
  } catch (err) {
    const elapsed = (Date.now() - startTime) / 1000;
    console.error(`\n❌ FAIL after ${elapsed.toFixed(1)}s: ${(err as Error).message}`);
    console.error((err as Error).stack);
  }
}

main().catch(console.error);
