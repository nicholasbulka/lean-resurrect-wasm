// Probe what fd 0's stream_ops actually IS in the patched lean-jspi.js.
// We need to override read so Lean sees our LSP bytes.

const path = require('node:path');

const LEAN_ROOT = '/Users/nicholasbulka/prog/lean/wasm/build-wasm/stage1/bin';
const LEAN_JS = 'lean-jspi.js';

global.Module = {
  noInitialRun: true,
  stdin: () => null,
  stdout: () => {},
  stderr: () => {},
  onAbort: (w) => { console.error('[probe2]', w); process.exit(3); },
};

require(path.join(LEAN_ROOT, LEAN_JS));

(async () => {
  while (!global.Module.calledRun) await new Promise((r) => setTimeout(r, 100));
  const FS = global.Module.FS;
  const stdin = FS.streams[0];
  console.log('fd 0 keys:', Object.keys(stdin));
  console.log('fd 0 node:', stdin.node && Object.keys(stdin.node));
  console.log('fd 0 stream_ops keys:', Object.keys(stdin.stream_ops));
  console.log('fd 0 stream_ops.read.toString().slice(0, 800):');
  console.log(stdin.stream_ops.read.toString().slice(0, 800));
  console.log('---');
  console.log('fd 0 node.node_ops keys:', stdin.node && stdin.node.node_ops && Object.keys(stdin.node.node_ops));
  if (stdin.node && stdin.node.node_ops && stdin.node.node_ops.read) {
    console.log('node_ops.read.toString().slice(0, 600):');
    console.log(stdin.node.node_ops.read.toString().slice(0, 600));
  }
  process.exit(0);
})();
