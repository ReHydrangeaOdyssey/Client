//! Validated source records; conversion to battle effects requires the master pipeline.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::skill_code::{MAX_EFFECT_LEVEL, MainEffect, SubEffect};

const MAX_PROBABILITY_LEVEL: u8 = 4;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillSource {
    pub id: u32,
    pub name: String,
    pub description: String,
    pub main_effect: String,
    pub sub_effects: Vec<String>,
    #[serde(deserialize_with = "crate::quest_data::present_option")]
    pub main_effect_level: Option<u8>,
    #[serde(deserialize_with = "crate::quest_data::present_option")]
    pub sub_effect_level: Option<u8>,
    #[serde(deserialize_with = "crate::quest_data::present_option")]
    pub probability_level: Option<u8>,
}

impl SkillSource {
    pub fn validate(&self) -> Result<(), String> {
        let error = |column: &str, reason: &str| format!("SkillID={} {column}: {reason}", self.id);
        if self.id == 0 || self.id == u32::MAX {
            return Err(error("ID", "reserved_id"));
        }
        let main = MainEffect::parse(&self.main_effect)
            .ok_or_else(|| error("MainEffect", "unknown_code"))?;
        let mut requires_sub_level = false;
        let mut requires_probability = main.requires_probability();
        for code in &self.sub_effects {
            let effect =
                SubEffect::parse(code).ok_or_else(|| error("SubEffect", "unknown_code"))?;
            requires_sub_level |= effect.requires_level();
            requires_probability |= effect.requires_probability();
        }
        let main_max = main.maximum_level();
        for (column, value, max) in [
            ("MainEffectLevel", self.main_effect_level, main_max),
            ("SubEffectLevel", self.sub_effect_level, MAX_EFFECT_LEVEL),
            (
                "ProbabilityLevel",
                self.probability_level,
                MAX_PROBABILITY_LEVEL,
            ),
        ] {
            if value.is_some_and(|level| level > max) {
                return Err(error(column, "out_of_range"));
            }
        }
        if main.requires_level() && self.main_effect_level.is_none() {
            return Err(error("MainEffectLevel", "required_level_missing"));
        }
        if requires_sub_level && self.sub_effect_level.is_none() {
            return Err(error("SubEffectLevel", "required_level_missing"));
        }
        if requires_probability && self.probability_level.is_none() {
            return Err(error("ProbabilityLevel", "required_level_missing"));
        }
        Ok(())
    }
}

pub fn validate_skills(records: &[SkillSource]) -> Result<(), String> {
    let mut ids = BTreeSet::new();
    for record in records {
        record.validate()?;
        if !ids.insert(record.id) {
            return Err(format!("SkillID={} ID: duplicate_id", record.id));
        }
    }
    Ok(())
}
