/** 批量解码页签:粘贴或上传大量报文,批量解码,统计成功率与耗时,导出结果 */

import { decodeMessage, fromHex } from '../core/decoder.js';
import { Reassembler, type ReassembleEvent } from '../core/fragment.js';
import type { DecodeResult } from '../core/types.js';
import { download } from './library.js';
import { batchState, registry } from './state.js';

export function initBatch(el: HTMLElement): { refreshProtocols: () => void } {
  el.innerHTML = `
    <div class="panel">
      <h2>批量解码</h2>
      <div class="row">
        <label>协议</label><select id="ba-proto"></select>
        <button class="btn" id="ba-file-btn">选择文件</button>
        <input type="file" id="ba-file" accept=".txt,.hex,.log,.csv" class="hidden">
        <button class="btn primary" id="ba-run">开始解码</button>
        <button class="btn" id="ba-export-json" disabled>导出 JSON</button>
        <button class="btn" id="ba-export-csv" disabled>导出 CSV</button>
      </div>
      <textarea id="ba-input" rows="8" placeholder="每行一条十六进制报文;# 开头的行视为注释"></textarea>
    </div>
    <div class="panel hidden" id="ba-result-panel">
      <h2>结果</h2>
      <div class="summary-cards" id="ba-cards"></div>
      <div id="ba-frag-events"></div>
      <div id="ba-failures"></div>
    </div>`;

  const protoSel = el.querySelector<HTMLSelectElement>('#ba-proto')!;
  const inputEl = el.querySelector<HTMLTextAreaElement>('#ba-input')!;
  const fileInput = el.querySelector<HTMLInputElement>('#ba-file')!;
  const resultPanel = el.querySelector<HTMLElement>('#ba-result-panel')!;
;
  const cardsEl = el.querySelector<HTMLElement>('#ba-cards')!;
  const fragEl = el.querySelector<HTMLElement>('#ba-frag-events')!;
  const failEl = el.querySelector<HTMLElement>('#ba-failures')!;
  const exportJsonBtn = el.querySelector<HTMLButtonElement>('#ba-export-json')!;
  const exportCsvBtn = el.querySelector<HTMLButtonElement>('#ba-export-csv')!;

  function refreshProtocols(): void {
    const prev = protoSel.value;
    protoSel.innerHTML = '';
    for (const p of registry.list()) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.id})`;
      protoSel.appendChild(opt);
    }
    if (prev) protoSel.value = prev;
  }

  el.querySelector('#ba-file-btn')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (f) inputEl.value = await f.text();
  });

  el.querySelector('#ba-run')!.addEventListener('click', () => {
    const proto = registry.get(protoSel.value);
    if (!proto) {
      alert('请选择协议');
      return;
    }
    const lines = inputEl.value
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    const fragDef = proto.versions.find((v) => v.fragment)?.fragment;
    const results: DecodeResult[] = [];
    const hexes: string[] = [];
    const failures: { line: number; hex: string; error: string }[] = [];
    const fragEvents: ReassembleEvent[] = [];
    let checksumFail = 0;
    let decodeError = 0;

    const t0 = performance.now();
    if (fragDef) {
      // 分片协议:重组后解码
      const inner = fragDef.innerProtocolId ? registry.get(fragDef.innerProtocolId) : undefined;
      const reasm = new Reassembler(proto, inner);
      for (const line of lines) {
        try {
          for (const ev of reasm.push(fromHex(line))) {
            fragEvents.push(ev);
            if (ev.type === 'complete' && ev.decoded) {
              results.push(ev.decoded);
              hexes.push(line);
              if (ev.decoded.checksum && !ev.decoded.checksum.ok) checksumFail++;
              if (!ev.decoded.ok) decodeError++;
            }
          }
        } catch (e) {
          failures.push({ line: results.length, hex: line.slice(0, 60), error: (e as Error).message });
        }
      }
      fragEvents.push(...reasm.finalize());
    } else {
      lines.forEach((line, i) => {
        try {
          const r = decodeMessage(fromHex(line), proto);
          results.push(r);
          hexes.push(line);
          if (r.checksum && !r.checksum.ok) checksumFail++;
          if (!r.ok) decodeError++;
          if (!r.ok && failures.length < 100) {
            failures.push({ line: i + 1, hex: line.slice(0, 60), error: r.errors.join('; ') });
          }
        } catch (e) {
          decodeError++;
          if (failures.length < 100) {
            failures.push({ line: i + 1, hex: line.slice(0, 60), error: (e as Error).message });
          }
        }
      });
    }
    const ms = performance.now() - t0;

    batchState.protocolId = proto.id;
    batchState.results = results;
    batchState.hexes = hexes;

    const completed = fragDef ? fragEvents.filter((e) => e.type === 'complete').length : 0;
    const lost = fragDef ? fragEvents.filter((e) => e.type === 'incomplete').length : 0;
    cardsEl.innerHTML = '';
    const cards: [string, string, string][] = fragDef
      ? [
          [String(lines.length), '分片帧', ''],
          [String(completed), '拼回完整报文', 'ok'],
          [String(lost), '丢包会话', lost > 0 ? 'err' : ''],
          [`${ms.toFixed(1)}ms`, '耗时', ''],
        ]
      : [
          [String(results.length), '总条数', ''],
          [String(results.length - decodeError), '解码成功', 'ok'],
          [String(checksumFail), '校验失败', checksumFail > 0 ? 'err' : ''],
          [String(decodeError), '解码错误', decodeError > 0 ? 'err' : ''],
          [`${ms.toFixed(1)}ms`, '耗时', ms > 1000 ? 'warn' : 'ok'],
        ];
    for (const [num, lbl, cls] of cards) {
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML = `<div class="num" style="color:var(--${cls || 'text'})">${num}</div><div class="lbl">${lbl}</div>`;
      cardsEl.appendChild(div);
    }

    // 分片事件
    fragEl.innerHTML = '';
    if (fragDef) {
      const problems = fragEvents.filter((e) => e.type !== 'complete' && e.type !== 'progress');
      if (problems.length > 0) {
        const ul = document.createElement('ul');
        ul.className = 'notes';
        for (const ev of problems.slice(0, 100)) {
          const li = document.createElement('li');
          li.textContent = ev.message;
          ul.appendChild(li);
        }
        fragEl.appendChild(ul);
      }
    }

    // 失败列表
    failEl.innerHTML = '';
    if (failures.length > 0) {
      const tbl = document.createElement('table');
      tbl.innerHTML = '<thead><tr><th>行号</th><th>报文(截断)</th><th>问题</th></tr></thead>';
      const tb = document.createElement('tbody');
      for (const f of failures) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${f.line}</td><td class="muted">${f.hex}</td><td style="color:var(--err)">${f.error}</td>`;
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      failEl.appendChild(tbl);
    }

    exportJsonBtn.disabled = results.length === 0;
    exportCsvBtn.disabled = results.length === 0;
    resultPanel.classList.remove('hidden');
  });

  exportJsonBtn.addEventListener('click', () => {
    download(
      `decode-${batchState.protocolId}.json`,
      JSON.stringify(batchState.results.map((r) => ({ version: r.version, ok: r.ok, values: r.values })), null, 2),
    );
  });

  exportCsvBtn.addEventListener('click', () => {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const r of batchState.results) {
      for (const k of Object.keys(r.values)) {
        if (!seen.has(k)) {
          seen.add(k);
          paths.push(k);
        }
      }
    }
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [paths.map(esc).join(',')];
    for (const r of batchState.results) {
      rows.push(paths.map((p) => esc(r.values[p])).join(','));
    }
    download(`decode-${batchState.protocolId}.csv`, rows.join('\n'));
  });

  refreshProtocols();
  return { refreshProtocols };
}
