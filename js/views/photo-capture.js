import { attachmentModel } from '../models/attachment.js';
import { followupModel } from '../models/followup.js';
import { imageCompressor } from '../services/image-compressor.js';
import { router } from '../router.js';
import { eventBus } from '../core/event-bus.js';

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default {
  _container: null,
  _unsubs: [],
  _followupId: null,
  _attachments: [],
  _thumbnailUrls: [],

  async render(container, params) {
    this._container = container;
    this._followupId = params.followupId;
    this._attachments = [];
    this._thumbnailUrls = [];

    container.innerHTML = '<div class="photo-capture-view"><div class="loading">加载中...</div></div>';
    const root = container.firstElementChild;

    try {
      const followup = await followupModel.getById(this._followupId);
      if (!followup) {
        root.innerHTML = '<div class="empty-state">未找到随访记录</div>';
        return;
      }

      this._attachments = await attachmentModel.getByFollowup(this._followupId);
      this._renderView(root);
    } catch (e) {
      console.error('Failed to load photo capture:', e);
      root.innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }
  },

  _renderView(root) {
    root.innerHTML = `
      <div class="photo-capture-section">
        <div class="capture-area">
          <label class="capture-btn">
            <input type="file" accept="image/*" capture="environment"
              class="file-input hidden" multiple />
            <span class="capture-icon">&#128247;</span>
            <span>拍照 / 选择图片</span>
          </label>
        </div>

        <div class="photo-grid">
          ${this._renderPhotoGrid()}
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn-secondary btn-back">返回</button>
      </div>
    `;

    this._bindEvents(root);
  },

  _renderPhotoGrid() {
    if (this._attachments.length === 0) {
      return '<div class="empty-state">暂无附件</div>';
    }

    return this._attachments.map((att, idx) => {
      const url = attachmentModel.getThumbnail(att);
      if (url) this._thumbnailUrls.push(url);

      return `
        <div class="photo-card" data-id="${att.id}" data-index="${idx}">
          ${url ? `<img class="photo-thumbnail" src="${url}" alt="${att.fileName || '附件'}" />` :
            '<div class="photo-placeholder">无法显示</div>'}
          <div class="photo-info">
            <span class="photo-name">${att.fileName || '未命名'}</span>
            <span class="photo-size">
              原始: ${formatSize(att.originalSize)} / 压缩: ${formatSize(att.compressedSize)}
            </span>
          </div>
          <button type="button" class="btn btn-sm btn-danger btn-delete-photo"
            data-id="${att.id}">删除</button>
        </div>
      `;
    }).join('');
  },

  _bindEvents(root) {
    // File input
    const fileInput = root.querySelector('.file-input');
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      for (const file of files) {
        await this._processFile(file);
      }

      // Reset input so same file can be selected again
      fileInput.value = '';

      // Re-render the grid
      this._refreshGrid(root);
    });

    // Delete buttons
    this._bindDeleteButtons(root);

    // Back button
    root.querySelector('.btn-back').addEventListener('click', () => {
      router.back();
    });
  },

  _bindDeleteButtons(root) {
    root.querySelectorAll('.btn-delete-photo').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        try {
          await attachmentModel.delete(id);
          this._attachments = this._attachments.filter(a => a.id !== id);
          this._refreshGrid(root);
        } catch (e) {
          console.error('Failed to delete attachment:', e);
          alert('删除失败');
        }
      });
    });
  },

  async _processFile(file) {
    try {
      const result = await imageCompressor.compress(file);
      const followup = await followupModel.getById(this._followupId);

      const saved = await attachmentModel.save(
        this._followupId,
        followup.patientId,
        result.blob,
        {
          fileName: file.name,
          mimeType: 'image/jpeg',
          originalSize: result.originalSize,
          compressedSize: result.compressedSize
        }
      );

      // Reload to get decrypted record
      const reloaded = await attachmentModel.getByFollowup(this._followupId);
      this._attachments = reloaded;

      eventBus.emit('photo:captured', { followupId: this._followupId, id: saved.id });
    } catch (e) {
      console.error('Failed to process image:', e);
      alert('图片处理失败，请重试');
    }
  },

  _refreshGrid(root) {
    // Revoke old URLs
    this._revokeUrls();

    const grid = root.querySelector('.photo-grid');
    if (grid) {
      grid.innerHTML = this._renderPhotoGrid();
      this._bindDeleteButtons(root);
    }
  },

  _revokeUrls() {
    this._thumbnailUrls.forEach(url => {
      try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    });
    this._thumbnailUrls = [];
  },

  destroy() {
    this._revokeUrls();
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._container = null;
    this._followupId = null;
    this._attachments = [];
  }
};
