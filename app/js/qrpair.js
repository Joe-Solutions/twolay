// QR show / scan for WebRTC pairing. Uses BarcodeDetector when the browser has it, else jsQR.
import qrcode from '../vendor/qr/qrcode.mjs';

let jsQRp;
function loadJsQR() {
  jsQRp ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/qr/jsQR.js', import.meta.url).href;
    s.onload = () => res(window.jsQR);
    s.onerror = rej;
    document.head.append(s);
  });
  return jsQRp;
}

export function renderQR(el, text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/** Scan with the rear camera until a Twolay code is found. Returns { promise, cancel }. */
export function scanQR(video) {
  let stream;
  let stopped = false;
  const cancel = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const promise = (async () => {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();
    let detector = null;
    if ('BarcodeDetector' in window) {
      try {
        if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
      } catch {}
    }
    const jsQR = detector ? null : await loadJsQR();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    while (!stopped) {
      await new Promise((r) => setTimeout(r, 150));
      if (video.readyState < 2) continue;
      let text = null;
      if (detector) {
        const codes = await detector.detect(video);
        text = codes[0]?.rawValue ?? null;
      } else {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        text = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null;
      }
      if (text && /^T[01]/.test(text)) {
        cancel();
        return text;
      }
    }
    throw new Error('cancelled');
  })();
  return { promise, cancel };
}
