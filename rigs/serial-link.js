// Web Serial transport shared by all built-in drivers.
// Opens the port, pumps received bytes to a callback and writes with a timeout,
// so a missing CTS line shows up as a clear error instead of a silent hang.

export class SerialLink {
  constructor(port, { onData, log }) {
    this.port = port;
    this.onData = onData;
    this.log = log;
    this.writer = null;
    this.reader = null;
    this.readLoopDone = null;
    this.open_ = false;
    this.flowControl = 'none';
  }

  async open({ baudRate, stopBits, flowControl }) {
    this.flowControl = flowControl;
    await this.port.open({
      baudRate: Number(baudRate),
      dataBits: 8,
      stopBits: Number(stopBits),
      parity: 'none',
      flowControl: flowControl === 'hardware' ? 'hardware' : 'none',
      bufferSize: 4096,
    });
    try {
      if (flowControl === 'hardware') await this.port.setSignals({ dataTerminalReady: true });
      else if (flowControl === 'none-low') await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      else await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (_) {}
    this.writer = this.port.writable.getWriter();
    this.open_ = true;
    this.readLoopDone = this.readLoop();
  }

  async readLoop() {
    while (this.open_ && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) this.onData(value);
        }
      } catch (e) {
        // Framing/parity/break errors are recoverable: loop and get a new reader.
        if (this.open_) this.log(`Serial read error: ${e.message}`, 'warn');
      } finally {
        try { this.reader.releaseLock(); } catch (_) {}
        this.reader = null;
      }
    }
  }

  async write(data) {
    if (!this.writer) throw new Error('not connected');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let t;
    try {
      await Promise.race([
        this.writer.write(bytes),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), 2000); }),
      ]);
    } catch (e) {
      if (e.message === 'timeout') {
        const err = new Error(
          this.flowControl === 'hardware'
            ? 'Serial write blocked: the radio is not asserting CTS. Check the cable, or try Flow control = None.'
            : 'Serial write blocked.'
        );
        err.fatal = true;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  async close() {
    this.open_ = false;
    try { await this.reader?.cancel(); } catch (_) {}
    try { await this.readLoopDone; } catch (_) {}
    try { await this.writer?.abort(); } catch (_) {}
    try { this.writer?.releaseLock(); } catch (_) {}
    this.writer = null;
    try { await this.port.close(); } catch (_) {}
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Promise that rejects after `ms` unless settled; returns { promise, resolve, reject }.
export function deferred(ms, what) {
  let resolve, reject, timer;
  const promise = new Promise((res, rej) => {
    resolve = (v) => { clearTimeout(timer); res(v); };
    reject = (e) => { clearTimeout(timer); rej(e); };
  });
  timer = setTimeout(() => reject(new Error(`no answer to ${what}`)), ms);
  return { promise, resolve, reject };
}
