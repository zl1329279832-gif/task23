export const imageCompressor = {
  async compress(file, maxDimension = 1200, quality = 0.7) {
    const originalSize = file.size;
    const imageBitmap = await this._loadImage(file);
    const { width, height } = this._calculateDimensions(
      imageBitmap.width, imageBitmap.height, maxDimension
    );

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, width, height);

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    });

    // Clean up
    canvas.width = 0;
    canvas.height = 0;

    return {
      blob,
      originalSize,
      compressedSize: blob.size,
      width,
      height
    };
  },

  _loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      img.src = url;
    });
  },

  _calculateDimensions(origWidth, origHeight, maxDimension) {
    if (origWidth <= maxDimension && origHeight <= maxDimension) {
      return { width: origWidth, height: origHeight };
    }
    const ratio = Math.min(maxDimension / origWidth, maxDimension / origHeight);
    return {
      width: Math.round(origWidth * ratio),
      height: Math.round(origHeight * ratio)
    };
  }
};
