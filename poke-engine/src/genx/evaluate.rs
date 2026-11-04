use super::abilities::Abilities;
use super::items::Items;
use super::state::PokemonVolatileStatus;
use crate::choices::{Choices, MoveCategory};
use crate::state::{Pokemon, PokemonStatus, Side, State};

const POKEMON_ALIVE: f32 = 30.0;
const POKEMON_HP: f32 = 100.0;
const USED_TERA: f32 = -75.0;

const POKEMON_ATTACK_BOOST: f32 = 30.0;
const POKEMON_DEFENSE_BOOST: f32 = 15.0;
const POKEMON_SPECIAL_ATTACK_BOOST: f32 = 30.0;
const POKEMON_SPECIAL_DEFENSE_BOOST: f32 = 15.0;
const POKEMON_SPEED_BOOST: f32 = 30.0;

const POKEMON_BOOST_MULTIPLIER_6: f32 = 3.3;
const POKEMON_BOOST_MULTIPLIER_5: f32 = 3.15;
const POKEMON_BOOST_MULTIPLIER_4: f32 = 3.0;
const POKEMON_BOOST_MULTIPLIER_3: f32 = 2.5;
const POKEMON_BOOST_MULTIPLIER_2: f32 = 2.0;
const POKEMON_BOOST_MULTIPLIER_1: f32 = 1.0;
const POKEMON_BOOST_MULTIPLIER_0: f32 = 0.0;
const POKEMON_BOOST_MULTIPLIER_NEG_1: f32 = -1.0;
const POKEMON_BOOST_MULTIPLIER_NEG_2: f32 = -2.0;
const POKEMON_BOOST_MULTIPLIER_NEG_3: f32 = -2.5;
const POKEMON_BOOST_MULTIPLIER_NEG_4: f32 = -3.0;
const POKEMON_BOOST_MULTIPLIER_NEG_5: f32 = -3.15;
const POKEMON_BOOST_MULTIPLIER_NEG_6: f32 = -3.3;

const POKEMON_FROZEN: f32 = -40.0;
const POKEMON_ASLEEP: f32 = -25.0;
const POKEMON_PARALYZED: f32 = -25.0;
const POKEMON_TOXIC: f32 = -30.0;
const POKEMON_POISONED: f32 = -10.0;
const POKEMON_BURNED: f32 = -25.0;

const LEECH_SEED: f32 = -30.0;
const SUBSTITUTE: f32 = 40.0;
const CONFUSION: f32 = -20.0;

const REFLECT: f32 = 20.0;
const LIGHT_SCREEN: f32 = 20.0;
const AURORA_VEIL: f32 = 40.0;
const SAFE_GUARD: f32 = 5.0;
const TAILWIND: f32 = 7.0;
const HEALING_WISH: f32 = 30.0;

const STEALTH_ROCK: f32 = -10.0;
const SPIKES: f32 = -7.0;
const TOXIC_SPIKES: f32 = -7.0;
const STICKY_WEB: f32 = -25.0;

fn evaluate_poison(pokemon: &Pokemon, base_score: f32) -> f32 {
    match pokemon.ability {
        Abilities::POISONHEAL => 15.0,
        Abilities::GUTS
        | Abilities::MARVELSCALE
        | Abilities::QUICKFEET
        | Abilities::TOXICBOOST
        | Abilities::MAGICGUARD => 10.0,
        _ => base_score,
    }
}

fn evaluate_burned(pokemon: &Pokemon) -> f32 {
    // burn is not as punishing in certain situations

    // guts, marvel scale, quick feet will result in a positive evaluation
    match pokemon.ability {
        Abilities::GUTS | Abilities::MARVELSCALE | Abilities::QUICKFEET => {
            return -2.0 * POKEMON_BURNED
        }
        _ => {}
    }

    let mut multiplier = 0.0;
    for mv in pokemon.moves.into_iter() {
        if mv.choice.category == MoveCategory::Physical {
            multiplier += 1.0;
        }
    }

    // don't make burn as punishing for special attackers
    if pokemon.special_attack > pokemon.attack {
        multiplier /= 2.0;
    }

    multiplier * POKEMON_BURNED
}

