// Assembles every ability batch into the registry. Import this module once (e.g.
// from calculate.ts, once ability dispatch is actually wired in) to populate
// lookupAbility()/allRegisteredAbilities() for the whole app.

import { registerAbilities } from '../registry'
import { DECLARATIVE_ABILITIES } from './00-flags'
import { OFFENSIVE_MULTIPLIER_BATCH_A } from './01-offensive-multiplier-a'
import { DEFENSIVE_MULTIPLIER_BATCH_A } from './02-defensive-multiplier-a'
import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'
import { CRIT_BATTLE_A } from './04-crit-a'
import { ATE_ABILITIES } from './05-ate-abilities'
import { OFFENSIVE_MULTIPLIER_BATCH_C } from './06-offensive-multiplier-c'
import { DEFENSIVE_MULTIPLIER_BATCH_B } from './07-defensive-multiplier-b'
import { SWARM_FAMILY } from './08-swarm-family'
import { UNMODELLED_ABILITIES } from './99-unmodelled'

registerAbilities(DECLARATIVE_ABILITIES)
registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_A)
registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_A)
registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_B)
registerAbilities(CRIT_BATTLE_A)
registerAbilities(ATE_ABILITIES)
registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_C)
registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_B)
registerAbilities(SWARM_FAMILY)

// Further Task 10 batches land here as they're ported, e.g.:
//   import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'
//   registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_B)

// Registered LAST: registerAbilities throws on a duplicate id, so an ability that's
// been ported to a real batch above but not yet deleted from 99-unmodelled.ts fails
// loudly here rather than silently keeping the stale stub.
registerAbilities(UNMODELLED_ABILITIES)
