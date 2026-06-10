// 患者详情视图
const DetailView = (() => {
  let _patient = null;
  let _visits = [];

  async function render(params) {
    const { patientId } = params;
    _patient = await DB.loadPatient(patientId);
    if (!_patient) {
      Utils.showToast('患者不存在', 'error');
      App.navigate('patient-list');
      return;
    }
    _visits = await DB.loadVisitsByPatient(patientId);
    _visits.sort((a, b) => new Date(b.date) - new Date(a.date));

    document.getElementById('page-title').textContent = _patient.name || '患者详情';
    document.getElementById('btn-back').style.display = 'flex';
    document.getElementById('bottom-nav').style.display = 'none';

    const container = document.getElementById('view-container');
    const diseases = (_patient.diseases || []).map(d => Utils.diseaseLabel(d)).join('、');
    const totalVisits = _visits.filter(v => !v.isDraft).length;
    const lastBP = _visits.find(v => v.bpSystolic);
    const lastBS = _visits.find(v => v.bloodSugar);

    container.innerHTML = `
      <div class="detail-header slide-in">
        <div class="detail-avatar">${(_patient.name || '?')[0]}</div>
        <div class="detail-name">${Utils.escapeHTML(_patient.name || '未命名')}</div>
        <div class="detail-subtitle">${_patient.age ? _patient.age + '岁' : ''} ${_patient.gender === 'male' ? '男' : _patient.gender === 'female' ? '女' : ''} ${diseases ? '| ' + diseases : ''}</div>
        <div class="detail-stats">
          <div class="detail-stat">
            <div class="value">${totalVisits}</div>
            <div class="label">随访次数</div>
          </div>
          <div class="detail-stat">
            <div class="value">${lastBP ? lastBP.bpSystolic + '/' + lastBP.bpDiastolic : '-'}</div>
            <div class="label">最近血压</div>
          </div>
          <div class="detail-stat">
            <div class="value">${lastBS ? lastBS.bloodSugar : '-'}</div>
            <div class="label">最近血糖</div>
          </div>
        </div>
      </div>

      ${_patient._dataCorrupted ? `
        <div class="corruption-alert" style="margin:12px">
          <svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          <span>该患者数据完整性校验失败，部分信息可能不准确</span>
        </div>
      ` : ''}

      <div class="card" style="margin:12px">
        <div class="card-title" style="margin-bottom:12px">基本信息</div>
        <div style="font-size:14px;line-height:2">
          <div><strong>电话：</strong>${_patient.phone || '未记录'}</div>
          <div><strong>地址：</strong>${_patient.address || '未记录'}</div>
          <div><strong>身份证：</strong>${_patient.idCard || '未记录'}</div>
          <div><strong>风险等级：</strong><span style="color:${Utils.riskColor(_patient.riskLevel)};font-weight:600">${Utils.riskLabel(_patient.riskLevel)}</span></div>
          <div><strong>同步状态：</strong>${_patient.syncStatus === 'synced' ? '已同步' : '待同步'}</div>
        </div>
      </div>

      <div style="padding:0 12px 12px;display:flex;gap:8px">
        <button class="btn btn-primary btn-block" id="btn-new-visit">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          新建随访
        </button>
        <button class="btn btn-outline" id="btn-fill-questionnaire">填写问卷</button>
      </div>

      <div style="padding:0 12px">
        <div class="card-title" style="margin-bottom:12px">随访记录</div>
        ${_visits.length === 0 ? `
          <div class="empty-state" style="padding:24px">
            <div class="title">暂无随访记录</div>
            <div class="desc">点击上方按钮开始首次随访</div>
          </div>
        ` : `
          <div class="timeline">
            ${_visits.map(v => _renderTimelineItem(v)).join('')}
          </div>
        `}
      </div>
    `;

    _bindEvents();
  }

  function _renderTimelineItem(visit) {
    const isDraft = visit.isDraft ? ' <span class="tag tag-draft">草稿</span>' : '';
    const syncIcon = visit.syncStatus === 'synced'
      ? '<span style="color:var(--success);font-size:12px">✓ 已同步</span>'
      : '<span style="color:var(--warning);font-size:12px">● 待同步</span>';

    let summary = [];
    if (visit.bpSystolic) summary.push(`血压 ${visit.bpSystolic}/${visit.bpDiastolic}`);
    if (visit.bloodSugar) summary.push(`血糖 ${visit.bloodSugar}`);
    if (visit.riskLevel && visit.riskLevel !== 'none') summary.push(`风险：${Utils.riskLabel(visit.riskLevel)}`);
    if (visit.medications && visit.medications.length > 0) summary.push(`用药 ${visit.medications.length} 种`);
    if (visit.attachments && visit.attachments.length > 0) summary.push(`附件 ${visit.attachments.length} 个`);

    return `
      <div class="timeline-item" data-visit-id="${visit.id}">
        <div class="card" style="margin:0;box-shadow:none;border:1px solid var(--border-light)">
          <div class="card-header">
            <div>
              <div class="card-title" style="font-size:14px">${Utils.formatDate(visit.date)}${isDraft}</div>
              <div class="card-subtitle">${summary.join(' · ') || '无记录内容'}</div>
            </div>
            ${syncIcon}
          </div>
          ${visit.notes ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">${Utils.escapeHTML(visit.notes)}</div>` : ''}
        </div>
      </div>
    `;
  }

  async function _bindEvents() {
    document.getElementById('btn-new-visit').addEventListener('click', async () => {
      // Check duplicate
      const duplicates = await DB.checkDuplicateVisit(_patient.id, Utils.today());
      if (duplicates.length > 0) {
        const choice = await Utils.showModal(
          '重复随访提醒',
          `<p>该患者今日已有 ${duplicates.length} 条随访记录。</p>
           <p style="margin-top:8px;font-size:13px;color:var(--text-secondary)">
             ${duplicates.map((d, i) => `记录${i + 1}：${d.bpSystolic ? '血压 ' + d.bpSystolic + '/' + d.bpDiastolic : ''} ${d.bloodSugar ? '血糖 ' + d.bloodSugar : ''}`).join('<br>')}
           </p>`,
          [
            { label: '查看已有记录', value: 'view', callback: () => {} },
            { label: '继续新建', value: 'create', primary: true }
          ]
        );
        if (choice === 'view') {
          App.navigate('record', { patientId: _patient.id, visitId: duplicates[0].id });
          return;
        }
      }
      App.navigate('record', { patientId: _patient.id });
    });

    document.getElementById('btn-fill-questionnaire').addEventListener('click', () => {
      App.navigate('questionnaire', { patientId: _patient.id });
    });

    // Timeline item click
    document.querySelector('.timeline')?.addEventListener('click', e => {
      const item = e.target.closest('.timeline-item');
      if (item) {
        App.navigate('record', { patientId: _patient.id, visitId: item.dataset.visitId });
      }
    });

    document.getElementById('btn-back').onclick = () => App.navigate('patient-list');
  }

  return { render };
})();
