import type { FormatList } from '../sim/dex-formats';

export const PDL_FORMAT_ID = 'gen9pdls4';

/**
 * January 2026 Gen 9 NU's non-tier restrictions. Tier bans are deliberately
 * absent: PDL roster ownership, not current Smogon tier, determines species
 * eligibility.
 */
export const PDL_NU_NON_TIER_BANS = [
	'Arena Trap', 'Moody', 'Shadow Tag', "King's Rock", 'Razor Fang',
	'Baton Pass', 'Last Respects', 'Shed Tail', 'Light Clay', 'Drought', 'Quick Claw',
];

export const PDL_FORMATS: FormatList = [
	{
		section: 'PDL S4',
	},
	{
		name: '[Gen 9] PDL S4',
		mod: 'gen9',
		searchShow: false,
		ruleset: [
			'Standard NatDex', 'Sleep Moves Clause', '!Sleep Clause Mod',
			'Min Team Size = 6', 'Max Team Size = 6', 'Z-Move Clause', 'Dynamax Clause',
		],
		banlist: PDL_NU_NON_TIER_BANS,
		onBegin() {
			for (const pokemon of this.getAllPokemon()) {
				pokemon.canMegaEvo = null;
				pokemon.canUltraBurst = null;
			}
		},
		onValidateSet(set) {
			const species = this.dex.species.get(set.species);
			const item = this.dex.items.get(set.item);
			if (species.isMega || species.isPrimal || species.forme === 'Ultra' || item.megaStone) {
				return [`${set.name || set.species} cannot use Mega Evolution, Primal Reversion, or Ultra Burst in PDL S4.`];
			}
		},
	},
];
