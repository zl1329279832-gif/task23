// 附件处理 - 拍照、图片压缩、缩略图生成
const Attachments = (() => {
  const MAX_WIDTH = 1280;
  const QUALITY = 0.7;
  const THUMB_WIDTH = 200;

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
    // Approximate size from base64
    const size = Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 0.75);

    return { dataUrl, size, width, height };
  }

  function createFromBase64(base64, name) {
    return {
      id: Utils.uuid(),
      name: name || `attachment_${Date.now()}.jpg`,
      type: 'image/jpeg',
      data: base64,
      thumbnail: base64, // Will use same data for simplicity in thumbnail display
      compressedSize: Math.round(base64.length * 0.75),
      createdAt: Utils.now()
    };
  }

  function formatSize(bytes) {
    return Utils.bytesToSize(bytes);
  }

  return { captureImage, selectImage, compressImage, createFromBase64, formatSize };
})();
