/**
 * Private composition entry point.  The workspace boundary guard permits this
 * subpath only to @golem/control-plane, which turns it into the one writer
 * capability available to application composition.
 */
export { openPersistenceForControlPlane } from "./owner.js";