fn get_boost_multiplier(boost: i8) -> f32 {
    match boost {
        6 => POKEMON_BOOST_MULTIPLIER_6,
        5 => POKEMON_BOOST_MULTIPLIER_5,
        4 => POKEMON_BOOST_MULTIPLIER_4,
        3 => POKEMON_BOOST_MULTIPLIER_3,
        2 => POKEMON_BOOST_MULTIPLIER_2,
        1 => POKEMON_BOOST_MULTIPLIER_1,
        0 => POKEMON_BOOST_MULTIPLIER_0,
        -1 => POKEMON_BOOST_MULTIPLIER_NEG_1,
        -2 => POKEMON_BOOST_MULTIPLIER_NEG_2,
        -3 => POKEMON_BOOST_MULTIPLIER_NEG_3,
        -4 => POKEMON_BOOST_MULTIPLIER_NEG_4,
        -5 => POKEMON_BOOST_MULTIPLIER_NEG_5,
        -6 => POKEMON_BOOST_MULTIPLIER_NEG_6,
        _ => panic!("Invalid boost value: {}", boost),
    }
}

fn has_usable_offensive_move(pokemon: &Pokemon, category: MoveCategory) -> bool {
    pokemon.moves.into_iter().any(|mv| {
        mv.id != Choices::NONE && !mv.disabled && mv.pp > 0 && mv.choice.category == category
    })
}

fn evaluate_offensive_boost(
    pokemon: &Pokemon,
    boost: i8,
    category: MoveCategory,
    value: f32,
) -> f32 {
    // Positive boosts are only useful when the currently usable moveset can
    // consume that offensive stat. Keep drops unchanged in this small
    // experiment: their value affects Memento and deserves its own test.
    if boost > 0 && !has_usable_offensive_move(pokemon, category) {
        return 0.0;
    }
    get_boost_multiplier(boost) * value
}

fn evaluate_hazards(pokemon: &Pokemon, side: &Side) -> f32 {
    let mut score = 0.0;
    let pkmn_is_grounded = pokemon.is_grounded();
    if pokemon.item != Items::HEAVYDUTYBOOTS {
        if pokemon.ability != Abilities::MAGICGUARD {
            score += side.side_conditions.stealth_rock as f32 * STEALTH_ROCK;
            if pkmn_is_grounded {
                score += side.side_conditions.spikes as f32 * SPIKES;
                score += side.side_conditions.toxic_spikes as f32 * TOXIC_SPIKES;
            }
        }
        if pkmn_is_grounded {
            score += side.side_conditions.sticky_web as f32 * STICKY_WEB;
        }
    }

    score
}

fn evaluate_pokemon(pokemon: &Pokemon) -> f32 {
    let mut score = 0.0;
    score += POKEMON_HP * pokemon.hp as f32 / pokemon.maxhp as f32;

    match pokemon.status {
        PokemonStatus::BURN => score += evaluate_burned(pokemon),
        PokemonStatus::FREEZE => score += POKEMON_FROZEN,
        PokemonStatus::SLEEP => score += POKEMON_ASLEEP,
        PokemonStatus::PARALYZE => score += POKEMON_PARALYZED,
        PokemonStatus::TOXIC => score += evaluate_poison(pokemon, POKEMON_TOXIC),
        PokemonStatus::POISON => score += evaluate_poison(pokemon, POKEMON_POISONED),
        PokemonStatus::NONE => {}
    }

    if pokemon.item != Items::NONE {
        score += 10.0;
    }

    // without this a low hp pokemon could get a negative score and incentivize the other side
    // to keep it alive
    if score < 0.0 {
        score = 0.0;
    }

    score += POKEMON_ALIVE;

    score
}

