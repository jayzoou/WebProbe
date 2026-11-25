import { inventoryScript } from './dom-scripts.js';
import { chromium, firefox, webkit, type Page, type Locator } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataDir, get } from '../store.js';
import { createEgressProxy, validateUrl, resolveTarget } from '../security.js';
import type { Project, BrowserName, DeviceName } from '../../../../packages/shared/src/index.js';
import type { Target, TestStep } from '../../../../packages/shared/src/testing.js';
export function environment(projectId: string, environmentId: string) {
  const project = get<Project>('project', projectId);
  const env = project?.environments.find((e) => e.id === environmentId);
  if (!env) throw new Error('项目或环境不存在');
  validateUrl(env.url);
  return env;
}
export function scopedUrl(path: string, base: string) {
  const url = validateUrl(new URL(path, base).href);
  if (url.origin !== new URL(base).origin) throw new Error('不允许站外导航');
  return url.href;
}
export function locatorFor(page: Page, t: Target): Locator {
  switch (t.by) {
    case 'testId':
      return page.getByTestId(t.value);
    case 'label':
      return page.getByLabel(t.value, { exact: true });
    case 'role':
      return page.getByRole(t.value as Parameters<Page['getByRole']>[0], {
        ...(t.name ? { name: t.name, exact: true } : {}),
      });
    case 'text':
      return page.getByText(t.value, { exact: true });
    default:
      return page.locator(t.value);
  }
}
export const sensitive =
  /password|passwd|secret|token|credit|card.number|cvv|密码|密钥|银行卡|身份证/i;
export const dangerous =
  /删除|注销|付款|支付|下单|购买|提交订单|转账|退出|delete|remove|destroy|logout|purchase|payment|checkout|unsubscribe/i;
export async function checkAction(page: Page, step: TestStep, base: string, allowed: boolean) {
  if (!['click', 'fill', 'select', 'check', 'press'].includes(step.action)) return;
  if (!allowed) throw new Error('需要启用页面交互后执行此用例');
  if (!('target' in step)) return;
  const loc = locatorFor(page, step.target);
  if ((await loc.count()) !== 1) throw new Error('定位目标必须唯一；请细化定位器');
  const info = await loc.evaluate((el) => ({
    text: el.textContent || '',
    type: el.getAttribute('type') || '',
    name: el.getAttribute('name') || '',
    autocomplete: el.getAttribute('autocomplete') || '',
    href: el.closest('a')?.href || '',
  }));
  if (sensitive.test(`${info.type} ${info.name} ${info.autocomplete} ${step.target.value}`))
    throw new Error('不能记录或操作密码、令牌及支付等敏感字段');
  if (step.action === 'click' || step.action === 'press') {
    if (dangerous.test(info.text)) throw new Error('危险业务操作被阻止');
    if (info.href) scopedUrl(info.href, base);
  }
}
export async function browserSession(options: {
  url: string;
  browser: BrowserName;
  device: DeviceName;
  allowWrites?: boolean;
  headless?: boolean;
  signal?: AbortSignal;
}) {
  const base = validateUrl(options.url);
  await resolveTarget(base.hostname);
  const proxy = await createEgressProxy(
    options.allowWrites ? { writeOrigin: base.origin } : undefined,
  );
  const home = resolve(dataDir, 'runtime', 'firefox-home');
  await mkdir(home, { recursive: true });
  let browser;
  try {
    browser = await { chromium, firefox, webkit }[options.browser].launch({
      headless: options.headless ?? true,
      proxy: { server: proxy.url },
      ...(options.browser === 'chromium'
        ? { args: ['--proxy-bypass-list=<-loopback>', '--disable-quic'] }
        : {}),
      ...(options.browser === 'firefox'
        ? {
            firefoxUserPrefs: { 'network.proxy.no_proxies_on': '' },
            ...(process.platform === 'darwin'
              ? { env: { ...process.env, CFFIXED_USER_HOME: home } }
              : {}),
          }
        : {}),
    });
  } catch (e) {
    await proxy.close();
    throw e;
  }
  const closeOnAbort = () => {
    void browser.close().catch(() => {});
  };
  options.signal?.addEventListener('abort', closeOnAbort, { once: true });
  if (options.signal?.aborted) {
    await browser.close();
    await proxy.close();
    throw new Error('任务已取消');
  }
  try {
    const blockedRequests: string[] = [];
    const context = await browser.newContext({
      viewport:
        options.device === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      acceptDownloads: false,
      ...(options.browser !== 'firefox' ? { isMobile: options.device === 'mobile' } : {}),
    });
    await context.route('**/*', async (route) => {
      const req = route.request();
      try {
        const url = validateUrl(req.url());
        if (req.isNavigationRequest() && url.origin !== base.origin) {
          blockedRequests.push('站外导航 ' + url.origin);
          return route.abort('blockedbyclient');
        }
        if (
          !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) &&
          (!options.allowWrites || url.origin !== base.origin)
        ) {
          blockedRequests.push(req.method() + ' ' + url.origin + url.pathname);
          return route.abort('blockedbyclient');
        }
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket(/.*/, (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(20000);
    page.on('popup', (p) => {
      void p.close();
    });
    page.on('dialog', (d) => {
      void d.dismiss();
    });
    return {
      browser,
      context,
      page,
      blockedRequests,
      close: async () => {
        options.signal?.removeEventListener('abort', closeOnAbort);
        await browser.close().catch(() => {});
        await proxy.close();
      },
    };
  } catch (error) {
    options.signal?.removeEventListener('abort', closeOnAbort);
    await browser.close().catch(() => {});
    await proxy.close();
    throw error;
  }
}
export type InventoryItem = {
  target: Target;
  tag: string;
  text: string;
  label: string;
  type: string;
  name: string;
  href: string;
};
export async function pageInventory(page: Page): Promise<InventoryItem[]> {
  return page.evaluate(inventoryScript);
}
