import type { SceneNode } from '@figtional/fig-model';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Tag name in Figma MCP's style: the node type, lower-case, kebab-cased (rounded-rectangle). */
export function xmlTag(n: SceneNode): string {
  const t = n.figType === 'FRAME' && n.type === 'GROUP' ? 'GROUP' : n.figType;
  return t.toLowerCase().replace(/_/g, '-');
}

export interface MetadataOptions {
  /** Stop after this many characters (the rest is summarised). */
  maxChars?: number;
}

/**
 * Sparse XML of a subtree: ids, layer types, names, positions (x/y relative to the parent, as in
 * the Plugin API) and sizes. Hidden layers carry hidden="true".
 */
export function metadataXml(
  root: SceneNode,
  opts: MetadataOptions = {},
): { xml: string; truncated: boolean } {
  const max = opts.maxChars ?? 400_000;
  const lines: string[] = [];
  let size = 0;
  let truncated = false;
  let omitted = 0;

  const attrs = (n: SceneNode) => {
    const a = [`id="${esc(n.id)}"`, `name="${esc(n.name)}"`];
    if (n.figType !== 'CANVAS' && n.figType !== 'DOCUMENT') {
      const t = n.relativeTransform;
      a.push(
        `x="${num(t.m02)}"`,
        `y="${num(t.m12)}"`,
        `width="${num(n.width)}"`,
        `height="${num(n.height)}"`,
      );
    }
    if (!n.visible) a.push('hidden="true"');
    return a.join(' ');
  };

  const visit = (n: SceneNode, depth: number) => {
    if (truncated) {
      omitted++;
      for (const c of n.children) visit(c, depth + 1);
      return;
    }
    const pad = '  '.repeat(depth);
    const tag = xmlTag(n);
    const kids = n.children;
    const open = `${pad}<${tag} ${attrs(n)}${kids.length ? '>' : ' />'}`;
    if (size + open.length > max) {
      truncated = true;
      omitted++;
      for (const c of kids) visit(c, depth + 1);
      return;
    }
    lines.push(open);
    size += open.length + 1;
    if (kids.length) {
      for (const c of kids) visit(c, depth + 1);
      lines.push(`${pad}</${tag}>`);
    }
  };
  visit(root, 0);
  if (truncated) {
    lines.push(
      `<!-- Output truncated: ${omitted} more nodes not shown. Call get_metadata on a child node id to see deeper parts of the tree. -->`,
    );
  }
  return { xml: lines.join('\n'), truncated };
}
