from __future__ import annotations

from collections import defaultdict

from fp.battle.helpers import normalize_name
from fp.data.sets.base import PokemonMoveset, PokemonSet, PokemonSets
from fp.data.sets.team_datasets import TeamDatasets
from fp.format_spec import FormatSpec
from fp.pdl.belief_data import PdlBeliefData


class PdlTeamDatasets(TeamDatasets):
    """A TeamDatasets implementation whose only source is a local PDL snapshot."""

    def __init__(self, belief: PdlBeliefData):
        super().__init__()
        self.belief = belief
        self.uses_weighted_set_counts = True

    def _get_sets_dict(self):
        return {
            species: {
                candidate.encoded: candidate.weight
                for candidate in candidates
            }
            for species, candidates in self.belief.candidates.items()
        }

    def apply_posterior_weights(
        self, species: str, posterior_weights: dict[str, float]
    ) -> None:
        """Refresh complete-set sampling counts from an observation-only posterior.

        ``TeamDatasets`` remains the owner of all existing public-state
        compatibility filtering.  This method only changes the counts on the
        already-correlated PDL templates; it does not synthesize a new set or
        bypass the legacy filters.
        """
        species = normalize_name(species)
        if species not in self.belief.candidates or species not in self.raw_pkmn_sets:
            return

        weighted_sets = {
            candidate.encoded: posterior_weights.get(candidate.encoded, 0.0)
            for candidate in self.belief.candidates_for(species)
            if posterior_weights.get(candidate.encoded, 0.0) > 0
        }
        if not weighted_sets:
            return

        # Preserve candidates already ruled out by the legacy public-state
        # inference path.  That path mutates pkmn_sets in place, so intersect
        # rather than accidentally reintroducing a rejected template.
        legacy_remaining = {
            self._encoded_predicted_set(candidate)
            for candidate in self.pkmn_sets.get(species, [])
        }
        if legacy_remaining:
            weighted_sets = {
                encoded: weight
                for encoded, weight in weighted_sets.items()
                if encoded in legacy_remaining
            }
        if not weighted_sets:
            return

        self.raw_pkmn_sets[species] = weighted_sets
        self.raw_pkmn_moves[species] = self._movesets_with_weights(
            species, weighted_sets
        )
        self._add_to_pkmn_sets({species: weighted_sets})

    @staticmethod
    def _encoded_predicted_set(candidate) -> str:
        tera_type = candidate.pkmn_set.tera_type
        if tera_type == "typeless":
            tera_type = ""
        return "|".join(
            (
                tera_type,
                candidate.pkmn_set.ability,
                candidate.pkmn_set.item,
                candidate.pkmn_set.nature,
                ",".join(str(value) for value in candidate.pkmn_set.evs),
                *candidate.pkmn_moveset.moves,
            )
        )

    def _movesets_with_weights(
        self, species: str, weights: dict[str, float]
    ) -> list[PokemonMoveset]:
        counts: dict[tuple[str, ...], float] = defaultdict(float)
        for candidate in self.belief.candidates_for(species):
            weight = weights.get(candidate.encoded, 0.0)
            if weight > 0:
                counts[candidate.moves] += weight
        return [PokemonMoveset(moves=moves, count=count) for moves, count in counts.items()]

    def _get_moves_dict(self):
        return {
            species: {
                "|".join(candidate.moves): candidate.weight
                for candidate in candidates
            }
            for species, candidates in self.belief.candidates.items()
        }

    def initialize(self, format_spec: FormatSpec, pkmn_names: set[str]):
        if not format_spec.pdl_s4:
            raise ValueError("PdlTeamDatasets may only be used for gen9pdls4")
        self.raw_pkmn_sets = {}
        self.raw_pkmn_moves = {}
        self.pkmn_sets = {}
        self.pkmn_mode = format_spec.full_name
        self._load_team_datasets({normalize_name(name) for name in pkmn_names}, False)
        self._add_to_pkmn_sets(self.raw_pkmn_sets)

    def add_new_pokemon(self, pkmn_name: str):
        normalized_name = normalize_name(pkmn_name)
        if normalized_name not in self.belief.candidates:
            return
        sets = self._get_sets_dict()[normalized_name]
        moves = self._get_moves_dict()[normalized_name]
        self.raw_pkmn_sets[normalized_name] = sets
        self.raw_pkmn_moves[normalized_name] = [
            PokemonMoveset(moves=tuple(moves_string.split("|")), count=count)
            for moves_string, count in moves.items()
        ]
        self._add_to_pkmn_sets({normalized_name: sets})


