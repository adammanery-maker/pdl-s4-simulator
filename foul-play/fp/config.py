import argparse
import logging
import os
import sys
from enum import Enum, auto
from logging.handlers import RotatingFileHandler
from typing import Optional

from fp.format_spec import FormatSpec


class CustomFormatter(logging.Formatter):
    def format(self, record):
        lvl = "{}".format(record.levelname)
        return "{} {}".format(lvl.ljust(8), record.msg)


class CustomRotatingFileHandler(RotatingFileHandler):
    def __init__(self, file_name, **kwargs):
        self.base_dir = "logs"
        if not os.path.exists(self.base_dir):
            os.mkdir(self.base_dir)

        super().__init__("{}/{}".format(self.base_dir, file_name), **kwargs)

    def do_rollover(self, new_file_name):
        new_file_name = new_file_name.replace("/", "_")
        self.baseFilename = "{}/{}".format(self.base_dir, new_file_name)
        self.doRollover()


def init_logging(level, log_to_file):
    websockets_logger = logging.getLogger("websockets")
    websockets_logger.setLevel(logging.INFO)
    requests_logger = logging.getLogger("urllib3")
    requests_logger.setLevel(logging.INFO)

    # Gets the root logger to set handlers/formatters
    logger = logging.getLogger()
    logger.setLevel(logging.DEBUG)
    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setLevel(level)
    stdout_handler.setFormatter(CustomFormatter())
    logger.addHandler(stdout_handler)
    FoulPlayConfig.stdout_log_handler = stdout_handler

    if log_to_file:
        file_handler = CustomRotatingFileHandler("init.log")
        file_handler.setLevel(logging.DEBUG)  # file logs are always debug
        file_handler.setFormatter(CustomFormatter())
        logger.addHandler(file_handler)
        FoulPlayConfig.file_log_handler = file_handler


class SaveReplay(Enum):
    always = auto()
    never = auto()
    on_loss = auto()
    on_win = auto()


class BotModes(Enum):
    challenge_user = auto()
    accept_challenge = auto()
    search_ladder = auto()


