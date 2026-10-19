/* Boardbook PDF Exporter - popup.js */

const statusEl  = document.getElementById('status');
const progressW = document.getElementById('progress-wrap');
const progressB = document.getElementById('progress-bar');
const exportBtn = document.getElementById('export-btn');
const bookInfo  = document.getElementById('book-info');
const bookNameE = document.getElementById('book-name');
const bookPagesE= document.getElementById('book-pages');

let bookData = null; // { baseUrl, totalPages, bookName }

/* ── helpers ─────────────────────────────────────────── */

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || '';
}

function setProgress(pct) {
  progressW.style.display = 'block';
  progressB.style.width = pct + '%';
}

/* ── detect book from the active tab ─────────────────── */

async function detectBook() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('boardbooks.vanin.be')) {
    setStatus('Open a boardbook on boardbooks.vanin.be first.', 'error');
    return;
  }

  // Inject a small script to extract info from the page's iframe
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Find iframe with the book content
      const frames = document.querySelectorAll('iframe');
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument || frame.contentWindow.document;
          if (!doc) continue;
          const imgs = doc.querySelectorAll('img.realImage, img[class*="realImage"]');
          if (imgs.length === 0) continue;

          // Extract the base URL pattern from the first image src
          // Pattern: .../Resources/BOOKNAME.pdf_/NUMBER.png
          const src = imgs[0].src;
          const match = src.match(/^(.*\/Resources\/[^/]+\.pdf_\/)\d+\.png$/);
          if (!match) continue;
          const baseUrl = match[1];

          // Extract book name from URL path
          const pathMatch = src.match(/\/([^/]+)\/Resources\//);
          const bookName = pathMatch ? pathMatch[1].replace(/_/g, ' ') : 'Boardbook';

          // Get total pages from the page indicator ("X van Y")
          let totalPages = 0;
          const allText = doc.body ? doc.body.innerText : '';
          const vanMatch = allText.match(/van\s+(\d+)/);
          if (vanMatch) {
            totalPages = parseInt(vanMatch[1]);
          }

          // Also check the parent document
          if (!totalPages) {
            const parentText = document.body.innerText;
            const vanMatch2 = parentText.match(/van\s+(\d+)/);
            if (vanMatch2) totalPages = parseInt(vanMatch2[1]);
          }

          return { baseUrl, totalPages, bookName };
        } catch (e) {
          // cross-origin frame, skip
        }
      }

      // Fallback: check main document images too
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const match = img.src.match(/^(.*\/Resources\/[^/]+\.pdf_\/)\d+\.png$/);
        if (match) {
          const pathMatch = img.src.match(/\/([^/]+)\/Resources\//);
          const bookName = pathMatch ? pathMatch[1].replace(/_/g, ' ') : 'Boardbook';
          return { baseUrl: match[1], totalPages: 0, bookName };
        }
      }

      return null;
    }
  });

  const data = results && results[0] && results[0].result;
  if (!data || !data.baseUrl) {
    setStatus('Could not detect a boardbook on this page.', 'error');
    return;
  }

  bookData = data;

  // If we couldn't detect total pages, probe for it
  if (!bookData.totalPages || bookData.totalPages < 1) {
    setStatus('Detecting page count...');
    bookData.totalPages = await probePageCount(bookData.baseUrl);
  }

  // Show book info
  bookNameE.textContent = bookData.bookName;
  bookPagesE.textContent = bookData.totalPages + ' pages';
  bookInfo.style.display = 'block';

  setStatus('Ready to export!', 'success');
  exportBtn.disabled = false;
}

/* probe total pages by binary search */
async function probePageCount(baseUrl) {
  // Start broad, narrow down
  let lo = 1, hi = 500;

  // Quick check: does page 1 exist?
  const r1 = await fetch(baseUrl + '1.png', { method: 'HEAD' });
  if (!r1.ok) return 0;

  // Find upper bound
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await fetch(baseUrl + mid + '.png', { method: 'HEAD' });
    if (r.ok) lo = mid;
    else hi = mid;
  }
  return lo;
}

/* ── export to PDF ───────────────────────────────────── */

async function exportPDF() {
  if (!bookData) return;

  exportBtn.disabled = true;
  setStatus('Starting export...');
  setProgress(0);

  const { PDFDocument } = PDFLib;
  const pdfDoc = await PDFDocument.create();

  const total = bookData.totalPages;
  let done = 0;
  let skipped = [];

  // Download in batches of 10 for speed
  const BATCH = 10;

  for (let batchStart = 1; batchStart <= total; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH - 1, total);
    const promises = [];

    for (let i = batchStart; i <= batchEnd; i++) {
      promises.push(
        fetch(bookData.baseUrl + i + '.png')
          .then(async (res) => {
            if (!res.ok) return { page: i, data: null };
            const buf = await res.arrayBuffer();
            // Verify it's actually a PNG (starts with \x89PNG)
            const header = new Uint8Array(buf.slice(0, 4));
            if (header[0] !== 0x89 || header[1] !== 0x50) {
              return { page: i, data: null };
            }
            return { page: i, data: buf };
          })
          .catch(() => ({ page: i, data: null }))
      );
    }

    const results = await Promise.all(promises);

    // Sort by page number and add to PDF in order
    results.sort((a, b) => a.page - b.page);

    for (const r of results) {
      if (!r.data) {
        skipped.push(r.page);
        done++;
        continue;
      }

      try {
        const img = await pdfDoc.embedPng(new Uint8Array(r.data));
        // A4 dimensions in points: 595.28 x 841.89
        const page = pdfDoc.addPage([595.28, 841.89]);
        const { width: pw, height: ph } = page.getSize();

        // Scale image to fit page
        const scale = Math.min(pw / img.width, ph / img.height);
        const w = img.width * scale;
        const h = img.height * scale;

        page.drawImage(img, {
          x: (pw - w) / 2,
          y: (ph - h) / 2,
          width: w,
          height: h,
        });
      } catch (e) {
        skipped.push(r.page);
      }

      done++;
    }

    const pct = Math.round((done / total) * 100);
    setProgress(pct);
    setStatus(`Downloading pages... ${done}/${total}`);
  }

  setStatus('Generating PDF file...');

  const pdfBytes = await pdfDoc.save();

  // Trigger download
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bookData.bookName.replace(/[^a-zA-Z0-9_\- ]/g, '') + '.pdf';
  a.click();
  URL.revokeObjectURL(url);

  const sizeMB = (pdfBytes.length / (1024 * 1024)).toFixed(1);
  let msg = `Done! ${done - skipped.length} pages exported (${sizeMB} MB).`;
  if (skipped.length > 0) {
    msg += ` Skipped ${skipped.length} missing page(s): ${skipped.join(', ')}`;
  }
  setStatus(msg, 'success');
  setProgress(100);
  exportBtn.disabled = false;
  exportBtn.textContent = 'Export again';
}

/* ── init ────────────────────────────────────────────── */

exportBtn.addEventListener('click', exportPDF);
detectBook();
