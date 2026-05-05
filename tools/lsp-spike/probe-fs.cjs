// Probe what FS looks like at various stages of Emscripten lifecycle
// in the JSPI build. Helps figure out where to inject our stdin
// bytes for the TTY-direct approach.

const path = require('node:path');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = 'lean-jspi.js';

function dump(label) {
  const FS = global.Module && global.Module.FS;
  if (!FS) { console.log(`[probe] ${label}: no FS yet`); return; }
  console.log(`[probe] ${label}: streams=${FS.streams ? Object.keys(FS.streams).length : 'n/a'} keys=${Object.keys(FS).slice(0, 10).join(',')}`);
  if (FS.streams) {
    for (let i = 0; i < 3; i++) {
      const s = FS.streams[i];
      if (!s) continue;
      console.log(`  fd ${i}: path=${s.path ?? 'n/a'} tty=${!!s.tty} flags=${s.flags ?? 'n/a'} stream_ops=${typeof s.stream_ops?.read}`);
      if (s.tty) console.log(`         tty.input=Array(${s.tty.input?.length ?? 'n/a'}) tty.ops keys=${Object.keys(s.tty.ops ?? {})}`);
    }
  }
  // Also check global TTY / Module.TTY
  if (global.Module.TTY) console.log(`  Module.TTY exists: keys=${Object.keys(global.Module.TTY)}`);
  else console.log('  Module.TTY: not found');
}

global.Module = {
  noInitialRun: true,
  stdin: () => null,
  stdout: () => {},
  stderr: () => {},
  preRun: [function () { dump('preRun'); }],
  preInit: [function () { dump('preInit'); }],
  postRun: [function () { dump('postRun'); }],
  onAbort: (w) => { console.error('[probe] onAbort:', w); process.exit(3); },
};

require(path.join(LEAN_ROOT, LEAN_JS));

(async () => {
  dump('after-require');
  let waited = 0;
  while (!global.Module.calledRun) {
    if (waited > 60000) { console.error('[probe] timeout'); process.exit(2); }
    await new Promise((r) => setTimeout(r, 100));
    waited += 100;
  }
  dump('calledRun');

  console.log('[probe] callMain(["--version"])');
  global.Module.callMain(['--version']);

  await new Promise((r) => setTimeout(r, 500));
  dump('after-callMain');
  process.exit(0);
})();
