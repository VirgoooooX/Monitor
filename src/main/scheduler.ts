// Per-task interval registry with mutex, error capture, and chained
// `setTimeout` scheduling.
//
// References:
//   - design.md §`scheduler.ts`
//   - design.md §Default intervals
//   - PLAN.md §scheduler.ts
//
// The scheduler intentionally does NOT depend on any concrete data
// store. Callers must inject a `CollectorHealthRecorder` so failures
// and runs are routed to the `collector_health` table without coupling
// the scheduler to the SQLite layer (task 1.4 is in flight in
// parallel).

/**
 * Side-effect interface the scheduler uses to persist run / failure
 * events. Implemented by the `collector_health` repository
 * (design.md §SQLite Schema, task 1.4).
 *
 * The scheduler swallows any exception thrown by these methods so a
 * misbehaving recorder cannot crash the tick loop.
 */
export interface CollectorHealthRecorder {
  recordRunStart(collectorId: string, at: number): void;
  recordRunSuccess(collectorId: string, at: number): void;
  recordRunFailure(collectorId: string, at: number, error: string): void;
}

/**
 * A task registered with the scheduler. Shape matches
 * design.md §`scheduler.ts`. `onError` exists for callers that want
 * extra side-effects on top of the scheduler's own health recording.
 */
export interface ScheduledTask {
  /** Stable id; unique per scheduler instance. */
  id: string;
  /** Base interval between ticks, in ms. Must be a positive finite number. */
  intervalMs: number;
  /** Tick implementation. Settlement of the returned promise marks tick end. */
  fn: () => Promise<void>;
  /**
   * Optional non-negative jitter window. The next-fire delay is
   * `intervalMs + Math.floor(rng() * jitterMs)`.
   */
  jitterMs?: number;
  /**
   * Optional callback invoked AFTER the recorder has been notified
   * of a thrown error. Exceptions thrown by `onError` are swallowed.
   */
  onError?: (e: unknown) => void;
}

/**
 * Per-task in-memory status snapshot. Pure projection of the
 * scheduler's internal state — does NOT read from `collector_health`.
 */
export interface ScheduledTaskStatus {
  id: string;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  inFlight: boolean;
  consecutiveFailures: number;
  /** Mirrors the scheduler-wide pause flag. Per-task pause is v2. */
  paused: boolean;
}

export interface SchedulerStatus {
  paused: boolean;
  tasks: ScheduledTaskStatus[];
}

/**
 * Public scheduler surface. See design.md §`scheduler.ts` for the
 * authoritative contract; per-method invariants are documented on
 * each member below.
 */
export interface Scheduler {
  /**
   * Add a task to the registry. Throws if `task.id` is already
   * registered or if interval / jitter values are invalid. If the
   * scheduler has already been started and is not paused, the new
   * task's first fire is scheduled immediately.
   */
  register(task: ScheduledTask): void;
  /**
   * Idempotent. Schedules the first fire of every registered task
   * (only when not paused).
   */
  start(): void;
  /**
   * Idempotent. Cancels every pending timer; in-flight ticks complete
   * naturally and their results are still recorded.
   */
  pause(): void;
  /**
   * Idempotent. Re-schedules every task's next fire. No-op when the
   * scheduler has not been started.
   */
  resume(): void;
  /**
   * Run the named task once, immediately. If a tick is already in
   * flight, drains it before starting a fresh tick. Returns the
   * promise of the fresh tick (NOT of any previous in-flight tick).
   *
   * `runNow` does NOT reschedule the next interval fire on its own;
   * any pending auto-scheduled timer continues to fire as normal.
   */
  runNow(id: string): Promise<void>;
  /** Snapshot of current state. Pure read; never mutates anything. */
  status(): SchedulerStatus;
}


/**
 * Dependencies the scheduler needs to operate. `rng` and `now` are
 * injectable for deterministic tests. Both default to standard
 * runtime sources.
 */
export interface SchedulerDeps {
  recorder: CollectorHealthRecorder;
  /** 0 <= rng() < 1; defaults to `Math.random`. */
  rng?: () => number;
  /** Epoch ms; defaults to `Date.now`. */
  now?: () => number;
}

