import { useMemo } from 'react';
import { toHexRows } from './hexutil';

interface Props {
  bytes: Uint8Array;
  /** 当前高亮字节区间 (来自字段树) */
  highlight: { start: number; end: number } | null;
  /** 点击字节回调 (反向高亮字段树) */
  onByteClick?: (index: number) => void;
  /** CRC 失败的字节区间标红 */
  badRanges?: { start: number; end: number }[];
}

export function HexViewer({ bytes, highlight, onByteClick, badRanges }: Props) {
  const rows = useMemo(() => toHexRows(bytes), [bytes]);
  const inRange = (i: number, r?: { start: number; end: number } | null) =>
    !!r && i >= r.start && i < r.end;

  return (
    <div className="hex-wrap">
      {rows.length === 0 && <div className="muted">无数据</div>}
      {rows.map((row) => (
        <div className="hex-row" key={row.offset}>
          <span className="hex-offset">{row.offset.toString(16).padStart(6, '0')}</span>
          <span className="hex-bytes">
            {row.bytes.map(({ value, index }) => {
              const hl = inRange(index, highlight);
              const bad = badRanges?.some((r) => inRange(index, r));
              const cls = ['hex-byte', hl ? 'hl-tree' : '', bad ? 'crc-bad' : ''].filter(Boolean).join(' ');
              return (
                <span
                  key={index}
                  className={cls}
                  onClick={() => onByteClick?.(index)}
                  title={`偏移 ${index} (0x${index.toString(16)})`}
                >
                  {value.toString(16).padStart(2, '0')}
                </span>
              );
            })}
          </span>
          <span className="hex-ascii">{row.ascii}</span>
        </div>
      ))}
    </div>
  );
}
