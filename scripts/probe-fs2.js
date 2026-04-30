#!/usr/bin/env node
// Read /leanroot/lib/lean/Init.olean directly via Module.FS to see if
// the data is what we expect. If FS read returns 20036 bytes of valid
// olean header, the issue is in Lean's parsing path, not FS.

const driver = `
(() => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const LEAN_ROOT = '/tmp/leanroot';
  let src = fs.readFileSync(LEAN_ROOT + '/bin/lean.js', 'utf8');
  src = src.replace('function callMain(args=[]){', 'Module["callMain"]=callMain;function callMain(args=[]){');
  src = src.replace(/(\\d+):\\(\\)=>\\{if\\(typeof process==="undefined"\\|\\|process\\.release\\.name!=="node"\\)\\{throw new Error\\("The Lean command-line driver[\\s\\S]*?FS\\.chdir\\(process\\.cwd\\(\\)\\)\\}/, '$1:()=>{}');

  global.__filename = '/leanroot/bin/lean.js';
  global.__dirname = '/leanroot/bin';
  global.Module = {
    noInitialRun: true, noExitRuntime: false, thisProgram: LEAN_ROOT + '/bin/lean.js',
    print: (...a) => { console.error('[lean stdout]', ...a); },
    printErr: (...a) => { console.error('[lean stderr]', ...a); },
    locateFile: (p) => path.join(LEAN_ROOT + '/bin', p),
    preRun: [function () {
      const FS = global.Module.FS, NODEFS = global.Module.NODEFS;
      try { FS.mkdirTree('/leanroot'); } catch(_){}
      FS.mount(NODEFS, { root: LEAN_ROOT }, '/leanroot');
    }],
  };
  vm.runInThisContext(src);
  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    const FS = global.Module.FS;
    // Read olean via FS
    try {
      const data = FS.readFile('/leanroot/lib/lean/Init.olean');
      console.log('FS.readFile returned', data.length, 'bytes');
      console.log('first 32 bytes:', Array.from(data.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      console.log('first 16 as ASCII:', Array.from(data.slice(0, 16)).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join(''));
    } catch (e) { console.log('FS.readFile threw:', e.message); }
    // Also low-level open + read
    try {
      const stream = FS.open('/leanroot/lib/lean/Init.olean', 'r');
      console.log('FS.open fd=' + stream.fd);
      const buf = new Uint8Array(64);
      const r = FS.read(stream, buf, 0, 64, 0);
      console.log('FS.read returned bytes=' + r);
      console.log('first 32 bytes:', Array.from(buf.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      FS.close(stream);
    } catch (e) { console.log('FS.open/read threw:', e.message); }

    // Also try reading via host fs directly:
    const hostData = fs.readFileSync(LEAN_ROOT + '/lib/lean/Init.olean');
    console.log('HOST readFileSync returned', hostData.length, 'bytes');
    console.log('first 32:', Array.from(hostData.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    process.exit(0);
  };
  wait();
})();
`;
const { spawn } = require('child_process');
const child = spawn('node', ['-e', driver], { stdio: ['ignore', 'inherit', 'inherit'] });
