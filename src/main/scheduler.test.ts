// Scheduler unit tests.
//
// Covers:
//   - Task registration and start
//   - Pause/resume lifecycle
//   - Failure recording and consecutiveFailures
//   - runNow mechanics
//   - Task isolation (one failure doesn't crash others)

import { describe, it, expect, vi } from 'vitest';
import { createScheduler, type CollectorHealthRecorder, type ScheduledTask } from './scheduler';

function createMockRecorder(): CollectorHealthRecorder {
  return {
    recordRunStart: vi.fn(),
    recordRunSuccess: vi.fn(),
    recordRunFailure: vi.fn(),
  };
}

function createTestScheduler(overrides?: { rng?: () => number; now?: () => number }) {
  const recorder = createMockRecorder();
  const scheduler = createScheduler({
    recorder,
    rng: overrides?.rng ?? (() => 0),
    now: overrides?.now ?? (() => Date.now()),
  });
  return { scheduler, recorder };
}

describe('scheduler', () => {
  it('registers and runs a task via runNow', async () => {
    const { scheduler } = createTestScheduler();
    const fn = vi.fn().mockResolvedValue(undefined);

    scheduler.register({ id: 'test', intervalMs: 10_000, fn });
    scheduler.start();

    await scheduler.runNow('test');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws on duplicate registration', () => {
    const { scheduler } = createTestScheduler();
    const fn = vi.fn().mockResolvedValue(undefined);

    scheduler.register({ id: 'dup', intervalMs: 5000, fn });
    expect(() => scheduler.register({ id: 'dup', intervalMs: 5000, fn })).toThrow(
      /already registered/,
    );
  });

  it('throws on invalid intervalMs', () => {
    const { scheduler } = createTestScheduler();
    expect(() =>
      scheduler.register({ id: 'bad', intervalMs: -1, fn: vi.fn() }),
    ).toThrow(/positive finite/);
  });

  it('records success on successful tick', async () => {
    const { scheduler, recorder } = createTestScheduler();
    const fn = vi.fn().mockResolvedValue(undefined);

    scheduler.register({ id: 'ok', intervalMs: 5000, fn });
    scheduler.start();
    await scheduler.runNow('ok');

    expect(recorder.recordRunSuccess).toHaveBeenCalledWith('ok', expect.any(Number));
  });

  it('records failure and increments consecutiveFailures on error', async () => {
    const { scheduler, recorder } = createTestScheduler();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    scheduler.register({ id: 'fail', intervalMs: 5000, fn });
    scheduler.start();
    await scheduler.runNow('fail');

    expect(recorder.recordRunFailure).toHaveBeenCalledWith('fail', expect.any(Number), 'boom');
    const status = scheduler.status();
    const task = status.tasks.find((t) => t.id === 'fail');
    expect(task?.consecutiveFailures).toBe(1);
  });

  it('resets consecutiveFailures after a success', async () => {
    const { scheduler } = createTestScheduler();
    let callCount = 0;
    const fn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('fail');
    });

    scheduler.register({ id: 'recover', intervalMs: 5000, fn });
    scheduler.start();
    await scheduler.runNow('recover');
    await scheduler.runNow('recover');
    await scheduler.runNow('recover'); // succeeds

    const task = scheduler.status().tasks.find((t) => t.id === 'recover');
    expect(task?.consecutiveFailures).toBe(0);
  });

  it('pause stops scheduling, resume restarts', async () => {
    const { scheduler } = createTestScheduler();
    const fn = vi.fn().mockResolvedValue(undefined);

    scheduler.register({ id: 'p', intervalMs: 5000, fn });
    scheduler.start();
    scheduler.pause();

    expect(scheduler.status().paused).toBe(true);

    scheduler.resume();
    expect(scheduler.status().paused).toBe(false);
  });

  it('one task failure does not prevent other tasks from running', async () => {
    const { scheduler } = createTestScheduler();
    const failFn = vi.fn().mockRejectedValue(new Error('crash'));
    const okFn = vi.fn().mockResolvedValue(undefined);

    scheduler.register({ id: 'bad', intervalMs: 5000, fn: failFn });
    scheduler.register({ id: 'good', intervalMs: 5000, fn: okFn });
    scheduler.start();

    await scheduler.runNow('bad');
    await scheduler.runNow('good');

    expect(okFn).toHaveBeenCalledTimes(1);
  });
});
