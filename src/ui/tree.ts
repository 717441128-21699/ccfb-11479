/**
 * 字段树视图:渲染解码树,悬停时回调供 hex 视图联动高亮。
 */

import type { DecodeNode } from '../core/types.js';

export interface TreeHandle {
  /** 按路径高亮一行;传 null 清除 */
  highlight(path: string | null): void;
  clear(): void;
}

function nodeText(node: DecodeNode): string {
  let text = node.name;
  if (node.value !== undefined) {
    text += ` = ${node.display ?? String(node.value)}`;
    if (node.unit) text += ` ${node.unit}`;
  }
  return text;
}

function nodeMeta(node: DecodeNode): string {
  const parts: string[] = [];
  if (node.length > 0) parts.push(`@${node.offset}+${node.length}`);
  if (node.bitLength !== undefined) parts.push(`bit ${node.bitOffset}+${node.bitLength}`);
  return parts.join(' ');
}

export function renderTree(
  container: HTMLElement,
  root: DecodeNode,
  onHover: (node: DecodeNode | null) => void,
): TreeHandle {
  container.innerHTML = '';
  container.classList.add('tree');
  const rows = new Map<string, HTMLElement>();

  function build(node: DecodeNode, ul: HTMLElement): void {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'node';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = nodeText(node);
    row.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ' ' + nodeMeta(node);
    row.appendChild(meta);
    if (node.error) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = ` ⚠ ${node.error}`;
      row.appendChild(err);
    }
    row.addEventListener('mouseenter', () => onHover(node));
    row.addEventListener('mouseleave', () => onHover(null));
    li.appendChild(row);
    rows.set(node.path, row);
    if (node.children?.length) {
      const sub = document.createElement('ul');
      for (const c of node.children) build(c, sub);
      li.appendChild(sub);
    }
    ul.appendChild(li);
  }

  const ul = document.createElement('ul');
  build(root, ul);
  container.appendChild(ul);

  let current: HTMLElement | null = null;
  return {
    highlight(path: string | null) {
      if (current) current.classList.remove('hl');
      current = path !== null ? rows.get(path) ?? null : null;
      if (current) current.classList.add('hl');
    },
    clear() {
      if (current) current.classList.remove('hl');
      current = null;
    },
  };
}
