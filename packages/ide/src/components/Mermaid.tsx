import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let inited = false;
function initOnce() {
  if (inited) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    fontFamily: 'ui-monospace, Menlo, monospace',
  });
  inited = true;
}

interface Props {
  source: string;
  /** Stable id prefix; mermaid needs unique ids per render call. */
  idPrefix: string;
}

/**
 * Renders a mermaid diagram from source. Debounces renders so rapid
 * typing doesn't swamp the parser.
 */
export function Mermaid({ source, idPrefix }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const renderCounter = useRef(0);

  useEffect(() => { initOnce(); }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled || !ref.current) return;
      try {
        renderCounter.current += 1;
        const id = `${idPrefix}-${renderCounter.current}`;
        const { svg } = await mermaid.render(id, source);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        setErr(null);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message ?? String(e));
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source, idPrefix]);

  if (err) return <div className="err">{err}</div>;
  return <div ref={ref} style={{ width: '100%' }} />;
}
