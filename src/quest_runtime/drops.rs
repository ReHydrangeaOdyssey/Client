use super::placement::PlannedEnemy;
use game_logic::{Error, pseudorandom::Random};
use std::collections::BTreeSet;

const DROP_CAPACITY: usize = 4;
const RESERVED_CAPACITY: usize = DROP_CAPACITY - 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Award {
    pub wave_index: u32,
    pub enemy_position: u8,
    pub item_id: u32,
    pub count: u32,
}

#[derive(Clone, Debug, Default)]
pub struct Drops {
    results: Vec<Award>,
    evaluated: BTreeSet<(u32, u8)>,
    reserved: bool,
    claimed: bool,
}

impl Drops {
    pub fn new(reserved: bool) -> Self {
        Self {
            reserved,
            ..Self::default()
        }
    }
    pub fn results(&self) -> &[Award] {
        &self.results
    }
    pub fn evaluated(&self) -> &BTreeSet<(u32, u8)> {
        &self.evaluated
    }
    pub fn claimed(&self) -> bool {
        self.claimed
    }
    pub fn first_zero_hp(
        &mut self,
        wave: u32,
        final_wave: u32,
        enemy: &PlannedEnemy,
        random: &mut Random,
    ) -> Result<(), Error> {
        if wave == 0 || wave > final_wave {
            return Err(Error::InvalidValue("drop wave"));
        }
        for drop in enemy.enemy.drop.values() {
            super::rate(drop.probability)?;
            if drop.count == 0 {
                return Err(Error::InvalidValue("drop count"));
            }
        }
        if !self.evaluated.insert((wave, enemy.slot)) {
            return Ok(());
        }
        for (&item_id, drop) in &enemy.enemy.drop {
            // Each item consumes its probability draw even when the capacity is exhausted.
            let won = random.probability(drop.probability);
            let guaranteed = wave == final_wave && drop.probability == 1.0;
            let capacity = if self.reserved && !self.claimed && !guaranteed {
                RESERVED_CAPACITY
            } else {
                DROP_CAPACITY
            };
            if won && self.results.len() < capacity {
                self.results.push(Award {
                    wave_index: wave,
                    enemy_position: enemy.slot,
                    item_id,
                    count: drop.count,
                });
                if guaranteed {
                    self.claimed = true;
                }
            }
        }
        Ok(())
    }
}
