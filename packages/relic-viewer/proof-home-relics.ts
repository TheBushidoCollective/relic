/**
 * Proof fixture serving the landing page and assets from relic-home-list
 * to verify client-side localStorage relic listing (#home-relics and home.js).
 *
 * Runs a Bun server with createApp and diskAssets.
 * Accepts RELIC_ROOT env var to point at any checkout.
 * If run with `--measure`, it executes the full headless browser measurement suite and exits.
 */

import { globSync } from 'node:fs';
import { resolve } from 'node:path';

// Runtime-selected checkout path: allows pointing this harness at any relic worktree.
// Static imports cannot be used because RELIC_ROOT is determined at runtime via env var.
const rootEnv = process.env['RELIC_ROOT'];
if (rootEnv === undefined) {
  console.error('[proof-home-relics] Set RELIC_ROOT to a relic checkout');
  process.exit(1);
}
const RELIC_ROOT = resolve(rootEnv);

console.log(`[proof-home-relics] Using RELIC_ROOT: ${RELIC_ROOT}`);

// 1. Build viewer assets in RELIC_ROOT only if dist is missing
const distPath = `${RELIC_ROOT}/packages/relic-viewer/dist`;
const distExists =
  (await Bun.file(`${distPath}/viewer.js`).exists()) &&
  (await Bun.file(`${distPath}/home.js`).exists());

