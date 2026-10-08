import { spawn, type SpawnOptions } from 'node:child_process';
import { TransportError } from '@maf/types';

export interface SpawnResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
  duration: number;
  /**
   * Present when no answer came back for a reason that says nothing about the request: the
   * process timed out (exit 124), or it exited non-zero without writing to stdout. A field
   * rather than a rejection so every adapter keeps returning its `exitCode`/`success` result
   * as before; a caller that wants the node retried throws it (D-06).
   */
  transportError?: TransportError;
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8MB cap — prevents OOM on large codebase outputs

/**
 * A non-zero exit that wrote something is an answer — an error the backend chose to report —
 * and judging it is the caller's business. Silence, or a kill on timeout, is no answer at all.
 */
function transportFailure(
  cmd: string, exitCode: number, timedOut: boolean, stdout: string, timeoutMs: number | undefined,
): TransportError | undefined {
  if (timedOut) {
    return new TransportError(`"${cmd}" did not finish within ${timeoutMs} ms and was killed (exit code 124).`);
  }
  if (exitCode !== 0 && stdout.trim() === '') {
    return new TransportError(`"${cmd}" exited with code ${exitCode} without writing any output.`);
  }
  return undefined;
}

/** The process never produced a result: it could not be started, or the OS refused it. */
function spawnFailure(cmd: string, err: Error): TransportError {
  return new TransportError(`Could not run "${cmd}": ${err.message}`, { cause: err });
}

export async function spawnAndCollect(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { timeoutMs?: number; input?: string; maxOutputBytes?: number } = {},
): Promise<SpawnResult> {
  const start = Date.now();
  const cap = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    // Collect chunks into arrays — avoids O(n²) string concatenation GC pressure
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;

    const proc = spawn(cmd, args, { ...opts, shell: false });

    if (opts.input) {
      proc.stdin?.write(opts.input);
      proc.stdin?.end();
    }

    proc.stdout?.on('data', (d: Buffer) => {
      if (truncated) return;
      stdoutBytes += d.length;
      if (stdoutBytes > cap) {
        truncated = true;
        const remaining = cap - (stdoutBytes - d.length);
        if (remaining > 0) stdoutChunks.push(d.subarray(0, remaining));
        stdoutChunks.push(Buffer.from('\n[MAF: output cap reached — subprocess killed]'));
        // Destroy stream first to flush queued 'data' events, then kill process
        proc.stdout?.destroy();
        proc.kill('SIGTERM');
      } else {
        stdoutChunks.push(d);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.subarray(0, 65_536);
      stderrChunks.push(chunk);
    });

    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
        }, opts.timeoutMs)
      : undefined;

    proc.on('error', (err) => reject(spawnFailure(cmd, err)));
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      const exitCode = timedOut ? 124 : (code ?? 1);
      const transportError = transportFailure(cmd, exitCode, timedOut, stdout, opts.timeoutMs);
      resolve({
        stdout, stderr, exitCode, duration: Date.now() - start,
        ...(transportError ? { transportError } : {}),
      });
    });
  });
}

export async function* spawnStreaming(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { timeoutMs?: number } = {},
): AsyncGenerator<string> {
  const proc = spawn(cmd, args, { ...opts, shell: false });

  const queue: string[] = [];
  let done = false;
  let error: Error | undefined;
  let resolve: (() => void) | undefined;

  proc.stdout?.on('data', (d: Buffer) => {
    queue.push(d.toString());
    resolve?.();
  });
  proc.stderr?.on('data', (d: Buffer) => {
    queue.push(d.toString());
    resolve?.();
  });
  proc.on('error', (e) => { error = spawnFailure(cmd, e); done = true; resolve?.(); });
  proc.on('close', () => { done = true; resolve?.(); });

  while (!done || queue.length > 0) {
    if (queue.length === 0 && !done) {
      await new Promise<void>((r) => { resolve = r; });
      resolve = undefined;
    }
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  }

  if (error) throw error;
}
