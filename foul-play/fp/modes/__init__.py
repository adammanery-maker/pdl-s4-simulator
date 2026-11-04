from fp.constants import BattleType
from fp.config import FoulPlayConfig
from fp.modes.base import BattleMode
from fp.modes.battle_factory import BattleFactoryMode
from fp.modes.bss import BSSMode
from fp.modes.random_battle import RandomBattleMode
from fp.modes.standard_battle import StandardBattleMode

BATTLE_MODES = {
    BattleType.RANDOM_BATTLE: RandomBattleMode(),
    BattleType.STANDARD_BATTLE: StandardBattleMode(),
    BattleType.BATTLE_FACTORY: BattleFactoryMode(),
    BattleType.BSS: BSSMode(),
}


def battle_mode(battle_type: BattleType) -> BattleMode:
    if battle_type == BattleType.STANDARD_BATTLE:
        standard_mode = BATTLE_MODES[battle_type]
        if standard_mode.is_pdl_s4 != FoulPlayConfig.format_spec.pdl_s4:
            BATTLE_MODES[battle_type] = StandardBattleMode()
    return BATTLE_MODES[battle_type]