if (!distExists) {
  console.log(
    `[proof-home-relics] Building viewer in ${RELIC_ROOT}/packages/relic-viewer ...`
  );
  const buildProc = Bun.spawnSync(['bun', 'run', 'build.ts'], {
    cwd: `${RELIC_ROOT}/packages/relic-viewer`,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (buildProc.exitCode !== 0) {
    console.error(
      `[proof-home-relics] Build failed with exit code ${buildProc.exitCode}`
    );
    process.exit(1);
  }
} else {
  console.log(
    `[proof-home-relics] dist already exists in ${distPath}, skipping rebuild.`
  );
}

// 2. Dynamically import server modules from the selected RELIC_ROOT
const { createApp } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/app.ts`
);
const { diskAssets } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/assets.ts`
);
const { MemoryStorage } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/storage.ts`
);
const { MemoryStore } = await import(
  `${RELIC_ROOT}/packages/relic-server/src/store.ts`
);

const SERVICE_PORT = Number(process.env['PORT'] ?? 8530);
const USERCONTENT_PORT = Number(process.env['USERCONTENT_PORT'] ?? 8531);
const SERVICE = `http://localhost:${SERVICE_PORT}`;
const USERCONTENT = `http://127.0.0.1:${USERCONTENT_PORT}`;

const storage = new MemoryStorage(SERVICE);
const store = new MemoryStore();

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

const s1 = Bun.serve({
  port: SERVICE_PORT,
  fetch: (req) => app.fetch(req),
});

console.log(`HOME_URL=${SERVICE}/`);
console.log(`INSTALL_URL=${SERVICE}/install`);
console.log(`READY port: service=${s1.port}`);

if (process.argv.includes('--measure')) {
  const results = await runHomeMeasurementSuite(SERVICE);
  console.log('[measure] ALL RESULTS:\n', JSON.stringify(results, null, 2));
  await s1.stop();
  process.exit(0);
}

export async function runHomeMeasurementSuite(serviceOrigin: string) {
  console.log(
    `[measure] Launching headless browser against ${serviceOrigin} ...`
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
    // -------------------------------------------------------------------------
    // STEP 1: Empty storage on / at 1440x900
    // -------------------------------------------------------------------------
    console.log('[measure] Step 1: Empty storage on / ...');
    const emptyContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const emptyPage = await emptyContext.newPage();
    const cdpEmpty = await emptyContext.newCDPSession(emptyPage);
    await cdpEmpty.send('Network.setCacheDisabled', { cacheDisabled: true });

    await emptyPage.goto(`${serviceOrigin}/`, { waitUntil: 'networkidle' });

    const step1Metrics = await emptyPage.evaluate(() => {
      const section = document.getElementById('home-relics');
      if (!section) return { found: false };
      const style = window.getComputedStyle(section);
      return {
        found: true,
        hasHiddenAttribute: section.hasAttribute('hidden'),
        computedDisplay: style.display,
        childElementCount: section.childElementCount,
      };
    });

    const step1Screenshot = '/tmp/home-empty-1440.png';
    await emptyPage.screenshot({ path: step1Screenshot, fullPage: false });
    console.log(`[measure] Step 1 screenshot saved to ${step1Screenshot}`);
    await emptyContext.close();

    // -------------------------------------------------------------------------
    // STEP 2 & 3: Seeded storage on / at 1440x900, 390x844, and Dark mode
    // -------------------------------------------------------------------------
    console.log('[measure] Step 2 & 3: Seeded storage on / ...');
    const now = Date.now();

    // 4 seed entries as requested
    const entries = [
      {
        relicId: 'q3boardmemo00000000000000a',
        title: 'Q3 board memo',
        renderer: 'markdown',
        lastOpenedAt: now - 3600 * 1000, // 1h ago
        fragment: 'r1AAAA',
        expiresAt: null,
      },
      {
        relicId: 'pricingmodelv200000000000b',
        title: 'Pricing model v2',
        renderer: 'sandboxed-html',
        lastOpenedAt: now - 300 * 1000, // 5m ago
        fragment: '#r1BBBB', // leading #
        expiresAt: null,
      },
      {
        relicId: 'notitleimage0000000000000c',
        renderer: 'image',
        fragment: 'r1CCCC',
        expiresAt: null,
      },
      {
        relicId: 'longtitlepdf0000000000000d',
        title:
          'Executive Summary and Comprehensive Analysis of Q4 Strategic Goals, Capital Allocation, Resource Constraints, and Operational Performance Benchmarks', // 140 chars
        renderer: 'pdf',
        lastOpenedAt: now - 2 * 86400 * 1000, // 2d ago
        fragment: 'r1DDDD',
        expiresAt: null,
      },
    ];

    const context1440 = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page1440 = await context1440.newPage();
    const cdp1440 = await context1440.newCDPSession(page1440);
    await cdp1440.send('Network.setCacheDisabled', { cacheDisabled: true });

    // Track console messages, page errors, CSP violations, and network requests
    const consoleMessages: string[] = [];
    const cspViolations: unknown[] = [];
    const requestsAfterDOMContentLoaded: string[] = [];
    let domContentLoaded = false;

    page1440.on('console', (msg) =>
      consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
    );
    page1440.on('pageerror', (err) =>
      consoleMessages.push(`[pageerror] ${err.message}`)
    );
    page1440.on('domcontentloaded', () => {
      domContentLoaded = true;
    });
    page1440.on('request', (req) => {
      if (domContentLoaded) {
        requestsAfterDOMContentLoaded.push(`${req.method()} ${req.url()}`);
      }
    });

    // Add CSP violation listener before navigation
    await page1440.addInitScript(() => {
      const g = window as unknown as Record<string, unknown>;
      if (!Array.isArray(g['__cspViolations'])) {
        g['__cspViolations'] = [];
      }
      window.addEventListener('securitypolicyviolation', (e) => {
        const list = g['__cspViolations'];
        if (Array.isArray(list)) {
          list.push({
            violatedDirective: e.violatedDirective,
            blockedURI: e.blockedURI,
            originalPolicy: e.originalPolicy,
          });
        }
      });
    });

    // Navigate once to set origin localStorage
    await page1440.goto(`${serviceOrigin}/`, { waitUntil: 'networkidle' });

    // Seed localStorage
    await page1440.evaluate((items) => {
      for (const item of items) {
        localStorage.setItem(`relic:key:${item.relicId}`, JSON.stringify(item));
      }
    }, entries);
    // Reset network request tracking specifically for step 2 reload on /
    requestsAfterDOMContentLoaded.length = 0;
    domContentLoaded = false;

    // Reload page to let home.js render
    await page1440.reload({ waitUntil: 'networkidle' });
    const step2RequestsAfterDOMContentLoaded = [
      ...requestsAfterDOMContentLoaded,
    ];

    // Collect CSP violations from page
    const pageCsp = await page1440.evaluate(() => {
      const g = window as unknown as Record<string, unknown>;
      const list = g['__cspViolations'];
      return Array.isArray(list) ? list : [];
    });
    cspViolations.push(...pageCsp);

    // Measure rows and layout at 1440
    const step2Metrics1440 = await page1440.evaluate(() => {
      const section = document.getElementById('home-relics');
      if (!section) return { found: false };

      const lede = document.querySelector('p.lede');
      const h2s = Array.from(document.querySelectorAll('h2'));
      const howItGoesH2 = h2s.find((h) =>
        h.textContent?.includes('How it goes')
      );

      const sectionRect = section.getBoundingClientRect();
      const ledeRect = lede?.getBoundingClientRect();
      const h2Rect = howItGoesH2?.getBoundingClientRect();

      const items = Array.from(section.querySelectorAll('li.home-relic'));
      const rows = items.map((li) => {
        const kindEl = li.querySelector('.home-relic-kind');
        const linkEl = li.querySelector(
          'a.home-relic-link'
        ) as HTMLAnchorElement | null;
        const linkRect = linkEl?.getBoundingClientRect();
        return {
          kindText: kindEl?.textContent?.trim() ?? '',
          linkText: linkEl?.textContent?.trim() ?? '',
          href: linkEl?.getAttribute('href') ?? '',
          isClipped: linkEl ? linkEl.scrollWidth > linkEl.clientWidth : false,
          scrollWidth: linkEl?.scrollWidth ?? 0,
          clientWidth: linkEl?.clientWidth ?? 0,
          rowHeight: linkRect?.height ?? 0,
        };
      });

      return {
        found: true,
        hasHiddenAttribute: section.hasAttribute('hidden'),
        computedDisplay: window.getComputedStyle(section).display,
        positionCheck: {
          sectionTop: sectionRect.top,
          ledeBottom: ledeRect?.bottom ?? null,
          howItGoesTop: h2Rect?.top ?? null,
          isBelowLede: ledeRect ? sectionRect.top >= ledeRect.bottom : false,
          isAboveHowItGoes: h2Rect ? sectionRect.bottom <= h2Rect.top : false,
        },
        rows,
      };
    });

    const step2Screenshot1440 = '/tmp/home-list-1440.png';
    await page1440.screenshot({ path: step2Screenshot1440, fullPage: false });
    console.log(
      `[measure] Step 2 1440 screenshot saved to ${step2Screenshot1440}`
    );

    // Dark mode screenshot at 1440
    await page1440.emulateMedia({ colorScheme: 'dark' });
    const step2ScreenshotDark = '/tmp/home-list-dark.png';
    await page1440.screenshot({ path: step2ScreenshotDark, fullPage: false });
    console.log(
      `[measure] Step 2 Dark mode screenshot saved to ${step2ScreenshotDark}`
    );

    // Mobile 390x844 screenshot
    const context390 = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page390 = await context390.newPage();
    const cdp390 = await context390.newCDPSession(page390);
    await cdp390.send('Network.setCacheDisabled', { cacheDisabled: true });

    // Seed localStorage on 390 context
    await page390.goto(`${serviceOrigin}/`, { waitUntil: 'networkidle' });
    await page390.evaluate((items) => {
      for (const item of items) {
        localStorage.setItem(`relic:key:${item.relicId}`, JSON.stringify(item));
      }
    }, entries);
    await page390.reload({ waitUntil: 'networkidle' });

    const step2Screenshot390 = '/tmp/home-list-390.png';
    await page390.screenshot({ path: step2Screenshot390, fullPage: false });
    console.log(
      `[measure] Step 2 390 screenshot saved to ${step2Screenshot390}`
    );
    await context390.close();

    // -------------------------------------------------------------------------
    // STEP 4: Click the first row's link
    // -------------------------------------------------------------------------
    console.log('[measure] Step 4: Click first row link ...');
    // Switch back to light mode on page1440
    await page1440.emulateMedia({ colorScheme: 'light' });

    let initialNavigatedUrl = '';
    page1440.on('framenavigated', (frame) => {
      if (
        frame === page1440.mainFrame() &&
        frame.url().includes('pricingmodelv2')
      ) {
        initialNavigatedUrl = frame.url();
      }
    });

    const firstLinkHref = await page1440.$eval(
      'li.home-relic a.home-relic-link',
      (a) => a.getAttribute('href')
    );
    const firstLinkFullHref = await page1440.$eval(
      'li.home-relic a.home-relic-link',
      (a) => (a as HTMLAnchorElement).href
    );
    console.log(
      `[measure] First link href: ${firstLinkHref}, full: ${firstLinkFullHref}`
    );

    await page1440.click('li.home-relic a.home-relic-link');
    await Bun.sleep(400);

    const postStripUrl = page1440.url();
    console.log(
      `[measure] Initial navigated URL: ${initialNavigatedUrl}, post-strip URL: ${postStripUrl}`
    );

    await page1440.goBack({ waitUntil: 'networkidle' });
    console.log(`[measure] Navigated back to: ${page1440.url()}`);
    await context1440.close();
    // -------------------------------------------------------------------------
    // STEP 5: /install with seeded storage
    // -------------------------------------------------------------------------
    console.log('[measure] Step 5: /install with seeded storage ...');
    const installContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const installPage = await installContext.newPage();
    const cdpInstall = await installContext.newCDPSession(installPage);
    await cdpInstall.send('Network.setCacheDisabled', { cacheDisabled: true });

    await installPage.goto(`${serviceOrigin}/install`, {
      waitUntil: 'networkidle',
    });
    await installPage.evaluate((items) => {
      for (const item of items) {
        localStorage.setItem(`relic:key:${item.relicId}`, JSON.stringify(item));
      }
    }, entries);
    await installPage.reload({ waitUntil: 'networkidle' });

    const installMetrics = await installPage.evaluate(() => {
      const section = document.getElementById('home-relics');
      const scriptElements = Array.from(document.querySelectorAll('script'));
      return {
        hasHomeRelicsSection: section !== null,
        scriptCount: scriptElements.length,
        scripts: scriptElements.map((s) => s.outerHTML),
      };
    });

    const installScreenshot = '/tmp/home-install.png';
    await installPage.screenshot({ path: installScreenshot, fullPage: false });
    console.log(`[measure] Step 5 screenshot saved to ${installScreenshot}`);
    await installContext.close();

    // -------------------------------------------------------------------------
    // STEP 6: JS disabled on / with seeded storage
    // -------------------------------------------------------------------------
    console.log('[measure] Step 6: JS disabled on / ...');
    const noJsContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const noJsPage = await noJsContext.newPage();

    await noJsPage.goto(`${serviceOrigin}/`, { waitUntil: 'networkidle' });

    const noJsMetrics = await noJsPage.evaluate(() => {
      const section = document.getElementById('home-relics');
      if (!section) return { found: false };
      return {
        found: true,
        hasHiddenAttribute: section.hasAttribute('hidden'),
        childElementCount: section.childElementCount,
      };
    });

    const noJsScreenshot = '/tmp/home-nojs.png';
    await noJsPage.screenshot({ path: noJsScreenshot, fullPage: false });
    console.log(`[measure] Step 6 screenshot saved to ${noJsScreenshot}`);
    await noJsContext.close();

    return {
      step1_empty: step1Metrics,
      step2_seeded_1440: step2Metrics1440,
      step3_monitoring: {
        consoleMessages,
        cspViolations,
        requestsAfterDOMContentLoaded: step2RequestsAfterDOMContentLoaded,
      },
      step4_navigation: {
        firstLinkHref,
        firstLinkFullHref,
        initialNavigatedUrl,
        postStripUrl,
      },
      step5_install: installMetrics,
      step6_nojs: noJsMetrics,
      screenshots: {
        empty_1440: step1Screenshot,
        seeded_1440: step2Screenshot1440,
        seeded_390: step2Screenshot390,
        seeded_dark: step2ScreenshotDark,
        install: installScreenshot,
        nojs: noJsScreenshot,
      },
    };
  } finally {
    await browser.close();
  }
}
