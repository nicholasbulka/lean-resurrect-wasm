import { EditorSelection } from '@codemirror/state';
import { forEachDiagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';

export interface EditorBridge {
  ready: boolean;
  backend: 'cm6';
  getValue(): string;
  setValue(text: string): void;
  jumpTo(line: number, column: number): void;
  getMarkers(): unknown[];
  // Debug/test-only escape hatch into the underlying EditorView. Keep
  // out of production code paths; tests and grammar-development tools
  // are the intended consumers.
  _view?: EditorView;
}

export function createCm6Bridge(
  viewRef: { current: EditorView | null },
  ready: boolean,
): EditorBridge {
  return {
    ready,
    backend: 'cm6',
    get _view() { return viewRef.current ?? undefined; },
    getValue: () => viewRef.current?.state.doc.toString() ?? '',
    setValue: (text) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    jumpTo: (line, column) => {
      const view = viewRef.current;
      if (!view) return;
      const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
      const lineObj = view.state.doc.line(safeLine);
      const offset = Math.min(lineObj.from + Math.max(0, column - 1), lineObj.to);
      view.focus();
      view.dispatch({
        selection: EditorSelection.cursor(offset),
        scrollIntoView: true,
      });
    },
    getMarkers: () => {
      const view = viewRef.current;
      if (!view) return [];
      const out: unknown[] = [];
      forEachDiagnostic(view.state, (d) => { out.push(d); });
      return out;
    },
  };
}
