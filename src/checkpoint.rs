//! Snapshot envelope only. State and wave-plan adapters must additionally validate
//! every common battle field and master reference before constructing a runtime.
use crate::quest_data::U64Decimal;
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 2;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_DROP_SLOTS: usize = 4;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint<State, WavePlan> {
    pub schema_version: u32,
    pub quest_id: u32,
    pub quest_run_id: u64,
    pub resume_wave_index: u32,
    pub quest_initial_seed: U64Decimal,
    pub prng_state: U64Decimal,
    pub formation_fingerprint_sha256: String,
    pub wave_definition_fingerprint_sha256: String,
    pub quest_definition_fingerprint_sha256: String,
    pub ally_states: Vec<Combatant<State>>,
    pub enemy_states: Vec<Combatant<State>>,
    pub wave_plans: Vec<WavePlan>,
    pub final_wave_guaranteed_drop_reserved: bool,
    pub final_wave_guaranteed_drop_claimed: bool,
    pub ally_hit_combo: u8,
    pub action_queue: Vec<serde_json::Value>,
    pub skill_queue: Vec<serde_json::Value>,
    pub reserved_actions: Vec<serde_json::Value>,
    pub quest_auto_mode: AutoMode,
    pub quest_speed_multiplier: u8,
    pub panel_slots: [PanelSlot; crate::quest_runtime::PANEL_COUNT],
    pub opening_abilities_applied: bool,
    pub drop_results: Vec<DropResult>,
    pub drop_slot_count: u8,
    pub drop_evaluated_enemies: Vec<EvaluatedEnemy>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Combatant<State> {
    pub character_instance_id: u32,
    pub character_id: u32,
    pub formation_slot_id: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occupied_slots: Option<Vec<u8>>,
    pub state: State,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AutoMode {
    Manual,
    Auto,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PanelSlot {
    pub index: u8,
    #[serde(deserialize_with = "crate::quest_data::present_option")]
    pub effect: Option<PanelEffect>,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum PanelEffect {
    #[serde(rename = "skill_gauge_up")]
    SkillGaugeUp,
    #[serde(rename = "normal_attack_damage_1_5")]
    NormalAttackDamageOneAndHalf,
    #[serde(rename = "normal_attack_damage_2_0")]
    NormalAttackDamageDouble,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DropResult {
    pub wave_index: u32,
    pub enemy_position: u8,
    pub item_id: u32,
    pub count: u32,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct EvaluatedEnemy {
    pub wave_index: u32,
    pub enemy_position: u8,
}

impl<State, WavePlan> Checkpoint<State, WavePlan> {
    pub fn validate_envelope(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION
            || !(1..=MAX_SAFE_INTEGER).contains(&self.quest_run_id)
            || self.resume_wave_index == 0
            || self.resume_wave_index as usize > self.wave_plans.len()
            || self.ally_states.is_empty()
            || self.ally_states.len() > game_logic::formation::MAX_PARTY_SIZE
            || self.enemy_states.is_empty()
            || self.enemy_states.len() > usize::from(crate::quest_runtime::placement::BOARD_SIZE)
        {
            return Err("invalid checkpoint identity or combatant count".into());
        }
        if !self.action_queue.is_empty()
            || !self.skill_queue.is_empty()
            || !self.reserved_actions.is_empty()
            || self.ally_hit_combo != 0
            || !self.opening_abilities_applied
            || !matches!(self.quest_speed_multiplier, 1 | 2 | 4)
        {
            return Err("checkpoint is not a saved wave-start boundary".into());
        }
        for hash in [
            &self.formation_fingerprint_sha256,
            &self.wave_definition_fingerprint_sha256,
            &self.quest_definition_fingerprint_sha256,
        ] {
            const SHA256_HEX_LENGTH: usize = 64;
            if hash.len() != SHA256_HEX_LENGTH
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("invalid input fingerprint".into());
            }
        }
        for (index, panel) in self.panel_slots.iter().enumerate() {
            if usize::from(panel.index) != index {
                return Err("invalid panel order".into());
            }
        }
        self.validate_drops()?;
        let mut instances = std::collections::BTreeSet::new();
        for side in [&self.ally_states, &self.enemy_states] {
            let mut occupied = std::collections::BTreeSet::new();
            for actor in side {
                if actor.character_instance_id == 0
                    || !instances.insert(actor.character_instance_id)
                {
                    return Err("invalid or duplicate combatant instance".into());
                }
                let slots = actor
                    .occupied_slots
                    .clone()
                    .unwrap_or_else(|| vec![actor.formation_slot_id]);
                if !slots.contains(&actor.formation_slot_id)
                    || slots.iter().any(|slot| {
                        !(1..=crate::quest_runtime::placement::BOARD_SIZE).contains(slot)
                            || !occupied.insert(*slot)
                    })
                {
                    return Err("invalid checkpoint occupancy".into());
                }
            }
        }
        Ok(())
    }
    fn validate_drops(&self) -> Result<(), String> {
        if self.drop_results.len() > MAX_DROP_SLOTS
            || self.drop_results.len() != usize::from(self.drop_slot_count)
            || self.final_wave_guaranteed_drop_claimed && !self.final_wave_guaranteed_drop_reserved
        {
            return Err("invalid checkpoint drop state".into());
        }
        let mut evaluated = std::collections::BTreeSet::new();
        for enemy in &self.drop_evaluated_enemies {
            if enemy.wave_index == 0
                || enemy.wave_index > self.resume_wave_index
                || !(1..=crate::quest_runtime::placement::BOARD_SIZE)
                    .contains(&enemy.enemy_position)
                || !evaluated.insert(enemy)
            {
                return Err("invalid evaluated enemy".into());
            }
        }
        for drop in &self.drop_results {
            if drop.count == 0
                || !evaluated.contains(&EvaluatedEnemy {
                    wave_index: drop.wave_index,
                    enemy_position: drop.enemy_position,
                })
            {
                return Err("drop has no evaluated enemy".into());
            }
        }
        Ok(())
    }
}
