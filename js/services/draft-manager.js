import { db } from '../core/db.js';
import { STORES, DRAFT } from '../core/config.js';
import { generateId } from '../utils/uid.js';
import { debounce } from '../utils/debounce.js';
import { eventBus } from '../core/event-bus.js';

class DraftManager {
  constructor() {
    this._autoSave = debounce((viewName, contextId, formState) => {
      this._save(viewName, contextId, formState);
    }, DRAFT.SAVE_DEBOUNCE);
  }

  async _save(viewName, contextId, formState) {
    const id = `${viewName}:${contextId}`;
    try {
      await db.putRaw(STORES.DRAFTS, {
        id,
        viewName,
        contextId,
        formState,
        updatedAt: Date.now()
      });
      eventBus.emit('draft:saved', { viewName, contextId });
    } catch (e) {
      console.error('Draft save failed:', e);
    }
  }

  scheduleAutoSave(viewName, contextId, formState) {
    this._autoSave(viewName, contextId, formState);
  }

  async saveDraft(viewName, contextId, formState) {
    this._autoSave.cancel();
    await this._save(viewName, contextId, formState);
  }

  async getDraft(viewName, contextId) {
    const id = `${viewName}:${contextId}`;
    return await db.getRaw(STORES.DRAFTS, id);
  }

  async deleteDraft(viewName, contextId) {
    const id = `${viewName}:${contextId}`;
    await db.delete(STORES.DRAFTS, id);
    eventBus.emit('draft:deleted', { viewName, contextId });
  }

  async getAllDrafts() {
    return await db.getAllRaw(STORES.DRAFTS);
  }

  async getDraftCount() {
    return await db.count(STORES.DRAFTS);
  }

  cancelAutoSave() {
    this._autoSave.cancel();
  }
}

export const draftManager = new DraftManager();
