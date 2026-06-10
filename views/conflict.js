// 冲突比对 + 三方合并视图 + 模板版本感知
const ConflictView = (() => {
  let _conflicts = [];
  let _currentConflict = null;
  let _selections = {};
  let _threeWayDiffs = null;
  let _autoMergeResult = null;

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
    _threeWayDiffs = null;
    _autoMergeResult = null;

    const hasBase = !!_currentConflict.baseData;
    const templateMismatch = !!_currentConflict.templateVersionMismatch;

    // 根据是否有 base 选择 diff 策略
    let diffs;
    if (hasBase) {
      _threeWayDiffs = SyncManager.diffThreeWay(
        _currentConflict.baseData,
        _currentConflict.localData,
        _currentConflict.remoteData
      );
      diffs = _threeWayDiffs;
    } else {
      diffs = SyncManager.diffObjects(
        _currentConflict.localData,
        _currentConflict.remoteData
      );
    }

    container.innerHTML = `
      <div class="conflict-container">
        <div class="conflict-header">
          <div>
            <div style="font-size:16px;font-weight:600">
              ${_currentConflict.entityType === 'patients' ? '患者' : '随访'} 数据冲突
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">
              共 ${_conflicts.length} 个冲突 · 第 1 个
              ${hasBase ? ' · 三方合并' : ' · 二方比对'}
            </div>
          </div>
        </div>

        ${templateMismatch ? `
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px;margin-bottom:12px">
            <div style="font-weight:600;color:#856404;font-size:13px">
              ⚠ 模板版本不一致
            </div>
            <div style="font-size:12px;color:#856404;margin-top:4px">
              本地模板 v${_currentConflict.localTemplateVersion || '?'} ↔
              远程模板 v${_currentConflict.remoteTemplateVersion || '?'}
              <br>问卷答案字段不允许自动合并，必须人工选择。
            </div>
          </div>
        ` : ''}

        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-hint);margin-bottom:8px;padding:0 4px">
          ${hasBase ? '<span>基线</span>' : ''}
          <span>本地 (v${_currentConflict.localVersion || 0} r${_currentConflict.localRevision || 0})</span>
          <span>远程 (v${_currentConflict.remoteVersion || 0} r${_currentConflict.remoteRevision || 0})</span>
        </div>

        <div id="conflict-fields">
          ${diffs.map(diff => _renderConflictField(diff, hasBase, templateMismatch)).join('')}
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
          <button class="btn btn-secondary" id="btn-auto-merge"
            ${templateMismatch ? 'disabled style="opacity:0.5"' : ''}>
            ${hasBase ? '三方自动合并' : '自动合并'}
          </button>
          <button class="btn btn-primary" id="btn-resolve-conflict">确认解决</button>
        </div>

        ${_conflicts.length > 1 ? `
          <div style="text-align:center;margin-top:12px">
            <button class="btn btn-sm btn-outline" id="btn-next-conflict">下一个冲突</button>
          </div>
        ` : ''}
      </div>
    `;

    _bindEvents(diffs, hasBase, templateMismatch);
  }

  function _renderConflictField(diff, hasBase, templateMismatch) {
    const fieldLabels = {
      name: '姓名', age: '年龄', gender: '性别', diseases: '疾病类型',
      phone: '电话', address: '地址', riskLevel: '风险等级',
      bpSystolic: '收缩压', bpDiastolic: '舒张压', bloodSugar: '血糖',
      medications: '用药', notes: '备注', lastVisitDate: '最后随访日期',
      date: '随访日期', templateId: '模板ID', templateVersion: '模板版本',
      questionnaireAnswers: '问卷答案', attachments: '附件',
      updatedAt: '更新时间', createdAt: '创建时间'
    };

    const label = fieldLabels[diff.field] || diff.field;
    const localDisplay = _formatValue(diff.localValue);
    const remoteDisplay = _formatValue(diff.remoteValue);
    const baseDisplay = hasBase ? _formatValue(diff.baseValue) : '';

    // 标记状态
    let statusBadge = '';
    let forceManual = false;
    if (hasBase && diff.status) {
      switch (diff.status) {
        case 'local_only':
          statusBadge = '<span style="font-size:10px;background:#d4edda;color:#155724;padding:1px 6px;border-radius:4px">仅本地修改</span>';
          break;
        case 'remote_only':
          statusBadge = '<span style="font-size:10px;background:#cce5ff;color:#004085;padding:1px 6px;border-radius:4px">仅远程修改</span>';
          break;
        case 'both_same':
          statusBadge = '<span style="font-size:10px;background:#d4edda;color:#155724;padding:1px 6px;border-radius:4px">两端一致</span>';
          break;
        case 'conflict':
          statusBadge = '<span style="font-size:10px;background:#f8d7da;color:#721c24;padding:1px 6px;border-radius:4px">冲突</span>';
          break;
      }
    }

    // 模板版本不一致时问卷答案字段强制人工
    if (templateMismatch && diff.field === 'questionnaireAnswers') {
      forceManual = true;
      statusBadge = '<span style="font-size:10px;background:#f8d7da;color:#721c24;padding:1px 6px;border-radius:4px">模板版本冲突·须人工</span>';
    }

    // 附件字段：显示上传状态
    if (diff.field === 'attachments') {
      return _renderAttachmentConflict(diff, label, hasBase);
    }

    return `
      <div class="conflict-field ${forceManual ? 'force-manual' : ''}" data-field="${diff.field}">
        <div class="conflict-field-header">${label} ${statusBadge}</div>
        ${hasBase ? `
          <div style="font-size:11px;color:var(--text-hint);padding:2px 8px;margin-bottom:4px;background:#f5f5f5;border-radius:4px">
            基线: ${baseDisplay}
          </div>
        ` : ''}
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

  // 附件冲突特殊渲染（显示压缩/上传状态）
  function _renderAttachmentConflict(diff, label, hasBase) {
    const statusLabels = {
      compressed: '已压缩',
      pending_upload: '待上传',
      uploading: '上传中',
      uploaded: '已上传',
      upload_failed: '上传失败'
    };

    function renderAttList(attachments) {
      if (!Array.isArray(attachments) || attachments.length === 0) {
        return '<em style="color:var(--text-hint)">无附件</em>';
      }
      return attachments.map(a => {
        const status = statusLabels[a.uploadStatus] || a.uploadStatus || '未知';
        const statusColor = a.uploadStatus === 'uploaded' ? '#155724' :
                           a.uploadStatus === 'upload_failed' ? '#721c24' : '#856404';
        return `<div style="font-size:12px;margin:2px 0">
          📎 ${Utils.escapeHTML(a.name || '附件')}
          <span style="font-size:10px;color:${statusColor}">[${status}]</span>
          ${a.compressedSize ? `<span style="font-size:10px;color:var(--text-hint)">${Utils.bytesToSize(a.compressedSize)}</span>` : ''}
        </div>`;
      }).join('');
    }

    return `
      <div class="conflict-field" data-field="${diff.field}">
        <div class="conflict-field-header">${label}
          <span style="font-size:10px;background:#fff3cd;color:#856404;padding:1px 6px;border-radius:4px">注意上传状态</span>
        </div>
        ${hasBase ? `
          <div style="font-size:11px;color:var(--text-hint);padding:4px 8px;margin-bottom:4px;background:#f5f5f5;border-radius:4px">
            基线: ${renderAttList(diff.baseValue)}
          </div>
        ` : ''}
        <div class="conflict-compare">
          <div class="conflict-side local ${_selections[diff.field] === 'local' ? 'selected' : ''}"
               data-field="${diff.field}" data-choice="local">
            <div>
              <span class="label">本地</span>
              ${renderAttList(diff.localValue)}
            </div>
          </div>
          <div class="conflict-side remote ${_selections[diff.field] === 'remote' ? 'selected' : ''}"
               data-field="${diff.field}" data-choice="remote">
            <div>
              <span class="label">远程</span>
              ${renderAttList(diff.remoteValue)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function _formatValue(val) {
    if (val === null || val === undefined) return '<em style="color:var(--text-hint)">空</em>';
    if (Array.isArray(val)) {
      if (val.length > 0 && typeof val[0] === 'object') {
        return `<span style="font-size:12px">[${val.length} 项]</span>`;
      }
      return val.map(v => Utils.escapeHTML(String(v))).join(', ');
    }
    if (typeof val === 'object') return '<pre style="font-size:12px;margin:0">' + Utils.escapeHTML(JSON.stringify(val, null, 2)) + '</pre>';
    if (typeof val === 'boolean') return val ? '是' : '否';
    return Utils.escapeHTML(String(val));
  }

  function _bindEvents(diffs, hasBase, templateMismatch) {
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
      if (templateMismatch) {
        Utils.showToast('模板版本不一致，问卷答案字段不允许自动合并', 'warning');
        return;
      }

      _autoMergeResult = SyncManager.tryAutoMerge(_currentConflict);

      if (_autoMergeResult.success) {
        // 全部自动解决
        diffs.forEach(d => { _selections[d.field] = 'auto'; });
        document.querySelectorAll('.conflict-side').forEach(s => s.classList.remove('selected'));
        Utils.showToast(
          hasBase ? '三方自动合并完成' : '自动合并完成（无基线，使用二方策略）',
          'success'
        );
      } else {
        // 部分自动解决，剩余需人工
        const resolvedFields = new Set((_autoMergeResult.autoResolved || []).map(r => r.field));
        diffs.forEach(d => {
          if (resolvedFields.has(d.field)) {
            _selections[d.field] = 'auto';
          }
        });

        // 高亮未解决字段
        document.querySelectorAll('.conflict-field').forEach(el => {
          const field = el.dataset.field;
          if (resolvedFields.has(field)) {
            el.style.opacity = '0.5';
            el.querySelectorAll('.conflict-side').forEach(s => s.classList.remove('selected'));
          }
        });

        const remaining = (_autoMergeResult.conflicts || []).length;
        Utils.showToast(`已自动解决部分字段，还有 ${remaining} 个字段需人工选择`, 'warning');
      }
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
      let resolvedData;
      if (_autoMergeResult && _autoMergeResult.success &&
          Object.values(_selections).every(s => s === 'auto')) {
        // 全自动合并结果
        resolvedData = _autoMergeResult.merged;
      } else {
        // 混合模式：自动 + 人工
        resolvedData = { ...(_currentConflict.remoteData || {}) };
        const local = _currentConflict.localData || {};

        // 先应用自动合并的字段
        if (_autoMergeResult && _autoMergeResult.merged) {
          for (const ar of (_autoMergeResult.autoResolved || [])) {
            resolvedData[ar.field] = _autoMergeResult.merged[ar.field];
          }
        }

        // 再应用人工选择
        for (const diff of diffs) {
          const choice = _selections[diff.field];
          if (choice === 'local') {
            resolvedData[diff.field] = diff.localValue;
          } else if (choice === 'remote') {
            // already set from remote base
          } else if (choice === 'auto' && _autoMergeResult && _autoMergeResult.merged) {
            resolvedData[diff.field] = _autoMergeResult.merged[diff.field];
          }
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
      }

      resolvedData.syncStatus = 'pending';
      resolvedData.syncVersion = _currentConflict.remoteVersion;

      try {
        const choice = _autoMergeResult && _autoMergeResult.success ? 'auto_merged' : 'manual_merged';
        await SyncManager.resolveConflict(_currentConflict.id, resolvedData, choice);
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
