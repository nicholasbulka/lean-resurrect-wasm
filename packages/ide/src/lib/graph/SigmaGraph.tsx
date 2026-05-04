import { useEffect, useRef } from 'react';
import Sigma from 'sigma';
import type Graph from 'graphology';

interface Props {
  /** The graphology Graph instance to render. Owned by the caller. */
  graph: Graph;
  /** Optional Sigma settings overrides. */
  settings?: ConstructorParameters<typeof Sigma>[2];
  /** Fires once after Sigma instantiates; use to wire interactions. */
  onSigma?: (sigma: Sigma) => void;
}

/**
 * Thin React wrapper over a Sigma instance. Mounts once into a div, owns
 * the WebGL renderer for the lifetime of the component. The graph data is
 * passed in by reference; callers mutate it via graphology APIs and Sigma
 * picks up changes via Sigma's refresh on graph events.
 *
 * Same uncontrolled pattern as the CodeMirror wrapper: prop changes after
 * mount don't re-instantiate. To replace the graph, give the component a
 * new `key`, or call `graph.clear()` and re-add.
 */
export function SigmaGraph({ graph, settings, onSigma }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const onSigmaRef = useRef(onSigma);
  onSigmaRef.current = onSigma;

  useEffect(() => {
    if (!hostRef.current) return;
    const sigma = new Sigma(graph, hostRef.current, settings);
    sigmaRef.current = sigma;
    onSigmaRef.current?.(sigma);
    return () => {
      sigma.kill();
      sigmaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
