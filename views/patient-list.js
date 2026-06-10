// 随访名单视图
const PatientListView = (() => {
  let _patients = [];
  let _filter = 'all';
  let _search = '';

  async function render() {
    document.getElementById('page-title').textContent = '随访名单';
    document.getElementById('btn-back').style.display = 'none';
    document.getElementById('bottom-nav').style.display = 'flex';

    _patients = await DB.loadAllPatients();
    const container = document.getElementById('view-container');

    // 统计各风险级别
    const counts = { all: _patients.length, high: 0, medium: 0, low: 0 };
    _patients.forEach(p => { if (counts[p.riskLevel] !== undefined) counts[p.riskLevel]++; });

    container.innerHTML = `
      <div class="search-bar">
        <svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
        <input type="text" id="search-input" placeholder="搜索患者姓名..." value="${Utils.escapeHTML(_search)}">
      </div>
      <div class="filter-bar">
        <button class="filter-chip ${_filter === 'all' ? 'active' : ''}" data-filter="all">全部 (${counts.all})</button>
        <button class="filter-chip ${_filter === 'high' ? 'active' : ''}" data-filter="high">高风险 (${counts.high})</button>
        <button class="filter-chip ${_filter === 'medium' ? 'active' : ''}" data-filter="medium">中风险 (${counts.medium})</button>
        <button class="filter-chip ${_filter === 'low' ? 'active' : ''}" data-filter="low">低风险 (${counts.low})</button>
      </div>
      <div id="patient-list"></div>
      <button class="btn-fab" id="btn-add-patient" title="新增患者">
        <svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      </button>
    `;

    _renderList();
    _bindEvents();
  }

  function _renderList() {
    const listEl = document.getElementById('patient-list');
    let filtered = _patients;

    if (_filter !== 'all') {
      filtered = filtered.filter(p => p.riskLevel === _filter);
    }
    if (_search) {
      const s = _search.toLowerCase();
      filtered = filtered.filter(p => (p.name || '').toLowerCase().includes(s));
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
          <div class="title">${_search ? '未找到匹配患者' : '暂无患者'}</div>
          <div class="desc">${_search ? '请尝试其他搜索关键词' : '点击右下角按钮添加首位患者'}</div>
        </div>
      `;
      return;
    }

    // Sort: high risk first, then by last visit date
    filtered.sort((a, b) => {
      const riskOrder = { high: 0, medium: 1, low: 2, none: 3 };
      const ra = riskOrder[a.riskLevel] || 3;
      const rb = riskOrder[b.riskLevel] || 3;
      if (ra !== rb) return ra - rb;
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });

    listEl.innerHTML = filtered.map(p => {
      const diseases = (p.diseases || []).map(d =>
        `<span class="tag tag-disease">${Utils.diseaseLabel(d)}</span>`
      ).join('');
      const riskTag = p.riskLevel && p.riskLevel !== 'none'
        ? `<span class="tag tag-risk-${p.riskLevel}">${Utils.riskLabel(p.riskLevel)}</span>`
        : '';
      const syncTag = p.syncStatus === 'pending'
        ? '<span class="tag tag-sync">待同步</span>'
        : '';
      const lastVisit = p.lastVisitDate
        ? `${Utils.daysBetween(p.lastVisitDate, Utils.today())}天前`
        : '未随访';

      return `
        <div class="card patient-card fade-in" data-id="${p.id}">
          <div class="risk-bar" style="background:${Utils.riskColor(p.riskLevel)}"></div>
          <div class="card-body">
            <div class="card-header">
              <div>
                <div class="patient-name">${Utils.escapeHTML(p.name || '未命名')}</div>
                <div class="card-subtitle">${p.age ? p.age + '岁' : ''} ${p.gender === 'male' ? '男' : p.gender === 'female' ? '女' : ''}</div>
              </div>
              <div style="text-align:right;font-size:12px;color:var(--text-hint)">
                ${lastVisit}
              </div>
            </div>
            <div class="patient-tags">
              ${diseases}${riskTag}${syncTag}
              ${p._dataCorrupted ? '<span class="tag" style="background:#ffebee;color:#c62828">数据异常</span>' : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function _bindEvents() {
    // Search
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('input', Utils.debounce(e => {
        _search = e.target.value;
        _renderList();
      }, 300));
    }

    // Filter chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        _filter = chip.dataset.filter;
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        _renderList();
      });
    });

    // Patient card click
    document.getElementById('patient-list').addEventListener('click', e => {
      const card = e.target.closest('.patient-card');
      if (card) {
        App.navigate('detail', { patientId: card.dataset.id });
      }
    });

    // Add patient button
    document.getElementById('btn-add-patient').addEventListener('click', () => {
      _showAddPatientForm();
    });
  }

  async function _showAddPatientForm() {
    const content = document.createElement('div');
    content.innerHTML = `
      <div class="form-group">
        <label class="form-label">姓名 <span class="required">*</span></label>
        <input type="text" class="form-input" id="inp-name" placeholder="请输入患者姓名">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">年龄</label>
          <input type="number" class="form-input" id="inp-age" placeholder="岁" min="0" max="150">
        </div>
        <div class="form-group">
          <label class="form-label">性别</label>
          <select class="form-select" id="inp-gender">
            <option value="">请选择</option>
            <option value="male">男</option>
            <option value="female">女</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">身份证号</label>
        <input type="text" class="form-input" id="inp-idcard" placeholder="18位身份证号" maxlength="18">
      </div>
      <div class="form-group">
        <label class="form-label">联系电话</label>
        <input type="tel" class="form-input" id="inp-phone" placeholder="手机号码">
      </div>
      <div class="form-group">
        <label class="form-label">地址</label>
        <input type="text" class="form-input" id="inp-address" placeholder="详细地址">
      </div>
      <div class="form-group">
        <label class="form-label">慢病类型</label>
        <div class="checkbox-group" id="disease-checkboxes">
          ${['hypertension','diabetes','copd','heart_disease','stroke','mental_illness','tuberculosis'].map(d =>
            `<label class="checkbox-item" data-value="${d}">
              <input type="checkbox" value="${d}" style="display:none">
              ${Utils.diseaseLabel(d)}
            </label>`
          ).join('')}
        </div>
      </div>
    `;

    const result = await Utils.showModal('新增患者', content, [
      { label: '取消', value: false },
      { label: '保存', value: true, primary: true }
    ]);

    if (!result) return;

    const name = document.getElementById('inp-name').value.trim();
    if (!name) { Utils.showToast('请输入患者姓名', 'error'); return; }

    const diseases = [];
    document.querySelectorAll('#disease-checkboxes .checkbox-item input:checked').forEach(cb => {
      diseases.push(cb.value);
    });

    const patient = {
      id: Utils.uuid(),
      name: name,
      age: parseInt(document.getElementById('inp-age').value) || null,
      gender: document.getElementById('inp-gender').value || null,
      idCard: document.getElementById('inp-idcard').value.trim() || null,
      phone: document.getElementById('inp-phone').value.trim() || null,
      address: document.getElementById('inp-address').value.trim() || null,
      diseases: diseases,
      riskLevel: 'none',
      lastVisitDate: null,
      syncStatus: 'pending'
    };

    try {
      await DB.savePatient(patient);
      Utils.showToast('患者已添加', 'success');
      render();
    } catch (err) {
      Utils.showToast('保存失败: ' + err.message, 'error');
    }
  }

  // Bind checkbox toggle (delegated since modal creates DOM later)
  document.addEventListener('click', e => {
    const item = e.target.closest('.checkbox-item');
    if (item && item.querySelector('input[type=checkbox]')) {
      const cb = item.querySelector('input[type=checkbox]');
      if (e.target !== cb) {
        cb.checked = !cb.checked;
      }
      item.classList.toggle('selected', cb.checked);
    }
  });

  return { render };
})();
