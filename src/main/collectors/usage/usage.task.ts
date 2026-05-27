import type { ScheduledTask } from '../../scheduler';
import type { SettingsRepository, UsageEventsRepository, CollectorHealthRepository } from '../../store/repositories';
import { type UsageCollector, runUsageCollector } from './Collector';

export const USAGE_TASK_ID = 'usage';

export interface UsageCollectorTaskDeps {
  collectors: UsageCollector[];
  repositories: {
    usageEvents: UsageEventsRepository;
    settings: SettingsRepository;
    collectorHealth: CollectorHealthRepository;
  };
  getIntervalMs: () => number;
  onAfterTick?: () => void;
  now?: () => number;
}

export function createUsageCollectorTask(deps: UsageCollectorTaskDeps): ScheduledTask {
  return {
    id: USAGE_TASK_ID,
    intervalMs: deps.getIntervalMs(),
    fn: async () => {
      const now = (deps.now ?? Date.now)();
      for (const collector of deps.collectors) {
        await runUsageCollector(collector, {
          settings: deps.repositories.settings,
          collectorHealth: deps.repositories.collectorHealth,
          usageEvents: deps.repositories.usageEvents,
          now,
        });
      }
      deps.onAfterTick?.();
    },
  };
}
