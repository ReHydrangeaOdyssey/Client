//! Validated source records; conversion to battle effects requires the master pipeline.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const MAIN_EFFECTS: &[&str] = &[
    "ALL_ENEMY_ATTACK",
    "CROSS",
    "CROSS_ADV_PIERCE_DIS_SLASH",
    "ENEMY_ONE_ATTACK",
    "ENEMY_ONE_ATTACK_CHEST_BONUS",
    "FLAT_ALL_ENEMY_ATTACK",
    "FLAT_CROSS",
    "FLAT_ENEMY_ONE_ATTACK",
    "FLAT_H_LINE",
    "FLAT_RND_3",
    "FLAT_RND_4",
    "FLAT_RND_5",
    "FLAT_V_LINE",
    "FLAT_X_CROSS",
    "H_LINE",
    "H_LINE_ADV_PIERCE_DIS_SLASH",
    "H_LINE_ADV_RANGED_DIS_STRIKE",
    "H_LINE_ADV_SLASH_DIS_PIERCE",
    "H_LINE_ADV_STRIKE_DIS_RANGED",
    "RND_1_4",
    "RND_2_5",
    "RND_2_5_RAMP",
    "RND_3",
    "RND_3_6",
    "RND_4",
    "RND_4_7",
    "RND_5",
    "RND_6",
    "RND_7",
    "V_LINE",
    "V_LINE_ADV_PIERCE_DIS_SLASH",
    "V_LINE_ADV_RANGED_DIS_STRIKE",
    "V_LINE_ADV_SLASH_DIS_PIERCE",
    "V_LINE_ADV_STRIKE_DIS_RANGED",
    "V_LINE_CHEST_BONUS",
    "X_CROSS",
    "X_CROSS_ADV_RANGED_DIS_STRIKE",
    "ALL_ENEMY_DEBUFF_ATK",
    "ALL_ENEMY_DEBUFF_ATK_DEF",
    "ALL_ENEMY_DEBUFF_DEF",
    "ALL_FRIEND_BUFF_ATK",
    "ALL_FRIEND_BUFF_ATK_DEF",
    "ALL_FRIEND_BUFF_DEF",
    "ENEMY_ONE_DEBUFF_ATK",
    "ENEMY_ONE_DEBUFF_ATK_DEF",
    "ENEMY_ONE_DEBUFF_DEF",
    "ENEMY_PIERCE_DEBUFF_ATK",
    "ENEMY_PIERCE_DEBUFF_ATK_DEF",
    "ENEMY_PIERCE_DEBUFF_DEF",
    "ENEMY_RANGED_DEBUFF_ATK",
    "ENEMY_RANGED_DEBUFF_ATK_DEF",
    "ENEMY_RANGED_DEBUFF_DEF",
    "ENEMY_SLASH_DEBUFF_ATK",
    "ENEMY_SLASH_DEBUFF_ATK_DEF",
    "ENEMY_SLASH_DEBUFF_DEF",
    "ENEMY_STRIKE_DEBUFF_ATK",
    "ENEMY_STRIKE_DEBUFF_ATK_DEF",
    "ENEMY_STRIKE_DEBUFF_DEF",
    "FRIEND_PIERCE_BUFF_ATK",
    "FRIEND_PIERCE_BUFF_ATK_DEF",
    "FRIEND_PIERCE_BUFF_DEF",
    "FRIEND_RANGED_BUFF_ATK",
    "FRIEND_RANGED_BUFF_ATK_DEF",
    "FRIEND_RANGED_BUFF_DEF",
    "FRIEND_SLASH_BUFF_ATK",
    "FRIEND_SLASH_BUFF_ATK_DEF",
    "FRIEND_SLASH_BUFF_DEF",
    "FRIEND_STRIKE_BUFF_ATK",
    "FRIEND_STRIKE_BUFF_ATK_DEF",
    "FRIEND_STRIKE_BUFF_DEF",
    "SELF_BUFF_ATK",
    "SELF_BUFF_ATK_DEF",
    "SELF_BUFF_DEF",
    "SELF_DEBUFF_DEF",
    "ALL_FRIEND_HEAL_HP",
    "ENEMY_STATUS_BLIND",
    "ENEMY_STATUS_DISABLE_AOE",
    "ENEMY_STATUS_POISON",
    "ENEMY_STATUS_SILENCE",
    "ENEMY_STATUS_SLEEP",
    "FOLLOW_UP_FRIEND_ATTACK",
    "FRIEND_MOST_DAMAGED_HEAL_HP",
    "FRIEND_ONE_REVIVE",
    "SELF_BUFF_NEXT_DAMAGE",
    "SELF_COUNTER",
    "SELF_TAUNT",
];
const SUB_EFFECTS: &[&str] = &[
    "DAMAGE_X2",
    "ENEMY_CANCEL_BUFF",
    "FRIEND_CANCEL_ABNORMAL",
    "FRIEND_CANCEL_DEBUFF",
    "SELF_BUFF_ATK",
    "SELF_BUFF_DEF",
    "SELF_HEAL_HP",
];

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
        if !MAIN_EFFECTS.contains(&self.main_effect.as_str()) {
            return Err(error("MainEffect", "unknown_code"));
        }
        if self
            .sub_effects
            .iter()
            .any(|code| !SUB_EFFECTS.contains(&code.as_str()))
        {
            return Err(error("SubEffect", "unknown_code"));
        }
        let main_max = if self.main_effect == "FRIEND_ONE_REVIVE" {
            2
        } else {
            6
        };
        for (column, value, max) in [
            ("MainEffectLevel", self.main_effect_level, main_max),
            ("SubEffectLevel", self.sub_effect_level, 6),
            ("ProbabilityLevel", self.probability_level, 4),
        ] {
            if value.is_some_and(|level| level > max) {
                return Err(error(column, "out_of_range"));
            }
        }
        let status = self.main_effect.starts_with("ENEMY_STATUS_");
        let special = matches!(
            self.main_effect.as_str(),
            "SELF_COUNTER" | "SELF_TAUNT" | "FOLLOW_UP_FRIEND_ATTACK"
        );
        if !status && !special && self.main_effect_level.is_none() {
            return Err(error("MainEffectLevel", "required_level_missing"));
        }
        if self.sub_effects.iter().any(|code| {
            matches!(
                code.as_str(),
                "SELF_BUFF_ATK" | "SELF_BUFF_DEF" | "SELF_HEAL_HP"
            )
        }) && self.sub_effect_level.is_none()
        {
            return Err(error("SubEffectLevel", "required_level_missing"));
        }
        if (status || self.sub_effects.iter().any(|code| code == "DAMAGE_X2"))
            && self.probability_level.is_none()
        {
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
