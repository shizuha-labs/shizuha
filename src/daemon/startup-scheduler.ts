/**
 * Launch independent daemon startup work without starving already-listening
 * control-plane sockets. Each launch gets its own event-loop turn, while the
 * returned promises still run concurrently after their first asynchronous
 * boundary.
 */
export async function launchConcurrentlyWithIoYield<T>(
  items: readonly T[],
  launch: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const pending: Promise<void>[] = [];
  for (const item of items) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.push(launch(item));
  }
  return Promise.allSettled(pending);
}
