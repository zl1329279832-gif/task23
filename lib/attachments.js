// 附件处理 - 拍照、图片压缩（状态追踪）、缩略图生成、上传队列
const Attachments = (() => {
  const MAX_WIDTH = 1280;
  const QUALITY = 0.7;
  const THUMB_WIDTH = 200;
  const THUMB_QUALITY = 0.5;
  const MAX_UPLOAD_RETRIES = 3;

  // 压缩状态枚举
  const COMPRESSION_STATE = {
    ORIGINAL: 'original',       // 原始文件
    COMPRESSED: 'compressed',   // 已压缩
    THUMBNAIL_ONLY: 'thumb',    // 仅缩略图（离线低带宽）
    UPLOADED: 'uploaded'        // 已上传到服务器
  };

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
        const originalDataUrl = e.target.result;
        const img = new Image();
        img.onload = () => {
          try {
            const result = resizeAndCompress(img, MAX_WIDTH, QUALITY);
            const thumb = resizeAndCompress(img, THUMB_WIDTH, THUMB_QUALITY);
            resolve({
              id: Utils.uuid(),
              name: file.name || `photo_${Date.now()}.jpg`,
              type: 'image/jpeg',
              data: result.dataUrl,
              thumbnail: thumb.dataUrl,
              originalDataUrl: originalDataUrl, // 保留原始数据以备重压缩
              originalSize: file.size,
              compressedSize: result.size,
              thumbnailSize: thumb.size,
              width: result.width,
              height: result.height,
              compressionState: COMPRESSION_STATE.COMPRESSED,
              compressionParams: { maxWidth: MAX_WIDTH, quality: QUALITY },
              uploadStatus: 'pending', // pending | uploading | uploaded | failed
              uploadRetryCount: 0,
              checksum: _simpleChecksum(result.dataUrl),
              createdAt: Utils.now()
            });
          } catch (err) {
            reject(err);
          }
        };
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = originalDataUrl;
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

  /** 简单校验和（检测数据损坏） */
  function _simpleChecksum(str) {
    let hash = 0;
    const step = Math.max(1, Math.floor(str.length / 1000)); // 采样以提速
    for (let i = 0; i < str.length; i += step) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /** 验证附件完整性 */
  function verifyIntegrity(attachment) {
    if (!attachment.checksum) return true; // 旧数据无校验和
    return _simpleChecksum(attachment.data) === attachment.checksum;
  }

  /** 从 base64 创建附件（带压缩状态） */
  function createFromBase64(base64, name) {
    return {
      id: Utils.uuid(),
      name: name || `attachment_${Date.now()}.jpg`,
      type: 'image/jpeg',
      data: base64,
      thumbnail: base64,
      compressedSize: Math.round(base64.length * 0.75),
      compressionState: COMPRESSION_STATE.ORIGINAL,
      uploadStatus: 'pending',
      uploadRetryCount: 0,
      checksum: _simpleChecksum(base64),
      createdAt: Utils.now()
    };
  }

  /**
   * 模拟附件上传（带重试和状态追踪）
   * @param {Object} attachment - 附件对象
   * @param {Object} options - { onProgress, mockFailRate }
   * @returns {Promise<Object>} 上传结果
   */
  async function uploadAttachment(attachment, options = {}) {
    const { mockFailRate = 0.15 } = options;

    // 更新状态为上传中
    attachment.uploadStatus = 'uploading';

    // 模拟网络延迟
    await new Promise(r => setTimeout(r, 300 + Math.random() * 700));

    // 模拟上传失败
    if (Math.random() < mockFailRate) {
      attachment.uploadStatus = 'failed';
      attachment.uploadRetryCount = (attachment.uploadRetryCount || 0) + 1;
      attachment.lastUploadError = '上传失败：网络错误';

      if (attachment.uploadRetryCount < MAX_UPLOAD_RETRIES) {
        // 指数退避重试
        const delay = Math.min(1000 * Math.pow(2, attachment.uploadRetryCount - 1), 30000);
        await new Promise(r => setTimeout(r, delay));
        return uploadAttachment(attachment, options); // 递归重试
      }
      throw new Error(`附件上传失败（已重试 ${attachment.uploadRetryCount} 次）`);
    }

    // 上传成功
    attachment.uploadStatus = 'uploaded';
    attachment.compressionState = COMPRESSION_STATE.UPLOADED;
    attachment.uploadedAt = Utils.now();
    attachment.serverUrl = `mock://attachments/${attachment.id}.jpg`;

    return { success: true, attachment };
  }

  /**
   * 处理附件队列中的待上传项（带去重和压缩状态校验）
   */
  async function processAttachmentQueue(options = {}) {
    if (typeof DB === 'undefined') return { processed: 0, failed: 0, skipped: 0 };

    const queue = await DB.getAttachmentQueue();
    let processed = 0;
    let failed = 0;
    let skipped = 0;

    // 去重：检查 visit 记录中附件是否已上传
    const visitedAttIds = new Set();
    if (options.checkVisitRecords) {
      try {
        const db = await DB.open();
        const visits = await DB.getAll(db, 'visits');
        for (const visit of visits) {
          if (visit.attachments && Array.isArray(visit.attachments)) {
            for (const att of visit.attachments) {
              if (att.uploadStatus === 'uploaded' && att.id) {
                visitedAttIds.add(att.id);
              }
            }
          }
        }
      } catch { /* skip visit check */ }
    }

    for (const item of queue) {
      // 跳过已在 visit 记录中标记为上传完成的附件
      if (item.attachmentId && visitedAttIds.has(item.attachmentId)) {
        await DB.updateAttachmentQueueItem(item.id, {
          status: 'uploaded',
          compressionState: COMPRESSION_STATE.UPLOADED
        });
        skipped++;
        continue;
      }

      // 跳过状态不一致的项：如果标记为 uploading 但实际未在上传（崩溃恢复）
      if (item.status === 'uploading') {
        // 将卡住的 uploading 状态重置为 pending
        await DB.updateAttachmentQueueItem(item.id, { status: 'pending' });
        item.status = 'pending';
      }

      // 校验压缩状态一致性
      if (item.compressionState === COMPRESSION_STATE.UPLOADED) {
        // 压缩状态已标记为上传完成但队列状态不是 → 修正
        await DB.updateAttachmentQueueItem(item.id, { status: 'uploaded' });
        skipped++;
        continue;
      }

      try {
        await DB.updateAttachmentQueueItem(item.id, { status: 'uploading' });
        // 模拟上传
        await new Promise(r => setTimeout(r, 200));
        if (Math.random() < (options.mockFailRate || 0.1)) {
          throw new Error('上传失败');
        }
        await DB.updateAttachmentQueueItem(item.id, {
          status: 'uploaded',
          compressionState: COMPRESSION_STATE.UPLOADED
        });
        processed++;
      } catch (err) {
        const retries = (item.retryCount || 0) + 1;
        if (retries >= MAX_UPLOAD_RETRIES) {
          await DB.updateAttachmentQueueItem(item.id, {
            status: 'failed',
            retryCount: retries,
            lastError: err.message,
            // 保持压缩状态不变（失败不应改变压缩状态）
            compressionState: item.compressionState || COMPRESSION_STATE.COMPRESSED
          });
          failed++;
        } else {
          await DB.updateAttachmentQueueItem(item.id, {
            status: 'pending', // 重置为 pending 以便下次重试
            retryCount: retries,
            lastError: err.message
          });
        }
      }
    }

    return { processed, failed, skipped };
  }

  /**
   * 重置失败的附件，允许手动重试
   * @param {string} queueItemId - 附件队列项 ID
   * @returns {Promise<Object|null>} 重置后的队列项
   */
  async function resetFailedAttachment(queueItemId) {
    if (typeof DB === 'undefined') return null;

    const item = await DB.updateAttachmentQueueItem(queueItemId, {
      status: 'pending',
      retryCount: 0,
      lastError: null
    });

    if (item && typeof DB._logOperation === 'function') {
      await DB._logOperation('attachment_queue', queueItemId, 'manual_retry_reset', {
        attachmentId: item.attachmentId,
        visitId: item.visitId
      });
    }

    return item;
  }

  /**
   * 批量重置所有失败的附件
   * @returns {Promise<number>} 重置的数量
   */
  async function resetAllFailedAttachments() {
    if (typeof DB === 'undefined') return 0;

    const queue = await DB.getAttachmentQueue();
    const failedItems = queue.filter(i => i.status === 'failed');
    let count = 0;

    for (const item of failedItems) {
      await DB.updateAttachmentQueueItem(item.id, {
        status: 'pending',
        retryCount: 0,
        lastError: null
      });
      count++;
    }

    return count;
  }

  /** 重新压缩附件（从原始数据重新压缩，保证压缩状态一致性） */
  function recompress(attachment, newMaxWidth, newQuality) {
    return new Promise((resolve, reject) => {
      const sourceData = attachment.originalDataUrl || attachment.data;
      const img = new Image();
      img.onload = () => {
        try {
          const result = resizeAndCompress(img, newMaxWidth || MAX_WIDTH, newQuality || QUALITY);
          const thumb = resizeAndCompress(img, THUMB_WIDTH, THUMB_QUALITY);
          attachment.data = result.dataUrl;
          attachment.thumbnail = thumb.dataUrl;
          attachment.compressedSize = result.size;
          attachment.thumbnailSize = thumb.size;
          attachment.width = result.width;
          attachment.height = result.height;
          attachment.compressionState = COMPRESSION_STATE.COMPRESSED;
          attachment.compressionParams = { maxWidth: newMaxWidth || MAX_WIDTH, quality: newQuality || QUALITY };
          attachment.checksum = _simpleChecksum(result.dataUrl);
          resolve(attachment);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = sourceData;
    });
  }

  function formatSize(bytes) {
    return Utils.bytesToSize(bytes);
  }

  return {
    captureImage, selectImage, compressImage, createFromBase64, formatSize,
    uploadAttachment, processAttachmentQueue, recompress, verifyIntegrity,
    resetFailedAttachment, resetAllFailedAttachments,
    COMPRESSION_STATE, MAX_UPLOAD_RETRIES, _simpleChecksum
  };
})();
