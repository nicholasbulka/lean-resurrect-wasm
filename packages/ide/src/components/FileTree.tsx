import { useMemo, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { selectFile, type Project, type ProjectFile } from '../slices/projectsSlice';

interface DirNode {
  name: string;
  /** Absolute path within the project. For directory nodes, "" means root. */
  path: string;
  children: Map<string, DirNode>;
  files: ProjectFile[];
}

function buildTree(project: Project): DirNode {
  const root: DirNode = { name: project.name, path: '', children: new Map(), files: [] };
  const paths = Object.keys(project.files).sort();
  for (const filePath of paths) {
    const segments = filePath.split('/');
    let cur = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = cur.children.get(seg);
      if (!child) {
        child = { name: seg, path: segments.slice(0, i + 1).join('/'), children: new Map(), files: [] };
        cur.children.set(seg, child);
      }
      cur = child;
    }
    cur.files.push(project.files[filePath]);
  }
  return root;
}

interface DirProps {
  node: DirNode;
  depth: number;
  currentPath: string | null;
  onSelect: (path: string) => void;
  /** Open dirs, by directory path. */
  open: Set<string>;
  toggle: (path: string) => void;
}

function DirView({ node, depth, currentPath, onSelect, open, toggle }: DirProps) {
  const isOpen = depth === 0 || open.has(node.path);
  const indent = depth * 12;
  return (
    <>
      {depth > 0 && (
        <button
          className="ft-dir"
          style={{ paddingLeft: indent + 4 }}
          onClick={() => toggle(node.path)}
          title={node.path}
        >
          <span className="ft-chev">{isOpen ? '▾' : '▸'}</span>
          <span className="ft-name">{node.name}</span>
        </button>
      )}
      {isOpen && (
        <>
          {[...node.children.values()].map((child) => (
            <DirView
              key={child.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              onSelect={onSelect}
              open={open}
              toggle={toggle}
            />
          ))}
          {node.files.map((f) => {
            const isActive = f.path === currentPath;
            return (
              <button
                key={f.path}
                className={'ft-file' + (isActive ? ' active' : '')}
                style={{ paddingLeft: (depth + 1) * 12 + 4 }}
                onClick={() => onSelect(f.path)}
                title={f.path}
              >
                <span className="ft-name">{f.path.split('/').pop()}</span>
              </button>
            );
          })}
        </>
      )}
    </>
  );
}

export function FileTree() {
  const dispatch = useAppDispatch();
  const projectId = useAppSelector((s) => s.projects.currentId);
  const project = useAppSelector((s) => (projectId ? s.projects.entities[projectId] : null));
  const tree = useMemo(() => (project ? buildTree(project) : null), [project]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  if (!project || !tree) return <aside className="sidebar"><div className="sidebar-empty">no project</div></aside>;

  const fileCount = Object.keys(project.files).length;
  const onToggle = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };
  const onSelect = (path: string) => {
    dispatch(selectFile({ projectId: project.id, path }));
  };

  return (
    <aside className="sidebar" aria-label="file tree">
      <div className="sidebar-header">
        <span className="sidebar-title">{project.name}</span>
        <span className="sidebar-count">{fileCount} file{fileCount === 1 ? '' : 's'}</span>
      </div>
      <div className="sidebar-tree">
        <DirView
          node={tree}
          depth={0}
          currentPath={project.currentPath}
          onSelect={onSelect}
          open={open}
          toggle={onToggle}
        />
      </div>
    </aside>
  );
}
