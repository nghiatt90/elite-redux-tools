/**
 * Boss fight progression definitions.
 *
 * Rules and citations sourced from Elite Redux decomp at pinned commit
 * (pipeline/.upstream/eliteredux-source/data/maps/<Map>/scripts.pory).
 *
 * Note: pipeline/.upstream/eliteredux-source/data/maps/MeteorFalls_HaxorusRoom/scripts.pory:554-563
 * (EventScript_Debug_CheatStart) sets all eight badge flags. It is a debug script: ignored for progression.
 */

import { type GymNumber, type ProgressionRow } from './progression'

export interface FightRow extends ProgressionRow {
  trainerIds: string[] // every id of the fight; fightId === trainerIds[0] (first in script order)
  format: 'single' | 'double' | 'tag' | 'multi_2_vs_2'
  chainId?: string // consecutive battles with no heal in between
  gymNumber?: GymNumber // set on the gym leader rows (Gym N leader row has gymNumber N)
  mandatory: boolean
  mandatoryCitation: string // always non-empty, also when mandatory is false
}

export const FIGHTS: readonly FightRow[] = [
  // --- Rival (4 fights) ---
  {
    fightId: 'TRAINER_MAY_ROUTE_103_TORCHIC',
    trainerIds: ['TRAINER_MAY_ROUTE_103_TORCHIC'],
    format: 'single',
    requiredBefore: [],
    mayBefore: [],
    evidence:
      'Route103:44-47,108: switch VAR_STARTER_MON branches to Route103_EventScript_StartMayBattleTorchic.',
    mandatory: true,
    mandatoryCitation:
      'Route103:255 / OldaleTown:13: victory sets FLAG_ADVENTURE_STARTED which unblocks Oldale Town west path.',
  },
  {
    fightId: 'TRAINER_MAY_RUSTBORO_TORCHIC',
    trainerIds: ['TRAINER_MAY_RUSTBORO_TORCHIC'],
    format: 'single',
    requiredBefore: [1],
    mayBefore: [],
    evidence:
      'RustboroCity:874,900 / Route104:158,183: switch VAR_STARTER_MON reaches May battle after Devon goods recovery.',
    mandatory: false,
    mandatoryCitation:
      'RustboroCity:853-858 / Route104:147-151: prompt uses MSGBOX_YESNO and player may decline without blocking story.',
  },
  {
    fightId: 'TRAINER_MAY_ROUTE_110_TORCHIC',
    trainerIds: ['TRAINER_MAY_ROUTE_110_TORCHIC'],
    format: 'single',
    requiredBefore: [1],
    mayBefore: [2],
    evidence:
      'Route110:433,445: switch VAR_STARTER_MON branches to Route110_EventScript_MayBattleTorchic on path north to Mauville.',
    mandatory: true,
    mandatoryCitation:
      'Route110:393-435: coordinate trigger across Route110 path north to Mauville with no opt-out or bypass.',
  },
  {
    fightId: 'TRAINER_MAY_ROUTE_119_TORCHIC',
    trainerIds: ['TRAINER_MAY_ROUTE_119_TORCHIC'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [],
    evidence:
      'Route119:92,101: switch VAR_STARTER_MON branches to Route119_EventScript_BattleMayTorchic after Weather Institute.',
    mandatory: true,
    mandatoryCitation:
      'Route119:36-75: coordinate trigger on Route 119 bridge blocks progress to Fortree City until defeated.',
  },

  // --- Gym leaders (8 fights) ---
  {
    fightId: 'TRAINER_ROXANNE_1',
    trainerIds: ['TRAINER_ROXANNE_1'],
    format: 'single',
    gymNumber: 1,
    requiredBefore: [],
    mayBefore: [],
    evidence:
      'RustboroCity_Gym:548/551/554: leader battle; sets FLAG_BADGE01_GET at RustboroCity_Gym:15.',
    mandatory: true,
    mandatoryCitation:
      'RustboroCity_Gym:15 / RustboroCity:45: Stone Badge required to trigger Devon Goods thief and advance story.',
  },
  {
    fightId: 'TRAINER_BRAWLY_1',
    trainerIds: ['TRAINER_BRAWLY_1'],
    format: 'single',
    gymNumber: 2,
    requiredBefore: [1],
    mayBefore: [3, 4],
    evidence:
      'DewfordTown_Gym:719/722/725: leader battle; sets FLAG_BADGE02_GET at DewfordTown_Gym:161.',
    mandatory: true,
    mandatoryCitation:
      "gates Norman's intro at PetalburgCity_Gym:1738 (requires FLAG_BADGE02_GET along with badges 1, 3, and 4 before Gym 5).",
  },
  {
    fightId: 'TRAINER_WATTSON_1',
    trainerIds: ['TRAINER_WATTSON_1'],
    format: 'single',
    gymNumber: 3,
    requiredBefore: [1],
    mayBefore: [2, 4],
    evidence:
      'MauvilleCity_Gym:586/589/592: leader battle; sets FLAG_BADGE03_GET at MauvilleCity_Gym:69.',
    mandatory: true,
    mandatoryCitation:
      "gates Norman's intro at PetalburgCity_Gym:1738 (requires FLAG_BADGE03_GET along with badges 1, 2, and 4 before Gym 5).",
  },
  {
    fightId: 'TRAINER_FLANNERY_1',
    trainerIds: ['TRAINER_FLANNERY_1'],
    format: 'single',
    gymNumber: 4,
    requiredBefore: [1],
    mayBefore: [2, 3],
    evidence:
      'LavaridgeTown_Gym_1F:638/641/644: leader battle; sets FLAG_BADGE04_GET at LavaridgeTown_Gym_1F:73.',
    mandatory: true,
    mandatoryCitation:
      "gates Norman's intro at PetalburgCity_Gym:1738 (requires FLAG_BADGE04_GET along with badges 1, 2, and 3 before Gym 5).",
  },
  {
    fightId: 'TRAINER_NORMAN_1',
    trainerIds: ['TRAINER_NORMAN_1'],
    format: 'single',
    gymNumber: 5,
    requiredBefore: [1, 2, 3, 4],
    mayBefore: [],
    holdsBracelet: true,
    evidence:
      'PetalburgCity_Gym:1741-1763 case 6 gives ITEM_MEGA_BRACELET (:1760) on first talk before the battle, while FLAG_BADGE05_GET is only set post-battle at :410; during the fight badges 1-4 are held and bracelet is held.',
    mandatory: true,
    mandatoryCitation:
      'PetalburgCity_Gym:410,481: Balance Badge required to trigger Wally father giving HM03 Surf.',
  },
  {
    fightId: 'TRAINER_WINONA_1',
    trainerIds: ['TRAINER_WINONA_1'],
    format: 'single',
    gymNumber: 6,
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [7, 8],
    evidence:
      'FortreeCity/map.json:178 warps into FortreeCity_GymReworked:91 which calls FortreeCity_Gym_EventScript_Winona at FortreeCity_Gym:518; sets FLAG_BADGE06_GET at :30.',
    mandatory: true,
    mandatoryCitation:
      'EverGrandeCity_PokemonLeague_1F:39-57 door guard checks goto_if_unset FLAG_BADGE06_GET (:56); script comment at :40-41 ("Its assumed the player has the remaining badges") is what makes gyms 1-8 mandatory in the legal-subset test as an assumption in a comment, not an explicit flag check.',
  },
  {
    fightId: 'TRAINER_TATE_AND_LIZA_1',
    trainerIds: ['TRAINER_TATE_AND_LIZA_1'],
    format: 'double',
    gymNumber: 7,
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [6],
    evidence:
      'MossdeepCity_Gym:1009/1012/1015: double battle with forcedDouble; sets FLAG_BADGE07_GET at MossdeepCity_Gym:71.',
    mandatory: true,
    mandatoryCitation:
      'MossdeepCity_Gym:85: sets VAR_MOSSDEEP_SPACE_CENTER_STATE to 1, triggering Space Center story and unlocking HM08 Dive.',
  },
  {
    fightId: 'TRAINER_JUAN_1',
    trainerIds: [
      'TRAINER_JUAN_1',
      'TRAINER_WALLACE',
      'TRAINER_JUAN_5',
      'TRAINER_WALLACE_5',
    ],
    format: 'tag',
    chainId: 'sootopolis-gym-juan-wallace',
    gymNumber: 8,
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'SootopolisCity_Gym_1F:278 chains starttagbattle stage 1 into stage 2 at :288 under FLAG_SYS_DISABLE_AUTOHEAL; sets FLAG_BADGE08_GET at :319.',
    mandatory: true,
    mandatoryCitation:
      'SootopolisCity_Gym_1F:319: Rain Badge required to use Waterfall to reach Ever Grande City.',
  },

  // --- Team Aqua (4 fights) ---
  {
    fightId: 'TRAINER_GRUNT_PETALBURG_WOODS',
    trainerIds: ['TRAINER_GRUNT_PETALBURG_WOODS'],
    format: 'single',
    requiredBefore: [],
    mayBefore: [],
    evidence:
      'PetalburgWoods:33,69: scripted ambush on Devon researcher blocking path north through woods.',
    mandatory: true,
    mandatoryCitation:
      'PetalburgWoods:33,69: unavoidable encounter blocking the only exit north to Rustboro City.',
  },
  {
    fightId: 'TRAINER_GRUNT_RUSTURF_TUNNEL',
    trainerIds: ['TRAINER_GRUNT_RUSTURF_TUNNEL'],
    format: 'single',
    requiredBefore: [1],
    mayBefore: [],
    evidence:
      'RusturfTunnel:322: battle with Devon goods thief to rescue Peeko for Mr. Briney.',
    mandatory: true,
    mandatoryCitation:
      'RusturfTunnel:322-327: drops Devon Goods and rescues Peeko, required for Mr. Briney to sail.',
  },
  {
    fightId: 'TRAINER_SHELLY_WEATHER_INSTITUTE',
    trainerIds: ['TRAINER_SHELLY_WEATHER_INSTITUTE'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [],
    evidence:
      'Route119_WeatherInstitute_2F:52: admin battle on 2F of Weather Institute.',
    mandatory: true,
    mandatoryCitation:
      'Route119_WeatherInstitute_2F:76: sets FLAG_HIDE_ROUTE_119_TEAM_AQUA, clearing grunts blocking Route 119 bridge.',
  },
  {
    fightId: 'TRAINER_MATT',
    trainerIds: ['TRAINER_MATT'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [6],
    evidence:
      'AquaHideout_B2F:30: admin battle guarding submarine escape in Aqua Hideout.',
    mandatory: true,
    mandatoryCitation:
      'AquaHideout_B2F:53: sets FLAG_HIDE_LILYCOVE_CITY_AQUA_GRUNTS, unblocking Route 124 sea route to Mossdeep.',
  },

  // --- Archie group (5 fights) ---
  {
    fightId: 'TRAINER_GRUNT_MUSEUM_1',
    trainerIds: ['TRAINER_GRUNT_MUSEUM_1'],
    format: 'single',
    chainId: 'oceanic-museum-2f',
    requiredBefore: [1],
    mayBefore: [2],
    evidence:
      'SlateportCity_OceanicMuseum_2F:43: first of three consecutive battles guarding Captain Stern.',
    mandatory: true,
    mandatoryCitation:
      'SlateportCity_OceanicMuseum_2F:94: chain leads to delivering Devon Goods and clearing Route 110 blockers.',
  },
  {
    fightId: 'TRAINER_GRUNT_MUSEUM_2',
    trainerIds: ['TRAINER_GRUNT_MUSEUM_2'],
    format: 'single',
    chainId: 'oceanic-museum-2f',
    requiredBefore: [1],
    mayBefore: [2],
    evidence:
      'SlateportCity_OceanicMuseum_2F:51: second consecutive battle with no heal before Archie.',
    mandatory: true,
    mandatoryCitation:
      'SlateportCity_OceanicMuseum_2F:94: chain leads to delivering Devon Goods and clearing Route 110 blockers.',
  },
  {
    fightId: 'TRAINER_ARCHIE_SLATEPORT',
    trainerIds: ['TRAINER_ARCHIE_SLATEPORT'],
    format: 'single',
    chainId: 'oceanic-museum-2f',
    requiredBefore: [1],
    mayBefore: [2],
    evidence:
      'SlateportCity_OceanicMuseum_2F:70: Archie battle; HealPlayerParty at :69 is commented out in source.',
    mandatory: true,
    mandatoryCitation:
      'SlateportCity_OceanicMuseum_2F:94,97: sets FLAG_HIDE_ROUTE_110_TEAM_AQUA and FLAG_DELIVERED_DEVON_GOODS.',
  },
  {
    fightId: 'TRAINER_ARCHIE_MT_PYRE',
    trainerIds: ['TRAINER_ARCHIE_MT_PYRE'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [6],
    evidence:
      'MtPyre_Summit:702: summit confrontation after Archie seizes the Blue Orb.',
    mandatory: true,
    mandatoryCitation:
      'MtPyre_Summit:777: defeating Archie triggers old lady giving ITEM_MAGMA_EMBLEM to open Magma Hideout.',
  },
  {
    fightId: 'TRAINER_ARCHIE',
    trainerIds: ['TRAINER_ARCHIE'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'SeafloorCavern_Room9:72: battle before Kyogre awakening in Seafloor Cavern.',
    mandatory: true,
    mandatoryCitation:
      'SeafloorCavern_Room9:72,217: awakens Kyogre, advancing story to the Sootopolis drought/flood crisis.',
  },

  // --- Team Magma (5 fights) ---
  {
    fightId: 'TRAINER_COURTNEY_METEOR_FALLS',
    trainerIds: [
      'TRAINER_COURTNEY_METEOR_FALLS',
      'TRAINER_GRUNT_METEOR_FALLS',
    ],
    format: 'multi_2_vs_2',
    requiredBefore: [1],
    mayBefore: [2, 3],
    evidence:
      'MeteorFalls_1F_1R:193,202,211: multi_2_vs_2 tag battle alongside rival against Courtney and grunt.',
    mandatory: true,
    mandatoryCitation:
      'MeteorFalls_1F_1R:102: sets FLAG_HIDE_ROUTE_112_TEAM_MAGMA, clearing cable car blockers to Mt Chimney.',
  },
  {
    fightId: 'TRAINER_GRUNT_SUNHOLLOW_1',
    trainerIds: ['TRAINER_GRUNT_SUNHOLLOW_1'],
    format: 'single',
    requiredBefore: [1, 4],
    mayBefore: [2, 3],
    evidence:
      'Route111_SunhollowRuins:193: Magma Grunt tagged in by Norman at ruins entrance; requires Flannery badge 4 per LavaridgeTown:527.',
    mandatory: true,
    mandatoryCitation:
      'PetalburgCity:787 / Route111_SunhollowRuins_Museum:1145: Norman remains in Sunhollow until story finished.',
  },
  {
    fightId: 'TRAINER_COURTNEY_SUNHOLLOW',
    trainerIds: ['TRAINER_COURTNEY_SUNHOLLOW'],
    format: 'single',
    requiredBefore: [1, 4],
    mayBefore: [2, 3],
    evidence:
      'Route111_SunhollowRuins_Museum:693: Courtney boss fight inside Sunhollow Museum.',
    mandatory: true,
    mandatoryCitation:
      'Route111_SunhollowRuins_Museum:1145: sets FLAG_FINISHED_SUNHOLLOW_STORY, returning Norman to Petalburg Gym.',
  },
  {
    fightId: 'TRAINER_GRUNT_SPACE_CENTER_2',
    trainerIds: ['TRAINER_GRUNT_SPACE_CENTER_2'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'MossdeepCity_SpaceCenter_1F:246: grunt guarding stairs to 2F; requires badge 7 per MossdeepCity_Gym:85.',
    mandatory: true,
    mandatoryCitation:
      'MossdeepCity_SpaceCenter_1F:258: sets VAR_MOSSDEEP_SPACE_CENTER_STAIR_GUARD_STATE to 2, unblocking stairs.',
  },
  {
    fightId: 'TRAINER_GRUNT_SPACE_CENTER_5',
    trainerIds: [
      'TRAINER_GRUNT_SPACE_CENTER_5',
      'TRAINER_GRUNT_SPACE_CENTER_6',
      'TRAINER_GRUNT_SPACE_CENTER_7',
    ],
    format: 'single',
    chainId: 'mossdeep-space-center-2f-grunts',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'MossdeepCity_SpaceCenter_2F:72,78,84: three consecutive battles under FLAG_SYS_DISABLE_AUTOHEAL.',
    mandatory: true,
    mandatoryCitation:
      'MossdeepCity_SpaceCenter_2F:88: sets VAR_MOSSDEEP_SPACE_CENTER_STATE to 2, advancing toward Maxie room.',
  },

  // --- Maxie (3 fights) ---
  {
    fightId: 'TRAINER_MAXIE_MT_CHIMNEY',
    trainerIds: ['TRAINER_MAXIE_MT_CHIMNEY'],
    format: 'single',
    requiredBefore: [1],
    mayBefore: [2, 3],
    evidence:
      'MtChimney:54: Maxie battle at Mt Chimney crater.',
    mandatory: true,
    mandatoryCitation:
      'MtChimney:63: sets FLAG_HIDE_MT_CHIMNEY_TEAM_MAGMA, clearing Jagged Pass blocker to Lavaridge Town.',
  },
  {
    fightId: 'TRAINER_MAXIE_MAGMA_HIDEOUT',
    trainerIds: ['TRAINER_MAXIE_MAGMA_HIDEOUT'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [6],
    evidence:
      'MagmaHideout_4F:57: Maxie battle in front of Groudon chamber in Magma Hideout.',
    mandatory: true,
    mandatoryCitation:
      'MagmaHideout_4F:85: sets VAR_SLATEPORT_CITY_STATE to 1, triggering submarine theft in Slateport.',
  },
  {
    fightId: 'TRAINER_MAXIE_MOSSDEEP',
    trainerIds: [
      'TRAINER_MAXIE_MOSSDEEP',
      'TRAINER_COURTNEY_MOSSDEEP',
    ],
    format: 'multi_2_vs_2',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'MossdeepCity_SpaceCenter_2F:274: multi_2_vs_2 alongside Steven against Maxie and Courtney.',
    mandatory: true,
    mandatoryCitation:
      'MossdeepCity_SpaceCenter_2F:313,319: rewards ITEM_HM08_DIVE and clears Seafloor Cavern entrance grunt.',
  },

  // --- Steven (3 fights) ---
  {
    fightId: 'TRAINER_STEVEN_GRANITE_CAVE',
    trainerIds: ['TRAINER_STEVEN_GRANITE_CAVE'],
    format: 'single',
    requiredBefore: [1],
    mayBefore: [2],
    evidence:
      'GraniteCave_StevensRoom:136: battle before letter handover.',
    mandatory: true,
    mandatoryCitation:
      'GraniteCave_StevensRoom:136 / DewfordTown:29: letter delivery required for Mr. Briney to sail to Slateport.',
  },
  {
    fightId: 'TRAINER_STEVEN_ROUTE118',
    trainerIds: ['TRAINER_STEVEN_ROUTE118'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5],
    mayBefore: [],
    evidence:
      'Route118:484: Steven battle on Route 118 beach path heading east toward Route 119.',
    mandatory: true,
    mandatoryCitation:
      'Route118:478-504: unavoidable coordinate trigger across Route 118 beach path heading east.',
  },
  {
    fightId: 'TRAINER_STEVEN',
    trainerIds: ['TRAINER_STEVEN'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 6, 7, 8],
    mayBefore: [],
    evidence:
      'EverGrandeCity_ChampionsRoom:325: Champion battle on the !FLAG_SYS_GAME_CLEAR branch.',
    mandatory: true,
    mandatoryCitation:
      'EverGrandeCity_ChampionsRoom:325: final mandatory story battle to achieve game clear.',
  },

  // --- Wally (2 fights) ---
  {
    fightId: 'TRAINER_WALLY_VR_1',
    trainerIds: ['TRAINER_WALLY_VR_1'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 7, 8],
    mayBefore: [6],
    evidence:
      'VictoryRoadRework:100: Wally battle upon entering Victory Road.',
    mandatory: true,
    mandatoryCitation:
      'VictoryRoadRework:68-100: unavoidable coordinate trigger upon entering Victory Road.',
  },
  {
    fightId: 'TRAINER_WALLY_VR_2',
    trainerIds: ['TRAINER_WALLY_VR_2'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 7, 8],
    mayBefore: [6],
    evidence:
      'VictoryRoadRework:104: trainerbattle_rematch immediate rematch option with Wally.',
    mandatory: false,
    mandatoryCitation:
      'VictoryRoadRework:101-105: optional rematch battle that does not gate path through Victory Road hole.',
  },

  // --- Gym 8's own trainers (4 fights) ---
  {
    fightId: 'TRAINER_TIFFANY',
    trainerIds: ['TRAINER_TIFFANY'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'SootopolisCity_Gym_B1F:252: individual gym trainer in basement.',
    mandatory: true,
    mandatoryCitation:
      'SootopolisCity_Gym_1F:273,484: SootopolisCity_Gym_EventScript_CheckTrainers blocks Juan battle until Tiffany is defeated.',
  },
  {
    fightId: 'TRAINER_BRIDGET',
    trainerIds: ['TRAINER_BRIDGET', 'TRAINER_CRISSY', 'TRAINER_BETHANY'],
    format: 'single',
    chainId: 'sootopolis-gym-bottom-group',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'SootopolisCity_Gym_1F:528-564: bottom group; single format selected as two-on-one branch uses identical trainer set; case 1 disables autoheal.',
    mandatory: true,
    mandatoryCitation:
      'SootopolisCity_Gym_1F:273,483,485,488: SootopolisCity_Gym_EventScript_CheckTrainers blocks Juan battle until Bridget, Crissy, and Bethany are defeated.',
  },
  {
    fightId: 'TRAINER_DAPHNE',
    trainerIds: ['TRAINER_DAPHNE', 'TRAINER_CONNIE', 'TRAINER_ANDREA'],
    format: 'single',
    chainId: 'sootopolis-gym-middle-group',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'SootopolisCity_Gym_1F:603-619: middle group; single format selected as two-on-one branch uses identical trainer set; case 1 disables autoheal.',
    mandatory: true,
    mandatoryCitation:
      'SootopolisCity_Gym_1F:273,479,480,482: SootopolisCity_Gym_EventScript_CheckTrainers blocks Juan battle until Daphne, Connie, and Andrea are defeated.',
  },
  {
    fightId: 'TRAINER_OLIVIA',
    trainerIds: ['TRAINER_OLIVIA', 'TRAINER_BRIANNA', 'TRAINER_ANNIKA'],
    format: 'single',
    chainId: 'sootopolis-gym-top-group',
    requiredBefore: [1, 2, 3, 4, 5, 7],
    mayBefore: [6],
    evidence:
      'SootopolisCity_Gym_1F:652-668: top group; single format selected as two-on-one branch uses identical trainer set; case 1 disables autoheal.',
    mandatory: true,
    mandatoryCitation:
      'SootopolisCity_Gym_1F:273,481,486,487: SootopolisCity_Gym_EventScript_CheckTrainers blocks Juan battle until Olivia, Brianna, and Annika are defeated.',
  },

  // --- Elite Four (4 fights) ---
  {
    fightId: 'TRAINER_SIDNEY',
    trainerIds: ['TRAINER_SIDNEY'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 6, 7, 8],
    mayBefore: [],
    evidence:
      'EverGrandeCity_SidneysRoom:56: first Elite Four room.',
    mandatory: true,
    mandatoryCitation:
      'EverGrandeCity_SidneysRoom:56: required to unlock second Elite Four room.',
  },
  {
    fightId: 'TRAINER_PHOEBE',
    trainerIds: ['TRAINER_PHOEBE'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 6, 7, 8],
    mayBefore: [],
    evidence:
      'EverGrandeCity_PhoebesRoom:49: second Elite Four room.',
    mandatory: true,
    mandatoryCitation:
      'EverGrandeCity_PhoebesRoom:49: required to unlock third Elite Four room.',
  },
  {
    fightId: 'TRAINER_GLACIA',
    trainerIds: ['TRAINER_GLACIA'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 6, 7, 8],
    mayBefore: [],
    evidence:
      'EverGrandeCity_GlaciasRoom:49: third Elite Four room.',
    mandatory: true,
    mandatoryCitation:
      'EverGrandeCity_GlaciasRoom:49: required to unlock fourth Elite Four room.',
  },
  {
    fightId: 'TRAINER_DRAKE',
    trainerIds: ['TRAINER_DRAKE'],
    format: 'single',
    requiredBefore: [1, 2, 3, 4, 5, 6, 7, 8],
    mayBefore: [],
    evidence:
      'EverGrandeCity_DrakesRoom:50: fourth Elite Four room.',
    mandatory: true,
    mandatoryCitation:
      'EverGrandeCity_DrakesRoom:50: required to unlock Champion room.',
  },
]
