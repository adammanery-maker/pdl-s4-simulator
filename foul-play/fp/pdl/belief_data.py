from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fp.battle.helpers import normalize_name
from fp.data import pokedex


class PdlBeliefDataError(ValueError):
    """Raised when a local PDL belief snapshot cannot safely be used."""


@dataclass(frozen=True)
class PdlRosterPokemon:
    species: str
    cost: float


@dataclass(frozen=True)
class PdlTeam:
    id: str
    drafted_tera_types: tuple[str, ...]
    roster: tuple[PdlRosterPokemon, ...]
    tera_captains: tuple[str, ...] | None


@dataclass(frozen=True)
class PdlSetCandidate:
    weight: float
    ability: str
    item: str
    nature: str
    evs: tuple[int, ...]
    moves: tuple[str, ...]
    tera_type: str

    @property
    def encoded(self) -> str:
        return "|".join(
            (
                self.tera_type if self.tera_type != "typeless" else "",
                self.ability,
                self.item,
                self.nature,
                ",".join(str(value) for value in self.evs),
                *self.moves,
            )
        )


class PdlBeliefData:
    """A validated, local-only PDL set-belief snapshot.

    The snapshot contains weighted candidate sets, rather than a hidden actual
    set. It is therefore valid input for the bot's opponent inference.
    """

    SCHEMA_VERSION = 1

    def __init__(
        self,
        snapshot_id: str,
        teams: dict[str, PdlTeam],
        candidates: dict[str, tuple[PdlSetCandidate, ...]],
    ):
        self.snapshot_id = snapshot_id
        self.teams = teams
        self.candidates = candidates
        self._owner_by_species = {
            roster_pokemon.species: team_id
            for team_id, team in teams.items()
            for roster_pokemon in team.roster
        }
        self._roster_by_species = {
            roster_pokemon.species: roster_pokemon
            for team in teams.values()
            for roster_pokemon in team.roster
        }

    @classmethod
    def load(cls, path: str | Path) -> "PdlBeliefData":
        try:
            raw = json.loads(Path(path).read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise PdlBeliefDataError(f"Could not read PDL belief data: {exc}") from exc

        if not isinstance(raw, dict) or raw.get("schemaVersion") != cls.SCHEMA_VERSION:
            raise PdlBeliefDataError(
                f"PDL belief data must use schemaVersion {cls.SCHEMA_VERSION}"
            )
        snapshot = raw.get("snapshot")
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("id"), str):
            raise PdlBeliefDataError("PDL belief data requires snapshot.id")
        teams = cls._parse_teams(raw.get("teams"))
        candidates = cls._parse_candidates(raw.get("sets"), teams)
        return cls(snapshot["id"], teams, candidates)

    @staticmethod
    def _parse_teams(raw_teams: Any) -> dict[str, PdlTeam]:
        if not isinstance(raw_teams, dict) or not raw_teams:
            raise PdlBeliefDataError("PDL belief data requires one or more teams")

        teams: dict[str, PdlTeam] = {}
        owned_species: set[str] = set()
        for raw_team_id, raw_team in raw_teams.items():
            team_id = normalize_name(str(raw_team_id))
            if not team_id or not isinstance(raw_team, dict):
                raise PdlBeliefDataError("PDL team ids and team objects are required")
            raw_tera_types = raw_team.get("draftedTeraTypes")
            if not isinstance(raw_tera_types, list) or len(raw_tera_types) != 2:
                raise PdlBeliefDataError(
                    f"PDL team {team_id} must provide exactly two drafted Tera types"
                )
            drafted_tera_types = tuple(normalize_name(str(value)) for value in raw_tera_types)
            if any(not tera_type for tera_type in drafted_tera_types):
                raise PdlBeliefDataError(f"PDL team {team_id} has an invalid drafted Tera type")

            raw_roster = raw_team.get("roster")
            if not isinstance(raw_roster, list) or not raw_roster:
                raise PdlBeliefDataError(f"PDL team {team_id} must provide a roster")
            roster: list[PdlRosterPokemon] = []
            for raw_pokemon in raw_roster:
                if not isinstance(raw_pokemon, dict):
                    raise PdlBeliefDataError(f"PDL team {team_id} has an invalid roster entry")
                species = normalize_name(str(raw_pokemon.get("species", "")))
                cost = raw_pokemon.get("cost")
                if not species or not isinstance(cost, (int, float)) or not math.isfinite(cost):
                    raise PdlBeliefDataError(
                        f"PDL team {team_id} roster entries need species and finite cost"
                    )
                if species in owned_species:
                    raise PdlBeliefDataError(f"PDL species {species} appears on more than one roster")
                owned_species.add(species)
                roster.append(PdlRosterPokemon(species=species, cost=float(cost)))
            roster_by_species = {pokemon.species: pokemon for pokemon in roster}
            raw_captains = raw_team.get("teraCaptains")
            tera_captains: tuple[str, ...] | None = None
            if raw_captains is not None:
                if not isinstance(raw_captains, list) or not raw_captains:
                    raise PdlBeliefDataError(
                        f"PDL team {team_id} teraCaptains must be a non-empty list"
                    )
                tera_captains = tuple(normalize_name(str(value)) for value in raw_captains)
                if any(not species for species in tera_captains) or len(set(tera_captains)) != len(tera_captains):
                    raise PdlBeliefDataError(f"PDL team {team_id} has invalid or duplicate Tera captains")
                for species in tera_captains:
                    pokemon = roster_by_species.get(species)
                    if pokemon is None:
                        raise PdlBeliefDataError(f"PDL team {team_id} Tera captain {species} is not rostered")
                    if pokemon.cost > 4:
                        raise PdlBeliefDataError(
                            f"PDL team {team_id} Tera captain {species} has cost {pokemon.cost:g} and cannot Terastallize"
                        )

            teams[team_id] = PdlTeam(
                team_id, drafted_tera_types, tuple(roster), tera_captains
            )
        return teams

    @classmethod
    def _parse_candidates(
        cls, raw_sets: Any, teams: dict[str, PdlTeam]
    ) -> dict[str, tuple[PdlSetCandidate, ...]]:
        if not isinstance(raw_sets, dict):
            raise PdlBeliefDataError("PDL belief data requires a sets object")
        roster_by_species = {
            roster_pokemon.species: (team, roster_pokemon)
            for team in teams.values()
            for roster_pokemon in team.roster
        }
        parsed: dict[str, tuple[PdlSetCandidate, ...]] = {}
        for raw_species, raw_candidates in raw_sets.items():
            species = normalize_name(str(raw_species))
            if species not in roster_by_species:
                raise PdlBeliefDataError(f"PDL set data references unrostered species {species}")
            if not isinstance(raw_candidates, list) or not raw_candidates:
                raise PdlBeliefDataError(f"PDL species {species} needs one or more candidate sets")
            team, roster_pokemon = roster_by_species[species]
            parsed[species] = tuple(
                cls._parse_candidate(species, candidate, team, roster_pokemon)
                for candidate in raw_candidates
            )

        missing = set(roster_by_species) - set(parsed)
        if missing:
            raise PdlBeliefDataError(
                "PDL belief data is missing candidates for: " + ", ".join(sorted(missing))
            )
        return parsed

    @staticmethod
    def _parse_candidate(
        species: str,
        raw_candidate: Any,
        team: PdlTeam,
        roster_pokemon: PdlRosterPokemon,
    ) -> PdlSetCandidate:
        if not isinstance(raw_candidate, dict):
            raise PdlBeliefDataError(f"PDL candidate for {species} must be an object")
        weight = raw_candidate.get("weight")
        if not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
            raise PdlBeliefDataError(f"PDL candidate for {species} needs a positive finite weight")
        ability = normalize_name(str(raw_candidate.get("ability", "")))
        item = normalize_name(str(raw_candidate.get("item", "")))
        nature = normalize_name(str(raw_candidate.get("nature", "")))
        moves = tuple(normalize_name(str(value)) for value in raw_candidate.get("moves", []))
        evs = raw_candidate.get("evs")
        # Ditto has one legal move. Preserve that complete set without padding
        # it with fabricated moves; all other existing prior checks stay strict.
        complete_moves = len(moves) == 4 or (species == "ditto" and moves == ("transform",))
        if not ability or not item or not nature or not complete_moves or any(not move for move in moves):
            raise PdlBeliefDataError(f"PDL candidate for {species} needs ability, item, nature, and four moves")
        if (
            not isinstance(evs, list)
            or len(evs) != 6
            or any(not isinstance(value, int) or value < 0 or value > 252 for value in evs)
            or sum(evs) > 510
        ):
            raise PdlBeliefDataError(f"PDL candidate for {species} has invalid EVs")
        tera_type = normalize_name(str(raw_candidate.get("teraType") or "typeless"))
        if tera_type != "typeless":
            allowed_tera_types = set(team.drafted_tera_types) | PdlBeliefData._native_types(species)
            if roster_pokemon.cost > 4:
                raise PdlBeliefDataError(
                    f"PDL candidate for {species} has cost {roster_pokemon.cost:g} and cannot Terastallize"
                )
            if tera_type not in allowed_tera_types:
                raise PdlBeliefDataError(
                    f"PDL candidate for {species} has illegal Tera type {tera_type}"
                )
        return PdlSetCandidate(
            weight=float(weight),
            ability=ability,
            item=item,
            nature=nature,
            evs=tuple(evs),
            moves=moves,
            tera_type=tera_type,
        )

    @staticmethod
    def _native_types(species: str) -> set[str]:
        try:
            return {normalize_name(type_name) for type_name in pokedex[species]["types"]}
        except KeyError as exc:
            raise PdlBeliefDataError(
                f"PDL species {species} is not present in Foul Play's local Pokédex"
            ) from exc

    def candidates_for(self, species: str) -> tuple[PdlSetCandidate, ...]:
        return self.candidates.get(normalize_name(species), ())

    def tera_is_allowed(self, team_id: str, species: str, tera_type: str | None) -> bool:
        normalized_team_id = normalize_name(team_id)
        normalized_species = normalize_name(species)
        normalized_tera_type = normalize_name(tera_type or "")
        team = self.teams.get(normalized_team_id)
        owner = self._owner_by_species.get(normalized_species)
        roster_pokemon = self._roster_by_species.get(normalized_species)
        if not team or owner != normalized_team_id or not roster_pokemon or roster_pokemon.cost > 4:
            return False
        if team.tera_captains is not None and normalized_species not in team.tera_captains:
            return False
        return normalized_tera_type in (set(team.drafted_tera_types) | self._native_types(normalized_species))

    def is_tera_captain(self, team_id: str, species: str) -> bool:
        team = self.teams.get(normalize_name(team_id))
        normalized_species = normalize_name(species)
        if team is None:
            return False
        if team.tera_captains is None:
            pokemon = self._roster_by_species.get(normalized_species)
            return pokemon is not None and pokemon.cost <= 4
        return normalized_species in team.tera_captains

    def owner_for(self, species: str) -> str | None:
        return self._owner_by_species.get(normalize_name(species))