pub fn evaluate(state: &State) -> f32 {
    let mut score = 0.0;

    let mut iter = state.side_one.pokemon.into_iter();
    let mut s1_used_tera = false;
    while let Some(pkmn) = iter.next() {
        if pkmn.hp > 0 {
            score += evaluate_pokemon(pkmn);
            score += evaluate_hazards(pkmn, &state.side_one);
            if iter.pokemon_index == state.side_one.active_index {
                if state
                    .side_one
                    .volatile_statuses
                    .contains(&PokemonVolatileStatus::LEECHSEED)
                {
                    score += LEECH_SEED;
                }
                if state
                    .side_one
                    .volatile_statuses
                    .contains(&PokemonVolatileStatus::SUBSTITUTE)
                {
                    score += SUBSTITUTE;
                }
                if state
                    .side_one
                    .volatile_statuses
                    .contains(&PokemonVolatileStatus::CONFUSION)
                {
                    score += CONFUSION;
                }

                score += evaluate_offensive_boost(
                    pkmn,
                    state.side_one.attack_boost,
                    MoveCategory::Physical,
                    POKEMON_ATTACK_BOOST,
                );
                score += get_boost_multiplier(state.side_one.defense_boost) * POKEMON_DEFENSE_BOOST;
                score += evaluate_offensive_boost(
                    pkmn,
                    state.side_one.special_attack_boost,
                    MoveCategory::Special,
                    POKEMON_SPECIAL_ATTACK_BOOST,
                );
                score += get_boost_multiplier(state.side_one.special_defense_boost)
                    * POKEMON_SPECIAL_DEFENSE_BOOST;
                score += get_boost_multiplier(state.side_one.speed_boost) * POKEMON_SPEED_BOOST;
            }
        }
        if pkmn.terastallized {
            s1_used_tera = true;
        }
    }
    if s1_used_tera {
        score += USED_TERA;
    }
    let mut iter = state.side_two.pokemon.into_iter();
    let mut s2_used_tera = false;
    while let Some(pkmn) = iter.next() {
        if pkmn.hp > 0 {
            score -= evaluate_pokemon(pkmn);
            score -= evaluate_hazards(pkmn, &state.side_two);

            if iter.pokemon_index == state.side_two.active_index {
                if state
                    .side_two
                    .volatile_statuses
                    .contains(&PokemonVolatileStatus::LEECHSEED)
                {
                    score -= LEECH_SEED;
                }
                if state
                    .side_two
                    .volatile_statuses
                    .contains(&PokemonVolatileStatus::SUBSTITUTE)
                {
                    score -= SUBSTITUTE;
                }
                if state
                    .side_two
                    .volatile_statuses
                    .contains(&PokemonVolatileStatus::CONFUSION)
                {
                    score -= CONFUSION;
                }

                score -= evaluate_offensive_boost(
                    pkmn,
                    state.side_two.attack_boost,
                    MoveCategory::Physical,
                    POKEMON_ATTACK_BOOST,
                );
                score -= get_boost_multiplier(state.side_two.defense_boost) * POKEMON_DEFENSE_BOOST;
                score -= evaluate_offensive_boost(
                    pkmn,
                    state.side_two.special_attack_boost,
                    MoveCategory::Special,
                    POKEMON_SPECIAL_ATTACK_BOOST,
                );
                score -= get_boost_multiplier(state.side_two.special_defense_boost)
                    * POKEMON_SPECIAL_DEFENSE_BOOST;
                score -= get_boost_multiplier(state.side_two.speed_boost) * POKEMON_SPEED_BOOST;
            }
        }
        if pkmn.terastallized {
            s2_used_tera = true;
        }
    }
    if s2_used_tera {
        score -= USED_TERA;
    }

    score += state.side_one.side_conditions.reflect as f32 * REFLECT;
    score += state.side_one.side_conditions.light_screen as f32 * LIGHT_SCREEN;
    score += state.side_one.side_conditions.aurora_veil as f32 * AURORA_VEIL;
    score += state.side_one.side_conditions.safeguard as f32 * SAFE_GUARD;
    score += state.side_one.side_conditions.tailwind as f32 * TAILWIND;
    score += state.side_one.side_conditions.healing_wish as f32 * HEALING_WISH;

    score -= state.side_two.side_conditions.reflect as f32 * REFLECT;
    score -= state.side_two.side_conditions.light_screen as f32 * LIGHT_SCREEN;
    score -= state.side_two.side_conditions.aurora_veil as f32 * AURORA_VEIL;
    score -= state.side_two.side_conditions.safeguard as f32 * SAFE_GUARD;
    score -= state.side_two.side_conditions.tailwind as f32 * TAILWIND;
    score -= state.side_two.side_conditions.healing_wish as f32 * HEALING_WISH;

    score
}

#[derive(Clone, Copy, Debug, Default)]
pub struct EvaluationBreakdown {
    pub pokemon: f32,
    pub hazards: f32,
    pub active_effects: f32,
    pub boosts: f32,
    pub tera: f32,
    pub side_conditions: f32,
    pub total: f32,
}

