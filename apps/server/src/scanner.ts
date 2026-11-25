import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  Finding,
  Scan,
  Project,
  PageResult,
  Source,
  Metrics,
  BrowserName,
  DeviceName,
} from '../../../packages/shared/src/index.js';
import { all, dataDir, finalize, fingerprint, get, now, put, uid } from './store.js';
import { createEgressProxy, resolveTarget, validateUrl } from './security.js';

const queue: string[] = [];
let working = false;
const controllers = new Map<string, AbortController>();
export function enqueue(scan: Scan) {
  put('scan', scan);
  queue.push(scan.id);
  void pump();
  return scan;
}
export function cancelScan(id: string) {
  const scan = get<Scan>('scan', id);
  if (!scan || !['queued', 'running'].includes(scan.status)) return false;
  controllers.get(id)?.abort();
  put('scan', { ...scan, status: 'cancelled', stage: '已取消', completedAt: now() });
  return true;
}
async function pump() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const scan = get<Scan>('scan', id);
      if (scan?.status === 'queued') await executeScan(scan);
    }
  } finally {
    working = false;
  }
}
export async function executeScan(scan: Scan) {
  const project = get<Project>('project', scan.projectId)!;
  const environment = project.environments.find((e) => e.id === scan.environmentId)!;
  const controller = new AbortController();
  controllers.set(scan.id, controller);
  let activeBrowser: Browser | undefined;
  const stopBrowser = () => {
    void activeBrowser?.close().catch(() => {});
  };
  controller.signal.addEventListener('abort', stopBrowser);
  const timer = setTimeout(() => controller.abort(new Error('检测超过 15 分钟上限')), 900000);
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error('检测已取消');
  };
  const log = (message: string) => {
    scan.stage = message;
    scan.logs.push({ time: now(), message });
    scan.logs = scan.logs.slice(-200);
    put('scan', scan);
  };
  const folder = resolve(dataDir, 'artifacts', scan.id);
  await mkdir(folder, { recursive: true });
  const firefoxHome = resolve(dataDir, 'runtime', 'firefox-home');
  if (process.platform === 'darwin') await mkdir(firefoxHome, { recursive: true });
  let proxy: Awaited<ReturnType<typeof createEgressProxy>> | undefined;
  try {
    scan.status = 'running';
    log('正在校验检测地址与网络权限');
    const base = validateUrl(environment.url);
    await resolveTarget(base.hostname);
    proxy = await createEgressProxy();
    const urls = [...new Set([base.href, ...scan.paths.map((p) => new URL(p, base).href)])].slice(
      0,
      scan.maxPages,
    );
    const visited = new Set<string>();
    for (let u = 0; u < urls.length && u < scan.maxPages; u++) {
      check();
      const url = urls[u];
      visited.add(url);
      for (const browserName of [...new Set(scan.browsers)])
        for (const device of [...new Set(scan.devices)]) {
          check();
          const started = Date.now();
          const pageResult: PageResult = {
            url,
            browser: browserName,
            device,
            title: '',
            status: 'completed',
            sources: [],
            duration: 0,
          };
          log(
            `浏览器检测 ${u + 1}/${urls.length} · ${browserName} · ${device} · ${new URL(url).pathname}`,
          );
          let navigationStarted = false;
          try {
            activeBrowser = await { chromium, firefox, webkit }[browserName].launch({
              headless: true,
              proxy: { server: proxy.url },
              ...(browserName === 'chromium'
                ? { args: ['--proxy-bypass-list=<-loopback>', '--disable-quic'] }
                : {}),
              ...(browserName === 'firefox'
                ? {
                    firefoxUserPrefs: { 'network.proxy.no_proxies_on': '' },
                    ...(process.platform === 'darwin'
                      ? { env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } }
                      : {}),
                  }
                : {}),
            });
            check();
            const context = await activeBrowser.newContext({
              viewport:
                device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
              deviceScaleFactor: 1,
              ...(browserName !== 'firefox' ? { isMobile: device === 'mobile' } : {}),
              serviceWorkers: 'block',
              acceptDownloads: false,
            });
            await context.route('**/*', async (route) => {
              const req = route.request();
              if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) || !/^https?:/.test(req.url()))
                return route.abort('blockedbyclient');
              try {
                validateUrl(req.url());
                await route.continue();
              } catch {
                await route.abort('blockedbyclient');
              }
            });
            await context.routeWebSocket(/.*/, (socket) => socket.close());
            const page = await context.newPage();
            page.on('popup', (popup) => {
              void popup.close();
            });
            page.on('dialog', (dialog) => {
              void dialog.dismiss();
            });
            const findings: Finding[] = [];
            const add = (
              rule: string,
              source: Source,
              title: string,
              severity: Finding['severity'],
              evidence: string,
              recommendation: string,
              identity = '',
              certainty: Finding['certainty'] = 'confirmed',
            ) => {
              if (findings.length >= 250) return;
              const f: Omit<Finding, 'fingerprint'> = {
                rule,
                source,
                title,
                severity,
                url,
                browser: browserName,
                device,
                evidence: evidence.slice(0, 12000),
                recommendation,
                certainty,
              };
              const key = fingerprint(f, identity);
              if (!findings.some((x) => x.fingerprint === key))
                findings.push({ ...f, fingerprint: key });
            };
            page.on('pageerror', (e) =>
              add(
                'js-uncaught',
                'runtime',
                'JavaScript 未捕获异常',
                'P1',
                e.stack || e.message,
                '检查异常堆栈中的脚本，修复异常后重新运行相同页面。',
                e.message,
              ),
            );
            page.on('console', (msg) => {
              if (msg.type() === 'error')
                add(
                  'console-error',
                  'runtime',
                  '控制台错误',
                  'P2',
                  JSON.stringify({ message: msg.text(), location: msg.location() }),
                  '结合上下文检查控制台错误是否影响业务。',
                  msg.text(),
                  'suspected',
                );
            });
            page.on('response', (response) => {
              if (response.status() >= 400)
                add(
                  'http-error',
                  'network',
                  `HTTP ${response.status()} 请求失败`,
                  response.request().isNavigationRequest() ? 'P1' : 'P2',
                  `${response.status()} ${response.url()}`,
                  '检查请求地址、部署资源及服务端响应。',
                  response.url(),
                );
            });
            page.on('requestfailed', (req) => {
              if (!req.failure()?.errorText.includes('ERR_ABORTED'))
                add(
                  'request-failed',
                  'network',
                  '网络请求未完成',
                  'P2',
                  `${req.method()} ${req.url()}\n${req.failure()?.errorText}`,
                  '检查跨域、域名、网络连接及只读检测策略对请求的影响。',
                  req.url(),
                  'suspected',
                );
            });
            navigationStarted = true;
            const response = await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            });
            if (!response || response.status() >= 400)
              throw new Error(`页面无法正常访问（HTTP ${response?.status() ?? '无响应'}）`);
            if (new URL(page.url()).origin !== base.origin)
              throw new Error(`页面跳转到了站外：${page.url()}`);
            await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);
            check();
            pageResult.title = await page.title();
            const snapshot = await inspectDOM(page);
            if (snapshot.overflow.length)
              add(
                'horizontal-overflow',
                'layout',
                '页面存在横向溢出',
                'P2',
                JSON.stringify(snapshot.overflow),
                '为溢出元素设置合理宽度，检查固定尺寸和响应式断点。',
                '',
                'suspected',
              );
            if (device === 'mobile' && !snapshot.viewport)
              add(
                'missing-viewport',
                'layout',
                '缺少移动端 viewport 配置',
                'P2',
                '未发现 meta[name="viewport"]',
                '添加 width=device-width, initial-scale=1 的 viewport。',
              );
            if (snapshot.brokenImages.length)
              add(
                'broken-images',
                'layout',
                '图片无法正常显示',
                'P2',
                JSON.stringify(snapshot.brokenImages),
                '检查图片地址、文件部署路径和访问权限。',
              );
            if (!snapshot.title)
              add(
                'missing-title',
                'seo',
                '页面缺少标题',
                'P2',
                'document.title 为空',
                '添加准确描述页面内容的 title。',
              );
            if (!snapshot.description)
              add(
                'missing-description',
                'seo',
                '缺少页面描述',
                'P3',
                '未发现有效 meta description',
                '为可索引页面添加有意义的 description。',
              );
            if (!snapshot.h1)
              add(
                'missing-h1',
                'seo',
                '未发现一级标题',
                'P3',
                '页面 h1 数量为 0',
                '根据页面结构确认是否需要语义化一级标题。',
                '',
                'suspected',
              );
            pageResult.sources.push('runtime', 'network', 'layout', 'seo');
            try {
              const axe = await new AxeBuilder({ page })
                .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
                .analyze();
              for (const violation of axe.violations)
                add(
                  `axe-${violation.id}`,
                  'accessibility',
                  violation.help,
                  violation.impact === 'critical' ? 'P1' : 'P2',
                  JSON.stringify({
                    id: violation.id,
                    impact: violation.impact,
                    helpUrl: violation.helpUrl,
                    nodes: violation.nodes
                      .slice(0, 8)
                      .map((n) => ({ target: n.target, html: n.html, summary: n.failureSummary })),
                  }),
                  violation.description,
                  violation.id,
                );
              pageResult.sources.push('accessibility');
            } catch (e) {
              pageResult.error = `无障碍检测失败：${errorMessage(e)}`;
            }
            const shot = `${u}-${browserName}-${device}.png`;
            await page.screenshot({ path: resolve(folder, shot), fullPage: false, timeout: 10000 });
            pageResult.screenshot = `/artifacts/${scan.id}/${shot}`;
            scan.findings.push(
              ...findings.map((f) => ({ ...f, screenshot: pageResult.screenshot })),
            );
            if (browserName === scan.browsers[0] && device === scan.devices[0]) {
              for (const link of snapshot.links) {
                const parsed = new URL(link);
                parsed.hash = '';
                if (
                  parsed.origin === base.origin &&
                  !visited.has(parsed.href) &&
                  !urls.includes(parsed.href) &&
                  urls.length < scan.maxPages
                )
                  urls.push(parsed.href);
              }
            }
          } catch (error) {
            check();
            pageResult.status = 'failed';
            pageResult.error = errorMessage(error);
            const f: Omit<Finding, 'fingerprint'> = {
              rule: 'page-unavailable',
              source: 'network',
              title: '页面检测失败',
              severity: 'P1',
              url,
              browser: browserName,
              device,
              evidence: pageResult.error,
              recommendation: '确认地址可访问、浏览器已安装以及检测环境权限；重新检测。',
              certainty: 'confirmed',
            };
            if (navigationStarted) scan.findings.push({ ...f, fingerprint: fingerprint(f) });
          } finally {
            await activeBrowser?.close().catch(() => {});
            activeBrowser = undefined;
          }
          if (scan.lighthouse && browserName === 'chromium' && pageResult.status === 'completed') {
            check();
            log(`Lighthouse 性能审计 · ${device} · ${new URL(url).pathname}`);
            try {
              const audit = await runLighthouse(
                url,
                device,
                proxy.port,
                folder,
                `${u}-${device}`,
                controller.signal,
              );
              pageResult.metrics = audit.metrics;
              pageResult.lighthouseReport = `/artifacts/${scan.id}/${u}-${device}.lighthouse.html`;
              pageResult.sources.push('lighthouse');
              for (const a of audit.audits) {
                const f: Omit<Finding, 'fingerprint'> = {
                  rule: `lh-${a.id}`,
                  source: 'lighthouse',
                  title: a.title,
                  severity: (a.score ?? 1) < 0.5 ? 'P1' : 'P2',
                  url,
                  browser: browserName,
                  device,
                  evidence: JSON.stringify({
                    id: a.id,
                    description: a.description,
                    displayValue: a.displayValue,
                    details: a.details,
                  }).slice(0, 12000),
                  recommendation: a.description,
                  certainty: 'suspected',
                  screenshot: pageResult.screenshot,
                };
                scan.findings.push({ ...f, fingerprint: fingerprint(f) });
              }
            } catch (e) {
              check();
              pageResult.error = [pageResult.error, `Lighthouse 失败：${errorMessage(e)}`]
                .filter(Boolean)
                .join('；');
            }
          }
          pageResult.duration = Date.now() - started;
          scan.pages.push(pageResult);
          scan.progress = Math.min(
            95,
            Math.round(
              (scan.pages.length /
                (Math.max(urls.length, 1) * scan.browsers.length * scan.devices.length)) *
                95,
            ),
          );
          put('scan', scan);
        }
    }
    scan.status = scan.pages.every((p) => p.status === 'failed')
      ? 'failed'
      : scan.pages.some((p) => p.status === 'failed' || p.error)
        ? 'partial'
        : 'completed';
    scan.completedAt = now();
    scan.progress = 100;
    log(
      scan.status === 'completed' ? '检测完成，报告已生成' : '检测结束，部分检查未成功，请查看详情',
    );
    finalize(scan, project);
  } catch (error) {
    const cancelled = get<Scan>('scan', scan.id)?.status === 'cancelled';
    scan.status = cancelled ? 'cancelled' : 'failed';
    scan.error = errorMessage(error);
    scan.completedAt = now();
    log(cancelled ? '已取消检测' : `检测失败：${scan.error}`);
  } finally {
    clearTimeout(timer);
    controllers.delete(scan.id);
    controller.signal.removeEventListener('abort', stopBrowser);
    await activeBrowser?.close().catch(() => {});
    await proxy?.close();
  }
  return scan;
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function inspectDOM(page: Page) {
  return page.evaluate(() => ({
    title: document.title.trim(),
    description: document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.content.trim(),
    h1: document.querySelectorAll('h1').length,
    viewport: !!document.querySelector('meta[name="viewport"]'),
    brokenImages: Array.from(document.images)
      .filter((i) => i.complete && i.naturalWidth === 0)
      .slice(0, 20)
      .map((i) => ({ src: i.currentSrc, alt: i.alt })),
    overflow: Array.from(document.body.querySelectorAll<HTMLElement>('*'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          s.display !== 'none' &&
          s.visibility !== 'hidden' &&
          r.width > 0 &&
          (r.right > innerWidth + 2 || r.left < -2)
        );
      })
      .slice(0, 12)
      .map((el) => ({
        tag: el.tagName,
        id: el.id,
        className: String(el.className).slice(0, 100),
        width: Math.round(el.getBoundingClientRect().width),
      })),
    links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map((a) => a.href)
      .filter((h) => /^https?:/.test(h))
      .slice(0, 500),
  }));
}
async function runLighthouse(
  url: string,
  device: DeviceName,
  proxyPort: number,
  folder: string,
  filename: string,
  signal: AbortSignal,
) {
  const chrome = await launch({
    chromePath: chromium.executablePath(),
    chromeFlags: [
      '--headless',
      '--disable-dev-shm-usage',
      '--disable-quic',
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--proxy-bypass-list=<-loopback>',
    ],
    logLevel: 'silent',
  });
  const kill = () => {
    void chrome.kill();
  };
  signal.addEventListener('abort', kill);
  const timeout = setTimeout(kill, 120000);
  try {
    if (signal.aborted) throw new Error('检测已中止');
    const result = await lighthouse(url, {
      port: chrome.port,
      output: ['html', 'json'],
      logLevel: 'silent',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      formFactor: device === 'mobile' ? 'mobile' : 'desktop',
      screenEmulation: {
        mobile: device === 'mobile',
        width: device === 'mobile' ? 390 : 1440,
        height: device === 'mobile' ? 844 : 900,
        deviceScaleFactor: 1,
        disabled: false,
      },
      throttlingMethod: 'simulate',
      maxWaitForLoad: 30000,
    });
    if (!result || result.lhr.runtimeError)
      throw new Error(result?.lhr.runtimeError?.message || 'Lighthouse 未返回报告');
    const reports = result.report as string[];
    await writeFile(resolve(folder, `${filename}.lighthouse.html`), reports[0]);
    await writeFile(resolve(folder, `${filename}.lighthouse.json`), reports[1]);
    const lhr = result.lhr;
    const metric = (id: string) => lhr.audits[id]?.numericValue ?? null;
    const score = (id: string) =>
      lhr.categories[id]?.score == null ? null : Math.round(lhr.categories[id].score! * 100);
    const metrics: Metrics = {
      performance: score('performance'),
      accessibility: score('accessibility'),
      seo: score('seo'),
      bestPractices: score('best-practices'),
      lcp: metric('largest-contentful-paint'),
      fcp: metric('first-contentful-paint'),
      cls: metric('cumulative-layout-shift'),
      tbt: metric('total-blocking-time'),
      ttfb: metric('server-response-time'),
    };
    const ids = new Set(
      lhr.categories.performance.auditRefs
        .filter(
          (a) => a.weight > 0 || a.group === 'diagnostics' || a.group === 'load-opportunities',
        )
        .map((a) => a.id),
    );
    const audits = Object.values(lhr.audits)
      .filter(
        (a) =>
          ids.has(a.id) &&
          a.score !== null &&
          a.score < 0.9 &&
          !['notApplicable', 'informative', 'manual', 'error'].includes(a.scoreDisplayMode),
      )
      .slice(0, 20);
    return { metrics, audits };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', kill);
    await chrome.kill();
  }
}
export function createScan(
  config: import('../../../packages/shared/src/index.js').ScanConfig,
): Scan {
  return {
    ...config,
    browsers: [...new Set(config.browsers)],
    devices: [...new Set(config.devices)],
    id: uid(),
    status: 'queued',
    createdAt: now(),
    progress: 0,
    stage: '等待执行',
    pages: [],
    findings: [],
    logs: [],
  };
}
export function activeScanCount() {
  return all<Scan>('scan').filter((s) => s.status === 'queued' || s.status === 'running').length;
}
