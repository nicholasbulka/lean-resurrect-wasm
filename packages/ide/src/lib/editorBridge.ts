import type { OnMount } from '@monaco-editor/react';

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
