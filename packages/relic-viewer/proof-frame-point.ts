/**
 * Proof fixture serving HTML and Image relics in the Relic viewer to reproduce and verify
 * point-marking and region-dragging on framed and image documents.
 *
 * Runs two Bun.serve listeners:
 * - Service origin: http://localhost:8520
 * - Usercontent origin: http://127.0.0.1:8521
 *
 * Accepts RELIC_ROOT env var to serve another checkout (e.g. the fix worktree).
 * If run with `--measure`, it executes the full headless browser measurement suite and exits.
 */

import { globSync } from 'node:fs';
import { resolve } from 'node:path';

// Runtime-selected checkout path: allows pointing this harness at any relic worktree.
// Static imports cannot be used because RELIC_ROOT is determined at runtime via env var.
const RELIC_ROOT = process.env['RELIC_ROOT']
  ? resolve(process.env['RELIC_ROOT'])
  : resolve(new URL('../..', import.meta.url).pathname);

console.log(`[proof-frame-point] Using RELIC_ROOT: ${RELIC_ROOT}`);

// 1. Build viewer assets in RELIC_ROOT only if dist is missing
const distPath = `${RELIC_ROOT}/packages/relic-viewer/dist`;
const distExists =
  (await Bun.file(`${distPath}/viewer.js`).exists()) &&
  (await Bun.file(`${distPath}/sandbox.html`).exists());

if (!distExists) {
  console.log(
    `[proof-frame-point] Building viewer in ${RELIC_ROOT}/packages/relic-viewer ...`
  );
  const buildProc = Bun.spawnSync(['bun', 'run', 'build.ts'], {
    cwd: `${RELIC_ROOT}/packages/relic-viewer`,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (buildProc.exitCode !== 0) {
    console.error(
      `[proof-frame-point] Build failed with exit code ${buildProc.exitCode}`
    );
    process.exit(1);
  }
} else {
  console.log(
    `[proof-frame-point] dist already exists in ${distPath}, skipping rebuild.`
  );
}

// 2. Dynamically import modules from the selected RELIC_ROOT
const { encodeFragment, encryptRelic, generateKey, generateRelicId } =
  await import(`${RELIC_ROOT}/packages/relic-format/src/index.ts`);

const { createApp } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/app.ts`
);
const { diskAssets } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/assets.ts`
);
const { MemoryStorage, crc32cBase64 } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/storage.ts`
);
const { MemoryStore } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/store.ts`
);

const SERVICE_PORT = Number(process.env['PORT'] ?? 8520);
const USERCONTENT_PORT = Number(process.env['USERCONTENT_PORT'] ?? 8521);
const SERVICE = `http://localhost:${SERVICE_PORT}`;
const USERCONTENT = `http://127.0.0.1:${USERCONTENT_PORT}`;

const storage = new MemoryStorage(SERVICE);
const store = new MemoryStore();
const objects = new Map<string, Uint8Array>();

const app = createApp({
  config: {
    serviceOrigin: SERVICE,
    usercontentOrigin: USERCONTENT,
    killSwitchEngaged: false,
  },
  storage,
  store,
  assets: diskAssets(`${RELIC_ROOT}/packages/relic-viewer/dist/`),
  operatorTokens: new Map<string, string>(),
});

function serve(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith('/o/')) {
    const id = (path.slice(3).split('?')[0] ?? '').replace(/\/$/, '');
    const bytes = objects.get(id);
    if (bytes === undefined) return new Response('no object', { status: 404 });
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        'content-type': 'application/octet-stream',
        'access-control-allow-origin': '*',
      },
    });
  }
  return app.fetch(request);
}

const s1 = Bun.serve({ port: SERVICE_PORT, fetch: serve });
const s2 = Bun.serve({ port: USERCONTENT_PORT, fetch: serve });

