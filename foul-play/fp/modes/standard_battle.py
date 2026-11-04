import json
import logging

from fp import constants
from fp.battle.inference import is_opponent
from fp.battle.protocol import process_battle_updates
from fp.battle.helpers import maximum_ev
from fp.config import FoulPlayConfig
from fp.constants import BattleType
from fp.data.sets import SmogonSets, TeamDatasets
from fp.format_spec import FormatSpec
from fp.pdl.belief_data import PdlBeliefData
from fp.pdl.posterior import PdlPosterior
from fp.pdl.team_datasets import PdlBeliefSmogonSets, PdlTeamDatasets
from fp.modes.base import (
    BattleMode,
    _switch_active_with_zoroark_from_reserves,
    async_pick_move,
    get_first_request_json,
)
from fp.search import standard_battles
from fp.websocket_client import PSWebsocketClient

logger = logging.getLogger(__name__)


class StandardBattleMode(BattleMode):
    name = BattleType.STANDARD_BATTLE
    requires_team = True

    def __init__(self):
        self.is_pdl_s4 = FoulPlayConfig.format_spec.pdl_s4
        if self.is_pdl_s4:
            belief = FoulPlayConfig.pdl_belief
            if belief is None:
                if not FoulPlayConfig.pdl_belief_data:
                    raise ValueError("gen9pdls4 requires --pdl-belief-data")
                belief = PdlBeliefData.load(FoulPlayConfig.pdl_belief_data)
                FoulPlayConfig.pdl_belief = belief
            self.team_datasets = PdlTeamDatasets(belief)
            self.smogon_sets = PdlBeliefSmogonSets(belief)
            self.posterior = (
                PdlPosterior.from_belief_data(belief)
                if FoulPlayConfig.pdl_belief_engine in {"posterior-shadow", "posterior"}
                else None
            )
            self._posterior_observed = {}
        else:
            self.team_datasets = TeamDatasets()
            self.smogon_sets = SmogonSets()
            self.posterior = None
            self._posterior_observed = {}

    async def start_battle(
        self, ps_websocket_client: PSWebsocketClient, pokemon_battle_type, team_dict
    ):
        battle, msg = await self.start_battle_common(
            ps_websocket_client, pokemon_battle_type
        )
        battle.user.team_dict = team_dict

        if not battle.gen.has_team_preview:
            while True:
                if constants.START_STRING in msg:
                    battle.started = True

                    # hold onto some messages to apply after we get the request JSON
                    # omit the bot's switch-in message because we won't need that
                    # parsing the request JSON will set the bot's active pkmn
                    battle.msg_list = [
                        m
                        for m in msg.split(constants.START_STRING)[1]
                        .strip()
                        .split("\n")
                        if not (m.startswith("|switch|{}".format(battle.user.name)))
                    ]
                    break
                msg = await ps_websocket_client.receive_message()

            await get_first_request_json(ps_websocket_client, battle)

            unique_pkmn_names = set(
                [p.name for p in battle.user.reserve] + [battle.user.active.name]
            )
            self.smogon_sets.initialize(
                FormatSpec.from_format_string(
                    FoulPlayConfig.smogon_stats or pokemon_battle_type
                ),
                unique_pkmn_names,
            )
            self.team_datasets.initialize(battle.format_spec, unique_pkmn_names)

            # apply the messages that were held onto
            process_battle_updates(battle)

            best_move = await async_pick_move(battle)
            await ps_websocket_client.send_message(battle.battle_tag, best_move)

        else:
            while constants.START_TEAM_PREVIEW not in msg:
                msg = await ps_websocket_client.receive_message()

            preview_string_lines = msg.split(constants.START_TEAM_PREVIEW)[-1].split(
                "\n"
            )

            opponent_pokemon = []
            for line in preview_string_lines:
                if not line:
                    continue

                split_line = line.split("|")
                if (
                    split_line[1] == constants.TEAM_PREVIEW_POKE
                    and split_line[2].strip() == battle.opponent.name
                ):
                    opponent_pokemon.append(split_line[3])

            await get_first_request_json(ps_websocket_client, battle)
            battle.initialize_team_preview(opponent_pokemon, pokemon_battle_type)
            battle.during_team_preview()

            unique_pkmn_names = set(
                p.name for p in battle.opponent.reserve + battle.user.reserve
            )

            self.initialize_team_preview_datasets(
                pokemon_battle_type, unique_pkmn_names, msg
            )

            await self.handle_team_preview(battle, ps_websocket_client)

        return battle

    def initialize_team_preview_datasets(
        self, pokemon_battle_type, unique_pkmn_names, msg
    ):
        self.smogon_sets.initialize(
            FormatSpec.from_format_string(
                FoulPlayConfig.smogon_stats or pokemon_battle_type
            ),
            unique_pkmn_names,
        )
        self.team_datasets.initialize(
            FormatSpec.from_format_string(pokemon_battle_type), unique_pkmn_names
        )

    def add_revealed_pokemon(self, battle, pkmn):
        # for standard battles gen4 and lower
        # we want to add the new pokemon to the datasets as they are revealed
        # because there is no teampreview
        if not battle.gen.has_team_preview:
            self.smogon_sets.add_new_pokemon(pkmn.name)
            self.team_datasets.add_new_pokemon(pkmn.name)
            logger.info("Adding new pokemon '{}' to the datasets".format(pkmn.name))

    def observe_posterior(self, battle):
        """Apply public evidence to the optional PDL posterior.

        Shadow mode emits the same trace without touching candidate sampling.
        Posterior mode refreshes the existing local candidate counts before the
        next ordinary Foul Play world sample; search, conversion, and action
        selection remain unchanged.
        """
        if self.posterior is None or battle.opponent.active is None:
            return
        active = battle.opponent.active
        species = active.name
        turn = battle.turn
        try:
            observed = self._posterior_observed.setdefault(
                species, {"moves": set(), "item": None, "ability": None}
            )
            for move in active.publicly_known_moves - observed["moves"]:
                self.posterior.apply_revealed_move(species, move, turn=turn)
            observed["moves"].update(active.publicly_known_moves)
            # Item-removal messages leave the public-known flag set while the
            # current item becomes None.  That is evidence that the old item
            # was revealed, not a new direct "item: none" reveal.
            if active.publicly_known_item and active.item and observed["item"] != active.item:
                self.posterior.apply_revealed_item(species, active.item, turn=turn)
                observed["item"] = active.item
            if active.publicly_known_ability and active.ability and observed["ability"] != active.ability:
                self.posterior.apply_revealed_ability(species, active.ability, turn=turn)
                observed["ability"] = active.ability
            if FoulPlayConfig.pdl_belief_engine == "posterior":
                weights = self.posterior.weights(species)
                self.team_datasets.apply_posterior_weights(species, weights)
                self.smogon_sets.apply_posterior_weights(species, weights)
            trace = json.dumps({
                "turn": turn, "species": species,
                "engine": FoulPlayConfig.pdl_belief_engine,
                "weights": self.posterior.weights(species),
                "evidence": [record.__dict__ for record in self.posterior.evidence_for(species)],
                "fallbackUsed": self.posterior.fallback_used(species),
            }, sort_keys=True)
            logger.info(f"PDL_BELIEF_TRACE {trace}")
        except KeyError:
            # A non-rostered illusion or unsupported form must not affect play.
            logger.info(f"PDL_BELIEF_TRACE {json.dumps({'turn': turn, 'species': species, 'unsupported': True}, sort_keys=True)}")

    def search_params(self, battle):
        opponent_active_num_moves = len(battle.opponent.active.moves)
        in_time_pressure = (
            battle.time_remaining is not None and battle.time_remaining <= 60
        )

        if (
            battle.team_preview
            or (battle.opponent.active.hp > 0 and opponent_active_num_moves == 0)
            or opponent_active_num_moves < 3
        ):
            num_battles_multiplier = 1 if in_time_pressure else 2
            return FoulPlayConfig.parallelism * num_battles_multiplier, int(
                FoulPlayConfig.search_time_ms
            )
        else:
            return FoulPlayConfig.parallelism, FoulPlayConfig.search_time_ms

    def prepare_battles(self, battle, num_battles, rng=None):
        prepared = standard_battles.prepare_battles(battle, num_battles, rng=rng)
        if self.is_pdl_s4:
            from fp.pdl.tera import apply_pdl_tera_search_restrictions

            for sampled_battle, _weight in prepared:
                apply_pdl_tera_search_restrictions(
                    sampled_battle, self.team_datasets.belief, FoulPlayConfig.pdl_team_id
                )
        return prepared

    def check_zoroark_from_move(
        self, battle, side, pkmn, move_name, split_msg, zoroark_from_reserves
    ):
        # in battle factory we can deduce that there is a zoroark in front of us
        # if we see a move that is not in the known moveset and a zoroark is in the reserves
        if (
            is_opponent(battle, split_msg)
            and zoroark_from_reserves is not None
            and "transform" not in pkmn.volatile_statuses
            and move_name not in self.team_datasets.get_all_possible_moves(pkmn)
            and move_name
            in self.team_datasets.get_all_possible_moves(zoroark_from_reserves)
            and "from" not in split_msg[-1]
        ):
            logger.info(
                "{} using {} means it is {}".format(
                    pkmn.name, move_name, zoroark_from_reserves.name
                )
            )
            _switch_active_with_zoroark_from_reserves(side, zoroark_from_reserves)

            # the rest of this function uses `pkmn`, so we need to set it to the correct pkmn
            pkmn = zoroark_from_reserves

        return pkmn

    def assume_spread_for_speed_check(self, battle, battle_copy):
        if battle.trick_room:
            battle_copy.opponent.active.set_spread(
                "quiet", "0,0,0,0,0,0"
            )  # assume as slow as possible in trickroom
        else:
            battle_copy.opponent.active.set_spread(
                "jolly", f"0,0,0,0,0,{maximum_ev()}"
            )  # assume as fast as possible

    def dataset_possibilities(self, battle):
        possibilites = self.team_datasets.get_pkmn_sets_from_pkmn_name(
            battle.opponent.active
        )
        smogon_possibilities = self.smogon_sets.get_pkmn_sets_from_pkmn_name(
            battle.opponent.active
        )
        return possibilites, smogon_possibilities, False
