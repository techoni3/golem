import { openTrackerCoreCapability } from '@golem/persistence';
import { createTrackerCoreServices } from '@golem/tracker';

/**
 * Attach the typed tracker capability after the legacy opener has completed.
 * This is deliberately tracker-only: it has no runtime database, owner lock,
 * migration plan, or automatic apply side effect.
 */
export function attachTrackerCore(tracker, trackerPath, clock = { now: () => new Date().toISOString() }) {
  const storage = openTrackerCoreCapability(trackerPath);
  const services = createTrackerCoreServices({
    storage,
    clock,
    // The dashboard composition is the authenticated server-owned seam. The
    // request body never supplies this context, and the generic MCP/control
    // plane composition intentionally leaves it absent.
    trustedExceptionalCloseContext: {
      actor: 'human:dashboard',
      role: 'human',
      authenticated: true,
      source: 'dashboard',
    },
  });
  tracker.attachTrackerCore(services.compatibility);
  return Object.freeze({ services, close: () => storage.close() });
}