// 3. Read and seed the reported HTML document at runtime
// Any long HTML document; the reported case was about 1088 x 9583 px of scroll.
const htmlPath = process.env['HTML_PATH'];
if (htmlPath === undefined) {
  console.error('[proof-frame-point] Set HTML_PATH to a long HTML document');
  process.exit(1);
}

const htmlFile = Bun.file(htmlPath);
if (!(await htmlFile.exists())) {
  console.error(`[proof-frame-point] Document not found: ${htmlPath}`);
  process.exit(1);
}
const htmlBytes = new Uint8Array(await htmlFile.arrayBuffer());

const htmlRelicId = generateRelicId();
const htmlKey = generateKey();
const htmlContainer = await encryptRelic({
  content: htmlBytes,
  filename: 'dist.html',
  mimetype: 'text/html',
  key: htmlKey,
});

storage.put(htmlRelicId, htmlContainer);
objects.set(htmlRelicId, htmlContainer);

await store.putRelic({
  id: htmlRelicId,
  publishIp: '127.0.0.1',
  grantedAt: Date.now(),
  expiresAt: undefined,
  rendererClass: 'html',
  publishingClient: 'proof/0.1.0',
  declaredSizeBytes: htmlBytes.length,
  version: 1,
  publishTokenHash: 'proof',
  mintsUsed: 0,
  title: 'Long HTML document',
});

const htmlCrc = crc32cBase64(htmlContainer);
await store.markPublished(
  htmlRelicId,
  Date.now(),
  htmlContainer.length,
  htmlCrc
);

const htmlViewerUrl = `${SERVICE}/${htmlRelicId}#${encodeFragment(htmlKey)}`;
await Bun.write('/tmp/relic-frame-point-url.txt', htmlViewerUrl);

// 4. Ensure tall test image exists and seed it as an image relic
const imagePath = process.env['IMAGE_PATH'] ?? '/tmp/tall-test.png';
if (!(await Bun.file(imagePath).exists())) {
  Bun.spawnSync([
    'magick',
    '-size',
    '1200x9000',
    'xc:white',
    '-fill',
    '#3498db',
    '-draw',
    'rectangle 0,1000 1200,1200 rectangle 0,3000 1200,3200 rectangle 0,5000 1200,5200 rectangle 0,7000 1200,7200',
    imagePath,
  ]);
}

const imageFile = Bun.file(imagePath);
const imageBytes = new Uint8Array(await imageFile.arrayBuffer());
const imageRelicId = generateRelicId();
const imageKey = generateKey();
const imageContainer = await encryptRelic({
  content: imageBytes,
  filename: 'tall-test.png',
  mimetype: 'image/png',
  key: imageKey,
});

storage.put(imageRelicId, imageContainer);
objects.set(imageRelicId, imageContainer);

await store.putRelic({
  id: imageRelicId,
  publishIp: '127.0.0.1',
  grantedAt: Date.now(),
  expiresAt: undefined,
  rendererClass: 'image',
  publishingClient: 'proof/0.1.0',
  declaredSizeBytes: imageBytes.length,
  version: 1,
  publishTokenHash: 'proof',
  mintsUsed: 0,
  title: 'Tall Test Image',
});

const imageCrc = crc32cBase64(imageContainer);
await store.markPublished(
  imageRelicId,
  Date.now(),
  imageContainer.length,
  imageCrc
);
const imageViewerUrl = `${SERVICE}/${imageRelicId}#${encodeFragment(imageKey)}`;

console.log(`VIEWER_HTML_URL=${htmlViewerUrl}`);
console.log(`VIEWER_IMAGE_URL=${imageViewerUrl}`);
console.log(`READY ports: service=${s1.port} usercontent=${s2.port}`);

if (process.argv.includes('--measure')) {
  const isUnfixed =
    process.argv.includes('--unfixed') ||
    !RELIC_ROOT.includes('relic-point-region');
  const results = await runFullMeasurementSuite(htmlViewerUrl, imageViewerUrl, {
    isUnfixed,
  });
  console.log('[measure] ALL RESULTS:\n', JSON.stringify(results, null, 2));
  await s1.stop();
  await s2.stop();
  process.exit(0);
}

