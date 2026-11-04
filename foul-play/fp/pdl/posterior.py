"""Evidence-backed PDL beliefs without access to opponent ground truth."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Mapping

from fp.battle.helpers import normalize_name
from fp.pdl.belief_data import PdlBeliefData, PdlSetCandidate


@dataclass(frozen=True)
class EvidenceRecord:
    turn: int
    source: str
    observation: str
    affected_variables: tuple[str, ...]
    hard_constraint: bool
    likelihoods: tuple[tuple[str, float], ...] = ()
    fallback_used: bool = False


@dataclass
class PosteriorCandidate:
    candidate: PdlSetCandidate
    prior_weight: float
    posterior_weight: float

    @property
    def key(self) -> str:
        return self.candidate.encoded


class PdlPosterior:
    """Correlated template posterior with evidence provenance.

    Template fields stay together: a likelihood can reweight one complete set,
    but this class never independently combines a move from one candidate with
    an item or spread from another.
    """

    def __init__(self, candidates: Mapping[str, tuple[PdlSetCandidate, ...]]):
        self._by_species = {
            normalize_name(species): [PosteriorCandidate(c, c.weight, c.weight) for c in sets]
            for species, sets in candidates.items()
        }
        self._evidence = {species: [] for species in self._by_species}
        self._fallback_used = {species: False for species in self._by_species}
        for species in self._by_species:
            self._normalize(species)

    @classmethod
    def from_belief_data(cls, belief: PdlBeliefData) -> "PdlPosterior":
        return cls(belief.candidates)

    @classmethod
    def from_candidates(cls, candidates: Mapping[str, tuple[PdlSetCandidate, ...]]) -> "PdlPosterior":
        return cls(candidates)

    def for_species(self, species: str) -> tuple[PosteriorCandidate, ...]:
        return tuple(candidate for candidate in self._species(species) if candidate.posterior_weight > 0)

    def weights(self, species: str) -> dict[str, float]:
        return {candidate.key: candidate.posterior_weight for candidate in self.for_species(species)}

    def evidence_for(self, species: str) -> tuple[EvidenceRecord, ...]:
        return tuple(self._evidence[normalize_name(species)])

    def active_count(self, species: str) -> int:
        return len(self.for_species(species))

    def fallback_used(self, species: str) -> bool:
        return self._fallback_used[normalize_name(species)]

    def apply_revealed_move(self, species: str, move: str, *, turn: int) -> None:
        move = normalize_name(move)
        self._apply_hard_constraint(species, "move", f"move:{move}", turn, lambda candidate: move in candidate.moves)

    def apply_revealed_item(self, species: str, item: str, *, turn: int) -> None:
        item = normalize_name(item)
        self._apply_hard_constraint(species, "item", f"item:{item}", turn, lambda candidate: candidate.item == item)

    def apply_revealed_ability(self, species: str, ability: str, *, turn: int) -> None:
        ability = normalize_name(ability)
        self._apply_hard_constraint(species, "ability", f"ability:{ability}", turn, lambda candidate: candidate.ability == ability)

    def apply_revealed_tera(self, species: str, tera_type: str, *, turn: int) -> None:
        tera_type = normalize_name(tera_type)
        self._apply_hard_constraint(species, "tera", f"tera:{tera_type}", turn, lambda candidate: candidate.tera_type == tera_type)

    def apply_damage_likelihood(self, species: str, likelihoods: Mapping[str, float], *, turn: int) -> None:
        entries = self._species(species)
        for entry in entries:
            likelihood = likelihoods.get(entry.key, 0.0)
            if not isfinite(likelihood) or likelihood < 0:
                raise ValueError("Damage likelihoods must be finite and non-negative")
            entry.posterior_weight *= likelihood
        _normalized, fallback_used = self._normalize(species, restore_on_zero=True)
        self._record(species, EvidenceRecord(turn, "damage", "damage-likelihood", ("evs", "nature", "item", "ability"), False, tuple(sorted(likelihoods.items())), fallback_used))

    def apply_speed_order(self, species: str, speeds: Mapping[str, int], *, reference_speed: int, opponent_moved_first: bool, turn: int) -> None:
        if reference_speed <= 0:
            raise ValueError("Reference speed must be positive")
        # Equality remains possible due to speed ties. Priority, Trick Room,
        # Tailwind, paralysis, and temporary ability modifiers must be screened
        # by the protocol layer before it calls this raw-speed constraint.
        if opponent_moved_first:
            def allowed(entry):
                return speeds.get(entry.key, -1) >= reference_speed
        else:
            def allowed(entry):
                return speeds.get(entry.key, float("inf")) <= reference_speed
        self._apply_hard_constraint(species, "speed", f"speed-order:{reference_speed}", turn, lambda candidate: allowed(self._entry_for(species, candidate)))

    def _apply_hard_constraint(self, species: str, variable: str, observation: str, turn: int, predicate) -> None:
        entries = self._species(species)
        for entry in entries:
            if not predicate(entry.candidate):
                entry.posterior_weight = 0.0
        _normalized, fallback_used = self._normalize(species, restore_on_zero=True)
        self._record(species, EvidenceRecord(turn, "reveal" if variable != "speed" else "speed", observation, (variable,), True, fallback_used=fallback_used))

    def _normalize(self, species: str, *, restore_on_zero: bool = False) -> tuple[bool, bool]:
        entries = self._species(species)
        total = sum(entry.posterior_weight for entry in entries)
        fallback_used = total <= 0 and restore_on_zero
        if fallback_used:
            self._fallback_used[normalize_name(species)] = True
            for entry in entries:
                entry.posterior_weight = entry.prior_weight
            total = sum(entry.posterior_weight for entry in entries)
        if total <= 0:
            return False, False
        for entry in entries:
            entry.posterior_weight /= total
        return True, fallback_used

    def _record(self, species: str, evidence: EvidenceRecord) -> None:
        self._evidence[normalize_name(species)].append(evidence)

    def _species(self, species: str) -> list[PosteriorCandidate]:
        normalized = normalize_name(species)
        if normalized not in self._by_species:
            raise KeyError(f"No PDL posterior exists for {normalized}")
        return self._by_species[normalized]

    def _entry_for(self, species: str, candidate: PdlSetCandidate) -> PosteriorCandidate:
        return next(entry for entry in self._species(species) if entry.candidate is candidate)
