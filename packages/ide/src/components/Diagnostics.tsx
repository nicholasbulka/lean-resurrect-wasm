import { useAppSelector } from '../store';
import type { LeanDiagnostic } from '../slices/compileSlice';

interface Props {
  onJump?: (pos: { line: number; column: number }) => void;
}

/**
 * Renders structured Lean diagnostics from --json output. Clicking a row
 * invokes onJump with the 1-based {line,column} so the editor can move
 * the cursor there.
 */
export function Diagnostics({ onJump }: Props) {
  const compile = useAppSelector((s) => s.compile);
  const diagnostics = compile.result?.diagnostics ?? [];
  if (compile.status === 'idle') return null;
  if (compile.status === 'running') return null;
  if (diagnostics.length === 0) return null;

  return (
    <ul className="diags">
      {diagnostics.map((d, i) => (
        <li key={i} className={'diag sev-' + normalizeSeverity(d.severity)}>
          <button
            className="diag-jump"
            onClick={() => onJump?.({ line: d.pos.line, column: d.pos.column })}
            title={`jump to ${d.pos.line}:${d.pos.column}`}
          >
            <span className="sev-badge">{severityLabel(d.severity)}</span>
            <span className="loc">{d.pos.line}:{d.pos.column}</span>
          </button>
          <pre className="diag-msg">{d.data}</pre>
        </li>
      ))}
    </ul>
  );
}

function normalizeSeverity(s: LeanDiagnostic['severity']): string {
  if (s === 'info' || s === 'information') return 'info';
  if (s === 'trace') return 'trace';
  return s;
}
function severityLabel(s: LeanDiagnostic['severity']): string {
  const n = normalizeSeverity(s);
  return n;
}