class _FoulPlayConfig:
    websocket_uri: str
    username: str
    password: str | None
    user_id: str
    avatar: str
    bot_mode: BotModes
    pokemon_format: str = ""
    smogon_stats: str = None
    pdl_belief_data: str | None = None
    belief_zero_policy: str = "restore"
    tera_gate_minimum_support_margin: float = 0.01
    pdl_team_id: str | None = None
    pdl_candidate_id: str | None = None
    pdl_sun_policy: str = "none"
    pdl_belief = None
    pdl_belief_engine: str = "legacy"
    protocol_log_path: str | None = None
    pdl_decision_bundle_path: str | None = None
    local_no_security: bool = False
    offline_runtime: bool = False
    search_engine: str = "mcts"
    action_policy: str = "argmax"
    search_time_ms: int
    evaluation_fixed_iterations: int | None = None
    evaluation_mcts_seed: str | None = None
    evaluation_belief_seed: str | None = None
    evaluation_world_seed: str | None = None
    evaluation_world_workers: int | None = None
    parallelism: int
    team_preview_search_time_ms: int | None
    team_preview_search_parallelism: int | None
    search_threads: int
    run_count: int
    team_name: str
    team_list: str = None
    user_to_challenge: str
    save_replay: SaveReplay
    room_name: str
    log_level: str
    log_to_file: bool
    stdout_log_handler: logging.StreamHandler
    file_log_handler: Optional[CustomRotatingFileHandler]

    def configure(self):
        parser = argparse.ArgumentParser()
        parser.add_argument(
            "--websocket-uri",
            required=True,
            help="The PokemonShowdown websocket URI, e.g. wss://sim3.psim.us/showdown/websocket",
        )
        parser.add_argument("--ps-username", required=True)
        parser.add_argument("--ps-password", default=None)
        parser.add_argument("--ps-avatar", default=None)
        parser.add_argument(
            "--bot-mode", required=True, choices=[e.name for e in BotModes]
        )
        parser.add_argument(
            "--user-to-challenge",
            default=None,
            help="If bot_mode is `challenge_user`, this is required",
        )
        parser.add_argument(
            "--pokemon-format", required=True, help="e.g. gen9randombattle"
        )
        parser.add_argument(
            "--smogon-stats-format",
            default=None,
            help="Overwrite which smogon stats are used to infer unknowns. If not set, defaults to the --pokemon-format value.",
        )
        parser.add_argument(
            "--pdl-belief-data",
            default=None,
            help="Path to a local schema-v1 PDL set-belief snapshot. Required for gen9pdls4.",
        )
        parser.add_argument(
            "--pdl-team-id",
            default=None,
            help="The local belief snapshot team controlled by this bot. Required for gen9pdls4.",
        )
        parser.add_argument(
            "--pdl-candidate-id",
            default=None,
            help="Stable candidate id for narrowly scoped PDL strategy experiments.",
        )
        parser.add_argument(
            "--pdl-sun-policy",
            default="none",
            choices=["none", "sun-lead-only-v1", "sun-sequence-v1"],
            help="Opt-in Adam 03 Sun action constraint experiment.",
        )
        parser.add_argument(
            "--belief-zero-policy",
            default="restore",
            choices=["fail", "restore"],
            help="What to do if all possible sets for a Pokemon are filtered out.",
        )
        parser.add_argument(
            "--belief-engine",
            default="legacy",
            choices=["legacy", "posterior-shadow", "posterior"],
            help="Use legacy beliefs, trace a posterior without affecting play, or feed posterior weights into existing PDL set sampling.",
        )
        parser.add_argument(
            "--tera-gate-minimum-support-margin",
            type=float,
            default=0.01,
            help="Minimum MCTS policy support margin over not-terastallizing required to Terastallize.",
        )
        parser.add_argument(
            "--protocol-log-path",
            default=None,
            help="Optional local path to append the raw Showdown messages received during battles.",
        )
        parser.add_argument(
            "--pdl-decision-bundle-path",
            default=None,
            help="Diagnostic-only actor-private JSONL capture of exact observed PDL decision inputs.",
        )
        parser.add_argument(
            "--local-no-security",
            action="store_true",
            help="Use an unsigned guest login for a local Showdown server started with --no-security.",
        )
        parser.add_argument(
            "--offline-runtime",
            action="store_true",
            help="Block all non-loopback network connections for a zero-hosted-call simulation.",
        )
        parser.add_argument(
            "--search-engine",
            default=os.environ.get("FOUL_PLAY_SEARCH_ENGINE", "mcts"),
            choices=["mcts", "expectiminimax"],
            help="Which native search engine to use: mcts or expectiminimax",
        )
        parser.add_argument(
            "--search-time-ms",
            type=int,
            default=100,
            help="Time to search per state in milliseconds",
        )
        parser.add_argument(
            "--action-policy",
            default="argmax",
            choices=["argmax", "stochastic"],
            help="Select the aggregate MCTS argmax, or explicitly enable stochastic near-best sampling.",
        )
        parser.add_argument("--evaluation-fixed-iterations", type=int, default=None, help="Opt-in exact local MCTS iterations for deterministic evaluation.")
        parser.add_argument("--evaluation-mcts-seed", default=None, help="Top-level SHA-256 seed for deterministic evaluation MCTS.")
        parser.add_argument("--evaluation-belief-seed", default=None, help="Top-level SHA-256 seed for deterministic belief sampling.")
        parser.add_argument("--evaluation-world-seed", default=None, help="Top-level SHA-256 seed for deterministic world ordering.")
        parser.add_argument("--evaluation-world-workers", type=int, default=None, help="Evaluation world workers; deterministic mode requires one.")
        parser.add_argument(
            "--search-parallelism",
            type=int,
            default=1,
            help="Number of states to search in parallel",
        )
        parser.add_argument(
            "--team-preview-search-parallelism",
            type=int,
            default=None,
            help="Number of team-preview states to search in parallel",
        )
        parser.add_argument(
            "--team-preview-search-time-ms",
            type=int,
            default=None,
            help="Time to search per team-preview state in milliseconds",
        )
        parser.add_argument(
            "--search-threads",
            type=int,
            default=1,
            help="Number of threads to use per state",
        )
        parser.add_argument(
            "--run-count",
            type=int,
            default=1,
            help="Number of PokemonShowdown battles to run",
        )
        parser.add_argument(
            "--team-name",
            default=None,
            help="Which team to use. Can be a filename or a foldername relative to ./fp/teams/teams/. "
            "If a foldername, a random team from that folder will be chosen each battle. "
            "If not set, defaults to the --pokemon-format value.",
        )
        parser.add_argument(
            "--team-list",
            default=None,
            help="A path to a text file containing a list of team names to choose from in order. Takes precedence over --team-name.",
        )
        parser.add_argument(
            "--save-replay",
            default="never",
            choices=[e.name for e in SaveReplay],
            help="When to save replays",
        )
        parser.add_argument(
            "--room-name",
            default=None,
            help="If bot_mode is `accept_challenge`, the room to join while waiting",
        )
        parser.add_argument("--log-level", default="DEBUG", help="Python logging level")
        parser.add_argument(
            "--log-to-file",
            action="store_true",
            help="When enabled, DEBUG logs will be written to a file in the logs/ directory",
        )

        args = parser.parse_args()
        self.websocket_uri = args.websocket_uri
        self.username = args.ps_username
        self.password = args.ps_password
        self.avatar = args.ps_avatar
        self.bot_mode = BotModes[args.bot_mode]
        self.pokemon_format = args.pokemon_format
        self.smogon_stats = args.smogon_stats_format
        self.pdl_belief_data = args.pdl_belief_data
        self.belief_zero_policy = args.belief_zero_policy
        self.pdl_belief_engine = args.belief_engine
        self.tera_gate_minimum_support_margin = args.tera_gate_minimum_support_margin
        self.pdl_team_id = args.pdl_team_id
        self.pdl_candidate_id = args.pdl_candidate_id
        self.pdl_sun_policy = args.pdl_sun_policy
        self.protocol_log_path = args.protocol_log_path
        self.pdl_decision_bundle_path = args.pdl_decision_bundle_path
        self.local_no_security = args.local_no_security
        self.offline_runtime = args.offline_runtime
        self.search_engine = args.search_engine
        self.action_policy = args.action_policy
        self.search_time_ms = args.search_time_ms
        self.evaluation_fixed_iterations = args.evaluation_fixed_iterations
        self.evaluation_mcts_seed = args.evaluation_mcts_seed
        self.evaluation_belief_seed = args.evaluation_belief_seed
        self.evaluation_world_seed = args.evaluation_world_seed
        self.evaluation_world_workers = args.evaluation_world_workers
        self.parallelism = args.search_parallelism
        self.team_preview_search_time_ms = (
            args.team_preview_search_time_ms or self.search_time_ms
        )
        self.team_preview_search_parallelism = (
            args.team_preview_search_parallelism or self.parallelism
        )
        self.search_threads = args.search_threads
        self.run_count = args.run_count
        self.team_name = args.team_name or self.pokemon_format
        self.team_list = args.team_list
        self.user_to_challenge = args.user_to_challenge
        self.save_replay = SaveReplay[args.save_replay]
        self.room_name = args.room_name
        self.log_level = args.log_level
        self.log_to_file = args.log_to_file

        self.validate_config()
        evaluation_values = (self.evaluation_fixed_iterations, self.evaluation_mcts_seed, self.evaluation_belief_seed, self.evaluation_world_seed, self.evaluation_world_workers)
        if any(value is not None for value in evaluation_values):
            if (self.evaluation_fixed_iterations is None or self.evaluation_fixed_iterations <= 0
                    or not self.evaluation_mcts_seed or not self.evaluation_belief_seed or not self.evaluation_world_seed):
                raise ValueError("deterministic evaluation requires positive --evaluation-fixed-iterations and all three evaluation seeds")
            if self.evaluation_world_workers != 1 or self.parallelism != 1 or self.search_threads != 1:
                raise ValueError("deterministic evaluation requires one world worker, search parallelism, and search thread")
            if not self.offline_runtime or self.search_engine != "mcts" or self.action_policy != "argmax":
                raise ValueError("deterministic evaluation requires offline MCTS argmax")
        if self.format_spec.pdl_s4:
            from fp.pdl.belief_data import PdlBeliefData

            self.pdl_belief = PdlBeliefData.load(self.pdl_belief_data)
        else:
            self.pdl_belief = None

    @property
    def format_spec(self) -> FormatSpec:
        return FormatSpec.from_format_string(self.pokemon_format)

    def validate_config(self):
        if self.pdl_sun_policy != "none":
            if (
                not self.format_spec.pdl_s4
                or self.pdl_team_id != "adam"
                or self.pdl_candidate_id != "adam-03-sun-drednaw"
            ):
                raise ValueError(
                    "PDL Sun policy is restricted to gen9pdls4 team adam "
                    "candidate adam-03-sun-drednaw"
                )
        elif self.pdl_candidate_id is not None:
            raise ValueError("--pdl-candidate-id requires an enabled --pdl-sun-policy")
        if self.offline_runtime:
            from urllib.parse import urlparse

            host = urlparse(self.websocket_uri).hostname
            if host not in {"localhost", "127.0.0.1", "::1"}:
                raise ValueError("--offline-runtime requires a loopback websocket URI")
            if not self.local_no_security:
                raise ValueError("--offline-runtime requires --local-no-security")
        if self.format_spec.pdl_s4:
            if not self.pdl_belief_data:
                raise ValueError("gen9pdls4 requires --pdl-belief-data")
            if not self.pdl_team_id:
                raise ValueError("gen9pdls4 requires --pdl-team-id")
            from fp.runtime_contract import runtime_contract

            runtime_contract(self)
        if self.bot_mode == BotModes.challenge_user:
            assert (
                self.user_to_challenge is not None
            ), "If bot_mode is `CHALLENGE_USER`, you must declare USER_TO_CHALLENGE"


FoulPlayConfig = _FoulPlayConfig()
