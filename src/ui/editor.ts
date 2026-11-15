/** 协议编辑页签:JSON 编辑 + 样本猜测辅助 */

import { fromHex } from '../core/decoder.js';
import { guessProtocol } from '../core/guess.js';
import type { ProtocolDef } from '../core/types.js';
import { persist, registry } from './state.js';

const TEMPLATE: ProtocolDef = {
  id: 'my-protocol',
  name: '新协议',
  description: '',
  versions: [
    {
      version: '1',
      fields: [
        { kind: 'bytes', name: 'header', label: '帧头', length: 2 },
        { kind: 'uint', name: 'addr', label: '地址', bits: 8 },
      ],
      checksum: { algorithm: 'crc16-modbus' },
    },
  ],
};

export function initEditor(el: HTMLElement): { edit: (id: string) => void } {
  el.innerHTML = `
    <div class="split">
      <div class="panel">
        <h2>协议</h2>
        <div id="ed-list"></div>
      </div>
      <div>
        <div class="panel">
          <h2>协议定义(JSON)</h2>
          <div class="row">
            <button class="btn primary" id="ed-save">保存</button>
            <button class="btn" id="ed-validate">校验格式</button>
            <button class="btn" id="ed-format">格式化</button>
            <span id="ed-msg"></span>
          </div>
          <textarea id="ed-json" rows="22" spellcheck="false"></textarea>
        </div>
        <div class="panel">
          <h2>样本猜测 <span class="muted">— 粘贴未知协议的报文样本(每行一条 hex),自动猜字段边界</span></h2>
          <textarea id="ed-samples" rows="5" placeholder="55aa0103...&#10;55aa0104..."></textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn" id="ed-guess">分析样本</button>
            <button class="btn hidden" id="ed-apply-guess">把建议填入编辑器</button>
          </div>
          <ul class="notes" id="ed-guess-notes"></ul>
          <textarea id="ed-guess-result" rows="8" class="hidden" readonly></textarea>
        </div>
      </div>
    </div>`;

  const jsonEl = el.querySelector<HTMLTextAreaElement>('#ed-json')!;
  const msgEl = el.querySelector<HTMLElement>('#ed-msg')!;
  const listEl = el.querySelector<HTMLElement>('#ed-list')!;
  let currentId = '';

  function refreshList(): void {
    listEl.innerHTML = '';
    for (const p of registry.list()) {
      const item = document.createElement('div');
      item.className = 'list-item' + (p.id === currentId ? ' active' : '');
      item.innerHTML = `${p.name}<div class="sub">${p.id} · v${p.versions.map((v) => v.version).join('/v')}</div>`;
      item.addEventListener('click', () => edit(p.id));
      listEl.appendChild(item);
    }
  }

  function edit(id: string): void {
    currentId = id;
    const p = id ? registry.get(id) : TEMPLATE;
    jsonEl.value = JSON.stringify(p ?? TEMPLATE, null, 2);
    msgEl.textContent = '';
    refreshList();
  }

  function setMsg(text: string, ok: boolean): void {
    msgEl.innerHTML = `<span class="badge ${ok ? 'ok' : 'err'}">${text}</span>`;
  }

  el.querySelector('#ed-save')!.addEventListener('click', () => {
    try {
      const p = JSON.parse(jsonEl.value) as ProtocolDef;
      registry.register(p); // register 内部做基本校验
      persist();
      currentId = p.id;
      refreshList();
      setMsg(`已保存 ${p.id}`, true);
    } catch (e) {
      setMsg((e as Error).message, false);
    }
  });

  el.querySelector('#ed-validate')!.addEventListener('click', () => {
    try {
      const p = JSON.parse(jsonEl.value) as ProtocolDef;
      if (!p.id || !Array.isArray(p.versions) || p.versions.length === 0) {
        throw new Error('缺少 id 或 versions');
      }
      for (const v of p.versions) {
        if (!Array.isArray(v.fields)) throw new Error(`版本 ${v.version} 缺少 fields`);
      }
      setMsg('格式正确', true);
    } catch (e) {
      setMsg((e as Error).message, false);
    }
  });

  el.querySelector('#ed-format')!.addEventListener('click', () => {
    try {
      jsonEl.value = JSON.stringify(JSON.parse(jsonEl.value), null, 2);
    } catch (e) {
      setMsg((e as Error).message, false);
    }
  });

  // ---- 样本猜测 ----
  const samplesEl = el.querySelector<HTMLTextAreaElement>('#ed-samples')!;
  const notesEl = el.querySelector<HTMLElement>('#ed-guess-notes')!;
  const resultEl = el.querySelector<HTMLTextAreaElement>('#ed-guess-result')!;
  const applyBtn = el.querySelector<HTMLButtonElement>('#ed-apply-guess')!;
  let guess: ReturnType<typeof guessProtocol> | null = null;

  el.querySelector('#ed-guess')!.addEventListener('click', () => {
    notesEl.innerHTML = '';
    guess = null;
    resultEl.classList.add('hidden');
    applyBtn.classList.add('hidden');
    try {
      const samples = samplesEl.value
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => fromHex(l));
      if (samples.length === 0) throw new Error('请先粘贴样本');
      guess = guessProtocol(samples);
      for (const n of guess.notes) {
        const li = document.createElement('li');
        li.textContent = n;
        notesEl.appendChild(li);
      }
      resultEl.value = JSON.stringify({ fields: guess.fields, checksum: guess.checksum }, null, 2);
      resultEl.classList.remove('hidden');
      applyBtn.classList.remove('hidden');
    } catch (e) {
      const li = document.createElement('li');
      li.textContent = `分析失败: ${(e as Error).message}`;
      notesEl.appendChild(li);
    }
  });

  applyBtn.addEventListener('click', () => {
    if (!guess) return;
    try {
      const p = JSON.parse(jsonEl.value) as ProtocolDef;
      p.versions[0].fields = guess.fields;
      if (guess.checksum) {
        p.versions[0].checksum = {
          algorithm: guess.checksum.algorithm,
          endian: guess.checksum.endian,
        };
      }
      jsonEl.value = JSON.stringify(p, null, 2);
      setMsg('建议已填入,请确认后保存', true);
    } catch (e) {
      setMsg((e as Error).message, false);
    }
  });

  edit('');
  return { edit };
}
