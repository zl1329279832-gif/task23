// 附件处理 - 拍照、图片压缩、缩略图生成、上传状态与重试队列
const Attachments = (() => {
  const MAX_WIDTH = 1280;
  const QUALITY = 0.7;
  const THUMB_WIDTH = 200;
  const MAX_UPLOAD_RETRIES = 3;
  const UPLOAD_RETRY_BASE_DELAY = 2000;

  // 上传状态常量
  const STATUS = Object.freeze({
    COMPRESSED: 'compressed',         // 压缩完成，等待上传
    PENDING_UPLOAD: 'pending_upload', // 已加入上传队列
    UPLOADING: 'uploading',           // 上传中
    UPLOADED: 'uploaded',             // 上传成功
    UPLOAD_FAILED: 'upload_failed'    // 上传失败（可重试）
  });

  // 上传重试队列
  const _uploadQueue = [];
  let _uploadProcessing = false;

  function captureImage() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.onchange = e => {
        const file = e.target.files[0];
        if (!file) { reject(new Error('未选择文件')); return; }
        compressImage(file).then(resolve).catch(reject);
      };
      input.onerror = () => reject(new Error('文件选择失败'));
      input.click();
    });
  }

  function selectImage() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = e => {
        const file = e.target.files[0];
        if (!file) { reject(new Error('未选择文件')); return; }
        compressImage(file).then(resolve).catch(reject);
      };
      input.onerror = () => reject(new Error('文件选择失败'));
      input.click();
    });
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          try {
            const result = resizeAndCompress(img, MAX_WIDTH, QUALITY);
            const thumb = resizeAndCompress(img, THUMB_WIDTH, 0.5);
            resolve({
              id: Utils.uuid(),
              name: file.name || `photo_${Date.now()}.jpg`,
              type: 'image/jpeg',
              data: result.dataUrl,
              thumbnail: thumb.dataUrl,
              originalSize: file.size,
              compressedSize: result.size,
              width: result.width,
              height: result.height,
              compressionQuality: QUALITY,
              uploadStatus: STATUS.COMPRESSED,
              uploadRetryCount: 0,
              lastUploadError: null,
              createdAt: Utils.now()
            });
          } catch (err) {
            reject(err);
          }
        };
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function resizeAndCompress(img, maxWidth, quality) {
    const canvas = document.createElement('canvas');
    let width = img.width;
    let height = img.height;

    if (width > maxWidth) {
      height = Math.round((height * maxWidth) / width);
      width = maxWidth;
    }

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const size = Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 0.75);

    return { dataUrl, size, width, height };
  }

  function createFromBase64(base64, name) {
    return {
      id: Utils.uuid(),
      name: name || `attachment_${Date.now()}.jpg`,
      type: 'image/jpeg',
      data: base64,
      thumbnail: base64,
      compressedSize: Math.round(base64.length * 0.75),
      compressionQuality: null,
      uploadStatus: STATUS.COMPRESSED,
      uploadRetryCount: 0,
      lastUploadError: null,
      createdAt: Utils.now()
    };
  }

  // 提取附件元数据（不含数据体，用于冲突比较）
  function getAttachmentMeta(attachment) {
    if (!attachment) return null;
    return {
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      originalSize: attachment.originalSize,
      compressedSize: attachment.compressedSize,
      width: attachment.width,
      height: attachment.height,
      compressionQuality: attachment.compressionQuality,
      uploadStatus: attachment.uploadStatus,
      uploadRetryCount: attachment.uploadRetryCount,
      createdAt: attachment.createdAt
    };
  }

  // 提取附件列表的元数据摘要
  function getAttachmentsMeta(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments.map(getAttachmentMeta);
  }

  // 验证附件完整性（压缩状态与数据一致）
  function validateAttachment(attachment) {
    const errors = [];
    if (!attachment) return { valid: false, errors: ['附件对象为空'] };
    if (!attachment.id) errors.push('缺少附件 ID');
    if (!attachment.uploadStatus) errors.push('缺少上传状态');
    if (attachment.uploadStatus === STATUS.COMPRESSED || attachment.uploadStatus === STATUS.PENDING_UPLOAD) {
      if (!attachment.data) errors.push('压缩附件缺少数据');
    }
    if (attachment.uploadStatus === STATUS.UPLOADED && !attachment.data && !attachment.remoteUrl) {
      errors.push('已上传附件缺少数据或远程 URL');
    }
    return { valid: errors.length === 0, errors };
  }

  // 合并附件列表（三方合并：base、local、remote）
  function mergeAttachments(baseAttachments, localAttachments, remoteAttachments) {
    const base = Array.isArray(baseAttachments) ? baseAttachments : [];
    const local = Array.isArray(localAttachments) ? localAttachments : [];
    const remote = Array.isArray(remoteAttachments) ? remoteAttachments : [];

    const baseMap = new Map(base.map(a => [a.id, a]));
    const localMap = new Map(local.map(a => [a.id, a]));
    const remoteMap = new Map(remote.map(a => [a.id, a]));
    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);

    const merged = [];
    const conflicts = [];

    for (const id of allIds) {
      const baseAtt = baseMap.get(id);
      const localAtt = localMap.get(id);
      const remoteAtt = remoteMap.get(id);

      if (localAtt && !remoteAtt) {
        // 本地新增或远程删除
        if (baseAtt) {
          // 远程删除了 base 有的 → 标记冲突
          conflicts.push({ id, local: localAtt, remote: null, base: baseAtt, reason: '远程已删除' });
        } else {
          // 本地离线新增
          merged.push(localAtt);
        }
      } else if (!localAtt && remoteAtt) {
        // 远程新增或本地删除
        if (baseAtt) {
          conflicts.push({ id, local: null, remote: remoteAtt, base: baseAtt, reason: '本地已删除' });
        } else {
          merged.push(remoteAtt);
        }
      } else if (localAtt && remoteAtt) {
        // 两端都有
        if (!baseAtt) {
          // 两端独立新增了同 ID 附件（不太可能但防御性处理）
          conflicts.push({ id, local: localAtt, remote: remoteAtt, base: null, reason: '两端分别新增' });
        } else {
          // 两端均修改了同一附件
          const localChanged = localAtt.compressedSize !== baseAtt.compressedSize ||
                               localAtt.uploadStatus !== baseAtt.uploadStatus;
          const remoteChanged = remoteAtt.compressedSize !== baseAtt.compressedSize ||
                                remoteAtt.uploadStatus !== baseAtt.uploadStatus;

          if (!localChanged && !remoteChanged) {
            // 都没改，保持远程（有更新上传状态的可能）
            merged.push(_pickBetterUploadState(localAtt, remoteAtt));
          } else if (localChanged && !remoteChanged) {
            merged.push(localAtt);
          } else if (!localChanged && remoteChanged) {
            merged.push(remoteAtt);
          } else {
            // 两端都改了 → 冲突
            conflicts.push({ id, local: localAtt, remote: remoteAtt, base: baseAtt, reason: '两端均修改' });
          }
        }
      }
    }

    return { merged, conflicts };
  }

  // 选择上传状态更优的版本
  function _pickBetterUploadState(a, b) {
    const priority = { uploaded: 4, uploading: 3, pending_upload: 2, compressed: 1, upload_failed: 0 };
    const pa = priority[a.uploadStatus] || 0;
    const pb = priority[b.uploadStatus] || 0;
    return pa >= pb ? a : b;
  }

  // --- 上传重试队列 ---

  function enqueueUpload(attachment, visitId) {
    attachment.uploadStatus = STATUS.PENDING_UPLOAD;
    _uploadQueue.push({ attachment, visitId, addedAt: Date.now() });
    _processUploadQueue();
    return attachment;
  }

  async function _processUploadQueue() {
    if (_uploadProcessing || _uploadQueue.length === 0 || !navigator.onLine) return;
    _uploadProcessing = true;

    while (_uploadQueue.length > 0 && navigator.onLine) {
      const item = _uploadQueue[0];
      const att = item.attachment;

      try {
        att.uploadStatus = STATUS.UPLOADING;
        // 模拟上传（实际项目中替换为真实 API 调用）
        await new Promise((resolve, reject) => {
          setTimeout(() => {
            if (Math.random() < 0.1) reject(new Error('上传网络错误'));
            else resolve();
          }, 300 + Math.random() * 500);
        });

        att.uploadStatus = STATUS.UPLOADED;
        att.uploadRetryCount = 0;
        att.lastUploadError = null;
        _uploadQueue.shift();

        // 更新关联 visit 中的附件状态
        if (item.visitId) {
          await _updateVisitAttachmentStatus(item.visitId, att.id, STATUS.UPLOADED);
        }
      } catch (err) {
        att.uploadRetryCount = (att.uploadRetryCount || 0) + 1;
        att.lastUploadError = err.message;

        if (att.uploadRetryCount >= MAX_UPLOAD_RETRIES) {
          att.uploadStatus = STATUS.UPLOAD_FAILED;
          _uploadQueue.shift();
          if (item.visitId) {
            await _updateVisitAttachmentStatus(item.visitId, att.id, STATUS.UPLOAD_FAILED, err.message);
          }
        } else {
          att.uploadStatus = STATUS.PENDING_UPLOAD;
          const delay = UPLOAD_RETRY_BASE_DELAY * Math.pow(2, att.uploadRetryCount - 1);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    _uploadProcessing = false;
  }

  // 更新 visit 记录中某个附件的上传状态
  async function _updateVisitAttachmentStatus(visitId, attachmentId, status, error) {
    try {
      const visit = await DB.loadVisit(visitId);
      if (!visit || !Array.isArray(visit.attachments)) return;
      const att = visit.attachments.find(a => a.id === attachmentId);
      if (att) {
        att.uploadStatus = status;
        if (error) att.lastUploadError = error;
        const db = await DB.open();
        await DB.put(db, 'visits', visit);
      }
    } catch { /* 非关键路径，静默失败 */ }
  }

  // 重试所有失败的附件上传
  async function retryFailedUploads(visitId) {
    const visit = await DB.loadVisit(visitId);
    if (!visit || !Array.isArray(visit.attachments)) return 0;

    let retried = 0;
    for (const att of visit.attachments) {
      if (att.uploadStatus === STATUS.UPLOAD_FAILED) {
        att.uploadRetryCount = 0;
        att.lastUploadError = null;
        enqueueUpload(att, visitId);
        retried++;
      }
    }
    return retried;
  }

  // 获取上传队列状态
  function getUploadQueueStatus() {
    return {
      pending: _uploadQueue.length,
      processing: _uploadProcessing
    };
  }

  function formatSize(bytes) {
    return Utils.bytesToSize(bytes);
  }

  return {
    captureImage, selectImage, compressImage, createFromBase64, formatSize,
    getAttachmentMeta, getAttachmentsMeta, validateAttachment,
    mergeAttachments, enqueueUpload, retryFailedUploads, getUploadQueueStatus,
    STATUS
  };
})();
