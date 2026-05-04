import { useMemo } from 'react';
import Graph from 'graphology';
import { SigmaGraph } from '../lib/graph/SigmaGraph';

/**
 * Phase 9a placeholder: a tiny demo graph proving the Sigma WebGL renderer
 * mounts cleanly inside our right-pane tab. Phase 9b will replace this
 * with a real Lean import-dependency graph extracted from the Lezer tree.
 */
export function GraphView() {
  const graph = useMemo(() => {
    const g = new Graph();
    g.addNode('a', { label: 'a', x: 0, y: 0, size: 10, color: '#2d7dd2' });
    g.addNode('b', { label: 'b', x: 1, y: 0.3, size: 10, color: '#2d7dd2' });
    g.addNode('c', { label: 'c', x: 0.5, y: -0.8, size: 10, color: '#2d7dd2' });
    g.addEdge('a', 'b', { color: '#999' });
    g.addEdge('b', 'c', { color: '#999' });
    g.addEdge('a', 'c', { color: '#999' });
    return g;
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', minHeight: 300 }}>
      <SigmaGraph graph={graph} settings={{ renderLabels: true }} />
    </div>
  );
}
