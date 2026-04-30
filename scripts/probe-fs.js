#!/usr/bin/env node
// Trace FS.open / FS.stat / FS.readFile during a compile to see what
// Lean asks for and whether it gets a valid response.

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
      try { FS.mkdirTree('/work'); } catch(_){}
      FS.writeFile('/work/Input.lean', new TextEncoder().encode('def x : Nat := 42\\n'));

      // Hook FS calls.
      const origOpen = FS.open;
      const origStat = FS.stat;
      const origRead = FS.read;
      FS.open = function(...args) {
        try {
          const r = origOpen.apply(this, args);
          if (/olean|Init/.test(args[0])) console.error('[FS.open]', args[0], 'flags=' + args[1] + ' fd=' + (r && r.fd));
          return r;
        } catch (e) {
          console.error('[FS.open ERR]', args[0], e.message || e);
          throw e;
        }
      };
      FS.stat = function(...args) {
        try {
          const r = origStat.apply(this, args);
          if (/olean|Init/.test(args[0])) console.error('[FS.stat]', args[0], 'size=' + (r && r.size) + ' mode=' + (r && r.mode));
          return r;
        } catch (e) {
          if (/olean|Init/.test(args[0])) console.error('[FS.stat ERR]', args[0], e.message || e.code);
          throw e;
        }
      };
      // FS.read for fd 3 (Init.olean is fd 3 above) — to see read result
      const fdCounters = {};
      FS.read = function(...args) {
        const fd = args[0];
        try {
          const r = origRead.apply(this, args);
          if (fd >= 3 && fd < 10) {
            fdCounters[fd] = (fdCounters[fd] || 0) + 1;
            if (fdCounters[fd] <= 3 || (fdCounters[fd] % 50 === 0)) {
              console.error('[FS.read]', 'fd=' + fd + ' length=' + args[3] + ' returned=' + r);
            }
          }
          return r;
        } catch (e) {
          console.error('[FS.read ERR]', 'fd=' + fd, e.message || e);
          throw e;
        }
      };
    }],
    onAbort: (what) => { console.error('ABORT=' + what); process.exit(3); },
  };
  vm.runInThisContext(src);

  const wait = () => {
    if (!global.Module.calledRun) { setTimeout(wait, 50); return; }
    let exit = -1;
    try { const ret = global.Module.callMain(['--json', '--root=/work', '/work/Input.lean']); exit = (typeof ret === 'number') ? ret : -2; }
    catch (e) { exit = (e && e.status !== undefined) ? e.status : 'THREW:' + (e && e.message || e); }
    console.error('[done] exit=' + exit);
    process.exit(0);
  };
  wait();
})();
`;

const { spawn } = require('child_process');
const child = spawn('node', ['--max-old-space-size=10240', '-e', driver], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (c, s) => console.error('[host] exit', c, s));
