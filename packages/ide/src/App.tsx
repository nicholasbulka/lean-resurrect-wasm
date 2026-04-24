import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from './store';
import { tickElapsed } from './slices/compileSlice';
import { ProofMenu } from './components/ProofMenu';
import { EditorPane } from './components/EditorPane';
import { RightPane } from './components/RightPane';
import { ArchitecturePage } from './components/ArchitecturePage';

export function App() {
  const view = useAppSelector((s) => s.ui.view);
  const compileStatus = useAppSelector((s) => s.compile.status);
  const dispatch = useAppDispatch();

  // Tick elapsed time while compiling so the status updates live.
  useEffect(() => {
    if (compileStatus !== 'running') return;
    const t = setInterval(() => dispatch(tickElapsed()), 250);
    return () => clearInterval(t);
  }, [compileStatus, dispatch]);

  return (
    <div className="app">
      <ProofMenu />
      {view === 'editor' ? (
        <div className="workspace">
          <EditorPane />
          <RightPane />
        </div>
      ) : (
        <ArchitecturePage />
      )}
    </div>
  );
}
