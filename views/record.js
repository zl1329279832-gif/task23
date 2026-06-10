// 体征录入视图 - 血压/血糖/用药/附件/风险等级
const RecordView = (() => {
  let _patient = null;
  let _visit = null;
  let _isNew = true;
  let _attachments = [];
  let _medications = [''];

  async function render(params) {
    const { patientId, visitId } = params;
    _patient = await DB.loadPatient(patientId);
    if (!_patient) {
      Utils.showToast('患者不存在', 'error');
      App.navigate('patient-list');
      return;
    }

    document.getElementById('btn-back').style.display = 'flex';
    document.getElementById('bottom-nav').style.display = 'none';

    if (visitId) {
      _visit = await DB.loadVisit(visitId);
      _isNew = false;
      document.getElementById('page-title').textContent = '编辑随访记录';
    } else {
      // Try to recover draft
      const draft = await DB.loadDraft('record', patientId);
      if (draft) {
        const recoverDraft = await Utils.showModal(
          '恢复草稿',
          `<p>发现未完成的随访记录草稿（保存于 ${Utils.formatDateTime(draft.savedAt)}）</p>`,
          [
            { label: '重新开始', value: 'new' },
            { label: '恢复草稿', value: 'recover', primary: true }
          ]
        );
        if (recoverDraft === 'recover') {
          _visit = draft;
          _attachments = draft.attachments || [];
          _medications = draft.medications && draft.medications.length > 0 ? draft.medications : [''];
        }
      }
      if (!_visit) {
        _visit = {
          id: Utils.uuid(),
          patientId: _patient.id,
          date: Utils.today(),
          bpSystolic: null,
          bpDiastolic: null,
          bloodSugar: null,
          medications: [],
          questionnaires: [],
          attachments: [],
          riskLevel: 'none',
          notes: '',
          isDraft: true,
          syncStatus: 'pending'
        };
        _attachments = [];
        _medications = [''];
      }
      document.getElementById('page-title').textContent = '新建随访记录';
    }

    if (_visit.attachments) _attachments = _visit.attachments;
    if (_visit.medications && _visit.medications.length > 0) _medications = _visit.medications;

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div style="padding:12px 16px 8px;font-size:13px;color:var(--text-secondary)">
        ${_patient.name} · ${Utils.formatDate(_visit.date)}
        ${_visit._dataCorrupted ? ' <span style="color:var(--danger)">⚠ 数据可能损坏</span>' : ''}
      </div>

      <!-- 血压 -->
      <div class="card" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">血压 (mmHg)</div>
        <div class="vitals-grid">
          <div class="vital-card">
            <label>收缩压</label>
            <input type="number" id="bp-systolic" value="${_visit.bpSystolic || ''}" placeholder="120" min="60" max="300">
            <div class="unit">mmHg</div>
          </div>
          <div class="vital-card">
            <label>舒张压</label>
            <input type="number" id="bp-diastolic" value="${_visit.bpDiastolic || ''}" placeholder="80" min="30" max="200">
            <div class="unit">mmHg</div>
          </div>
        </div>
      </div>

      <!-- 血糖 -->
      <div class="card" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">血糖 (mmol/L)</div>
        <div class="vital-card">
          <label>血糖值</label>
          <input type="number" id="blood-sugar" value="${_visit.bloodSugar || ''}" placeholder="5.6" min="0" max="50" step="0.1">
          <div class="unit">mmol/L</div>
        </div>
      </div>

      <!-- 用药记录 -->
      <div class="card" style="margin:12px">
        <div class="card-header">
          <div class="card-title">用药记录</div>
          <button class="btn btn-sm btn-outline" id="btn-add-med">+ 添加</button>
        </div>
        <div id="medication-list">
          ${_medications.map((m, i) => _renderMedItem(m, i)).join('')}
        </div>
      </div>

      <!-- 风险等级 -->
      <div class="card" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">风险等级</div>
        <div class="risk-selector">
          <div class="risk-option ${_visit.riskLevel === 'low' ? 'selected' : ''}" data-risk="low">低风险</div>
          <div class="risk-option ${_visit.riskLevel === 'medium' ? 'selected' : ''}" data-risk="medium">中风险</div>
          <div class="risk-option ${_visit.riskLevel === 'high' ? 'selected' : ''}" data-risk="high">高风险</div>
        </div>
      </div>

      <!-- 附件 -->
      <div class="card" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">附件 (照片)</div>
        <div class="attachment-grid" id="attachment-grid">
          ${_attachments.map((a, i) => `
            <div class="attachment-thumb" data-idx="${i}">
              <img src="${a.thumbnail || a.data}" alt="${a.name}">
              <button class="remove-btn" data-idx="${i}">&times;</button>
            </div>
          `).join('')}
          <div class="attachment-add" id="btn-add-attachment">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            <span>拍照/选择</span>
          </div>
        </div>
      </div>

      <!-- 备注 -->
      <div class="card" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">备注</div>
        <textarea class="form-textarea" id="visit-notes" rows="3"
          placeholder="其他需要记录的信息...">${Utils.escapeHTML(_visit.notes || '')}</textarea>
      </div>

      <!-- 复诊提醒 -->
      <div class="card" style="margin:12px;background:var(--primary-light)">
        <div style="font-size:13px;color:var(--primary)">
          <strong>复诊提醒：</strong>
          <span id="next-visit-hint">${_getNextVisitHint()}</span>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="btn-group" style="padding:12px 16px 24px">
        <button class="btn btn-secondary" id="btn-save-draft-record">存草稿</button>
        <button class="btn btn-primary" id="btn-submit-record">提交记录</button>
      </div>
    `;

    _bindEvents();
    _startDraftAutosave();
  }

  function _renderMedItem(med, index) {
    return `
      <div class="medication-item">
        <input type="text" class="med-input" data-idx="${index}" value="${Utils.escapeHTML(typeof med === 'string' ? med : med.name || '')}" placeholder="药品名称 + 剂量">
        <button class="btn-remove" data-idx="${index}">&times;</button>
      </div>
    `;
  }

  function _getNextVisitHint() {
    const nextDate = Reminders.getNextVisitDate(_patient, _visit.riskLevel, _visit.date);
    const days = Utils.daysBetween(_visit.date || Utils.today(), nextDate);
    return `建议 ${Utils.formatDate(nextDate)} 复诊（${days}天后）`;
  }

  function _bindEvents() {
    // Risk selector
    document.querySelectorAll('.risk-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.risk-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        _visit.riskLevel = opt.dataset.risk;
        document.getElementById('next-visit-hint').textContent = _getNextVisitHint();
      });
    });

    // Add medication
    document.getElementById('btn-add-med').addEventListener('click', () => {
      _medications.push('');
      _refreshMedList();
    });

    // Medication input
    document.getElementById('medication-list').addEventListener('input', e => {
      if (e.target.classList.contains('med-input')) {
        _medications[parseInt(e.target.dataset.idx)] = e.target.value;
      }
    });

    // Remove medication
    document.getElementById('medication-list').addEventListener('click', e => {
      if (e.target.classList.contains('btn-remove')) {
        _medications.splice(parseInt(e.target.dataset.idx), 1);
        if (_medications.length === 0) _medications.push('');
        _refreshMedList();
      }
    });

    // Add attachment
    document.getElementById('btn-add-attachment').addEventListener('click', async () => {
      try {
        const choice = await Utils.showModal(
          '添加附件',
          '<p>选择附件来源</p>',
          [
            { label: '拍照', value: 'camera', primary: true },
            { label: '相册选择', value: 'gallery' },
            { label: '取消', value: null }
          ]
        );
        let attachment;
        if (choice === 'camera') {
          attachment = await Attachments.captureImage();
        } else if (choice === 'gallery') {
          attachment = await Attachments.selectImage();
        }
        if (attachment) {
          _attachments.push(attachment);
          _refreshAttachments();
          Utils.showToast(`已添加 (${Attachments.formatSize(attachment.compressedSize)})`, 'success');
        }
      } catch (err) {
        if (err.message !== '未选择文件') {
          Utils.showToast('附件添加失败: ' + err.message, 'error');
        }
      }
    });

    // Remove attachment
    document.getElementById('attachment-grid').addEventListener('click', e => {
      if (e.target.classList.contains('remove-btn')) {
        _attachments.splice(parseInt(e.target.dataset.idx), 1);
        _refreshAttachments();
      }
    });

    // Save draft
    document.getElementById('btn-save-draft-record').addEventListener('click', () => {
      _collectData();
      _saveDraft();
      Utils.showToast('草稿已保存', 'success');
    });

    // Submit
    document.getElementById('btn-submit-record').addEventListener('click', async () => {
      _collectData();
      _visit.isDraft = false;

      // Basic validation
      if (!_visit.bpSystolic && !_visit.bloodSugar && _medications.filter(m => m).length === 0 && _attachments.length === 0) {
        const proceed = await Utils.showModal(
          '确认提交',
          '<p>当前未录入任何体征数据，确定提交吗？</p>',
          [
            { label: '继续编辑', value: false },
            { label: '确认提交', value: true, primary: true }
          ]
        );
        if (!proceed) return;
      }

      try {
        await DB.saveVisit(_visit);
        await DB.clearDraft('record', _patient.id);
        _stopDraftAutosave();

        // Update patient risk level and last visit date
        _patient.riskLevel = _visit.riskLevel;
        _patient.lastVisitDate = _visit.date;
        await DB.savePatient(_patient);

        Utils.showToast('随访记录已保存', 'success');
        App.navigate('detail', { patientId: _patient.id });
      } catch (err) {
        Utils.showToast('保存失败: ' + err.message, 'error');
      }
    });

    // Back
    document.getElementById('btn-back').onclick = async () => {
      _collectData();
      const hasData = _visit.bpSystolic || _visit.bloodSugar || _medications.some(m => m) || _attachments.length > 0;
      if (hasData) {
        const choice = await Utils.showModal(
          '离开确认',
          '<p>当前记录尚未提交，是否保存为草稿？</p>',
          [
            { label: '不保存', value: 'discard' },
            { label: '保存草稿', value: 'save', primary: true },
            { label: '取消', value: 'cancel' }
          ]
        );
        if (choice === 'cancel') return;
        if (choice === 'save') await _saveDraft();
      }
      _stopDraftAutosave();
      App.navigate('detail', { patientId: _patient.id });
    };
  }

  function _collectData() {
    _visit.bpSystolic = parseInt(document.getElementById('bp-systolic').value) || null;
    _visit.bpDiastolic = parseInt(document.getElementById('bp-diastolic').value) || null;
    _visit.bloodSugar = parseFloat(document.getElementById('blood-sugar').value) || null;
    _visit.medications = _medications.filter(m => m && m.trim());
    _visit.attachments = _attachments;
    _visit.notes = document.getElementById('visit-notes').value;
    _visit.date = _visit.date || Utils.today();
  }

  function _refreshMedList() {
    const list = document.getElementById('medication-list');
    list.innerHTML = _medications.map((m, i) => _renderMedItem(m, i)).join('');
  }

  function _refreshAttachments() {
    const grid = document.getElementById('attachment-grid');
    grid.innerHTML = `
      ${_attachments.map((a, i) => `
        <div class="attachment-thumb" data-idx="${i}">
          <img src="${a.thumbnail || a.data}" alt="${a.name}">
          <button class="remove-btn" data-idx="${i}">&times;</button>
        </div>
      `).join('')}
      <div class="attachment-add" id="btn-add-attachment">
        <svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        <span>拍照/选择</span>
      </div>
    `;
    // Rebind add button
    document.getElementById('btn-add-attachment').addEventListener('click', async () => {
      try {
        const choice = await Utils.showModal(
          '添加附件',
          '<p>选择附件来源</p>',
          [
            { label: '拍照', value: 'camera', primary: true },
            { label: '相册选择', value: 'gallery' },
            { label: '取消', value: null }
          ]
        );
        let attachment;
        if (choice === 'camera') attachment = await Attachments.captureImage();
        else if (choice === 'gallery') attachment = await Attachments.selectImage();
        if (attachment) {
          _attachments.push(attachment);
          _refreshAttachments();
        }
      } catch (err) {
        if (err.message !== '未选择文件') Utils.showToast('附件添加失败', 'error');
      }
    });
    grid.addEventListener('click', e => {
      if (e.target.classList.contains('remove-btn')) {
        _attachments.splice(parseInt(e.target.dataset.idx), 1);
        _refreshAttachments();
      }
    });
  }

  let _draftTimer = null;
  async function _saveDraft() {
    _visit.isDraft = true;
    await DB.saveDraft('record', { ..._visit, attachments: _attachments, savedAt: Utils.now() });
  }
  function _startDraftAutosave() {
    _draftTimer = setInterval(() => { _collectData(); _saveDraft(); }, 30000);
  }
  function _stopDraftAutosave() {
    if (_draftTimer) { clearInterval(_draftTimer); _draftTimer = null; }
  }

  return { render };
})();
