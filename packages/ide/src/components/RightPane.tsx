import { basicSetup } from 'codemirror';
import { useAppDispatch, useAppSelector } from '../store';
import { setRightPane } from '../slices/uiSlice';
import { updateMermaid } from '../slices/proofsSlice';
import { Mermaid } from './Mermaid';
import { Diagnostics } from './Diagnostics';
import { CodeMirror } from '../lib/cm/CodeMirror';
import { GraphView } from './GraphView';

export function RightPane() {
  const dispatch = useAppDispatch();
  const currentId = useAppSelector((s) => s.proofs.currentId);
  const proof = useAppSelector((s) => (currentId ? s.proofs.entities[currentId] : null));
  const rightPane = useAppSelector((s) => s.ui.rightPane);
  const compile = useAppSelector((s) => s.compile);

  if (!proof) return <div className="pane"><div className="pane-body" /></div>;

  const statusClass = compile.status === 'ok' ? 'ok' : compile.status === 'error' ? 'fail' : compile.status === 'running' ? 'running' : '';
  const progressText = compile.progress
    ? compile.progress.total
      ? `${compile.progress.message ?? compile.progress.phase} ${compile.progress.current ?? 0}/${compile.progress.total}`
      : compile.progress.message ?? compile.progress.phase
    : null;
  const statusText =
    compile.status === 'idle' ? 'idle' :
    compile.status === 'running' ? (progressText ? `${progressText} · ${Math.round(compile.elapsedMs / 1000)}s` : `compiling… ${Math.round(compile.elapsedMs / 1000)}s`) :
    compile.status === 'ok' ? `ok (${compile.result?.ms ?? 0}ms, ${compile.result?.diagnostics.length ?? 0} diag)` :
    compile.error ? `error: ${compile.error}` :
    compile.result ? `exit ${compile.result.exitCode} (${compile.result?.diagnostics.length ?? 0} diag)` : 'error';

  const onJump = (pos: { line: number; column: number }) => {
    (window as any).__ideEditor?.jumpTo(pos.line, pos.column);
  };

  return (
    <div className="pane">
      <div className="pane-header">
        <div className="tabs">
          <button
            className={rightPane === 'output' ? 'active' : ''}
            onClick={() => dispatch(setRightPane('output'))}
          >
            Output
          </button>
          <button
            className={rightPane === 'design' ? 'active' : ''}
            onClick={() => dispatch(setRightPane('design'))}
          >
            Design
          </button>
          <button
            className={rightPane === 'graph' ? 'active' : ''}
            onClick={() => dispatch(setRightPane('graph'))}
          >
            Graph
          </button>
        </div>
        <span className={'status ' + statusClass}>{statusText}</span>
      </div>
      <div className="pane-body">
        {rightPane === 'output' && (
          <>
            <Diagnostics onJump={onJump} />
            <OutputView />
          </>
        )}
        {rightPane === 'design' && (
          <DesignView
            source={proof.mermaidSource}
            onChange={(s) => dispatch(updateMermaid({ id: proof.id, source: s }))}
            proofId={proof.id}
          />
        )}
        {rightPane === 'graph' && <GraphView />}
      </div>
    </div>
  );
}

function OutputView() {
  const compile = useAppSelector((s) => s.compile);
  if (compile.status === 'idle') {
    return <pre className="output muted">(press compile, or ⌘↵ in the editor)</pre>;
  }
  if (compile.status === 'running') {
    return <pre className="output muted">compiling… ({Math.round(compile.elapsedMs / 1000)}s)</pre>;
  }
  if (compile.error) {
    return <pre className="output"><span className="err">{compile.error}</span></pre>;
  }
  const r = compile.result;
  if (!r) return <pre className="output muted">(no output)</pre>;
  const hasAnything = r.stdout || r.stderr || r.diagnostics.length > 0;
  return (
    <pre className="output">
      {r.stdout}
      {r.stderr ? <span className="err">{r.stderr}</span> : null}
      {!hasAnything ? <span className="muted">(no output)</span> : null}
    </pre>
  );
}

interface DesignProps {
  source: string;
  onChange: (s: string) => void;
  proofId: string;
}
function DesignView({ source, onChange, proofId }: DesignProps) {
  return (
    <div className="design">
      <div className="design-preview">
        <Mermaid source={source} idPrefix={`diag-${proofId}`} />
      </div>
      <div className="design-source">
        {/* key={proofId}: remount when the active proof changes so the
            uncontrolled editor picks up the new mermaid source. */}
        <CodeMirror
          key={proofId}
          initialValue={source}
          onChange={onChange}
          extensions={[basicSetup]}
        />
      </div>
    </div>
  );
}
