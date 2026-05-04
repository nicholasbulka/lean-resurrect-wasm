import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

interface Props {
  initialValue: string;
  onChange?: (value: string) => void;
  extensions?: Extension[];
  onView?: (view: EditorView) => void;
}

/**
 * Thin React wrapper over a CodeMirror 6 EditorView. Uncontrolled: pass
 * `initialValue` once at mount; updates flow out via `onChange`. To
 * replace the document programmatically, call view.dispatch({changes}) via
 * the onView callback or the test bridge — never re-render with a new
 * initialValue prop; the wrapper ignores it after mount on purpose. Use
 * key={...} to force a remount when you want a fresh editor.
 */
export function CodeMirror({ initialValue, onChange, extensions = [], onView }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const listener = EditorView.updateListener.of((u) => {
      if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
    });
    const state = EditorState.create({
      doc: initialValue,
      extensions: [listener, ...extensions],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    onView?.(view);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} style={{ height: '100%', width: '100%' }} />;
}
