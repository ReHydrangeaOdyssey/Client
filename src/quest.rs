//! JSON adapters and lifecycle gates. Combat calculations belong to GameLogic.
use crate::quest_runtime::placement::{Drop, Enemy, FixedEnemy, Placement};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wave {
    placement: PlacementWire,
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
enum PlacementWire {
    Fixed {
        slots: BTreeMap<String, FixedWire>,
    },
    Auto {
        min_count: u8,
        max_count: u8,
        candidates: Vec<EnemyWire>,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnemyWire {
    id: u32,
    drop: BTreeMap<String, DropWire>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FixedWire {
    id: u32,
    multi: Vec<u8>,
    drop: BTreeMap<String, DropWire>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DropWire {
    probability: f32,
    count: u32,
}

fn enemy(
    id: u32,
    drops: BTreeMap<String, DropWire>,
    enemies: &BTreeSet<u32>,
    items: &BTreeSet<u32>,
) -> Result<Enemy, String> {
    if !enemies.contains(&id) {
        return Err(format!("unknown EnemyID {id}"));
    }
    let mut result = BTreeMap::new();
    for (key, drop) in drops {
        let id = crate::json::canonical_u32(&key)?;
        if !items.contains(&id) {
            return Err(format!("unknown OfflineItemID {id}"));
        }
        result.insert(
            id,
            Drop {
                probability: drop.probability,
                count: drop.count,
            },
        );
    }
    Ok(Enemy { id, drop: result })
}

pub fn definition(
    text: &str,
    enemies: &BTreeSet<u32>,
    items: &BTreeSet<u32>,
) -> Result<Vec<Placement>, String> {
    let wire: BTreeMap<String, Wave> = crate::json::parse(text)?;
    if wire.is_empty() {
        return Err("quest has no waves".into());
    }
    let mut ordered = BTreeMap::new();
    for (key, wave) in wire {
        let suffix = key.strip_prefix("wave").ok_or("invalid wave key")?;
        let number = crate::json::canonical_u32(suffix)?;
        if number == 0 {
            return Err("wave numbers start at 1".into());
        }
        ordered.insert(number, wave);
    }
    let mut result = Vec::new();
    for (index, (number, wave)) in ordered.into_iter().enumerate() {
        if u32::try_from(index + 1).map_err(|_| "wave count overflow")? != number {
            return Err(
                "クエストデータが破損しています。データを再ダウンロードしてください。".into(),
            );
        }
        let placement = match wave.placement {
            PlacementWire::Fixed { slots } => {
                let mut fixed = Vec::new();
                for (key, entry) in slots {
                    let slot = u8::try_from(crate::json::canonical_u32(&key)?)
                        .map_err(|_| "invalid formation slot")?;
                    fixed.push(FixedEnemy {
                        enemy: enemy(entry.id, entry.drop, enemies, items)?,
                        slot,
                        multi: entry.multi,
                    });
                }
                Placement::Fixed(fixed)
            }
            PlacementWire::Auto {
                min_count,
                max_count,
                candidates,
            } => Placement::Auto {
                min_count,
                max_count,
                candidates: candidates
                    .into_iter()
                    .map(|e| enemy(e.id, e.drop, enemies, items))
                    .collect::<Result<_, _>>()?,
            },
        };
        placement.validate().map_err(|e| e.to_string())?;
        result.push(placement);
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Selection,
    SavingWave,
    Battle,
    WaveTransition,
    Failed,
    Finalizing,
    Reward,
    Acknowledging,
}

#[derive(Clone, Debug)]
pub struct Controller {
    phase: Phase,
    wave: u32,
    wave_count: u32,
    foreground: bool,
}
impl Default for Controller {
    fn default() -> Self {
        Self {
            phase: Phase::Selection,
            wave: 0,
            wave_count: 0,
            foreground: true,
        }
    }
}
impl Controller {
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn accepts_battle_input(&self) -> bool {
        self.foreground && self.phase == Phase::Battle
    }
    pub fn can_leave(&self) -> bool {
        self.phase == Phase::Selection
    }
    pub fn foreground(&mut self, visible: bool) {
        self.foreground = visible;
    }
    pub fn begin(&mut self, wave: u32, count: u32) -> Result<(), String> {
        if !matches!(self.phase, Phase::Selection | Phase::Failed) || wave == 0 || wave > count {
            return Err("invalid quest start".into());
        }
        self.wave = wave;
        self.wave_count = count;
        self.phase = Phase::SavingWave;
        Ok(())
    }
    pub fn checkpoint_committed(&mut self) -> Result<(), String> {
        self.require(Phase::SavingWave)?;
        self.phase = Phase::Battle;
        Ok(())
    }
    pub fn outcome(&mut self, allies_alive: bool, enemies_alive: bool) -> Result<(), String> {
        self.require(Phase::Battle)?;
        match (allies_alive, enemies_alive) {
            (false, false) => {
                return Err("simultaneous annihilation violates quest invariant".into());
            }
            (false, true) => self.phase = Phase::Failed,
            (true, false) if self.wave == self.wave_count => self.phase = Phase::Finalizing,
            (true, false) => self.phase = Phase::WaveTransition,
            (true, true) => {}
        }
        Ok(())
    }
    pub fn next_wave_prepared(&mut self) -> Result<(), String> {
        self.require(Phase::WaveTransition)?;
        self.wave = self.wave.checked_add(1).ok_or("wave overflow")?;
        self.phase = Phase::SavingWave;
        Ok(())
    }
    pub fn result_committed(&mut self) -> Result<(), String> {
        self.require(Phase::Finalizing)?;
        self.phase = Phase::Reward;
        Ok(())
    }
    pub fn reward_committed(&mut self) -> Result<(), String> {
        self.require(Phase::Reward)?;
        self.phase = Phase::Acknowledging;
        Ok(())
    }
    pub fn receipt_acknowledged(&mut self) -> Result<(), String> {
        self.require(Phase::Acknowledging)?;
        self.phase = Phase::Selection;
        Ok(())
    }
    pub fn failure_checkpoint_deleted(&mut self) -> Result<(), String> {
        self.require(Phase::Failed)?;
        self.phase = Phase::Selection;
        Ok(())
    }
    fn require(&self, phase: Phase) -> Result<(), String> {
        if self.phase == phase {
            Ok(())
        } else {
            Err("invalid quest lifecycle transition".into())
        }
    }
}
