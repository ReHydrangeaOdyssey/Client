//! Confirmed wire contracts; file locations and production records are supplied by the caller.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnemyCatalog {
    pub enemies: BTreeMap<String, EnemyData>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnemyData {
    pub character_id: u32,
    pub attribute: u8,
    pub hp: u32,
    pub attack: u32,
    pub defense: u32,
    pub speed: u8,
    pub skill_ids: Vec<u32>,
    pub ability_ids: Vec<u32>,
}

const MAX_ATTRIBUTE_ID: u8 = 3;
const MAX_SPEED_RANK: u8 = 32;
impl EnemyCatalog {
    pub fn validate(
        &self,
        character_ids: &BTreeSet<u32>,
        skill_ids: &BTreeSet<u32>,
        ability_ids: &BTreeSet<u32>,
    ) -> Result<(), String> {
        for (id, data) in &self.enemies {
            crate::json::canonical_u32(id)?;
            if data.hp == 0
                || data.attribute > MAX_ATTRIBUTE_ID
                || data.speed > MAX_SPEED_RANK
                || !character_ids.contains(&data.character_id)
                || data.skill_ids.iter().any(|id| !skill_ids.contains(id))
                || data.ability_ids.iter().any(|id| !ability_ids.contains(id))
            {
                return Err("invalid enemy data or unresolved master reference".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterSkills {
    pub character_skills: BTreeMap<String, SkillMapping>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillMapping {
    pub skill1_id: u32,
    #[serde(deserialize_with = "present_option")]
    pub skill2_id: Option<u32>,
    #[serde(deserialize_with = "present_option")]
    pub skill2_condition_id: Option<u32>,
}

impl SkillMapping {
    pub fn validate(
        &self,
        skills: &BTreeSet<u32>,
        conditions: &BTreeSet<u32>,
    ) -> Result<(), String> {
        if self.skill1_id == 0 || self.skill1_id == u32::MAX || !skills.contains(&self.skill1_id) {
            return Err("unknown Skill1".into());
        }
        match (self.skill2_id, self.skill2_condition_id) {
            (None, None) => Ok(()),
            (Some(skill), Some(condition))
                if skill != 0
                    && skill != u32::MAX
                    && skills.contains(&skill)
                    && conditions.contains(&condition) =>
            {
                Ok(())
            }
            _ => Err("Skill2 mapping is incomplete or its condition is unbound".into()),
        }
    }
}

/// Original CSV slots remain distinct even when Skill1 is not owned.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CharacterLoadout {
    pub skill: u32,
    pub uf: u32,
    pub tactics1: u32,
    pub tactics2: u32,
    pub characteristic: u32,
    pub knight_skill: u32,
    pub support_skill: u32,
}

impl CharacterLoadout {
    pub fn skill_ids(&self) -> Vec<u32> {
        [self.skill, self.uf]
            .into_iter()
            .filter(|id| *id != 0)
            .collect()
    }

    pub fn tactics_ids(&self) -> Vec<u32> {
        [self.tactics1, self.tactics2]
            .into_iter()
            .filter(|id| *id != 0)
            .collect()
    }

    pub fn validate(&self, skills: &BTreeSet<u32>, tactics: &BTreeSet<u32>) -> Result<(), String> {
        let ids = self.skill_ids();
        if ids.is_empty() || ids.iter().any(|id| *id == u32::MAX || !skills.contains(id)) {
            return Err("missing or unresolved owned Skill".into());
        }
        if self.tactics_ids().iter().any(|id| !tactics.contains(id)) {
            return Err("unresolved owned Tactics".into());
        }
        // The three unused source columns are retained without inferred Ability mappings.
        Ok(())
    }

    pub fn quest_mapping(&self, skill2_condition_id: Option<u32>) -> Result<SkillMapping, String> {
        if self.skill == 0 || self.skill == u32::MAX {
            return Err("Quest Skill1 slot is unavailable; Skill2 cannot replace it".into());
        }
        if self.uf == u32::MAX || (self.uf == 0 && skill2_condition_id.is_some()) {
            return Err("invalid Skill2 slot or condition".into());
        }
        if self.uf != 0 && skill2_condition_id.is_none() {
            return Err("Skill2 condition mapping is not yet supplied".into());
        }
        Ok(SkillMapping {
            skill1_id: self.skill,
            skill2_id: (self.uf != 0).then_some(self.uf),
            skill2_condition_id,
        })
    }
}

/// Lossless snapshot wire value, not a rounded JSON floating-point number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct F32Bits(u32);

impl F32Bits {
    pub fn new(value: f32) -> Result<Self, String> {
        if !value.is_finite() {
            return Err("non-finite snapshot value".into());
        }
        Ok(Self(value.to_bits()))
    }
    pub fn value(self) -> f32 {
        f32::from_bits(self.0)
    }
}
impl Serialize for F32Bits {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("{:08x}", self.0))
    }
}
impl<'de> Deserialize<'de> for F32Bits {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.len() != 8
            || !text
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(serde::de::Error::custom("invalid f32_bits"));
        }
        let bits = u32::from_str_radix(&text, 16).map_err(serde::de::Error::custom)?;
        Self::new(f32::from_bits(bits)).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U64Decimal(pub u64);
impl Serialize for U64Decimal {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for U64Decimal {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let value = text.parse::<u64>().map_err(serde::de::Error::custom)?;
        if text != value.to_string() {
            return Err(serde::de::Error::custom("non-canonical u64"));
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RewardCatalog {
    pub quest_rewards: BTreeMap<String, Vec<Reward>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Reward {
    pub item_id: u32,
    pub count: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OfflineItemCatalog {
    pub items: BTreeMap<String, OfflineItem>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OfflineItem {
    #[serde(rename = "type")]
    pub kind: String,
    pub display_name: String,
    pub icon: String,
}

impl RewardCatalog {
    pub fn validate(&self, quests: &BTreeSet<u32>, items: &BTreeSet<u32>) -> Result<(), String> {
        for (key, rewards) in &self.quest_rewards {
            if !quests.contains(&crate::json::canonical_u32(key)?) {
                return Err("unknown QuestID in rewards".into());
            }
            for reward in rewards {
                if reward.count == 0 || !items.contains(&reward.item_id) {
                    return Err("invalid offline reward".into());
                }
            }
        }
        Ok(())
    }
}
impl OfflineItemCatalog {
    pub fn validate(&self) -> Result<(), String> {
        for (key, item) in &self.items {
            crate::json::canonical_u32(key)?;
            let path = item
                .icon
                .strip_prefix("./assets/")
                .ok_or("unsafe item icon path")?;
            if path.is_empty()
                || path.contains(['\\', ':', '?', '#', '%'])
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err("unsafe item icon path".into());
            }
        }
        // Item type values and consumption semantics are intentionally not inferred.
        Ok(())
    }
}
pub(crate) fn present_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
