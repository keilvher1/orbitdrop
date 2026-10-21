/**
 * Processor worker entry (Electron utilityProcess). Built by electron-vite as
 * out/main/processor-host.js and forked by the main-process ProcessorPool.
 *
 * Talks to main only through process.parentPort with the contracts'
 * MainToProcessorMessage / ProcessorToMainMessage. Each job and preview gets
 * its own AbortController; `cancel` / `cancelPreview` abort it and the
 * processors stop at their next check. @orbitdrop/processors is loaded with a
 * dynamic import so a broken native engine (sharp, canvas, pdf.js) does not
 * kill the worker: the probe reports the failure and jobs fail with
 * ENGINE_UNAVAILABLE instead.
 */
import {
  OrbitError,
  toErrorInfo,
  type JobProgress,
  type MainToProcessorMessage,
  type OrbitErrorInfo,
  type ProcessorApi,
  type ProcessorToMainMessage,
} from '@orbitdrop/contracts';
import { failedProbe } from './probe-fallback';

const port = process.parentPort;
if (!port) {
  process.stderr.write('processor-host must run inside an Electron utility process\n');
  process.exit(1);
}

function send(message: ProcessorToMainMessage): void {
  try {
    port.postMessage(message);
  } catch (error) {
    process.stderr.write(`processor-host: postMessage failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

let loadError: string | null = null;
let apiPromise: Promise<ProcessorApi> | null = null;

function api(): Promise<ProcessorApi> {
  apiPromise ??= import('@orbitdrop/processors').then(
    (m): ProcessorApi => ({
      probeEngines: m.probeEngines,
      runJob: m.runJob,
      renderPreview: m.renderPreview,
      inspectImage: m.inspectImage,
      clearPreviewCaches: m.clearPreviewCaches,
    }),
    (error: unknown) => {
      loadError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      process.stderr.write(`processor-host: processors failed to load: ${loadError}\n`);
      throw new OrbitError('ENGINE_UNAVAILABLE', 'Processing engines failed to load', { detail: loadError.slice(0, 500) });
    },
  );
  return apiPromise;
}

function errorInfo(error: unknown): OrbitErrorInfo {
  return toErrorInfo(error);
}

/** Forward progress at most every 50 ms, always delivering the latest value before the result. */
function progressForwarder(jobId: string): { push: (progress: JobProgress) => void; flush: () => void } {
  let latest: JobProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = 0;
  const emit = (): void => {
    timer = null;
    if (!latest) return;
    send({ type: 'progress', jobId, progress: latest });
    latest = null;
    lastSent = Date.now();
  };
  return {
    push(progress) {
      latest = progress;
      if (timer) return;
      const wait = Math.max(0, 50 - (Date.now() - lastSent));
      if (wait === 0) emit();
      else timer = setTimeout(emit, wait);
    },
    flush() {
      if (timer) clearTimeout(timer);
      emit();
    },
  };
}

const jobs = new Map<string, AbortController>();
const previews = new Map<string, AbortController>();

/** Job and preview handlers still running (awaited, bounded, before exiting). */
const inflight = new Set<Promise<void>>();
const EXIT_GRACE_MS = 1500;

let exiting = false;
/**
 * Abort everything and exit — a utility process with piped stdio never exits
 * on its own. The aborted processors get a moment to remove their temp files
 * before the process ends (main kills the worker only after a longer timeout).
 */
function shutdownAndExit(): void {
  if (exiting) return;
  exiting = true;
  for (const controller of jobs.values()) controller.abort(new OrbitError('CANCELLED', 'Shutting down'));
  for (const controller of previews.values()) controller.abort(new OrbitError('CANCELLED', 'Shutting down'));
  const grace = new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS));
  void Promise.race([Promise.allSettled([...inflight]), grace]).then(() => process.exit(0));
}

async function handle(message: MainToProcessorMessage): Promise<void> {
  switch (message.type) {
    case 'run': {
      const { job } = message;
      if (jobs.has(job.jobId)) return;
      const controller = new AbortController();
      jobs.set(job.jobId, controller);
      const progress = progressForwarder(job.jobId);
      try {
        const processors = await api();
        const result = await processors.runJob(job, { signal: controller.signal, onProgress: (p) => progress.push(p) });
        progress.flush();
        // Resolved means the outputs were committed: report them even if a cancel arrived meanwhile.
        send({ type: 'done', jobId: job.jobId, result });
      } catch (error) {
        progress.flush();
        send(controller.signal.aborted ? { type: 'cancelled', jobId: job.jobId } : { type: 'failed', jobId: job.jobId, error: errorInfo(error) });
      } finally {
        jobs.delete(job.jobId);
      }
      return;
    }
    case 'cancel':
      jobs.get(message.jobId)?.abort(new OrbitError('CANCELLED', 'Cancelled'));
      return;
    case 'preview': {
      const { request } = message;
      if (previews.has(request.previewId)) return;
      const controller = new AbortController();
      previews.set(request.previewId, controller);
      try {
        const processors = await api();
        const result = await processors.renderPreview(request, { signal: controller.signal });
        if (controller.signal.aborted) send({ type: 'previewFailed', previewId: request.previewId, error: { code: 'CANCELLED', message: 'Cancelled', retryable: false } });
        else send({ type: 'previewDone', previewId: request.previewId, result });
      } catch (error) {
        const info: OrbitErrorInfo = controller.signal.aborted ? { code: 'CANCELLED', message: 'Cancelled', retryable: false } : errorInfo(error);
        send({ type: 'previewFailed', previewId: request.previewId, error: info });
      } finally {
        previews.delete(request.previewId);
      }
      return;
    }
    case 'cancelPreview':
      previews.get(message.previewId)?.abort(new OrbitError('CANCELLED', 'Cancelled'));
      return;
    case 'inspect': {
      try {
        const processors = await api();
        const info = await processors.inspectImage(message.input, message.limits);
        send({ type: 'inspectDone', requestId: message.requestId, info });
      } catch (error) {
        send({ type: 'inspectFailed', requestId: message.requestId, error: errorInfo(error) });
      }
      return;
    }
    case 'probe': {
      try {
        const processors = await api();
        const probe = await processors.probeEngines();
        send({ type: 'probeDone', requestId: message.requestId, probe });
      } catch (error) {
        const reason = loadError ?? (error instanceof Error ? error.message : String(error));
        send({ type: 'probeDone', requestId: message.requestId, probe: failedProbe([`probe failed: ${reason}`.slice(0, 500)]) });
      }
      return;
    }
    case 'clearPreviewCaches':
      // Nothing is cached before the processors are loaded; don't load them just to clear.
      if (apiPromise) (await api()).clearPreviewCaches();
      return;
    case 'shutdown':
      shutdownAndExit();
      return;
    default:
      return;
  }
}

port.on('message', (event) => {
  const message = (event as { data?: unknown }).data;
  if (typeof message !== 'object' || message === null || typeof (message as { type?: unknown }).type !== 'string') return;
  const type = (message as { type: string }).type;
  if (exiting && type !== 'cancel' && type !== 'cancelPreview') return; // no new work while exiting
  const work = handle(message as MainToProcessorMessage).catch((error: unknown) => {
    process.stderr.write(`processor-host: handler error: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  if (type === 'run' || type === 'preview') {
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  }
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`processor-host: unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
});

// Parent loss (main crashed or was killed): no `shutdown` message will come, so watch main's pid
// (ORBITDROP_PARENT_PID, else the OS parent) and exit when it is gone — no orphan workers.
const parentPid = Number.parseInt(process.env.ORBITDROP_PARENT_PID ?? '', 10) || process.ppid;
const initialPpid = process.ppid;
function parentAlive(): boolean {
  // POSIX re-parents orphans (ppid changes); Windows keeps the old ppid, so also probe the pid.
  if (process.platform !== 'win32' && process.ppid !== initialPpid) return false;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
const parentWatch = setInterval(() => {
  if (!parentAlive()) {
    process.stderr.write('processor-host: main process is gone; exiting\n');
    shutdownAndExit();
  }
}, 1000);
parentWatch.unref();

send({ type: 'ready', pid: process.pid });
// Warm up: load the engines in the background so the first job does not pay for it.
api().catch(() => undefined);
