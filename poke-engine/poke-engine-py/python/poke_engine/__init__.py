from dataclasses import dataclass
from enum import StrEnum

from .poke_engine import *


class Weather(StrEnum):
    NONE = "none"
    SUN = "sun"
    RAIN = "rain"
    SAND = "sand"
    HAIL = "hail"
    SNOW = "snow"
    HARSH_SUN = "harshsun"
    HEAVY_RAIN = "heavyrain"


class Terrain(StrEnum):
    NONE = "none"
    GRASSY = "grassyterrain"
    ELECTRIC = "electricterrain"
    MISTY = "mistyterrain"
    PSYCHIC = "psychicterrain"


class PokemonIndex(StrEnum):
    P0 = "0"
    P1 = "1"
    P2 = "2"
    P3 = "3"
    P4 = "4"
    P5 = "5"


@dataclass
class IterativeDeepeningResult:
    """
    Result of an Iterative Deepening Expectiminimax Search

    :param side_one: The moves for side_one
    :type side_one: list[str]
    :param side_two: The moves for side_two
    :type side_two: list[str]
    :param matrix: A vector representing the payoff matrix of the search.
        Pruned branches are represented by None
    :type matrix: int
    :param depth_searched: The depth that was searched to
    :type depth_searched: int
    """

    side_one: list[str]
    side_two: list[str]
    matrix: list[float]
    depth_searched: int

    @classmethod
    def _from_rust(cls, rust_result):
        return cls(
            side_one=rust_result.s1,
            side_two=rust_result.s2,
            matrix=rust_result.matrix,
            depth_searched=rust_result.depth_searched,
        )

    def get_safest_move(self) -> str:
        """
        Get the safest move for side_one
        The safest move is the move that minimizes the loss for the turn

        :return: The safest move
        :rtype: str
        """
        safest_value = float("-inf")
        safest_s1_index = 0
        vec_index = 0
        for i in range(len(self.side_one)):
            worst_case_this_row = float("inf")
            for _ in range(len(self.side_two)):
                score = self.matrix[vec_index]
                if score < worst_case_this_row:
                    worst_case_this_row = score

            if worst_case_this_row > safest_value:
                safest_s1_index = i
                safest_value = worst_case_this_row

        return self.side_one[safest_s1_index]


@dataclass
class MctsSideResult:
    """
    Result of a Monte Carlo Tree Search for a single side

    :param move_choice: The move that was chosen
    :type move_choice: str
    :param total_score: The total score of the chosen move
    :type total_score: float
    :param visits: The number of times the move was chosen
    :type visits: int
    """

    move_choice: str
    total_score: float
    visits: int


@dataclass
class MctsResult:
    """
    Result of a Monte Carlo Tree Search

    :param side_one: Result for side one
    :type side_one: list[MctsSideResult]
    :param side_two: Result for side two
    :type side_two: list[MctsSideResult]
    :param total_visits: Total number of monte carlo iterations
    :type total_visits: int
    """

    side_one: list[MctsSideResult]
    side_two: list[MctsSideResult]
    total_visits: int

    @classmethod
    def _from_rust(cls, rust_result):
        return cls(
            side_one=[
                MctsSideResult(
                    move_choice=i.move_choice,
                    total_score=i.total_score,
                    visits=i.visits,
                )
                for i in rust_result.s1
            ],
            side_two=[
                MctsSideResult(
                    move_choice=i.move_choice,
                    total_score=i.total_score,
                    visits=i.visits,
                )
                for i in rust_result.s2
            ],
            total_visits=rust_result.iteration_count,
        )


