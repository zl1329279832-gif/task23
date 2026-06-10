// 医疗随访系统 - 合并与同步综合测试
(async () => {
  // --- 极简测试框架 ---
  const results = { pass: 0, fail: 0, suites: [] };
  let currentSuite = null;

  function suite(name) {
    currentSuite = { name, tests: [] };
    results.suites.push(currentSuite);
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || '断言失败');
  }

  function assertEqual(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label || ''}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    }
  }

  function assertNotEqual(actual, expected, label) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      throw new Error(`${label || ''}不应相等: ${JSON.stringify(actual)}`);
    }
  }

  async function test(name, fn) {
    try {
      await fn();
      currentSuite.tests.push({ name, pass: true });
      results.pass++;
    } catch (e) {
      currentSuite.tests.push({ name, pass: false, error: e.message || String(e) });
      results.fail++;
      console.error(`FAIL: ${name}`, e);
    }
  }

  function renderResults() {
    const container = document.getElementById('results');
    const summary = document.getElementById('summary');

    summary.textContent = `通过 ${results.pass}  失败 ${results.fail}  共 ${results.pass + results.fail}`;
    summary.className = results.fail === 0 ? 'all-pass' : 'has-fail';

    container.innerHTML = results.suites.map(s => `
      <div class="suite">
        <div class="suite-header">${s.name}</div>
        ${s.tests.map(t => `
          <div class="test ${t.pass ? 'pass' : 'fail'}">
            <span class="icon">${t.pass ? '✓' : '✗'}</span>
            <div>
              <div>${t.name}</div>
              ${t.error ? `<div class="error">${t.error}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  // --- 初始化 ---
  try {
    await DB.open();
    await CryptoManager.init('1234');
  } catch (e) {
    console.error('初始化失败:', e);
  }

  // ====================================================================
  // 测试套件 1：离线新建记录
  // ====================================================================
  suite('离线新建记录');

  await test('新建患者应分配 revision=1 和 syncStatus=pending', async () => {
    const patient = {
      id: 'test-p-' + Date.now(),
      name: '张三',
      age: 65,
      gender: 'male',
      diseases: ['hypertension'],
      riskLevel: 'medium'
    };
    const saved = await DB.savePatient(patient);
    assertEqual(saved.revision, 1, 'revision');
    assertEqual(saved.syncStatus, 'pending', 'syncStatus');
    assert(saved.createdAt, '应有 createdAt');
    assert(saved.updatedAt, '应有 updatedAt');
    assert(saved._hmac, '应有 HMAC');
  });

  await test('新建 visit 应分配 revision=1 和 syncVersion=0', async () => {
    const visit = {
      id: 'test-v-' + Date.now(),
      patientId: 'test-p-1',
      date: Utils.today(),
      bpSystolic: 140,
      bpDiastolic: 90,
      riskLevel: 'medium',
      templateId: 'tpl-1',
      templateVersion: 2
    };
    const saved = await DB.saveVisit(visit);
    assertEqual(saved.revision, 1, 'revision');
    assertEqual(saved.syncVersion, 0, 'syncVersion');
    assertEqual(saved.syncStatus, 'pending', 'syncStatus');
    assert(saved._hmac, '应有 HMAC（含模板版本）');
  });

  await test('新建记录应加入同步队列', async () => {
    const id = 'test-v-queue-' + Date.now();
    await DB.saveVisit({
      id,
      patientId: 'test-p-1',
      date: Utils.today(),
      bpSystolic: 130,
      bpDiastolic: 85,
      riskLevel: 'low'
    });
    const queue = await DB.getSyncQueue();
    const found = queue.find(q => q.entityId === id);
    assert(found, '应在同步队列中找到新记录');
    assertEqual(found.action, 'create', '动作应为 create');
  });

  // ====================================================================
  // 测试套件 2：离线编辑 + 修订号递增
  // ====================================================================
  suite('离线编辑与修订号');

  await test('编辑已有患者应递增 revision', async () => {
    const id = 'test-edit-p-' + Date.now();
    const p1 = await DB.savePatient({ id, name: '李四', age: 50, diseases: [] });
    assertEqual(p1.revision, 1);

    p1.age = 51;
    p1.syncStatus = 'pending'; // 模拟仍未同步
    const p2 = await DB.savePatient(p1);
    assertEqual(p2.revision, 2, '第二次保存 revision 应为 2');
  });

  await test('编辑已同步记录应保存基线快照', async () => {
    const id = 'test-base-' + Date.now();
    const v1 = await DB.saveVisit({
      id,
      patientId: 'test-p-1',
      date: Utils.today(),
      bpSystolic: 120,
      bpDiastolic: 80,
      riskLevel: 'low'
    });

    // 模拟同步成功
    const db = await DB.open();
    v1.syncStatus = 'synced';
    v1.syncVersion = 1;
    await DB.put(db, 'visits', v1);

    // 离线编辑
    v1.bpSystolic = 135;
    v1.syncStatus = 'pending';
    await DB.saveVisit(v1);

    // 验证基线快照
    const base = await DB.getBaseSnapshot(id);
    assert(base, '应存在基线快照');
    assertEqual(base.bpSystolic, 120, '基线应为编辑前的值');
    assertEqual(base.syncStatus, 'synced', '基线应为已同步状态');
  });

  await test('多次离线编辑不应覆盖基线快照', async () => {
    const id = 'test-base-stable-' + Date.now();
    const v1 = await DB.saveVisit({
      id,
      patientId: 'test-p-1',
      date: Utils.today(),
      bpSystolic: 110,
      bpDiastolic: 70,
      riskLevel: 'low'
    });

    // 模拟同步
    const db = await DB.open();
    v1.syncStatus = 'synced';
    v1.syncVersion = 1;
    await DB.put(db, 'visits', v1);

    // 第一次离线编辑
    v1.bpSystolic = 125;
    v1.syncStatus = 'pending';
    await DB.saveVisit(v1);

    // 第二次离线编辑
    const v2 = await DB.loadVisit(id);
    v2.bpSystolic = 140;
    await DB.saveVisit(v2);

    // 基线仍应是最初同步的版本
    const base = await DB.getBaseSnapshot(id);
    assertEqual(base.bpSystolic, 110, '基线应仍为初始同步值');
  });

  // ====================================================================
  // 测试套件 3：同步队列去重
  // ====================================================================
  suite('同步队列去重');

  await test('同一实体多次编辑只保留一个队列项', async () => {
    const id = 'test-dedup-' + Date.now();
    await DB.saveVisit({
      id,
      patientId: 'test-p-1',
      date: Utils.today(),
      bpSystolic: 120,
      riskLevel: 'low'
    });

    // 再次编辑
    const v = await DB.loadVisit(id);
    v.bpSystolic = 130;
    await DB.saveVisit(v);

    // 检查队列
    const queue = await DB.getSyncQueue();
    const items = queue.filter(q => q.entityId === id);
    assertEqual(items.length, 1, '同一实体应只有一个队列项');
  });

  await test('去重后应保留 create 动作优先级', async () => {
    const id = 'test-dedup-action-' + Date.now();
    await DB.saveVisit({
      id,
      patientId: 'test-p-1',
      date: Utils.today(),
      bpSystolic: 120,
      riskLevel: 'low'
    });

    // 编辑（此时 action 会尝试设为 update，但因为原始是 create 应保留）
    const v = await DB.loadVisit(id);
    v.bpSystolic = 135;
    await DB.saveVisit(v);

    const queue = await DB.getSyncQueue();
    const item = queue.find(q => q.entityId === id);
    assertEqual(item.action, 'create', '应保留 create 动作');
  });

  // ====================================================================
  // 测试套件 4：三方合并
  // ====================================================================
  suite('三方合并');

  await test('仅本地修改的字段应取本地值', () => {
    const base   = { name: '王五', age: 60, bpSystolic: 120 };
    const local  = { name: '王五', age: 61, bpSystolic: 120 }; // age changed
    const remote = { name: '王五', age: 60, bpSystolic: 120 };

    const result = SyncManager.threeWayMerge(base, local, remote);
    assertEqual(result.merged.age, 61, '应取本地修改的 age');
    assertEqual(result.conflicts.length, 0, '不应有冲突');
    assert(result.autoResolved.find(r => r.field === 'age' && r.source === 'local'), '应标记 age 为本地解决');
  });

  await test('仅远程修改的字段应取远程值', () => {
    const base   = { name: '王五', age: 60, bpSystolic: 120 };
    const local  = { name: '王五', age: 60, bpSystolic: 120 };
    const remote = { name: '王五', age: 60, bpSystolic: 145 }; // bpSystolic changed

    const result = SyncManager.threeWayMerge(base, local, remote);
    assertEqual(result.merged.bpSystolic, 145, '应取远程修改的 bpSystolic');
    assertEqual(result.conflicts.length, 0);
  });

  await test('两端修改不同字段应自动合并', () => {
    const base   = { name: '王五', age: 60, bpSystolic: 120, notes: '' };
    const local  = { name: '王五', age: 61, bpSystolic: 120, notes: '' };  // age
    const remote = { name: '王五', age: 60, bpSystolic: 145, notes: '' };  // bp

    const result = SyncManager.threeWayMerge(base, local, remote);
    assertEqual(result.merged.age, 61, 'age 取本地');
    assertEqual(result.merged.bpSystolic, 145, 'bpSystolic 取远程');
    assertEqual(result.conflicts.length, 0, '不同字段不应冲突');
  });

  await test('两端修改相同字段为不同值应产生冲突', () => {
    const base   = { name: '王五', age: 60 };
    const local  = { name: '王五', age: 61 };
    const remote = { name: '王五', age: 62 };

    const result = SyncManager.threeWayMerge(base, local, remote);
    assertEqual(result.conflicts.length, 1, '应有 1 个冲突');
    assertEqual(result.conflicts[0].field, 'age');
    assertEqual(result.conflicts[0].status, 'conflict');
  });

  await test('两端修改相同字段为相同值不应冲突', () => {
    const base   = { name: '王五', age: 60 };
    const local  = { name: '王五', age: 65 };
    const remote = { name: '王五', age: 65 };

    const result = SyncManager.threeWayMerge(base, local, remote);
    assertEqual(result.conflicts.length, 0);
    assertEqual(result.merged.age, 65);
  });

  await test('无基线时应降级为二方合并', () => {
    const conflict = {
      baseData: null,
      localData: { name: '张三', age: 60, notes: '本地备注' },
      remoteData: { name: '张三', age: 61, notes: '' },
      templateVersionMismatch: false
    };

    const result = SyncManager.tryAutoMerge(conflict);
    assert(result.success, '二方合并应成功');
    assert(result.degraded, '应标记为降级');
    assertEqual(result.merged.notes, '本地备注', '本地非空覆盖远程空值');
    assertEqual(result.merged.age, 61, '远程非空保留');
  });

  // ====================================================================
  // 测试套件 5：模板版本冲突
  // ====================================================================
  suite('模板版本冲突');

  await test('模板版本不一致时 tryAutoMerge 应失败', () => {
    const conflict = {
      baseData: { templateVersion: 1, questionnaireAnswers: { q1: 'yes' } },
      localData: { templateVersion: 1, questionnaireAnswers: { q1: 'no' } },
      remoteData: { templateVersion: 2, questionnaireAnswers: { q1: 'yes', q2: 'new' } },
      templateVersionMismatch: true,
      entityType: 'visits'
    };

    const result = SyncManager.tryAutoMerge(conflict);
    assert(!result.success, '模板版本不一致不应自动合并');
    assert(result.reason.includes('模板版本'), '原因应提及模板版本');
  });

  await test('问卷答案验证：移除的问题应标记为不兼容', () => {
    const template = {
      id: 'tpl-test',
      version: 2,
      questions: [
        { id: 'q1', type: 'text', text: '问题1' },
        { id: 'q3', type: 'number', text: '问题3' }
      ]
    };
    const answers = { q1: '回答1', q2: '旧问题答案' }; // q2 已不在新模板中

    const result = QuestionnaireEngine.validateAnswersAgainstTemplate(answers, template);
    assert(!result.valid, '应标记为不全兼容');
    assertEqual(result.incompatible.length, 1);
    assertEqual(result.incompatible[0].questionId, 'q2');
    assertEqual(result.incompatible[0].reason, 'question_removed');
  });

  await test('问卷答案验证：类型不匹配应标记', () => {
    const template = {
      id: 'tpl-test',
      version: 2,
      questions: [
        { id: 'q1', type: 'number', text: '数值题' }
      ]
    };
    const answers = { q1: '不是数字abc' };

    const result = QuestionnaireEngine.validateAnswersAgainstTemplate(answers, template);
    assert(!result.valid);
    assertEqual(result.incompatible[0].reason, 'type_mismatch');
  });

  await test('问卷答案验证：选项已移除应标记', () => {
    const template = {
      id: 'tpl-test',
      version: 2,
      questions: [
        { id: 'q1', type: 'select', text: '选择题', options: [
          { value: 'a', label: '选项A' },
          { value: 'b', label: '选项B' }
        ]}
      ]
    };
    const answers = { q1: 'c' }; // c 已不在选项中

    const result = QuestionnaireEngine.validateAnswersAgainstTemplate(answers, template);
    assert(!result.valid);
    assertEqual(result.incompatible[0].reason, 'option_invalid');
  });

  await test('模板版本兼容性检查：相同版本应兼容', () => {
    const tplA = { id: 'tpl-1', version: 1, diseaseType: 'hypertension', questions: [{ id: 'q1', type: 'text' }] };
    const tplB = { id: 'tpl-1', version: 1, diseaseType: 'hypertension', questions: [{ id: 'q1', type: 'text' }] };
    const result = QuestionnaireEngine.areTemplateVersionsCompatible(tplA, tplB);
    assert(result.compatible);
  });

  await test('模板版本兼容性检查：问题类型变更应不兼容', () => {
    const tplA = { id: 'tpl-1', version: 1, diseaseType: 'hypertension', questions: [{ id: 'q1', type: 'text' }] };
    const tplB = { id: 'tpl-1', version: 2, diseaseType: 'hypertension', questions: [{ id: 'q1', type: 'number' }] };
    const result = QuestionnaireEngine.areTemplateVersionsCompatible(tplA, tplB);
    assert(!result.compatible);
    assert(result.details.typeChanged.length > 0);
  });

  await test('flagIncompatibleFields 应区分可自动合并和须人工字段', () => {
    const oldTpl = {
      questions: [{ id: 'q1', type: 'text' }, { id: 'q2', type: 'number' }]
    };
    const newTpl = {
      questions: [{ id: 'q1', type: 'text' }] // q2 被移除
    };
    const answers = { q1: '答案1', q2: 42 };

    const result = QuestionnaireEngine.flagIncompatibleFields(oldTpl, newTpl, answers);
    assertEqual(result.autoMergeable.q1, '答案1');
    assert(result.manualRequired.q2, 'q2 应须人工');
    assert(result.manualRequired.q2.reason.includes('移除'), '原因应提及移除');
  });

  // ====================================================================
  // 测试套件 6：附件状态与合并
  // ====================================================================
  suite('附件状态与合并');

  await test('新创建的附件应为 compressed 状态', () => {
    const att = Attachments.createFromBase64('data:image/jpeg;base64,/9j/4AAQ', 'test.jpg');
    assertEqual(att.uploadStatus, Attachments.STATUS.COMPRESSED);
    assertEqual(att.uploadRetryCount, 0);
    assert(att.id, '应有 ID');
  });

  await test('附件元数据提取应不含数据体', () => {
    const att = Attachments.createFromBase64('data:image/jpeg;base64,/9j/4AAQlongdata', 'photo.jpg');
    const meta = Attachments.getAttachmentMeta(att);
    assert(meta.id === att.id);
    assert(meta.uploadStatus === att.uploadStatus);
    assert(!meta.data, '元数据不应包含 data');
    assert(!meta.thumbnail, '元数据不应包含 thumbnail');
  });

  await test('附件验证：缺少数据的 compressed 附件应无效', () => {
    const att = { id: 'a1', uploadStatus: 'compressed', data: null };
    const result = Attachments.validateAttachment(att);
    assert(!result.valid);
  });

  await test('附件三方合并：本地新增附件应保留', () => {
    const base = [{ id: 'a1', name: 'old.jpg', uploadStatus: 'uploaded', compressedSize: 100 }];
    const local = [
      { id: 'a1', name: 'old.jpg', uploadStatus: 'uploaded', compressedSize: 100 },
      { id: 'a2', name: 'new-local.jpg', uploadStatus: 'compressed', compressedSize: 200 }
    ];
    const remote = [{ id: 'a1', name: 'old.jpg', uploadStatus: 'uploaded', compressedSize: 100 }];

    const result = Attachments.mergeAttachments(base, local, remote);
    assertEqual(result.merged.length, 2, '应合并为 2 个附件');
    assert(result.merged.find(a => a.id === 'a2'), '本地新增的附件应保留');
    assertEqual(result.conflicts.length, 0);
  });

  await test('附件三方合并：两端同时修改同一附件应冲突', () => {
    const base = [{ id: 'a1', name: 'photo.jpg', uploadStatus: 'compressed', compressedSize: 100 }];
    const local = [{ id: 'a1', name: 'photo.jpg', uploadStatus: 'uploaded', compressedSize: 100 }];
    const remote = [{ id: 'a1', name: 'photo.jpg', uploadStatus: 'upload_failed', compressedSize: 150 }];

    const result = Attachments.mergeAttachments(base, local, remote);
    assertEqual(result.conflicts.length, 1, '应有 1 个附件冲突');
    assertEqual(result.conflicts[0].id, 'a1');
  });

  await test('附件三方合并：远程删除 base 中存在的附件应冲突', () => {
    const base = [{ id: 'a1', name: 'photo.jpg', uploadStatus: 'uploaded', compressedSize: 100 }];
    const local = [{ id: 'a1', name: 'photo.jpg', uploadStatus: 'uploaded', compressedSize: 100 }];
    const remote = [];

    const result = Attachments.mergeAttachments(base, local, remote);
    assertEqual(result.conflicts.length, 1, '远程删除应触发冲突');
    assertEqual(result.conflicts[0].reason, '远程已删除');
  });

  // ====================================================================
  // 测试套件 7：提醒计算幂等性
  // ====================================================================
  suite('提醒计算幂等性');

  await test('提醒日期应基于实际随访日期而非今天', () => {
    const patient = { id: 'p1', name: '张三', diseases: ['hypertension'], riskLevel: 'medium' };
    const pastDate = '2025-01-01';
    const nextDate = Reminders.getNextVisitDate(patient, 'medium', pastDate);
    assertEqual(nextDate, Utils.addDays(pastDate, 14), '应从随访日期 +14 天');
    // 不应是从今天算的
    assertNotEqual(nextDate, Utils.addDays(Utils.today(), 14), '不应从今天计算');
  });

  await test('generateReminder 应包含 sourceVisitId', () => {
    const patient = { id: 'p1', name: '张三', diseases: ['hypertension'], riskLevel: 'medium' };
    const visit = { id: 'v1', date: '2025-06-01', riskLevel: 'medium', bpSystolic: 140, bpDiastolic: 90 };
    const reminder = Reminders.generateReminder(visit, patient);
    assertEqual(reminder.sourceVisitId, 'v1', '应追踪来源 visit ID');
    assertEqual(reminder.sourceVisitDate, '2025-06-01', '应追踪来源日期');
  });

  await test('deduplicateReminders 应对同一 visit 只保留一个提醒', () => {
    const reminders = [
      { sourceVisitId: 'v1', sourceVisitDate: '2025-06-01', patientId: 'p1' },
      { sourceVisitId: 'v1', sourceVisitDate: '2025-06-01', patientId: 'p1' }, // 重复
      { sourceVisitId: 'v2', sourceVisitDate: '2025-06-05', patientId: 'p2' }
    ];
    const deduped = Reminders.deduplicateReminders(reminders);
    assertEqual(deduped.length, 2, '应去重为 2 个');
  });

  await test('computeMergedReminder 对同 ID visit 不应重复推进', () => {
    const patient = { id: 'p1', name: '张三', diseases: ['hypertension'], riskLevel: 'high' };
    const localVisits = [
      { id: 'v1', date: '2025-06-01', riskLevel: 'high', updatedAt: '2025-06-01T10:00:00', isDraft: false }
    ];
    const remoteVisits = [
      { id: 'v1', date: '2025-06-01', riskLevel: 'high', updatedAt: '2025-06-01T12:00:00', isDraft: false }
    ];

    const reminder = Reminders.computeMergedReminder(patient, localVisits, remoteVisits);
    assert(reminder, '应生成提醒');
    assertEqual(reminder.sourceVisitId, 'v1', '应基于同一 visit');
    // 不应出现两个不同的 nextVisitDate
    const expected = Reminders.getNextVisitDate(patient, 'high', '2025-06-01');
    assertEqual(reminder.nextVisitDate, expected, '合并后提醒日期不应重复推进');
  });

  await test('getVisitInterval 高风险应强制最短 7 天', () => {
    const patient = { id: 'p1', diseases: ['copd'], riskLevel: 'high' }; // COPD default=30
    const interval = Reminders.getVisitInterval(patient, 'high');
    assertEqual(interval, 7, '高风险应强制 7 天');
  });

  // ====================================================================
  // 测试套件 8：HMAC 与加密完整性
  // ====================================================================
  suite('HMAC 与加密完整性');

  await test('HMAC 计算和验证应正常工作', async () => {
    const data = { id: '123', name: '测试', age: 50 };
    const hmac = await CryptoManager.computeHMAC(data);
    assert(hmac, '应返回 HMAC 签名');
    assert(typeof hmac === 'string', '签名应为字符串');

    const valid = await CryptoManager.verifyHMAC(data, hmac);
    assert(valid, '验证应通过');

    const tampered = { id: '123', name: '测试', age: 51 };
    const invalid = await CryptoManager.verifyHMAC(tampered, hmac);
    assert(!invalid, '篡改数据后验证应失败');
  });

  await test('加密解密应可逆', async () => {
    const plaintext = '敏感患者身份证号 1234567890';
    const encrypted = await CryptoManager.encrypt(plaintext);
    assert(encrypted !== plaintext, '密文不应等于明文');
    const decrypted = await CryptoManager.decrypt(encrypted);
    assertEqual(decrypted, plaintext, '解密结果应等于原始明文');
  });

  await test('isReady 应在初始化后返回 true', () => {
    assert(CryptoManager.isReady(), '初始化后应 ready');
  });

  // ====================================================================
  // 测试套件 9：三方 diff
  // ====================================================================
  suite('三方 diff 详细');

  await test('diffThreeWay 应正确识别 local_only 变更', () => {
    const diffs = SyncManager.diffThreeWay(
      { a: 1, b: 2 },
      { a: 9, b: 2 },
      { a: 1, b: 2 }
    );
    assertEqual(diffs.length, 1);
    assertEqual(diffs[0].field, 'a');
    assertEqual(diffs[0].status, 'local_only');
  });

  await test('diffThreeWay 应正确识别 remote_only 变更', () => {
    const diffs = SyncManager.diffThreeWay(
      { a: 1, b: 2 },
      { a: 1, b: 2 },
      { a: 1, b: 9 }
    );
    assertEqual(diffs.length, 1);
    assertEqual(diffs[0].field, 'b');
    assertEqual(diffs[0].status, 'remote_only');
  });

  await test('diffThreeWay 应跳过内部字段', () => {
    const diffs = SyncManager.diffThreeWay(
      { a: 1, _hmac: 'old', syncStatus: 'synced' },
      { a: 1, _hmac: 'new1', syncStatus: 'pending' },
      { a: 1, _hmac: 'new2', syncStatus: 'synced' }
    );
    assertEqual(diffs.length, 0, '内部字段变更不应报告');
  });

  await test('diffThreeWay 新增字段处理', () => {
    const diffs = SyncManager.diffThreeWay(
      { a: 1 },
      { a: 1, b: 2 },      // 本地新增 b
      { a: 1, c: 3 }        // 远程新增 c
    );
    assertEqual(diffs.length, 2);
    const bDiff = diffs.find(d => d.field === 'b');
    const cDiff = diffs.find(d => d.field === 'c');
    assertEqual(bDiff.status, 'local_only');
    assertEqual(cDiff.status, 'remote_only');
  });

  // ====================================================================
  // 测试套件 10：问卷引擎模板元信息
  // ====================================================================
  suite('问卷引擎模板元信息');

  await test('startQuestionnaire 应记录模板元信息', () => {
    const template = { id: 'tpl-1', version: 3, diseaseType: 'diabetes', questions: [] };
    const patient = { id: 'p1', diseases: ['diabetes'], age: 55, gender: 'male' };
    QuestionnaireEngine.startQuestionnaire(template, patient, {});
    const meta = QuestionnaireEngine.getTemplateMeta();
    assertEqual(meta.templateId, 'tpl-1');
    assertEqual(meta.templateVersion, 3);
    assertEqual(meta.diseaseType, 'diabetes');
  });

  await test('migrateAnswers 应返回不兼容答案列表', async () => {
    // 先保存模板到 DB
    const oldTpl = {
      id: 'tpl-migrate',
      version: 1,
      diseaseType: 'hypertension',
      questions: [
        { id: 'q1', type: 'text', text: '问题1' },
        { id: 'q2', type: 'text', text: '问题2' },
        { id: 'q3', type: 'number', text: '问题3' }
      ]
    };
    const newTpl = {
      id: 'tpl-migrate',
      version: 2,
      diseaseType: 'hypertension',
      questions: [
        { id: 'q1', type: 'text', text: '问题1' },
        { id: 'q3', type: 'select', text: '问题3改选择', options: [{ value: 'a' }, { value: 'b' }] },
        { id: 'q4', type: 'text', text: '新问题4' }
      ]
    };

    await DB.saveTemplate(oldTpl);
    await DB.saveTemplate(newTpl);
    await QuestionnaireEngine.loadTemplates();

    const oldAnswers = { q1: '回答1', q2: '回答2', q3: 42 };
    const result = QuestionnaireEngine.migrateAnswers('tpl-migrate', 1, oldAnswers, 'hypertension');

    assert(result.migrated.includes('q1'), 'q1 应被迁移');
    assert(result.unmapped.find(u => u.questionId === 'q2'), 'q2 应在 unmapped 列表');
    assert(result.templateMeta, '应包含模板元信息');
    assertEqual(result.templateMeta.fromVersion, 1);
    assertEqual(result.templateMeta.templateVersion, 2);
  });

  // ====================================================================
  // 渲染结果
  // ====================================================================
  renderResults();
  console.log(`测试完成: ${results.pass} 通过, ${results.fail} 失败`);
})();