export async function runFullMeasurementSuite(
  htmlUrl: string,
  imageUrl: string,
  options: { isUnfixed?: boolean } = {}
) {
  console.log(
    `[measure] Launching headless browser against test URLs (isUnfixed: ${options.isUnfixed}) ...`
  );

  let chromium: typeof import('playwright').chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    const matches = globSync(
      `${process.env.HOME}/.bun/install/cache/playwright@*/index.mjs`
    );
    if (matches.length === 0) {
      throw new Error('Playwright not found in node_modules or bun cache');
    }
    const pw = await import(matches[0]);
    chromium = pw.chromium;
  }

  const [shellPath] = globSync(
    `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`
  );

  const browser = await chromium.launch({
    executablePath: shellPath,
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // Disable caching
    const client = await context.newCDPSession(page);
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });

    // =========================================================================
    // PART 1: HTML RELIC (CLICK AND DRAG)
    // =========================================================================
    console.log(`[measure] Navigating to HTML relic: ${htmlUrl} ...`);
    await page.goto(htmlUrl, { waitUntil: 'networkidle' });

    const iframeElement = await page.waitForSelector(
      'iframe.usercontent-frame',
      { timeout: 10000 }
    );
    const subframe = await iframeElement.contentFrame();
    if (!subframe) throw new Error('Could not access subframe');

    await subframe.waitForFunction(
      () => {
        return Array.from(document.querySelectorAll('p')).some((p) =>
          p.textContent?.includes('A guest arrives')
        );
      },
      { timeout: 10000 }
    );

    const isOpen = await page.$eval('.thread', (el) =>
      el.classList.contains('is-open')
    );
    if (!isOpen) {
      await page.click('button.action-comments, button.thread-tab');
      await page.waitForSelector('.thread.is-open', { timeout: 5000 });
    }

    // 1A. Click measurement
    console.log(
      '[measure] Phase 1A: Arming and clicking point on HTML relic ...'
    );
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button.mark-mode');
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      },
      { timeout: 5000 }
    );
    await page.click('button.mark-mode');

    await subframe.waitForFunction(
      () => {
        return document.documentElement.classList.contains(
          'relic-pointing-active'
        );
      },
      { timeout: 5000 }
    );

    const arrivesInfo = await subframe.evaluate(() => {
      const p = Array.from(document.querySelectorAll('p')).find((el) =>
        el.textContent?.includes('A guest arrives')
      );
      if (!p) return null;
      p.scrollIntoView({ block: 'center' });

      let targetRange: Range | null = null;
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const idx = node.textContent?.indexOf('arrives') ?? -1;
        if (idx !== -1) {
          const r = document.createRange();
          r.setStart(node, idx);
          r.setEnd(node, idx + 'arrives'.length);
          targetRange = r;
          break;
        }
      }
      const rect = targetRange
        ? targetRange.getBoundingClientRect()
        : p.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });

    if (!arrivesInfo)
      throw new Error('Target text "arrives" not found in subframe');

    let iframeBox = await iframeElement.boundingBox();
    if (!iframeBox) throw new Error('Could not get iframe bounding box');

    const clickX = iframeBox.x + arrivesInfo.left + arrivesInfo.width / 2;
    const clickY = iframeBox.y + arrivesInfo.top + arrivesInfo.height / 2;

    await page.mouse.click(clickX, clickY);

    await subframe.waitForSelector(
      '#relic-frame-overlay [data-comment-id="pending:target"]',
      {
        timeout: 5000,
      }
    );

    const clickMetrics = await subframe.evaluate(() => {
      const mark = document.querySelector(
        '#relic-frame-overlay [data-comment-id="pending:target"]'
      ) as HTMLElement | null;
      if (!mark) return null;
      const b = mark.getBoundingClientRect();
      const docWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0
      );
      const docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0
      );

      return {
        tagName: mark.tagName,
        className: mark.className,
        commentId: mark.dataset.commentId,
        style: {
          left: mark.style.left,
          top: mark.style.top,
          width: mark.style.width,
          height: mark.style.height,
        },
        boundingBoxPx: {
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
        },
        scrollWidth: docWidth,
        scrollHeight: docHeight,
      };
    });

    const clickChipText = await page.$eval('.compose-target-label', (el) =>
      el.textContent?.trim()
    );
    const clickScreenshotPath = options.isUnfixed
      ? '/tmp/relic-frame-point-before.png'
      : '/tmp/relic-int-click.png';
    await page.screenshot({ path: clickScreenshotPath, fullPage: false });
    console.log(`[measure] Click screenshot saved to ${clickScreenshotPath}`);

    // 1B. One-line drag measurement on HTML relic
    console.log(
      '[measure] Phase 1B: Clearing target and testing drag on HTML relic ...'
    );
    await page.click('button.compose-target-clear');
    await subframe.waitForFunction(
      () => {
        return (
          document.querySelector(
            '#relic-frame-overlay [data-comment-id="pending:target"]'
          ) === null
        );
      },
      { timeout: 5000 }
    );

    await page.click('button.mark-mode');
    await subframe.waitForFunction(
      () => {
        return document.documentElement.classList.contains(
          'relic-pointing-active'
        );
      },
      { timeout: 5000 }
    );

    const dragTextPositions = await subframe.evaluate(() => {
      const p = Array.from(document.querySelectorAll('p')).find((el) =>
        el.textContent?.includes('A guest arrives')
      );
      if (!p) return null;
      p.scrollIntoView({ block: 'center' });

      function getRangeRect(searchStr: string, atEnd = false) {
        const walker = document.createTreeWalker(p!, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const idx = node.textContent?.indexOf(searchStr) ?? -1;
          if (idx !== -1) {
            const r = document.createRange();
            if (atEnd) {
              r.setStart(node, idx + searchStr.length - 1);
              r.setEnd(node, idx + searchStr.length);
            } else {
              r.setStart(node, idx);
              r.setEnd(node, idx + 1);
            }
            return r.getBoundingClientRect();
          }
        }
        return null;
      }

      const isReadyRect = getRangeRect('is ready', false);
      const welcomingRect = getRangeRect('welcoming', true);

      return {
        start: isReadyRect
          ? {
              left: isReadyRect.left,
              top: isReadyRect.top,
              height: isReadyRect.height,
            }
          : null,
        end: welcomingRect
          ? {
              right: welcomingRect.right,
              top: welcomingRect.top,
              height: welcomingRect.height,
            }
          : null,
      };
    });

    if (!dragTextPositions?.start || !dragTextPositions?.end) {
      throw new Error(
        'Could not find drag boundary text ("is ready" or "welcoming")'
      );
    }

    iframeBox = await iframeElement.boundingBox();
    if (!iframeBox)
      throw new Error('Could not get iframe bounding box for drag');

    const dragStartX = iframeBox.x + dragTextPositions.start.left;
    const dragStartY =
      iframeBox.y +
      dragTextPositions.start.top +
      dragTextPositions.start.height / 2;
    const dragEndX = iframeBox.x + dragTextPositions.end.right;
    const dragEndY =
      iframeBox.y +
      dragTextPositions.end.top +
      dragTextPositions.end.height / 2;

    await page.mouse.move(dragStartX, dragStartY);
    await page.mouse.down();

    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const stepX = dragStartX + (dragEndX - dragStartX) * (i / steps);
      const stepY = dragStartY + (dragEndY - dragStartY) * (i / steps);
      await page.mouse.move(stepX, stepY);
      await Bun.sleep(60);
    }

    const htmlMidDragInfo = await subframe.evaluate(() => {
      const drawing = document.querySelector(
        '.relic-region-mark.is-drawing'
      ) as HTMLElement | null;
      if (!drawing)
        return { exists: false, box: null, className: null, style: null };
      const b = drawing.getBoundingClientRect();
      return {
        exists: true,
        className: drawing.className,
        box: { x: b.x, y: b.y, width: b.width, height: b.height },
        style: {
          left: drawing.style.left,
          top: drawing.style.top,
          width: drawing.style.width,
          height: drawing.style.height,
        },
      };
    });

    const midScreenshotPath = options.isUnfixed
      ? '/tmp/relic-frame-drag-unfixed-mid.png'
      : '/tmp/relic-frame-drag-mid.png';
    await page.screenshot({ path: midScreenshotPath, fullPage: false });

    await page.mouse.up();

    await subframe.waitForSelector(
      '#relic-frame-overlay [data-comment-id="pending:target"]',
      {
        timeout: 5000,
      }
    );

    const htmlPostDragMetrics = await subframe.evaluate(() => {
      const mark = document.querySelector(
        '#relic-frame-overlay [data-comment-id="pending:target"]'
      ) as HTMLElement | null;
      const b = mark ? mark.getBoundingClientRect() : null;
      const docWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0
      );
      const docHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0
      );
      const selectionText = window.getSelection()?.toString() ?? '';

      return {
        className: mark?.className ?? null,
        boundingBoxPx: b
          ? { x: b.x, y: b.y, width: b.width, height: b.height }
          : null,
        style: mark
          ? {
              left: mark.style.left,
              top: mark.style.top,
              width: mark.style.width,
              height: mark.style.height,
            }
          : null,
        scrollWidth: docWidth,
        scrollHeight: docHeight,
        selectionText,
      };
    });

    const htmlDragChipText = await page.$eval('.compose-target-label', (el) =>
      el.textContent?.trim()
    );
    const afterScreenshotPath = options.isUnfixed
      ? '/tmp/relic-frame-drag-unfixed-after.png'
      : '/tmp/relic-int-drag.png';
    await page.screenshot({ path: afterScreenshotPath, fullPage: false });
    console.log(
      `[measure] HTML drag after screenshot saved to ${afterScreenshotPath}`
    );

    // =========================================================================
    // PART 2: IMAGE RELIC (DRAG MEASUREMENT)
    // =========================================================================
    console.log(`[measure] Navigating to Image relic: ${imageUrl} ...`);
    await page.goto(imageUrl, { waitUntil: 'networkidle' });

    // Wait for img.relic-image
    const imgElement = await page.waitForSelector('img.relic-image', {
      timeout: 10000,
    });

    // Wait for image load
    await page.waitForFunction(
      () => {
        const img = document.querySelector(
          'img.relic-image'
        ) as HTMLImageElement | null;
        return img && img.complete && img.naturalHeight > 0;
      },
      { timeout: 10000 }
    );

    const imgRenderedBox = await page.$eval('img.relic-image', (img) => {
      const r = img.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        naturalWidth: (img as HTMLImageElement).naturalWidth,
        naturalHeight: (img as HTMLImageElement).naturalHeight,
      };
    });
    console.log('[measure] Rendered image dimensions:', imgRenderedBox);

    // Open comments sidebar if not already open
    const isImageThreadOpen = await page.$eval('.thread', (el) =>
      el.classList.contains('is-open')
    );
    if (!isImageThreadOpen) {
      await page.click('button.action-comments, button.thread-tab');
      await page.waitForSelector('.thread.is-open', { timeout: 5000 });
    }

    // Arm pointing
    console.log('[measure] Arming Point at something on Image relic ...');
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button.mark-mode');
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      },
      { timeout: 5000 }
    );
    await page.click('button.mark-mode');

    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button.mark-mode');
        return btn && btn.getAttribute('aria-pressed') === 'true';
      },
      { timeout: 5000 }
    );

    // Drag coordinates on image in client pixels:
    // width ~150 px, height ~12 px (well below old 0.5% threshold: 0.005 * 8000+ = >40px)
    const imgFreshBox = await page.$eval('img.relic-image', (img) => {
      const r = img.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });

    const imgDragStartX = imgFreshBox.x + 100;
    const imgDragStartY = Math.max(imgFreshBox.y + 100, 150);
    const imgDragEndX = imgDragStartX + 150;
    const imgDragEndY = imgDragStartY + 12;

    console.log(
      `[measure] Dragging on image from (${imgDragStartX}, ${imgDragStartY}) to (${imgDragEndX}, ${imgDragEndY}) ...`
    );

    await page.mouse.move(imgDragStartX, imgDragStartY);
    await page.mouse.down();

    for (let i = 1; i <= steps; i++) {
      const stepX = imgDragStartX + (imgDragEndX - imgDragStartX) * (i / steps);
      const stepY = imgDragStartY + (imgDragEndY - imgDragStartY) * (i / steps);
      await page.mouse.move(stepX, stepY);
      await Bun.sleep(60);
    }

    // Mid-drag observation on image
    const imgMidDragInfo = await page.evaluate(() => {
      const drawing = document.querySelector(
        '.comment-region.is-drawing'
      ) as HTMLElement | null;
      if (!drawing)
        return { exists: false, box: null, className: null, style: null };
      const b = drawing.getBoundingClientRect();
      return {
        exists: true,
        className: drawing.className,
        box: { x: b.x, y: b.y, width: b.width, height: b.height },
        style: {
          left: drawing.style.left,
          top: drawing.style.top,
          width: drawing.style.width,
          height: drawing.style.height,
        },
      };
    });

    // Complete drag
    await page.mouse.up();
    await Bun.sleep(200);

    // Post-drag observation on image
    const imgPostDragMetrics = await page.evaluate(() => {
      const mark = document.querySelector(
        '[data-comment-id="pending:target"]'
      ) as HTMLElement | null;
      const b = mark ? mark.getBoundingClientRect() : null;
      return {
        exists: mark !== null,
        className: mark?.className ?? null,
        boundingBoxPx: b
          ? { x: b.x, y: b.y, width: b.width, height: b.height }
          : null,
        style: mark
          ? {
              left: mark.style.left,
              top: mark.style.top,
              width: mark.style.width,
              height: mark.style.height,
            }
          : null,
      };
    });

    const imgChipText = await page.$eval('.compose-target-label', (el) =>
      el.textContent?.trim()
    );
    const imageScreenshotPath = options.isUnfixed
      ? '/tmp/relic-unfixed-image-drag.png'
      : '/tmp/relic-int-image-drag.png';
    await page.screenshot({ path: imageScreenshotPath, fullPage: false });
    console.log(
      `[measure] Image drag screenshot saved to ${imageScreenshotPath}`
    );

    return {
      mode: options.isUnfixed ? 'unfixed' : 'fixed-integrated',
      htmlRelic: {
        click: {
          clickCoords: { x: clickX, y: clickY },
          metrics: clickMetrics,
          chipText: clickChipText,
          screenshot: clickScreenshotPath,
        },
        drag: {
          dragCoords: {
            start: { x: dragStartX, y: dragStartY },
            end: { x: dragEndX, y: dragEndY },
          },
          midDrag: htmlMidDragInfo,
          postDrag: htmlPostDragMetrics,
          chipText: htmlDragChipText,
          screenshots: {
            mid: midScreenshotPath,
            after: afterScreenshotPath,
          },
        },
      },
      imageRelic: {
        renderedBox: imgRenderedBox,
        dragCoords: {
          start: { x: imgDragStartX, y: imgDragStartY },
          end: { x: imgDragEndX, y: imgDragEndY },
          widthPx: 150,
          heightPx: 12,
        },
        midDrag: imgMidDragInfo,
        postDrag: imgPostDragMetrics,
        chipText: imgChipText,
        screenshot: imageScreenshotPath,
      },
    };
  } finally {
    await browser.close();
  }
}
