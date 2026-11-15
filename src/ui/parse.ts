/** 报文解析页签:单条报文解码,hex 视图与字段树双向高亮 */

import { decodeMessage, fromHex } from '../core/decoder.js';
import type { DecodeNode } from '../core/types.js';
import { deepestNodeAt, renderHexView } from './hexview.js';
import { registry } from './state.js';
import { renderTree } from './tree.js';

export function initParse(el: HTMLElement): { refreshProtocols: () => void } {
  el.innerHTML = `
    <div class="panel">
      <h2>报文解析</h2>
      <div class="row">
        <label>协议</label><select id="pa-proto"></select>
        <label>版本</label><select id="pa-version"></select>
        <button class="btn primary" id="pa-decode">解码</button>
        <span id="pa-status"></span>
      </div>
      <textarea id="pa-hex" rows="3" placeholder="粘贴十六进制报文,如: 55aa01030003012c01f403e8..."></textarea>
      <div id="pa-errors" class="notes" style="margin-top:6px"></div>
    </div>
    <div class="parse-grid">
      <div class="panel"><h2>十六进制</h2><div id="pa-hexview"></div></div>
      <div class="panel"><h2>字段树</h2><div id="pa-tree"></div></div>
    </div>`;

  const protoSel = el.querySelector<HTMLSelectElement>('#pa-proto')!;
  const versionSel = el.querySelector<HTMLSelectElement>('#pa-version')!;
  const hexEl = el.querySelector<HTMLTextAreaElement>('#pa-hex')!;
  const statusEl = el.querySelector<HTMLElement>('#pa-status')!;
  const errorsEl = el.querySelector<HTMLElement>('#pa-errors')!;
  const hexViewEl = el.querySelector<HTMLElement>('#pa-hexview')!;
  const treeEl = el.querySelector<HTMLElement>('#pa-tree')!;

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
    refreshVersions();
  }

  function refreshVersions(): void {
    const p = registry.get(protoSel.value);
    versionSel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动匹配';
    versionSel.appendChild(auto);
    for (const v of p?.versions ?? []) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = `v${v.version}`;
      versionSel.appendChild(opt);
    }
  }

  protoSel.addEventListener('change', refreshVersions);

  el.querySelector('#pa-decode')!.addEventListener('click', () => {
    errorsEl.innerHTML = '';
    statusEl.innerHTML = '';
    hexViewEl.innerHTML = '';
    treeEl.innerHTML = '';
    try {
      const proto = registry.get(protoSel.value);
      if (!proto) throw new Error('请选择协议');
      const buf = fromHex(hexEl.value);
      if (buf.length === 0) throw new Error('请输入报文');
      const version = versionSel.value || undefined;
      const result = decodeMessage(buf, proto, version ? { version } : {});

      // 状态徽标
      const badges: string[] = [`<span class="badge ok">v${result.version}</span>`];
      if (result.checksum) {
        badges.push(
          result.checksum.ok
            ? `<span class="badge ok">${result.checksum.algorithm} 校验通过</span>`
            : `<span class="badge err">${result.checksum.algorithm} 校验失败</span>`,
        );
      }
      badges.push(
        result.ok
          ? '<span class="badge ok">解码成功</span>'
          : `<span class="badge err">${result.errors.length} 个问题</span>`,
      );
      statusEl.innerHTML = badges.join(' ');
      for (const e of result.errors) {
        const div = document.createElement('div');
        div.textContent = '⚠ ' + e;
        errorsEl.appendChild(div);
      }

      // 双向高亮:树 <-> hex
      let treeHandle: ReturnType<typeof renderTree> | null = null;
      const hexHandle = renderHexView(hexViewEl, buf, result.root, (byteIndex) => {
        if (byteIndex === null) {
          hexHandle.clear();
          treeHandle?.clear();
          return;
        }
        const node = deepestNodeAt(result.root, byteIndex);
        if (node) {
          hexHandle.highlight(node.offset, node.length);
          treeHandle?.highlight(node.path);
        }
      });
      treeHandle = renderTree(treeEl, result.root, (node: DecodeNode | null) => {
        if (node) hexHandle.highlight(node.offset, node.length);
        else hexHandle.clear();
      });
    } catch (e) {
      statusEl.innerHTML = `<span class="badge err">${(e as Error).message}</span>`;
    }
  });

  refreshProtocols();
  return { refreshProtocols };
}
