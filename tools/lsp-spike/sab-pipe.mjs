// SharedArrayBuffer ring-buffer pipe — the transport for Option A's
// virtualized watchdog↔worker pipes (and client↔watchdog stdio).
//
// One pipe is unidirectional: a producer writes bytes, a consumer reads
// them, blocking via Atomics.wait when empty/full. Two of these give a
// bidirectional channel. Designed so EITHER end can be the WASM side
// (whose fd_read/fd_write the JSPI shim drives) or the JS host side.
//
// Layout of the control SAB (Int32Array): [head, tail, closed].
// Data lives in a separate Uint8Array SAB of capacity `cap`.
//   - producer writes at tail, bumps tail, notifies head-waiters
//   - consumer reads at head, bumps head, notifies tail-waiters
// head/tail are monotonic byte counters mod cap; available = tail - head.
//
// NOTE: Atomics.wait throws on the main browser thread. Both the WASM
// pthread side (proxied) and dedicated Workers can wait. The host driver
// that must not block uses waitAsync (where available) or the JSPI
// suspension path instead. This module exposes both blocking and
// async readers so callers pick per-context.

const HEAD = 0, TAIL = 1, CLOSED = 2;

export function createPipe(cap = 1 << 20) {
  const ctrl = new SharedArrayBuffer(3 * 4);
  const data = new SharedArrayBuffer(cap);
  return { ctrl, data, cap };
}

export class PipeWriter {
  constructor({ ctrl, data, cap }) {
    this.c = new Int32Array(ctrl); this.d = new Uint8Array(data); this.cap = cap;
  }
  write(bytes) {
    let off = 0;
    while (off < bytes.length) {
      const head = Atomics.load(this.c, HEAD);
      const tail = Atomics.load(this.c, TAIL);
      const free = this.cap - (tail - head);
      if (free === 0) {
        // Full: wait for the consumer to advance head.
        Atomics.wait(this.c, HEAD, head);
        continue;
      }
      const n = Math.min(free, bytes.length - off);
      for (let i = 0; i < n; i++) this.d[(tail + i) % this.cap] = bytes[off + i];
      Atomics.store(this.c, TAIL, tail + n);
      Atomics.notify(this.c, TAIL);
      off += n;
    }
  }
  close() { Atomics.store(this.c, CLOSED, 1); Atomics.notify(this.c, TAIL); }
}

export class PipeReader {
  constructor({ ctrl, data, cap }) {
    this.c = new Int32Array(ctrl); this.d = new Uint8Array(data); this.cap = cap;
  }
  // Blocking read of up to `max` bytes. Returns a Uint8Array (length 0 only
  // if the pipe is closed and drained). Safe on Worker/pthread, NOT main.
  read(max) {
    for (;;) {
      const head = Atomics.load(this.c, HEAD);
      const tail = Atomics.load(this.c, TAIL);
      const avail = tail - head;
      if (avail > 0) {
        const n = Math.min(avail, max);
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = this.d[(head + i) % this.cap];
        Atomics.store(this.c, HEAD, head + n);
        Atomics.notify(this.c, HEAD);
        return out;
      }
      if (Atomics.load(this.c, CLOSED)) return new Uint8Array(0);
      Atomics.wait(this.c, TAIL, tail); // block until producer writes
    }
  }
}
