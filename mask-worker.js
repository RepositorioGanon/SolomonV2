/**
 * mask-worker.js
 *
 * Worker Thread que procesa la máscara de segmentación fuera del event loop principal.
 * Esto evita bloquear Node.js mientras se hacen solicitudes simultáneas.
 *
 * Se ejecuta automáticamente desde server_alt.js mediante Worker Threads.
 */

const { workerData, parentPort } = require('worker_threads');
const { createCanvas, loadImage } = require('canvas');

async function aplicarMascara(base64Jpg, response) {
  const data0 = response && response.data && response.data[0];
  if (
    !data0 ||
    !data0.masks ||
    !data0.masks_shape_list ||
    !data0.rois ||
    !data0.masks_shape_list.length ||
    !data0.rois.length
  ) {
    return null;
  }

  const masksStr = data0.masks;
  const shapes = data0.masks_shape_list;
  const rois = data0.rois;

  const imgBuffer = Buffer.from(base64Jpg, 'base64');
  const img = await loadImage(imgBuffer);

  const w = img.width;
  const h = img.height;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let offset = 0;
  const overlayR = 0;
  const overlayG = 255;
  const overlayB = 0;
  const overlayA = 0.45;

  for (let m = 0; m < shapes.length && m < rois.length; m++) {
    const mh = shapes[m][0];
    const mw = shapes[m][1];
    const roi = rois[m];
    const x1 = roi[0];
    const y1 = roi[1];
    const x2 = roi[2];
    const y2 = roi[3];
    const roiW = x2 - x1;
    const roiH = y2 - y1;
    const size = mh * mw;
    const end = offset + size;
    if (end > masksStr.length) break;

    for (let row = 0; row < mh; row++) {
      for (let col = 0; col < mw; col++) {
        const idx = offset + row * mw + col;
        const ch = masksStr.charCodeAt(idx);
        if (ch === 1) {
          const px = x1 + Math.floor((col / mw) * roiW);
          const py = y1 + Math.floor((row / mh) * roiH);
          if (px >= 0 && px < w && py >= 0 && py < h) {
            const i = (py * w + px) * 4;
            data[i] = Math.round(data[i] * (1 - overlayA) + overlayR * overlayA);
            data[i + 1] = Math.round(data[i + 1] * (1 - overlayA) + overlayG * overlayA);
            data[i + 2] = Math.round(data[i + 2] * (1 - overlayA) + overlayB * overlayA);
          }
        }
      }
    }
    offset = end;
  }

  ctx.putImageData(imageData, 0, 0);
  const outBuffer = canvas.toBuffer('image/jpeg');
  return outBuffer.toString('base64');
}

(async () => {
  try {
    const result = await aplicarMascara(workerData.base64Jpg, workerData.response);
    parentPort.postMessage(result);
  } catch (_) {
    parentPort.postMessage(null);
  }
})();
