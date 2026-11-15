/** 字段统计页签:对最近一次批量解码结果做字段级聚合统计 */

import { computeStats } from '../core/stats.js';
import { batchState } from './state.js';

export function initStats(el: HTMLElement): { refresh: () => void } {
  function refresh(): void {
    if (batchState.results.length === 0) {
      el.innerHTML = `
        <div class="panel">
          <h2>字段统计</h2>
          <p class="muted">还没有批量解码数据。请先到「批量解码」页签跑一批报文,再回来查看统计。</p>
        </div>`;
      return;
    }
    const stats = computeStats(batchState.results);
    el.innerHTML = `
      <div class="panel">
        <h2>字段统计 <span class="muted">— ${batchState.protocolId}, ${batchState.results.length} 条报文, ${stats.length} 个字段路径</span></h2>
        <table>
          <thead>
            <tr><th>字段路径</th><th>出现次数</th><th>最小</th><th>最大</th><th>均值</th><th>唯一值数</th><th>高频取值 Top 5</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>`;
    const tbody = el.querySelector('tbody')!;
    for (const s of stats) {
      const tr = document.createElement('tr');
      const top = s.top
        .slice(0, 5)
        .map((t) => `${t.value} (${((t.count / s.count) * 100).toFixed(1)}%)`)
        .join(', ');
      tr.innerHTML = `
        <td style="font-family:var(--mono)">${s.path}</td>
        <td>${s.count}</td>
        <td>${s.numeric ? s.min : '<span class="muted">—</span>'}</td>
        <td>${s.numeric ? s.max : '<span class="muted">—</span>'}</td>
        <td>${s.numeric ? s.mean : '<span class="muted">—</span>'}</td>
        <td>${s.unique}</td>
        <td class="muted">${top}</td>`;
      tbody.appendChild(tr);
    }
  }

  refresh();
  return { refresh };
}
