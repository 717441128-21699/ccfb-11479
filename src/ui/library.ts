/** 协议库页签:协议列表、导入导出、删除 */

import { builtinIds, persist, registry } from './state.js';

export function initLibrary(el: HTMLElement, goEdit: (id: string) => void): { refresh: () => void } {
  function refresh(): void {
    const protos = registry.list();
    el.innerHTML = `
      <div class="panel">
        <h2>协议库 <span class="muted">(${protos.length} 个协议)</span></h2>
        <div class="row">
          <button class="btn primary" id="lib-new">新建协议</button>
          <button class="btn" id="lib-import">导入 JSON</button>
          <button class="btn" id="lib-export">导出全部</button>
        </div>
        <table>
          <thead><tr><th>ID</th><th>名称</th><th>版本</th><th>特性</th><th>说明</th><th>操作</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="panel hidden" id="lib-import-panel">
        <h2>导入协议 JSON(单个协议或数组)</h2>
        <textarea id="lib-import-text" rows="8" placeholder='[{"id":"...","versions":[...]}] 或单个协议对象'></textarea>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" id="lib-import-ok">导入</button>
          <span id="lib-import-msg" class="muted"></span>
        </div>
      </div>`;

    const tbody = el.querySelector('tbody')!;
    for (const p of protos) {
      const tr = document.createElement('tr');
      const features: string[] = [];
      for (const v of p.versions) {
        if (v.checksum) features.push(v.checksum.algorithm);
        if (v.fragment) features.push('分包重组');
        if (v.match) features.push('版本匹配');
        const kinds = new Set(v.fields.map((f) => f.kind));
        if (kinds.has('tlv')) features.push('TLV');
        if (kinds.has('bits')) features.push('位域');
        if (kinds.has('array')) features.push('数组');
        if (kinds.has('bcd')) features.push('BCD');
      }
      const builtin = builtinIds.has(p.id);
      tr.innerHTML = `
        <td class="muted">${p.id}</td>
        <td>${p.name}${builtin ? ' <span class="badge ok">内置</span>' : ''}</td>
        <td>${p.versions.map((v) => v.version).join(', ')}</td>
        <td class="muted">${[...new Set(features)].join(' / ')}</td>
        <td class="muted">${p.description ?? ''}</td>
        <td></td>`;
      const ops = tr.lastElementChild!;
      const editBtn = document.createElement('button');
      editBtn.className = 'btn';
      editBtn.textContent = builtin ? '查看' : '编辑';
      editBtn.addEventListener('click', () => goEdit(p.id));
      ops.appendChild(editBtn);
      if (!builtin) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn danger';
        delBtn.textContent = '删除';
        delBtn.style.marginLeft = '6px';
        delBtn.addEventListener('click', () => {
          registry.remove(p.id);
          persist();
          refresh();
        });
        ops.appendChild(delBtn);
      }
      tbody.appendChild(tr);
    }

    el.querySelector('#lib-new')!.addEventListener('click', () => goEdit(''));
    el.querySelector('#lib-export')!.addEventListener('click', () => {
      download('protocols.json', registry.exportJson());
    });
    const importPanel = el.querySelector('#lib-import-panel')!;
    el.querySelector('#lib-import')!.addEventListener('click', () => importPanel.classList.toggle('hidden'));
    el.querySelector('#lib-import-ok')!.addEventListener('click', () => {
      const text = (el.querySelector('#lib-import-text') as HTMLTextAreaElement).value.trim();
      const msg = el.querySelector('#lib-import-msg')!;
      try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of arr) registry.register(p);
        persist();
        msg.textContent = `已导入 ${arr.length} 个协议`;
        refresh();
      } catch (e) {
        msg.textContent = `导入失败: ${(e as Error).message}`;
      }
    });
  }

  refresh();
  return { refresh };
}

export function download(filename: string, content: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
