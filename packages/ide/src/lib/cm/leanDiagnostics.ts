import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import type { LeanDiagnostic } from '../../slices/compileSlice';

/**
 * Map LeanDiagnostic[] (1-based line/col, 0-based column inside the line) to
 * CodeMirror Diagnostic[] (absolute byte offsets) and apply via the lint
 * extension's setDiagnostics transaction.
 */
export function setLeanDiagnostics(view: EditorView, diags: LeanDiagnostic[]) {
  const cmDiags: Diagnostic[] = diags.map((d) => {
    const from = posToOffset(view, d.pos.line, d.pos.column);
    const endLine = d.endPos?.line ?? d.pos.line;
    const endCol = d.endPos?.column ?? d.pos.column + 1;
    let to = posToOffset(view, endLine, endCol);
    if (to <= from) to = from + 1;
    return {
      from,
      to,
      severity: mapSeverity(d.severity),
      message: d.data,
      source: 'lean',
    };
  });
  view.dispatch(setDiagnostics(view.state, cmDiags));
}

function posToOffset(view: EditorView, line: number, column: number): number {
  const doc = view.state.doc;
  const safeLine = Math.max(1, Math.min(line, doc.lines));
  const lineObj = doc.line(safeLine);
  const offset = lineObj.from + Math.max(0, column);
  return Math.min(offset, lineObj.to);
}

function mapSeverity(s: LeanDiagnostic['severity']): Diagnostic['severity'] {
  if (s === 'error') return 'error';
  if (s === 'warning') return 'warning';
  return 'info';
}