/// Exposes the terms of the exact static evaluator used by MCTS.
///
/// `total` is obtained by calling `evaluate` itself so instrumentation cannot
/// silently replace the search evaluator with a look-alike implementation.
pub fn evaluate_breakdown(state: &State) -> EvaluationBreakdown {
    let mut result = EvaluationBreakdown::default();
    for (sign, side) in [(1.0_f32, &state.side_one), (-1.0_f32, &state.side_two)] {
        let mut used_tera = false;
        let mut iter = side.pokemon.into_iter();
        while let Some(pokemon) = iter.next() {
            if pokemon.hp > 0 {
                result.pokemon += sign * evaluate_pokemon(pokemon);
                result.hazards += sign * evaluate_hazards(pokemon, side);
                if iter.pokemon_index == side.active_index {
                    if side.volatile_statuses.contains(&PokemonVolatileStatus::LEECHSEED) {
                        result.active_effects += sign * LEECH_SEED;
                    }
                    if side.volatile_statuses.contains(&PokemonVolatileStatus::SUBSTITUTE) {
                        result.active_effects += sign * SUBSTITUTE;
                    }
                    if side.volatile_statuses.contains(&PokemonVolatileStatus::CONFUSION) {
                        result.active_effects += sign * CONFUSION;
                    }
                    result.boosts += sign
                        * evaluate_offensive_boost(
                            pokemon,
                            side.attack_boost,
                            MoveCategory::Physical,
                            POKEMON_ATTACK_BOOST,
                        );
                    result.boosts += sign * get_boost_multiplier(side.defense_boost) * POKEMON_DEFENSE_BOOST;
                    result.boosts += sign
                        * evaluate_offensive_boost(
                            pokemon,
                            side.special_attack_boost,
                            MoveCategory::Special,
                            POKEMON_SPECIAL_ATTACK_BOOST,
                        );
                    result.boosts += sign * get_boost_multiplier(side.special_defense_boost) * POKEMON_SPECIAL_DEFENSE_BOOST;
                    result.boosts += sign * get_boost_multiplier(side.speed_boost) * POKEMON_SPEED_BOOST;
                }
            }
            used_tera |= pokemon.terastallized;
        }
        if used_tera {
            result.tera += sign * USED_TERA;
        }
        result.side_conditions += sign * side.side_conditions.reflect as f32 * REFLECT;
        result.side_conditions += sign * side.side_conditions.light_screen as f32 * LIGHT_SCREEN;
        result.side_conditions += sign * side.side_conditions.aurora_veil as f32 * AURORA_VEIL;
        result.side_conditions += sign * side.side_conditions.safeguard as f32 * SAFE_GUARD;
        result.side_conditions += sign * side.side_conditions.tailwind as f32 * TAILWIND;
        result.side_conditions += sign * side.side_conditions.healing_wish as f32 * HEALING_WISH;
    }
    result.total = evaluate(state);
    result
}

#[cfg(test)]
mod tests {
    use super::evaluate;
    use crate::choices::Choices;
    use crate::state::{PokemonIndex, PokemonMoveIndex, State};

    fn state_with_active_moves(moves: &[Choices]) -> State {
        let mut state = State::default();
        for (index, choice) in moves.iter().enumerate() {
            let move_index = match index {
                0 => PokemonMoveIndex::M0,
                1 => PokemonMoveIndex::M1,
                2 => PokemonMoveIndex::M2,
                3 => PokemonMoveIndex::M3,
                _ => unreachable!("Pokemon has at most four moves"),
            };
            state.side_one.pokemon[PokemonIndex::P0].replace_move(move_index, *choice);
        }
        state
    }

    fn boost_delta(mut state: State, attack: i8, special_attack: i8) -> f32 {
        let baseline = evaluate(&state);
        state.side_one.attack_boost = attack;
        state.side_one.special_attack_boost = special_attack;
        evaluate(&state) - baseline
    }

    #[test]
    fn physical_only_active_values_attack_but_not_special_attack_boost() {
        let state = state_with_active_moves(&[Choices::TACKLE]);

        assert!(boost_delta(state.clone(), 2, 0) > 0.0);
        assert_eq!(boost_delta(state, 0, 2), 0.0);
    }

    #[test]
    fn special_only_active_values_special_attack_but_not_attack_boost() {
        let state = state_with_active_moves(&[Choices::FLAMETHROWER]);

        assert_eq!(boost_delta(state.clone(), 2, 0), 0.0);
        assert!(boost_delta(state, 0, 2) > 0.0);
    }

    #[test]
    fn mixed_active_values_both_offensive_boosts() {
        let state = state_with_active_moves(&[Choices::TACKLE, Choices::FLAMETHROWER]);

        assert!(boost_delta(state.clone(), 2, 0) > 0.0);
        assert!(boost_delta(state, 0, 2) > 0.0);
    }

    #[test]
    fn status_only_active_values_neither_offensive_boost() {
        let state = state_with_active_moves(&[Choices::PROTECT]);

        assert_eq!(boost_delta(state.clone(), 2, 0), 0.0);
        assert_eq!(boost_delta(state, 0, 2), 0.0);
    }

    #[test]
    fn unboosted_state_evaluation_is_unchanged() {
        let state = state_with_active_moves(&[Choices::TACKLE]);

        assert_eq!(evaluate(&state), 0.0);
        assert_eq!(evaluate(&state), evaluate(&state));
    }
}