@dataclass
class MctsRootDiagnostic:
    """Structural metrics for one side-one MCTS root action."""

    action: str
    root_visits: int
    mean_root_utility: float
    policy_support: float
    direct_move_pairs: int
    descendant_nodes: int
    evaluated_leaves: int
    terminal_leaves: int
    static_leaves: int
    max_depth: int
    mean_leaf_depth: float
    median_leaf_depth: float
    p90_leaf_depth: float
    p95_leaf_depth: float
    depth_histogram: list[int]
    deepest_meaningful_depth: int

    @classmethod
    def _from_rust(cls, value):
        return cls(
            action=value.action,
            root_visits=value.root_visits,
            mean_root_utility=value.mean_root_utility,
            policy_support=value.policy_support,
            direct_move_pairs=value.direct_move_pairs,
            descendant_nodes=value.descendant_nodes,
            evaluated_leaves=value.evaluated_leaves,
            terminal_leaves=value.terminal_leaves,
            static_leaves=value.static_leaves,
            max_depth=value.max_depth,
            mean_leaf_depth=value.mean_leaf_depth,
            median_leaf_depth=value.median_leaf_depth,
            p90_leaf_depth=value.p90_leaf_depth,
            p95_leaf_depth=value.p95_leaf_depth,
            depth_histogram=value.depth_histogram,
            deepest_meaningful_depth=value.deepest_meaningful_depth,
        )


@dataclass
class MctsDiagnosticResult:
    """Seeded, fixed-iteration MCTS output used by offline diagnostics only."""

    result: MctsResult
    roots: list[MctsRootDiagnostic]
    root_visit_floor: int
    path_prefixes: list["MctsPathPrefix"]

    @classmethod
    def _from_rust(cls, value):
        return cls(
            result=MctsResult._from_rust(value.result),
            roots=[MctsRootDiagnostic._from_rust(root) for root in value.roots],
            root_visit_floor=value.root_visit_floor,
            path_prefixes=[MctsPathPrefix._from_rust(path) for path in value.path_prefixes],
        )


@dataclass
class MctsPathPrefix:
    """One focused side-one action prefix in an offline MCTS diagnostic."""

    actions: list[str]
    evaluations: int
    mean_leaf_utility: float
    max_continuation_depth: int

    @classmethod
    def _from_rust(cls, value):
        return cls(
            actions=value.actions,
            evaluations=value.evaluations,
            mean_leaf_utility=value.mean_leaf_utility,
            max_continuation_depth=value.max_continuation_depth,
        )


def monte_carlo_tree_search(
    state: State, duration_ms: int = 1000, iterations: int = 0, threads: int = 1
) -> MctsResult:
    """
    Perform monte-carlo-tree-search on the given state and for the given duration

    :param state: the state to search through
    :type state: State
    :param duration_ms: time in milliseconds to run the search. ignored if iterations > 0
    :type duration_ms: int
    :param iterations: exact number of monte-carlo iterations to run
    :type iterations: int
    :param threads: number of threads to use for the search
    :type threads: int
    :return: the result of the search
    :rtype: MctsResult
    """
    return MctsResult._from_rust(mcts(state, duration_ms, iterations, threads))


def monte_carlo_tree_search_diagnostic(
    state: State,
    iterations: int,
    seed: int = 0,
    root_visit_floor: int = 0,
    focus_root_action: str | None = None,
) -> MctsDiagnosticResult:
    """Run seeded fixed-iteration MCTS with opt-in tree-depth measurements.

    This is an offline measurement API. Normal production MCTS continues to
    call :func:`monte_carlo_tree_search` and does not collect this data.
    """
    return MctsDiagnosticResult._from_rust(
        mcts_diagnostic(state, iterations, seed, root_visit_floor, focus_root_action)
    )


def monte_carlo_tree_search_seeded(state: State, iterations: int, seed: int) -> MctsResult:
    """Single-threaded, production-equivalent MCTS with an exact seeded budget.

    This is opt-in evaluation plumbing. Ordinary calls retain their existing
    time-budgeted/unseeded behaviour.
    """
    if iterations < 1:
        raise ValueError("iterations must be positive")
    return MctsResult._from_rust(mcts_seeded(state, iterations, seed))


def iterative_deepening_expectiminimax(
    state: State, duration_ms: int = 1000
) -> IterativeDeepeningResult:
    """
    Perform an iterative-deepening expectiminimax search on the given state and for the given duration

    :param state: the state to search through
    :type state: State
    :param duration_ms: time in milliseconds to run the search
    :type duration_ms: int
    :return: the result of the search
    :rtype: IterativeDeepeningResult
    """
    return IterativeDeepeningResult._from_rust(id(state, duration_ms))
