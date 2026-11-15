import { useState } from 'react';
import type { DecodeNode } from '../engine/types';

interface Props {
  node: DecodeNode;
  selectedPath: string | null;
  onSelect: (node: DecodeNode) => void;
  depth?: number;
}

const TYPE_LABEL: Record<string, string> = {
  uint: 'UINT', int: 'INT', float: 'FLOAT', bcd: 'BCD', bool: 'BOOL', enum: 'ENUM',
  bits: 'BITS', string: 'STR', bytes: 'BYTES', array: 'ARRAY', tlv: 'TLV',
  struct: 'STRUCT', crc: 'CRC', 'tlv-item': 'TLV',
};

export function FieldTree({ node, selectedPath, onSelect, depth = 0 }: Props) {
  const [open, setOpen] = useState(depth < 3);
  const hasChildren = !!node.children?.length || !!node.bits?.length;
  const selected = selectedPath === node.path;
  const crcBad = node.type === 'crc' && node.crcOk === false;

  return (
    <div className="tree-node">
      <div
        className={['tree-line', selected ? 'selected' : '', crcBad ? 'crc-bad' : ''].filter(Boolean).join(' ')}
        onClick={() => onSelect(node)}
      >
        <span
          className="tree-toggle"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setOpen(!open); }}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </span>
        <span className="tree-name">{node.name}</span>
        <span className="tree-type">{TYPE_LABEL[node.type] ?? node.type.toUpperCase()}</span>
        {node.type !== 'struct' && node.type !== 'array' && node.type !== 'tlv' && (
          <span className="tree-value">{formatValue(node)}</span>
        )}
        {node.crcOk !== undefined && (
          <span className={`tag ${node.crcOk ? 'ok' : 'err'}`}>{node.crcOk ? '校验通过' : '校验失败'}</span>
        )}
        <span className="tree-range">[{node.start}–{node.end})</span>
      </div>

      {node.warning && <div className="tree-warn" style={{ marginLeft: 32 }}>⚠ {node.warning}</div>}
      {node.error && <div className="tree-err" style={{ marginLeft: 32 }}>✗ {node.error}</div>}

      {open && node.bits && node.bits.length > 0 && (
        <div className="tree-bits">
          {node.bits.map((b) => (
            <div className="tree-bit" key={b.name}>
              {b.name} (bit {b.bitStart}–{b.bitEnd}) = {b.display}
            </div>
          ))}
        </div>
      )}

      {open && node.children && node.children.length > 0 && (
        <div className="tree-children">
          {node.children.map((child) => (
            <FieldTree
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatValue(node: DecodeNode): string {
  if (node.display) return node.display;
  if (typeof node.value === 'object') return JSON.stringify(node.value);
  return String(node.value);
}

/** 收集全部节点 (扁平), 供点击字节反查 */
export function flattenNodes(node: DecodeNode, acc: DecodeNode[] = []): DecodeNode[] {
  acc.push(node);
  for (const c of node.children ?? []) flattenNodes(c, acc);
  return acc;
}

/** 找到包含指定字节偏移的最小字段节点 */
export function findNodeAtByte(nodes: DecodeNode[], index: number): DecodeNode | null {
  let best: DecodeNode | null = null;
  for (const n of nodes) {
    if (index >= n.start && index < n.end) {
      if (!best || n.end - n.start <= best.end - best.start) best = n;
    }
  }
  return best;
}
