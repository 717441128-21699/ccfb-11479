/**
 * 十六进制视图:按字节渲染,顶层字段交替配色。
 * 提供区间高亮与字节悬停回调,与字段树联动。
 */

import type { DecodeNode } from '../core/types.js';

export interface HexViewHandle {
  /** 高亮 [offset, offset+length) 区间;传空清除 */
  highlight(offset: number, length: number): void;
  clear(): void;
}

export function renderHexView(
  container: HTMLElement,
  buf: Uint8Array,
  root: DecodeNode,
  onByteHover: (byteIndex: number | null) => void,
): HexViewHandle {
  container.innerHTML = '';
  container.classList.add('hexview');

  // 每个字节归属的顶层字段序号(用于配色)
  const owner = new Array<number>(buf.length).fill(-1);
  const topFields = root.children ?? [];
  topFields.forEach((f, i) => {
    for (let b = f.offset; b < Math.min(f.offset + f.length, buf.length); b++) owner[b] = i % 8;
  });

  const spans: HTMLSpanElement[] = [];
  const frag = document.createDocumentFragment();
  for (let rowStart = 0; rowStart < buf.length; rowStart += 16) {
    const line = document.createElement('div');
    const off = document.createElement('span');
    off.className = 'off';
    off.textContent = rowStart.toString(16).padStart(4, '0') + '  ';
    line.appendChild(off);
    let ascii = '';
    for (let i = rowStart; i < Math.min(rowStart + 16, buf.length); i++) {
      const b = buf[i];
      const span = document.createElement('span');
      span.className = 'b' + (owner[i] >= 0 ? ` f${owner[i]}` : '');
      span.textContent = b.toString(16).padStart(2, '0');
      span.dataset.i = String(i);
      span.addEventListener('mouseenter', () => onByteHover(i));
      span.addEventListener('mouseleave', () => onByteHover(null));
      line.appendChild(span);
      line.appendChild(document.createTextNode(i % 16 === 7 ? '  ' : ' '));
      spans[i] = span;
      ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
    }
    const asciiSpan = document.createElement('span');
    asciiSpan.className = 'ascii';
    asciiSpan.textContent = '  ' + ascii;
    line.appendChild(asciiSpan);
    frag.appendChild(line);
  }
  container.appendChild(frag);

  let highlighted: HTMLSpanElement[] = [];
  return {
    highlight(offset: number, length: number) {
      for (const s of highlighted) s.classList.remove('hl');
      highlighted = [];
      for (let i = offset; i < Math.min(offset + length, spans.length); i++) {
        if (spans[i]) {
          spans[i].classList.add('hl');
          highlighted.push(spans[i]);
        }
      }
    },
    clear() {
      for (const s of highlighted) s.classList.remove('hl');
      highlighted = [];
    },
  };
}

/** 找覆盖某个字节的最深节点 */
export function deepestNodeAt(node: DecodeNode, byteIndex: number): DecodeNode | null {
  if (byteIndex < node.offset || byteIndex >= node.offset + node.length) return null;
  for (const c of node.children ?? []) {
    const hit = deepestNodeAt(c, byteIndex);
    if (hit) return hit;
  }
  return node.length > 0 ? node : null;
}
