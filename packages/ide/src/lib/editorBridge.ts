import type { OnMount } from '@monaco-editor/react';
import { EditorSelection } from '@codemirror/state';
import { forEachDiagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';

type MonacoEditor = Parameters<OnMount>[0];
type MonacoNs = Parameters<OnMount>[1];

export interface EditorBridge {
  ready: boolean;
  backend: 'monaco' | 'cm6';
  getValue(): string;
  setValue(text: string): void;
  jumpTo(line: number, column: number): void;
  getMarkers(): unknown[];
  monaco?: MonacoNs;
  // Debug/test-only escape hatch. Stable while we develop the grammar; do
  // not couple production code to it.
  _view?: EditorView;
}

export function createMonacoBridge(
  editorRef: { current: MonacoEditor | null },
  monacoRef: { current: MonacoNs | null },
  ready: boolean,
): EditorBridge {
  return {
    ready,
    backend: 'monaco',
    monaco: monacoRef.current ?? undefined,
    getValue: () => editorRef.current?.getValue() ?? '',
    setValue: (text) => { editorRef.current?.setValue(text); },
    jumpTo: (line, column) => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.focus();
      ed.setPosition({ lineNumber: line, column });
      ed.revealPositionInCenter({ lineNumber: line, column });
    },
    getMarkers: () => {
      const monaco = monacoRef.current;
      const ed = editorRef.current;
      if (!monaco || !ed) return [];
      const model = ed.getModel();
      return model ? monaco.editor.getModelMarkers({ resource: model.uri }) : [];
    },
  };
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