class PdlBeliefSmogonSets(PokemonSets):
    """Local belief marginals for code paths historically backed by Smogon data.

    It exposes only the same local PDL candidates as ``PdlTeamDatasets`` and
    deliberately has no URL, cache, or HTTP fallback.
    """

    def __init__(self, belief: PdlBeliefData):
        self.belief = belief
        self.current_pkmn_sets_url = "pdl-belief-v1"
        self.raw_pkmn_sets = {}
        self.pkmn_sets = {}
        self.pkmn_mode = "uninitialized"
        self.all_pkmn_counts = {}
        self._candidate_weights: dict[str, dict[str, float]] = {}

    def initialize(self, format_spec: FormatSpec, pkmn_names: set[str]):
        if not format_spec.pdl_s4:
            raise ValueError("PdlBeliefSmogonSets may only be used for gen9pdls4")
        self.pkmn_mode = format_spec.full_name
        self.raw_pkmn_sets = {}
        self.pkmn_sets = {}
        self._candidate_weights = {}
        for raw_name in pkmn_names:
            species = normalize_name(raw_name)
            candidates = self.belief.candidates_for(species)
            self.raw_pkmn_sets[species] = candidates
            self._candidate_weights[species] = {
                candidate.encoded: candidate.weight for candidate in candidates
            }
            self.pkmn_sets[species] = [
                PokemonSet(
                    ability=candidate.ability,
                    item=candidate.item,
                    nature=candidate.nature,
                    evs=candidate.evs,
                    count=candidate.weight,
                    tera_type=candidate.tera_type,
                )
                for candidate in candidates
            ]

    def add_new_pokemon(self, pkmn_name: str):
        species = normalize_name(pkmn_name)
        candidates = self.belief.candidates_for(species)
        self.raw_pkmn_sets[species] = candidates
        self._candidate_weights[species] = {
            candidate.encoded: candidate.weight for candidate in candidates
        }
        self.pkmn_sets[species] = [
            PokemonSet(
                ability=candidate.ability,
                item=candidate.item,
                nature=candidate.nature,
                evs=candidate.evs,
                count=candidate.weight,
                tera_type=candidate.tera_type,
            )
            for candidate in candidates
        ]

    def apply_posterior_weights(
        self, species: str, posterior_weights: dict[str, float]
    ) -> None:
        """Refresh local marginal fallback weights from complete-set beliefs."""
        species = normalize_name(species)
        candidates = self.belief.candidates_for(species)
        if not candidates or species not in self.pkmn_sets:
            return
        weights = {
            candidate.encoded: posterior_weights.get(candidate.encoded, 0.0)
            for candidate in candidates
            if posterior_weights.get(candidate.encoded, 0.0) > 0
        }
        if not weights:
            return
        legacy_traits = {
            self._traits_from_set(candidate)
            for candidate in self.pkmn_sets[species]
        }
        if legacy_traits:
            weights = {
                candidate.encoded: weight
                for candidate, weight in (
                    (candidate, weights[candidate.encoded])
                    for candidate in candidates
                    if candidate.encoded in weights
                )
                if self._traits_from_candidate(candidate) in legacy_traits
            }
        if not weights:
            return
        self._candidate_weights[species] = weights
        self.pkmn_sets[species] = [
            PokemonSet(
                ability=candidate.ability,
                item=candidate.item,
                nature=candidate.nature,
                evs=candidate.evs,
                count=weights[candidate.encoded],
                tera_type=candidate.tera_type,
            )
            for candidate in candidates
            if candidate.encoded in weights
        ]

    @staticmethod
    def _traits_from_candidate(candidate):
        return (
            candidate.ability,
            candidate.item,
            candidate.nature,
            candidate.evs,
            candidate.tera_type,
        )

    @staticmethod
    def _traits_from_set(candidate):
        return (
            candidate.ability,
            candidate.item,
            candidate.nature,
            candidate.evs,
            candidate.tera_type,
        )

    def get_all_remaining_trait_combinations(self, pkmn):
        return [
            candidate
            for candidate in self.get_pkmn_sets_from_pkmn_name(pkmn)
            if candidate.set_makes_sense(pkmn)
        ]

    def move_usage_rates(self, pkmn):
        return self.move_usage_rates_by_name(pkmn.name)

    def move_usage_rates_by_name(self, species: str):
        weighted_moves: dict[str, float] = defaultdict(float)
        candidates = self.belief.candidates_for(species)
        weights = self._candidate_weights.get(species, {})
        total_candidate_weight = sum(
            weights.get(candidate.encoded, 0.0) for candidate in candidates
        )
        if total_candidate_weight <= 0:
            return []
        for candidate in candidates:
            candidate_weight = weights.get(candidate.encoded, 0.0)
            if candidate_weight <= 0:
                continue
            for move in candidate.moves:
                weighted_moves[move] += (
                    candidate_weight / total_candidate_weight
                )
        return sorted(weighted_moves.items(), key=lambda pair: pair[1], reverse=True)

    def get_raw_count(self, _pkmn_name):
        return None

    def mega_lower_usage_than_non_mega(self, _pkmn_name, _pkmn_mega_name):
        return False
