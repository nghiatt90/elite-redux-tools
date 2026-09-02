// Assembles every ability batch into the registry. Import this module once (e.g.
// from calculate.ts, once ability dispatch is actually wired in) to populate
// lookupAbility()/allRegisteredAbilities() for the whole app.

import { registerAbilities } from '../registry'
import { DECLARATIVE_ABILITIES } from './00-flags'
import { UNMODELLED_ABILITIES } from './99-unmodelled'

registerAbilities(DECLARATIVE_ABILITIES)

// Task 10 batches land here as they're ported, e.g.:
//   import { OFFENSIVE_MULTIPLIER_BATCH_1 } from './01-offensive-multiplier-a'
//   registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_1)

// Registered LAST: registerAbilities throws on a duplicate id, so an ability that's
// been ported to a real batch above but not yet deleted from 99-unmodelled.ts fails
// loudly here rather than silently keeping the stale stub.
registerAbilities(UNMODELLED_ABILITIES)
