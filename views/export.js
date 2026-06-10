// 数据导出 + 清理视图
const ExportView = (() => {
  async function render() {
    document.getElementById('page-title').textContent = '数据管理';
    document.getElementById('btn-back').style.display = 'none';
    document.getElementById('bottom-nav').style.display = 'flex';

    const stats = await DB.getStorageStats();
    const status = await SyncManager.getStatus();

    const container = document.getElementById('view-container');
    container.innerHTML = `
      <div class="export-section">
        <!-- 存储统计 -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-title" style="margin-bottom:12px">存储统计</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:14px">
            <div>患者数量</div><div style="text-align:right;font-weight:600">${stats.patients || 0}</div>
            <div>随访记录</div><div style="text-align:right;font-weight:600">${stats.visits || 0}</div>
            <div>问卷模板</div><div style="text-align:right;font-weight:600">${stats.questionnaire_templates || 0}</div>
            <div>随访计划</div><div style="text-align:right;font-weight:600">${stats.followup_plans || 0}</div>
            <div>风险规则</div><div style="text-align:right;font-weight:600">${stats.risk_config || 0}</div>
            <div>待同步</div><div style="text-align:right;font-weight:600">${stats.sync_queue || 0}</div>
            <div>冲突记录</div><div style="text-align:right;font-weight:600">${stats.sync_conflicts || 0}</div>
          </div>
        </div>

        <!-- 导出选项 -->
        <div class="card-title" style="margin-bottom:8px">导出数据</div>

        <div class="export-option" id="btn-export-json">
          <div class="icon" style="background:#e3f2fd">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#1a73e8" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          </div>
          <div class="info">
            <div class="title">导出 JSON</div>
            <div class="desc">完整数据导出，可用于备份和迁移</div>
          </div>
        </div>

        <div class="export-option" id="btn-export-csv">
          <div class="icon" style="background:#e8f5e9">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#43a047" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          </div>
          <div class="info">
            <div class="title">导出 CSV</div>
            <div class="desc">表格格式，可在 Excel 中打开</div>
          </div>
        </div>

        <div class="export-option" id="btn-export-unsynced">
          <div class="icon" style="background:#fff3e0">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#fb8c00" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
          </div>
          <div class="info">
            <div class="title">仅导出未同步记录</div>
            <div class="desc">${stats.sync_queue || 0} 条待同步数据</div>
          </div>
        </div>

        <div class="export-option" id="btn-export-audit">
          <div class="icon" style="background:#ede7f6">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#7b1fa2" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
          </div>
          <div class="info">
            <div class="title">导出审计包</div>
            <div class="desc">含随访计划、风险规则、患者风险画像和操作日志</div>
          </div>
        </div>

        <!-- 数据清理 -->
        <div class="card-title" style="margin:16px 0 8px">数据清理</div>

        <div class="export-option" id="btn-clear-synced">
          <div class="icon" style="background:#fce4ec">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#e53935" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </div>
          <div class="info">
            <div class="title">清理已同步数据</div>
            <div class="desc">删除本地已同步到服务器的数据</div>
          </div>
        </div>

        <div class="export-option" id="btn-clear-drafts">
          <div class="icon" style="background:#f3e5f5">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#7b1fa2" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </div>
          <div class="info">
            <div class="title">清理所有草稿</div>
            <div class="desc">删除未提交的草稿数据</div>
          </div>
        </div>

        <div class="export-option" id="btn-clear-all" style="opacity:0.7">
          <div class="icon" style="background:#ffebee">
            <svg width="24" height="24" viewBox="0 0 24 24"><path fill="#c62828" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </div>
          <div class="info">
            <div class="title" style="color:var(--danger)">清空所有数据</div>
            <div class="desc">重置系统，删除全部本地数据</div>
          </div>
        </div>
      </div>
    `;

    _bindEvents();
  }

  function _bindEvents() {
    // Export JSON
    document.getElementById('btn-export-json').addEventListener('click', async () => {
      const data = {
        exportDate: Utils.now(),
        version: '1.0',
        patients: await DB.loadAllPatients(),
        visits: await (async () => {
          const db = await DB.open();
          return DB.getAll(db, 'visits');
        })(),
        templates: await DB.getAllTemplates(),
        followupPlans: await DB.getAllPlans(),
        riskConfig: await DB.getRiskConfig()
      };
      // Remove internal encrypted fields from export
      if (data.patients) {
        data.patients.forEach(p => {
          delete p._encrypted_idCard;
          delete p._hmac;
        });
      }
      const json = JSON.stringify(data, null, 2);
      Utils.downloadFile(json, `随访数据_${Utils.today()}.json`, 'application/json');
      Utils.showToast('JSON 导出成功', 'success');
    });

    // Export CSV
    document.getElementById('btn-export-csv').addEventListener('click', async () => {
      const patients = await DB.loadAllPatients();
      const db = await DB.open();
      const visits = await DB.getAll(db, 'visits');

      // Build CSV for visits with patient info
      const headers = ['日期', '患者', '年龄', '疾病', '收缩压', '舒张压', '血糖', '风险', '用药', '备注', '状态'];
      const rows = visits.map(v => {
        const p = patients.find(p => p.id === v.patientId);
        return [
          v.date,
          p ? p.name : v.patientId,
          p ? p.age : '',
          p ? (p.diseases || []).map(d => Utils.diseaseLabel(d)).join('/') : '',
          v.bpSystolic || '',
          v.bpDiastolic || '',
          v.bloodSugar || '',
          Utils.riskLabel(v.riskLevel),
          (v.medications || []).join('; '),
          (v.notes || '').replace(/[\r\n,]/g, ' '),
          v.isDraft ? '草稿' : (v.syncStatus === 'synced' ? '已同步' : '待同步')
        ];
      });

      const csv = '\uFEFF' + [headers, ...rows].map(row =>
        row.map(cell => `"${String(cell || '').replace(/"/g, '""')}"`).join(',')
      ).join('\r\n');

      Utils.downloadFile(csv, `随访记录_${Utils.today()}.csv`, 'text/csv;charset=utf-8');
      Utils.showToast('CSV 导出成功', 'success');
    });

    // Export unsynced only
    document.getElementById('btn-export-unsynced').addEventListener('click', async () => {
      const queue = await DB.getSyncQueue();
      if (queue.length === 0) {
        Utils.showToast('没有待同步的数据', 'info');
        return;
      }

      const data = {
        exportDate: Utils.now(),
        unsyncedCount: queue.length,
        items: queue.map(q => ({
          type: q.entityType,
          action: q.action,
          date: q.createdAt,
          entityId: q.entityId
        }))
      };

      // Try to include decrypted payloads
      for (const item of data.items) {
        const original = queue.find(q => q.entityId === item.entityId);
        if (original && original.payload) {
          try {
            if (original.payload._encrypted && CryptoManager.isReady()) {
              item.data = JSON.parse(await CryptoManager.decrypt(original.payload._encrypted));
            } else {
              item.data = original.payload;
            }
          } catch { item.data = null; }
        }
      }

      Utils.downloadFile(
        JSON.stringify(data, null, 2),
        `未同步记录_${Utils.today()}.json`,
        'application/json'
      );
      Utils.showToast('导出成功', 'success');
    });

    // Export audit package
    document.getElementById('btn-export-audit').addEventListener('click', async () => {
      Utils.showToast('正在生成审计包...', 'info');
      try {
        const auditData = await FollowupPlan.exportAuditData();

        // 附加同步日志和冲突历史
        const db = await DB.open();
        auditData.syncLog = {
          queue: await DB.getSyncQueue(),
          conflicts: await DB.getAll(db, 'sync_conflicts'),
          lastSyncTime: await DB.getSetting('lastSyncTime')
        };

        // 附加附件队列状态
        auditData.attachmentQueue = await DB.getAttachmentQueue();

        const json = JSON.stringify(auditData, null, 2);
        Utils.downloadFile(
          json,
          `审计包_${Utils.today()}.json`,
          'application/json'
        );
        Utils.showToast('审计包导出成功', 'success');
      } catch (err) {
        Utils.showToast('审计包导出失败: ' + err.message, 'error');
      }
    });

    // Clear synced data
    document.getElementById('btn-clear-synced').addEventListener('click', async () => {
      const confirm = await Utils.showModal(
        '确认清理',
        '<p>将删除所有已同步到服务器的本地数据。<br>未同步的数据不受影响。</p>',
        [
          { label: '取消', value: false },
          { label: '确认删除', value: true }
        ]
      );
      if (!confirm) return;

      const db = await DB.open();
      let count = 0;
      for (const store of ['patients', 'visits']) {
        const items = await DB.getAll(db, store);
        for (const item of items) {
          if (item.syncStatus === 'synced') {
            await DB.deleteRecord(db, store, item.id);
            count++;
          }
        }
      }
      Utils.showToast(`已清理 ${count} 条数据`, 'success');
      render();
    });

    // Clear drafts
    document.getElementById('btn-clear-drafts').addEventListener('click', async () => {
      const confirm = await Utils.showModal(
        '清理草稿',
        '<p>将删除所有未提交的草稿数据，包括问卷和随访记录草稿。</p>',
        [
          { label: '取消', value: false },
          { label: '确认删除', value: true }
        ]
      );
      if (!confirm) return;

      const db = await DB.open();
      // Clear draft visits
      const visits = await DB.getAll(db, 'visits');
      let count = 0;
      for (const v of visits) {
        if (v.isDraft) {
          await DB.deleteRecord(db, 'visits', v.id);
          count++;
        }
      }
      // Clear draft settings
      const settings = await DB.getAll(db, 'settings');
      for (const s of settings) {
        if (s.key && s.key.startsWith('draft_')) {
          await DB.deleteRecord(db, 'settings', s.key);
          count++;
        }
      }
      Utils.showToast(`已清理 ${count} 条草稿`, 'success');
      render();
    });

    // Clear all
    document.getElementById('btn-clear-all').addEventListener('click', async () => {
      const confirm = await Utils.showModal(
        '⚠ 清空所有数据',
        `<p style="color:var(--danger);font-weight:600">此操作将永久删除所有本地数据！</p>
         <p style="margin-top:8px">包括患者信息、随访记录、问卷答案、同步队列等。<br>建议先导出数据再执行清理。</p>`,
        [
          { label: '取消', value: false },
          { label: '确认清空', value: true }
        ]
      );
      if (!confirm) return;

      // Double confirm
      const confirm2 = await Utils.showModal(
        '最终确认',
        '<p style="color:var(--danger)">确定要清空所有数据吗？此操作不可撤销！</p>',
        [
          { label: '取消', value: false },
          { label: '确认清空', value: true }
        ]
      );
      if (!confirm2) return;

      const db = await DB.open();
      for (const store of ['patients', 'visits', 'sync_queue', 'sync_conflicts', 'settings', 'followup_plans', 'risk_config', 'attachment_queue']) {
        await DB.clear(db, store);
      }
      Utils.showToast('所有数据已清空', 'success');
      render();
    });
  }

  return { render };
})();
