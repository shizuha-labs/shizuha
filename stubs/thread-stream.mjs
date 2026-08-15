// thread-stream stub — pino dependency that uses worker_threads.
// Not needed since our pino stub uses console directly.
import { Writable } from 'node:stream';
export default class ThreadStream extends Writable {
  constructor(_opts) { super(); }
  _write(chunk, _enc, cb) { process.stderr.write(chunk); cb(); }
  flushSync() {}
  end() { super.end(); }
}
