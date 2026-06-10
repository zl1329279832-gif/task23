import { db } from '../core/db.js';
import { STORES } from '../core/config.js';
import { generateId } from '../utils/uid.js';
import { eventBus } from '../core/event-bus.js';

const STORE = STORES.ATTACHMENTS;

const ENCRYPTED_FIELDS = [
  'blobData',
  'fileName',
  'description'
];

export const attachmentModel = {
  async save(followupId, patientId, compressedBlob, metadata = {}) {
    const arrayBuffer = await compressedBlob.arrayBuffer();
    const blobData = Array.from(new Uint8Array(arrayBuffer));

    const record = {
      id: generateId(),
      followupId,
      patientId,
      blobData,
      fileName: metadata.fileName || '',
      description: metadata.description || '',
      mimeType: metadata.mimeType || compressedBlob.type || 'image/jpeg',
      originalSize: metadata.originalSize || 0,
      compressedSize: compressedBlob.size || 0,
      createdAt: Date.now()
    };

    const saved = await db.put(STORE, record, ENCRYPTED_FIELDS);
    eventBus.emit('attachment:saved', saved);
    return saved;
  },

  async getByFollowup(followupId) {
    return db.getAllByIndex(STORE, 'followupId', followupId, ENCRYPTED_FIELDS);
  },

  async delete(id) {
    await db.delete(STORE, id);
    eventBus.emit('attachment:deleted', { id });
  },

  getThumbnail(record) {
    if (!record || !record.blobData) return null;
    const bytes = new Uint8Array(record.blobData);
    const blob = new Blob([bytes], { type: record.mimeType || 'image/jpeg' });
    return URL.createObjectURL(blob);
  }
};
