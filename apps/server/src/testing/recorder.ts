import { recordingScript } from './dom-scripts.js';
import {
  recordSchema,
  testStepSchema,
  type Recording,
  type TestStep,
} from '../../../../packages/shared/src/testing.js';
import { browserSession, environment, scopedUrl, sensitive, locatorFor } from './browser.js';
import { put, get, uid, now } from '../store.js';
import { saveCase } from './runner.js';
let starting = false;
const sessions = new Map<
  string,
  {
    session: Awaited<ReturnType<typeof browserSession>>;
    timer: ReturnType<typeof setTimeout>;
    chain: Promise<void>;
    stopping: boolean;
  }
>();
export async function startRecording(
  input: import('zod').infer<typeof recordSchema>,
  headless = false,
) {
  if (sessions.size || starting) throw new Error('已有录制会话，请先结束当前录制');
  const env = environment(input.projectId, input.environmentId);
  starting = true;
  let session: Awaited<ReturnType<typeof browserSession>>;
  try {
    session = await browserSession({
      url: env.url,
      browser: 'chromium',
      device: 'desktop',
      allowWrites: input.allowWrites,
      headless,
    });
  } catch (error) {
    starting = false;
    throw error;
  }
  starting = false;
  const record: Recording = {
    id: uid(),
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: input.name,
    status: 'recording',
    createdAt: now(),
    steps: [{ action: 'navigate', path: input.path }],
    omitted: 0,
  };
  put('recording', record);
  const state = {
    session,
    timer: setTimeout(() => {
      void stopRecording(record.id, false);
    }, 600000),
    chain: Promise.resolve(),
    stopping: false,
  };
  sessions.set(record.id, state);
  try {
    await session.context.exposeBinding('__webprobeRecord', ({ frame }, raw) => {
      if (state.stopping) return;
      if (
        frame !== session.page.mainFrame() ||
        new URL(frame.url()).origin !== new URL(env.url).origin
      )
        return;
      state.chain = state.chain.then(async () => {
        if (record.steps.length >= 39) return;
        try {
          const step = testStepSchema.parse(raw);
          if (
            !['click', 'fill', 'select', 'check', 'press'].includes(step.action) ||
            !('target' in step)
          )
            return;
          const loc = locatorFor(session.page, step.target);
          const attrs = await loc.evaluate((el) =>
            [
              el.getAttribute('type'),
              el.getAttribute('name'),
              el.getAttribute('autocomplete'),
            ].join(' '),
          );
          if (
            sensitive.test(attrs) ||
            ('value' in step &&
              typeof step.value === 'string' &&
              /sk-[a-zA-Z0-9]{12}|eyJ[a-zA-Z0-9_-]{15}/.test(step.value))
          ) {
            record.omitted++;
            put('recording', record);
            return;
          }
          const prev = record.steps.at(-1);
          if (
            step.action === 'fill' &&
            prev?.action === 'fill' &&
            JSON.stringify(prev.target) === JSON.stringify(step.target)
          )
            record.steps[record.steps.length - 1] = step;
          else record.steps.push(step);
          put('recording', record);
        } catch {
          record.omitted++;
          put('recording', record);
        }
      });
      return state.chain;
    });
    await session.context.addInitScript(recordingScript);
    let initial = true;
    session.page.on('framenavigated', (frame) => {
      if (frame !== session.page.mainFrame() || state.stopping) return;
      try {
        const url = new URL(scopedUrl(frame.url(), env.url));
        if (initial) {
          initial = false;
          return;
        }
        const path = url.pathname + url.search;
        const previous = record.steps.at(-1);
        record.steps.push(
          previous && ['click', 'press'].includes(previous.action)
            ? { action: 'assertUrl', path }
            : { action: 'navigate', path },
        );
        record.steps = record.steps.slice(0, 39);
        put('recording', record);
      } catch {}
    });
    session.browser.on('disconnected', () => {
      if (!state.stopping) void stopRecording(record.id, true);
    });
    await session.page.goto(scopedUrl(input.path, env.url));
    return record;
  } catch (e) {
    state.stopping = true;
    clearTimeout(state.timer);
    sessions.delete(record.id);
    await session.close();
    put('recording', { ...record, status: 'failed', error: (e as Error).message });
    throw e;
  }
}
export async function stopRecording(id: string, save: boolean) {
  const state = sessions.get(id);
  let record = get<Recording>('recording', id);
  if (!record) throw new Error('录制不存在');
  if (!state) return record;
  if (state.stopping) return record;
  state.stopping = true;
  await state.chain;
  record = get<Recording>('recording', id)!;
  state.stopping = true;
  clearTimeout(state.timer);
  sessions.delete(id);
  try {
    if (save) {
      const test = saveCase(
        {
          projectId: record.projectId,
          name: record.name,
          description: '操作录制草稿；请补充业务预期与视觉检查点后执行。',
          steps: [...record.steps, { action: 'assertNoErrors' }],
          tags: ['录制'],
        },
        'recording',
      );
      record.caseId = test.id;
      record.status = 'saved';
    } else record.status = 'cancelled';
  } catch (e) {
    record.status = 'failed';
    record.error = (e as Error).message;
  } finally {
    await state.session.close();
    put('recording', record);
  }
  return record;
}
// Internal access for controlled integration tests; never exposed by HTTP routes.
export const recordingPage = (id: string) => sessions.get(id)?.session.page;
