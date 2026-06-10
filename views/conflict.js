// 冲突比对 + 三方合并视图（显示基础版本对比）
const ConflictView = (() => {
  let _conflicts = [];
  let _currentConflict = null;
  let _selections = {};
  let _currentDiffs = [];

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

    // 使用三方差异比对
    _currentDiffs = SyncManager.diffObjectsThreeWay(
      _currentConflict.baseData,
      _currentConflict.localData,
      _currentConflict.remoteData
    );

    // 自动选择无冲突字段
    _currentDiffs.forEach(diff => {
      if (!diff.conflict) {
        // 只有一方修改 → 自动选择修改方
        if (diff.localChanged && !diff.remoteChanged) {
          _selections[diff.field] = 'local';
        } else if (diff.remoteChanged && !diff.localChanged) {
          _selections[diff.field] = 'remote';
        }
      }
    });

    const conflictCount = _currentDiffs.filter(d => d.conflict).length;
    const autoCount = _currentDiffs.length - conflictCount;

    container.innerHTML = `
      <div class="conflict-container">
        <div class="conflict-header">
          <div>
            <div style="font-size:16px;font-weight:600">
              ${_currentConflict.entityType === 'patients' ? '患者' : '随访'} 数据冲突
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">
              共 ${_conflicts.length} 个冲突 · 第 1 个
              · ${conflictCount} 个需手动选择 · ${autoCount} 个已自动合并
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-hint);margin-bottom:4px;padding:0 4px">
          <span>本地修订 (r${_currentConflict.localVersion || 0})</span>
          <span>基础版本</span>
          <span>远程版本 (v${_currentConflict.remoteVersion || 0})</span>
        </div>

        <div id="conflict-fields">
          ${_currentDiffs.map(diff => _renderConflictField(diff)).join('')}
        </div>

        ${_currentDiffs.length === 0 ? `
          <div class="card" style="text-align:center;padding:24px">
            <div style="color:var(--success)">数据内容一致，无需合并</div>
          </div>
        ` : ''}

        ${_currentConflict.mergeResult?.conflicts?.length > 0 ? `
          <div class="card" style="margin:12px 0;background:#fff9c4;padding:12px">
            <div style="font-size:13px;font-weight:600;color:#f57f17;margin-bottom:4px">模板版本冲突</div>
            ${_currentConflict.mergeResult.conflicts
              .filter(c => c.type === 'template_version_conflict')
              .map(c => `
                <div style="font-size:12px;margin-bottom:4px">
                  模板 ${c.templateId}: 本地 v${c.localValue} vs 远程 v${c.remoteValue}
                </div>
              `).join('')
            }
          </div>
        ` : ''}

        <div class="btn-group" style="margin-top:16px">
          <button class="btn btn-secondary btn-sm" id="btn-keep-all-local">全部保留本地</button>
          <button class="btn btn-secondary btn-sm" id="btn-keep-all-remote">全部使用远程</button>
        </div>
        <div class="btn-group">
          <button class="btn btn-secondary" id="btn-auto-merge">三方自动合并</button>
          <button class="btn btn-primary" id="btn-resolve-conflict">确认解决</button>
        </div>

        ${_conflicts.length > 1 ? `
          <div style="text-align:center;margin-top:12px">
            <button class="btn btn-sm btn-outline" id="btn-next-conflict">下一个冲突 (${_conflicts.length - 1})</button>
          </div>
        ` : ''}
      </div>
    `;

    _bindEvents();
  }

  function _renderConflictField(diff) {
    const fieldLabels = {
      name: '姓名', age: '年龄', gender: '性别', diseases: '疾病类型',
      phone: '电话', address: '地址', riskLevel: '风险等级',
      bpSystolic: '收缩压', bpDiastolic: '舒张压', bloodSugar: '血糖',
      medications: '用药', notes: '备注', lastVisitDate: '最后随访日期',
      attachments: '附件', questionnaires: '问卷数据', date: '日期',
      nextVisitDate: '下次复诊'
    };

    const label = fieldLabels[diff.field] || diff.field;
    const localDisplay = _formatValue(diff.localValue);
    const remoteDisplay = _formatValue(diff.remoteValue);
    const baseDisplay = _formatValue(diff.baseValue);
    const isSelected = _selections[diff.field] !== undefined;

    // 冲突标记
    const conflictBadge = diff.conflict
      ? '<span style="background:#ffebee;color:#c62828;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px">冲突</span>'
      : '<span style="background:#e8f5e9;color:#2e7d32;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px">自动</span>';

    return `
      <div class="conflict-field ${diff.conflict ? 'conflict-real' : 'conflict-auto'}" data-field="${diff.field}">
        <div class="conflict-field-header">
          ${label}${conflictBadge}
        </div>
        ${diff.baseValue !== undefined ? `
          <div style="font-size:11px;color:var(--text-hint);margin-bottom:4px;padding:2px 4px;background:#f5f5f5;border-radius:4px">
            基础: ${baseDisplay}
          </div>
        ` : ''}
        <div class="conflict-compare">
          <div class="conflict-side local ${_selections[diff.field] === 'local' ? 'selected' : ''}"
               data-field="${diff.field}" data-choice="local"
               style="${diff.localChanged ? 'border-left:3px solid var(--primary)' : ''}">
            <div>
              <span class="label">本地${diff.localChanged ? ' *' : ''}</span>
              ${localDisplay}
            </div>
          </div>
          <div class="conflict-side remote ${_selections[diff.field] === 'remote' ? 'selected' : ''}"
               data-field="${diff.field}" data-choice="remote"
               style="${diff.remoteChanged ? 'border-left:3px solid var(--success)' : ''}">
            <div>
              <span class="label">远程${diff.remoteChanged ? ' *' : ''}</span>
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

  function _bindEvents() {
    // Click on conflict side to select
    document.getElementById('conflict-fields').addEventListener('click', e => {
      const side = e.target.closest('.conflict-side');
      if (!side) return;

      const field = side.dataset.field;
      const choice = side.dataset.choice;
      _selections[field] = choice;

      const parent = side.closest('.conflict-field');
      parent.querySelectorAll('.conflict-side').forEach(s => s.classList.remove('selected'));
      side.classList.add('selected');
    });

    // Keep all local
    document.getElementById('btn-keep-all-local').addEventListener('click', () => {
      _currentDiffs.forEach(d => { _selections[d.field] = 'local'; });
      document.querySelectorAll('.conflict-side').forEach(s => {
        s.classList.toggle('selected', s.dataset.choice === 'local');
      });
    });

    // Keep all remote
    document.getElementById('btn-keep-all-remote').addEventListener('click', () => {
      _currentDiffs.forEach(d => { _selections[d.field] = 'remote'; });
      document.querySelectorAll('.conflict-side').forEach(s => {
        s.classList.toggle('selected', s.dataset.choice === 'remote');
      });
    });

    // Three-way auto merge
    document.getElementById('btn-auto-merge').addEventListener('click', () => {
      // 三方自动合并：无冲突的字段自动选择修改方，冲突字段标记为 auto（取远程）
      _currentDiffs.forEach(d => {
        if (!d.conflict) {
          if (d.localChanged && !d.remoteChanged) {
            _selections[d.field] = 'local';
          } else if (d.remoteChanged && !d.localChanged) {
            _selections[d.field] = 'remote';
          }
          // 双方做相同修改，选任意一方
          else if (d.localChanged && d.remoteChanged) {
            _selections[d.field] = 'local';
          }
        } else {
          _selections[d.field] = 'auto';
        }
      });
      // 更新UI
      document.querySelectorAll('.conflict-side').forEach(s => {
        const field = s.dataset.field;
        const choice = s.dataset.choice;
        s.classList.toggle('selected', _selections[field] === choice);
      });
      Utils.showToast('已执行三方自动合并', 'info');
    });

    // Resolve
    document.getElementById('btn-resolve-conflict').addEventListener('click', async () => {
      // 只检查冲突字段是否已选择
      const unresolved = _currentDiffs.filter(d => d.conflict && !_selections[d.field]);
      if (unresolved.length > 0) {
        Utils.showToast(`还有 ${unresolved.length} 个冲突字段未选择`, 'warning');
        return;
      }

      // Build resolved data using three-way merge logic
      let resolvedData = { ...(_currentConflict.baseData || _currentConflict.remoteData || {}) };
      const local = _currentConflict.localData || {};
      const remote = _currentConflict.remoteData || {};

      for (const diff of _currentDiffs) {
        const choice = _selections[diff.field];
        if (choice === 'local') {
          resolvedData[diff.field] = diff.localValue;
        } else if (choice === 'remote') {
          resolvedData[diff.field] = diff.remoteValue;
        } else if (choice === 'auto') {
          // auto: 取远程值（或可进一步分析）
          resolvedData[diff.field] = diff.remoteValue;
        }
      }

      // Merge non-conflicting fields that weren't in diffs
      if (local) {
        for (const key of Object.keys(local)) {
          if (key.startsWith('_')) continue;
          if (key === 'syncStatus' || key === 'syncVersion') continue;
          if (resolvedData[key] === undefined) {
            resolvedData[key] = local[key];
          }
        }
      }
      if (remote) {
        for (const key of Object.keys(remote)) {
          if (key.startsWith('_')) continue;
          if (key === 'syncStatus' || key === 'syncVersion') continue;
          if (resolvedData[key] === undefined) {
            resolvedData[key] = remote[key];
          }
        }
      }

      resolvedData.syncStatus = 'pending';
      resolvedData.syncVersion = _currentConflict.remoteVersion;

      try {
        await SyncManager.resolveConflict(_currentConflict.id, resolvedData, 'merged');
        Utils.showToast('冲突已解决', 'success');

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
    const nextBtn = document.getElementById('btn-next-conflict');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        _conflicts.shift();
        if (_conflicts.length > 0) {
          render();
        } else {
          App.navigate('sync-review');
        }
      });
    }
  }

  return { render };
})();
