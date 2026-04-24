// Debug variant: logs every FS.open call so we can see where oleans are
// actually being loaded from.
const path = require('path');
const fs = require('fs');
const NodeModule = require('module');

const INSTALL = path.resolve(__dirname, '../vendor/lean-linux_wasm32');
const LEAN_JS = path.join(INSTALL, 'bin/lean.js');

process.on('unhandledRejection', (r) => {
  console.error('[tr] unhandledRejection:', r && r.message);
  process.exit(42);
});

globalThis.Module = {
  arguments: process.argv.slice(2),
  thisProgram: `${INSTALL}/bin/lean`,
  print: (...a) => process.stdout.write(a.join(' ') + '\n'),
  printErr: (...a) => process.stderr.write('[lean] ' + a.join(' ') + '\n'),
  locateFile: (p) => `${INSTALL}/bin/${p}`,
  preRun: [
    function () {
      const FS = Module.FS;
      const NODEFS = Module.NODEFS;
      const ENV = Module.ENV || {};
      try { FS.mkdirTree('/Users'); } catch (e) {}
      try { FS.mount(NODEFS, { root: '/Users' }, '/Users'); } catch (e) {}
      if (process.env.LEAN_PATH_OVERRIDE) ENV.LEAN_PATH = process.env.LEAN_PATH_OVERRIDE;
      else ENV.LEAN_PATH = `${INSTALL}/lib/lean`;
      ENV.LEAN_SRC_PATH = `${INSTALL}/src/lean`;
      ENV.LEAN_SYSROOT = INSTALL;
      ENV.HOME = '/Users/' + (process.env.USER || 'user');
      console.error('[tr] LEAN_PATH=' + ENV.LEAN_PATH);

      const origOpen = FS.open;
      const seen = new Map();
      FS.open = function (p, flags, mode) {
        let err = null;
        try {
          const r = origOpen.call(FS, p, flags, mode);
          if (p.endsWith('.olean') || p.includes('/lean/')) {
            const cnt = (seen.get(p) || 0) + 1;
            seen.set(p, cnt);
            if (cnt === 1) console.error('[tr] FS.open OK ', flags, p);
          }
          return r;
        } catch (e) {
          if (p.endsWith('.olean') || p.includes('/lean/')) {
            console.error('[tr] FS.open ERR', e.errno, flags, p);
          }
          throw e;
        }
      };
    },
  ],
};

const src = fs.readFileSync(LEAN_JS, 'utf8');
const OLD = 'var Module=typeof Module!="undefined"?Module:{};';
const NEW = 'var Module=typeof globalThis!=="undefined"&&globalThis.Module?globalThis.Module:(typeof Module!="undefined"?Module:{});';
const lm = new NodeModule(LEAN_JS, module);
lm.filename = LEAN_JS;
lm.paths = NodeModule._nodeModulePaths(path.dirname(LEAN_JS));
lm._compile(src.replace(OLD, NEW), LEAN_JS);
