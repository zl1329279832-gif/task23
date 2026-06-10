// 冲突比对 + 手动合并视图
const ConflictView = (() => {
  let _conflicts = [];
  let _currentConflict = null;
  let _selections = {};

  async function render() {
    document.getElementById('page-title').textContent = '冲突解决';
    document.getElementById('btn-back').style.display = 'flex';
    document.getElementById('bottom-nav').style.display = 'none';
    document.getElementById('btn-back').onclick = () => App.navigate('sync-review');

    _conflicts = await DB.getUnresolvedConflicts();

    const container = document.getElementById('view-container');

    if (_conflicts.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          <div class="title">无冲突</div>
          <div class="desc">所有数据版本一致</div>
        </div>
      `;
      return;
    }

    _currentConflict = _conflicts[0];
    _selections = {};

    const diffs = SyncManager.diffObjects(
      _currentConflict.localData,
      _currentConflict.remoteData
    );

    container.innerHTML = `
      <div class="conflict-container">
        <div class="conflict-header">
          <div>
            <div style="font-size:16px;font-weight:600">
              ${_currentConflict.entityType === 'patients' ? '患者' : '随访'} 数据冲突
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">
              共 ${_conflicts.length} 个冲突 · 第 1 个
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-hint);margin-bottom:8px;padding:0 4px">
          <span>本地版本 (v${_currentConflict.localVersion || 0})</span>
          <span>远程版本 (v${_currentConflict.remoteVersion || 0})</span>
        </div>

        <div id="conflict-fields">
          ${diffs.map(diff => _renderConflictField(diff)).join('')}
        </div>

        ${diffs.length === 0 ? `
          <div class="card" style="text-align:center;padding:24px">
            <div style="color:var(--success)">数据内容一致，无需合并</div>
          </div>
        ` : ''}

        <div class="btn-group" style="margin-top:16px">
          <button class="btn btn-secondary btn-sm" id="btn-keep-all-local">全部保留本地</button>
          <button class="btn btn-secondary btn-sm" id="btn-keep-all-remote">全部使用远程</button>
        </div>
        <div class="btn-group">
          <button class="btn btn-secondary" id="btn-auto-merge">自动合并</button>
          <button class="btn btn-primary" id="btn-resolve-conflict">确认解决</button>
        </div>

        ${_conflicts.length > 1 ? `
          <div style="text-align:center;margin-top:12px">
            <button class="btn btn-sm btn-outline" id="btn-next-conflict">下一个冲突</button>
          </div>
        ` : ''}
      </div>
    `;

    _bindEvents(diffs);
  }

  function _renderConflictField(diff) {
    const fieldLabels = {
      name: '姓名', age: '年龄', gender: '性别', diseases: '疾病类型',
      phone: '电话', address: '地址', riskLevel: '风险等级',
      bpSystolic: '收缩压', bpDiastolic: '舒张压', bloodSugar: '血糖',
      medications: '用药', notes: '备注', lastVisitDate: '最后随访日期'
    };

    const label = fieldLabels[diff.field] || diff.field;
    const localDisplay = _formatValue(diff.localValue);
    const remoteDisplay = _formatValue(diff.remoteValue);

    return `
      <div class="conflict-field" data-field="${diff.field}">
        <div class="conflict-field-header">${label}</div>
        <div class="conflict-compare">
          <div class="conflict-side local ${_selections[diff.field] === 'local' ? 'selected' : ''}"
               data-field="${diff.field}" data-choice="local">
            <div>
              <span class="label">本地</span>
              ${localDisplay}
            </div>
          </div>
          <div class="conflict-side remote ${_selections[diff.field] === 'remote' ? 'selected' : ''}"
               data-field="${diff.field}" data-choice="remote">
            <div>
              <span class="label">远程</span>
              ${remoteDisplay}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function _formatValue(val) {
    if (val === null || val === undefined) return '<em style="color:var(--text-hint)">空</em>';
    if (Array.isArray(val)) return val.map(v => Utils.escapeHTML(String(v))).join(', ');
    if (typeof val === 'object') return '<pre style="font-size:12px;margin:0">' + Utils.escapeHTML(JSON.stringify(val, null, 2)) + '</pre>';
    if (typeof val === 'boolean') return val ? '是' : '否';
    return Utils.escapeHTML(String(val));
  }

  function _bindEvents(diffs) {
    // Click on conflict side to select
    document.getElementById('conflict-fields').addEventListener('click', e => {
      const side = e.target.closest('.conflict-side');
      if (!side) return;

      const field = side.dataset.field;
      const choice = side.dataset.choice;
      _selections[field] = choice;

      // Update UI
      const parent = side.closest('.conflict-field');
      parent.querySelectorAll('.conflict-side').forEach(s => s.classList.remove('selected'));
      side.classList.add('selected');
    });

    // Keep all local
    document.getElementById('btn-keep-all-local').addEventListener('click', () => {
      diffs.forEach(d => { _selections[d.field] = 'local'; });
      document.querySelectorAll('.conflict-side').forEach(s => {
        s.classList.toggle('selected', s.dataset.choice === 'local');
      });
    });

    // Keep all remote
    document.getElementById('btn-keep-all-remote').addEventListener('click', () => {
      diffs.forEach(d => { _selections[d.field] = 'remote'; });
      document.querySelectorAll('.conflict-side').forEach(s => {
        s.classList.toggle('selected', s.dataset.choice === 'remote');
      });
    });

    // Auto merge
    document.getElementById('btn-auto-merge').addEventListener('click', () => {
      diffs.forEach(d => { _selections[d.field] = 'auto'; });
      document.querySelectorAll('.conflict-side').forEach(s => s.classList.remove('selected'));
      Utils.showToast('已自动合并（取最新值）', 'info');
    });

    // Resolve
    document.getElementById('btn-resolve-conflict').addEventListener('click', async () => {
      if (diffs.length > 0) {
        const unresolved = diffs.filter(d => !_selections[d.field]);
        if (unresolved.length > 0) {
          Utils.showToast(`还有 ${unresolved.length} 个字段未选择`, 'warning');
          return;
        }
      }

      // Build resolved data
      let resolvedData = { ...(_currentConflict.remoteData || {}) };
      const local = _currentConflict.localData || {};

      for (const diff of diffs) {
        const choice = _selections[diff.field];
        if (choice === 'local') {
          resolvedData[diff.field] = diff.localValue;
        } else if (choice === 'auto') {
          // Auto merge takes the more recent value
          resolvedData[diff.field] = diff.remoteValue;
        }
        // 'remote' keeps the remote value (already set)
      }

      // Merge non-conflicting local fields
      if (local) {
        for (const key of Object.keys(local)) {
          if (key.startsWith('_')) continue;
          if (resolvedData[key] === undefined) {
            resolvedData[key] = local[key];
          }
        }
      }

      resolvedData.syncStatus = 'pending';
      resolvedData.syncVersion = _currentConflict.remoteVersion;

      try {
        await SyncManager.resolveConflict(_currentConflict.id, resolvedData, 'merged');
        Utils.showToast('冲突已解决', 'success');

        // Move to next conflict or back
        _conflicts = await DB.getUnresolvedConflicts();
        if (_conflicts.length > 0) {
          render();
        } else {
          App.navigate('sync-review');
        }
      } catch (err) {
        Utils.showToast('解决失败: ' + err.message, 'error');
      }
    });

    // Next conflict
    document.getElementById('btn-next-conflict')?.addEventListener('click', () => {
      _conflicts.shift();
      if (_conflicts.length > 0) {
        render();
      } else {
        App.navigate('sync-review');
      }
    });
  }

  return { render };
})();
