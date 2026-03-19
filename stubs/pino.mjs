/**
 * pino stub for Android (nodejs-mobile).
 *
 * Real pino uses thread-stream (worker_threads) for async logging.
 * On Android, console.log goes to logcat which is visible via `adb logcat`.
 * This stub provides the same API surface using console methods.
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function createLogger(opts = {}) {
  const logger = {
    level: opts.level || 'info',

    trace(obj, msg, ...args) { if (LEVELS.trace >= LEVELS[logger.level]) console.debug('[TRACE]', msg || obj, ...args); },
    debug(obj, msg, ...args) { if (LEVELS.debug >= LEVELS[logger.level]) console.debug('[DEBUG]', msg || obj, ...args); },
    info(obj, msg, ...args) { if (LEVELS.info >= LEVELS[logger.level]) console.log('[INFO]', msg || obj, ...args); },
    warn(obj, msg, ...args) { if (LEVELS.warn >= LEVELS[logger.level]) console.warn('[WARN]', msg || obj, ...args); },
    error(obj, msg, ...args) { if (LEVELS.error >= LEVELS[logger.level]) console.error('[ERROR]', msg || obj, ...args); },
    fatal(obj, msg, ...args) { if (LEVELS.fatal >= LEVELS[logger.level]) console.error('[FATAL]', msg || obj, ...args); },

    child(_bindings) { return logger; },
    isLevelEnabled(level) { return LEVELS[level] >= LEVELS[logger.level]; },
    flush() {},
    on() { return logger; },
  };
  return logger;
}

function pino(opts, stream) {
  return createLogger(typeof opts === 'object' ? opts : {});
}

pino.multistream = function(_streams) {
  // Return a writable-like object
  return {
    write(chunk) { process.stderr.write(chunk); },
  };
};

pino.destination = function(_opts) {
  return process.stderr;
};

export default pino;
export { pino };
