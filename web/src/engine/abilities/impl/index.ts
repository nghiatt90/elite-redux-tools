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
import { HUB_ABILITIES } from './09-hub-abilities'
import { ALIAS_ABILITIES } from './10-aliases'
import { OFFENSIVE_MULTIPLIER_BATCH_D } from './11-offensive-multiplier-d'
import { ADDS_TYPE_ABILITIES } from './12-adds-type'
import { DEFENSIVE_MULTIPLIER_BATCH_C } from './13-defensive-multiplier-c'
import { ON_STAT_BATCH_A } from './14-on-stat-a'
import { ATE_FAMILY_AND_ONSTAB } from './15-ate-family-and-onstab'
import { TYPE_EFFECTIVENESS_ABILITIES } from './16-type-effectiveness'
import { CRIT_SWAPSPLIT_MISC } from './17-crit-swapsplit-misc'
import { OFFENSIVE_MULTIPLIER_BATCH_E } from './18-offensive-multiplier-e'
import { CHOOSE_STAT_ABILITIES } from './19-choose-stat'
import { MOVE_TYPE_AND_RECOIL_ABILITIES } from './20-move-type-and-recoil'
import { ALLY_ONLY_ABILITIES } from './21-ally-only'
import { HIGHER_RANK_ABILITIES } from './22-higher-rank'
import { MOLD_BREAKER_ABILITIES } from './23-mold-breaker'
import { PARENTAL_BOND_ABILITIES } from './24-parental-bond'
import { ABSORB_ABILITIES } from './25-absorb'
import { IMMUNE_ABILITIES } from './26-immune'
import { INFILTRATE_ABILITIES } from './27-infiltrate'
import { MODIFY_MOVE_FLAGS_ABILITIES } from './28-modify-move-flags'
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
registerAbilities(HUB_ABILITIES)
registerAbilities(ALIAS_ABILITIES)
registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_D)
registerAbilities(ADDS_TYPE_ABILITIES)
registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_C)
registerAbilities(ON_STAT_BATCH_A)
registerAbilities(ATE_FAMILY_AND_ONSTAB)
registerAbilities(TYPE_EFFECTIVENESS_ABILITIES)
registerAbilities(CRIT_SWAPSPLIT_MISC)
registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_E)
registerAbilities(CHOOSE_STAT_ABILITIES)
registerAbilities(MOVE_TYPE_AND_RECOIL_ABILITIES)
registerAbilities(ALLY_ONLY_ABILITIES)
registerAbilities(HIGHER_RANK_ABILITIES)
registerAbilities(MOLD_BREAKER_ABILITIES)
registerAbilities(PARENTAL_BOND_ABILITIES)
registerAbilities(ABSORB_ABILITIES)
registerAbilities(IMMUNE_ABILITIES)
registerAbilities(INFILTRATE_ABILITIES)
registerAbilities(MODIFY_MOVE_FLAGS_ABILITIES)

// Further Task 10 batches land here as they're ported, e.g.:
//   import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'
//   registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_B)

// Registered LAST: registerAbilities throws on a duplicate id, so an ability that's
// been ported to a real batch above but not yet deleted from 99-unmodelled.ts fails
// loudly here rather than silently keeping the stale stub.
registerAbilities(UNMODELLED_ABILITIES)
