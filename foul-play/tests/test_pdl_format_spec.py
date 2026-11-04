from fp.constants import BattleType
from fp.format_spec import FormatSpec


def test_pdl_s4_is_a_national_dex_standard_battle_format():
    spec = FormatSpec.from_format_string("gen9pdls4")

    assert spec.gen_number == 9
    assert spec.battle_type == BattleType.STANDARD_BATTLE
    assert spec.national_dex
    assert spec.pdl_s4


def test_non_pdl_formats_retain_their_existing_metadata():
    spec = FormatSpec.from_format_string("gen9ou")

    assert not spec.national_dex
    assert not spec.pdl_s4