interface TaskState {
  task: ScheduledTask;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Resolved promise of the currently in-flight tick, if any. */
  inFlight: Promise<void> | null;
  /** Handle for the next auto-scheduled fire, if any. */
  timer: ReturnType<typeof setTimeout> | null;
}

function validateTask(task: ScheduledTask): void {
  if (typeof task.id !== 'string' || task.id.length === 0) {
    throw new Error('scheduler.register: task.id must be a non-empty string');
  }
  if (
    typeof task.intervalMs !== 'number' ||
    !Number.isFinite(task.intervalMs) ||
    task.intervalMs <= 0
  ) {
    throw new Error(
      `scheduler.register(${task.id}): intervalMs must be a positive finite number`,
    );
  }
  if (task.jitterMs !== undefined) {
    if (
      typeof task.jitterMs !== 'number' ||
      !Number.isFinite(task.jitterMs) ||
      task.jitterMs < 0
    ) {
      throw new Error(
        `scheduler.register(${task.id}): jitterMs must be a non-negative finite number`,
      );
    }
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    return e.message || e.name || 'Error';
  }
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Construct a scheduler instance.
 *
 * The returned object satisfies design.md §`scheduler.ts`:
 *   - per-task mutex prevents reentry while a previous tick is
 *     in-flight; auto-fires that arrive during a tick are dropped
 *     (the queue does NOT stack)
 *   - every exception is caught, routed to the recorder, increments
 *     `consecutiveFailures`, and finally invokes `task.onError` if
 *     provided
 *   - `consecutiveFailures` resets to 0 on a successful tick
 *   - the next fire is scheduled at the END of the previous tick
 *     using a chained `setTimeout` (not `setInterval`) so jitter
 *     varies per tick and slow ticks naturally avoid overlap
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const recorder = deps.recorder;
  const rng = deps.rng ?? Math.random;
  const now = deps.now ?? Date.now;

  const tasks = new Map<string, TaskState>();
  let started = false;
  let paused = false;

  function nextDelay(task: ScheduledTask): number {
    const jitter = task.jitterMs;
    if (jitter === undefined || jitter <= 0) return task.intervalMs;
    // Math.floor(rng() * jitter) — rng() in [0, 1) so the upper bound is
    // jitter - 1 ms. This matches design.md §`scheduler.ts`.
    const r = rng();
    const offset = Math.floor((Number.isFinite(r) ? r : 0) * jitter);
    return task.intervalMs + offset;
  }

  function cancelTimer(state: TaskState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function scheduleNext(state: TaskState): void {
    if (!started || paused) return;
    cancelTimer(state);
    const delay = nextDelay(state.task);
    state.timer = setTimeout(() => {
      state.timer = null;
      // If a tick is already in flight (e.g. runNow drained it just
      // before this fire), skip — the queue does not stack.
      if (state.inFlight !== null) {
        scheduleNext(state);
        return;
      }
      // Fire-and-forget: tick() chains the next scheduling itself.
      void tick(state);
    }, delay);
    // `unref` is Node-only; in renderer-style runtimes it is absent.
    // Avoid keeping the event loop alive solely for the scheduler.
    const t = state.timer as { unref?: () => void } | null;
    if (t && typeof t.unref === 'function') t.unref();
  }

  async function tick(state: TaskState): Promise<void> {
    if (state.inFlight !== null) {
      // Reentry guard. Callers must await the existing promise.
      return state.inFlight;
    }
    const startedAt = now();
    state.lastRunAt = startedAt;
    try {
      recorder.recordRunStart(state.task.id, startedAt);
    } catch {
      // Recorder failures must not crash the loop.
    }

    const run = (async () => {
      try {
        await state.task.fn();
        const finishedAt = now();
        state.lastDurationMs = Math.max(0, finishedAt - startedAt);
        state.lastError = null;
        state.consecutiveFailures = 0;
        try {
          recorder.recordRunSuccess(state.task.id, finishedAt);
        } catch {
          /* swallow */
        }
      } catch (e) {
        const finishedAt = now();
        state.lastDurationMs = Math.max(0, finishedAt - startedAt);
        const message = describeError(e);
        state.lastError = message;
        state.consecutiveFailures += 1;
        try {
          recorder.recordRunFailure(state.task.id, finishedAt, message);
        } catch {
          /* swallow */
        }
        const onError = state.task.onError;
        if (onError !== undefined) {
          try {
            onError(e);
          } catch {
            /* swallow */
          }
        }
      }
    })();

    state.inFlight = run;
    try {
      await run;
    } finally {
      state.inFlight = null;
      // Chain the next fire from the END of this tick (regardless of
      // success/failure) so slow ticks naturally avoid overlap.
      scheduleNext(state);
    }
  }

  function getState(id: string): TaskState {
    const state = tasks.get(id);
    if (state === undefined) {
      throw new Error(`scheduler: no task registered with id '${id}'`);
    }
    return state;
  }

  return {
    register(task: ScheduledTask): void {
      validateTask(task);
      if (tasks.has(task.id)) {
        throw new Error(
          `scheduler.register: task '${task.id}' is already registered`,
        );
      }
      const state: TaskState = {
        task,
        lastRunAt: null,
        lastDurationMs: null,
        lastError: null,
        consecutiveFailures: 0,
        inFlight: null,
        timer: null,
      };
      tasks.set(task.id, state);
      // If the scheduler is already running and not paused, start the
      // new task's clock immediately.
      if (started && !paused) scheduleNext(state);
    },

    start(): void {
      if (started) return;
      started = true;
      if (paused) return;
      for (const state of tasks.values()) scheduleNext(state);
    },

    pause(): void {
      if (paused) return;
      paused = true;
      for (const state of tasks.values()) cancelTimer(state);
      // In-flight ticks complete naturally and still record results.
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      if (!started) return;
      for (const state of tasks.values()) {
        // If a tick is currently running, scheduleNext will be invoked
        // when it finishes; avoid double-scheduling here.
        if (state.inFlight === null) scheduleNext(state);
      }
    },

    async runNow(id: string): Promise<void> {
      const state = getState(id);
      // Drain any in-flight tick first, then run a fresh one. This
      // matches the contract: runNow always reflects the work it
      // launched, never a previously-running tick.
      while (state.inFlight !== null) {
        await state.inFlight;
      }
      // Cancel any pending auto-fire so the manual run does not race
      // with an imminent timer fire.
      cancelTimer(state);
      await tick(state);
    },

    status(): SchedulerStatus {
      const out: ScheduledTaskStatus[] = [];
      for (const state of tasks.values()) {
        out.push({
          id: state.task.id,
          lastRunAt: state.lastRunAt,
          lastDurationMs: state.lastDurationMs,
          lastError: state.lastError,
          inFlight: state.inFlight !== null,
          consecutiveFailures: state.consecutiveFailures,
          paused,
        });
      }
      return { paused, tasks: out };
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton accessor (parallels the secrets module pattern, task 1.6).
// ---------------------------------------------------------------------------

let _scheduler: Scheduler | null = null;

/**
 * Initialize the process-wide scheduler. Idempotent within a single
 * call — calling twice with different deps throws to surface
 * misconfiguration. Tests may call `resetSchedulerForTesting` to drop
 * the cached instance.
 */
export function initScheduler(deps: SchedulerDeps): Scheduler {
  if (_scheduler !== null) {
    throw new Error('scheduler: initScheduler has already been called');
  }
  _scheduler = createScheduler(deps);
  return _scheduler;
}

/**
 * Access the process-wide scheduler. Throws if `initScheduler` has
 * not been called yet — callers should always go through
 * `initScheduler` during boot (design.md §Compact Window Boot).
 */
export function getScheduler(): Scheduler {
  if (_scheduler === null) {
    throw new Error('scheduler: initScheduler has not been called');
  }
  return _scheduler;
}

/**
 * Drop the cached singleton. For unit tests only; production callers
 * should never need this.
 */
export function resetSchedulerForTesting(): void {
  _scheduler = null;
}
