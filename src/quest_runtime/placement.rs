use super::{PANEL_COUNT, Panel};
use game_logic::{Error, pseudorandom::Random};
use std::collections::{BTreeMap, BTreeSet};

pub const BOARD_SIZE: u8 = 9;

#[derive(Clone, Debug, PartialEq)]
pub struct Drop {
    pub probability: f32,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Enemy {
    pub id: u32,
    pub drop: BTreeMap<u32, Drop>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FixedEnemy {
    pub enemy: Enemy,
    pub slot: u8,
    pub multi: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Placement {
    Fixed(Vec<FixedEnemy>),
    Auto {
        min_count: u8,
        max_count: u8,
        candidates: Vec<Enemy>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlannedEnemy {
    pub instance_id: u32,
    pub enemy: Enemy,
    pub slot: u8,
    pub occupied_slots: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub waves: Vec<Vec<PlannedEnemy>>,
    pub panels: [Panel; PANEL_COUNT],
    pub random: Random,
    pub guaranteed_drop_reserved: bool,
}

impl Placement {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Fixed(enemies) => {
                if enemies.is_empty() || enemies.len() > usize::from(BOARD_SIZE) {
                    return Err(Error::InvalidFormation);
                }
                let mut occupied = BTreeSet::new();
                for enemy in enemies {
                    validate_enemy(&enemy.enemy)?;
                    for slot in std::iter::once(&enemy.slot).chain(&enemy.multi) {
                        if !(1..=BOARD_SIZE).contains(slot) || !occupied.insert(*slot) {
                            return Err(Error::InvalidFormation);
                        }
                    }
                }
            }
            Self::Auto {
                min_count,
                max_count,
                candidates,
            } => {
                if *min_count == 0
                    || min_count > max_count
                    || *max_count > BOARD_SIZE
                    || candidates.is_empty()
                    || u32::try_from(candidates.len()).is_err()
                {
                    return Err(Error::InvalidFormation);
                }
                for enemy in candidates {
                    validate_enemy(enemy)?;
                }
            }
        }
        Ok(())
    }
}

fn validate_enemy(enemy: &Enemy) -> Result<(), Error> {
    for item in enemy.drop.values() {
        super::rate(item.probability)?;
        if item.count == 0 {
            return Err(Error::InvalidValue("drop count"));
        }
    }
    Ok(())
}

fn auto_place(
    min: u8,
    max: u8,
    candidates: &[Enemy],
    random: &mut Random,
) -> Result<Vec<FixedEnemy>, Error> {
    // N = min + uniform_integer(0, max - min); consume count, then N candidates, then N slots.
    let count = u32::from(min) + random.next_bounded(u32::from(max - min) + 1);
    let bound = u32::try_from(candidates.len()).map_err(|_| Error::ArithmeticOverflow)?;
    let mut enemies = Vec::new();
    for _ in 0..count {
        let index = random.next_bounded(bound) as usize;
        enemies.push(
            candidates
                .get(index)
                .ok_or(Error::InvalidFormation)?
                .clone(),
        );
    }
    let mut available: Vec<_> = (1..=BOARD_SIZE).collect();
    let mut result = Vec::new();
    for enemy in enemies {
        let index = random.next_bounded(available.len() as u32) as usize;
        let slot = *available.get(index).ok_or(Error::InvalidFormation)?;
        available.remove(index);
        result.push(FixedEnemy {
            enemy,
            slot,
            multi: Vec::new(),
        });
    }
    Ok(result)
}

pub fn prepare(waves: &[Placement], seed: u64, first_enemy_instance: u32) -> Result<Plan, Error> {
    if waves.is_empty() || first_enemy_instance == 0 {
        return Err(Error::InvalidValue("quest waves or instance ID"));
    }
    for wave in waves {
        wave.validate()?;
    }
    let mut random = Random::new(seed);
    let mut instance_id = first_enemy_instance;
    let mut plans = Vec::new();
    for wave in waves {
        let mut enemies = match wave {
            Placement::Fixed(enemies) => {
                let mut sorted = enemies.clone();
                sorted.sort_by_key(|enemy| enemy.slot);
                sorted
            }
            Placement::Auto {
                min_count,
                max_count,
                candidates,
            } => auto_place(*min_count, *max_count, candidates, &mut random)?,
        };
        let mut plan = Vec::new();
        for enemy in enemies.drain(..) {
            let mut occupied_slots = vec![enemy.slot];
            occupied_slots.extend(enemy.multi);
            plan.push(PlannedEnemy {
                instance_id,
                enemy: enemy.enemy,
                slot: enemy.slot,
                occupied_slots,
            });
            instance_id = instance_id
                .checked_add(1)
                .ok_or(Error::ArithmeticOverflow)?;
        }
        plans.push(plan);
    }
    let guaranteed_drop_reserved = plans.last().is_some_and(|wave| {
        wave.iter().any(|enemy| {
            enemy
                .enemy
                .drop
                .values()
                .any(|drop| drop.probability == 1.0)
        })
    });
    let panels = std::array::from_fn(|_| Panel::draw(&mut random));
    Ok(Plan {
        waves: plans,
        panels,
        random,
        guaranteed_drop_reserved,
    })
}
