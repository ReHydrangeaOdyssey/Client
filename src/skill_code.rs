//! Parses authored effect codes; execution rules remain in the master conversion pipeline.

pub const MAX_EFFECT_LEVEL: u8 = 6;
const MAX_REVIVE_LEVEL: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weapon {
    Slash,
    Pierce,
    Strike,
    Ranged,
}

impl Weapon {
    fn parse(code: &str) -> Option<Self> {
        match code {
            "SLASH" => Some(Self::Slash),
            "PIERCE" => Some(Self::Pierce),
            "STRIKE" => Some(Self::Strike),
            "RANGED" => Some(Self::Ranged),
            _ => None,
        }
    }

    fn disadvantage(self) -> Self {
        match self {
            Self::Slash => Self::Pierce,
            Self::Pierce => Self::Slash,
            Self::Strike => Self::Ranged,
            Self::Ranged => Self::Strike,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttackRange {
    AllEnemies,
    OneEnemy,
    Horizontal,
    Vertical,
    Cross,
    DiagonalCross,
    Random { minimum: u8, maximum: u8 },
}

impl AttackRange {
    fn parse(code: &str) -> Option<Self> {
        match code {
            "ALL_ENEMY_ATTACK" => Some(Self::AllEnemies),
            "ENEMY_ONE_ATTACK" => Some(Self::OneEnemy),
            "H_LINE" => Some(Self::Horizontal),
            "V_LINE" => Some(Self::Vertical),
            "CROSS" => Some(Self::Cross),
            "X_CROSS" => Some(Self::DiagonalCross),
            _ => Self::random(code.strip_prefix("RND_")?),
        }
    }

    fn random(code: &str) -> Option<Self> {
        fn count(value: &str) -> Option<u8> {
            if value.len() != 1 {
                return None;
            }
            value.parse().ok()
        }
        let (minimum, maximum) = match code.split_once('_') {
            Some((minimum, maximum)) => {
                let minimum = count(minimum)?;
                let maximum = count(maximum)?;
                if minimum == maximum {
                    return None;
                }
                (minimum, maximum)
            }
            None => {
                let count = count(code)?;
                (count, count)
            }
        };
        // Registered variable-hit syntax uses maximum = minimum + 3; fixed counts use one token.
        let supported = if minimum == maximum {
            (3..=7).contains(&minimum)
        } else {
            (1..=4).contains(&minimum) && maximum == minimum + 3
        };
        supported.then_some(Self::Random { minimum, maximum })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttackModifier {
    None,
    ChestPriority,
    IncreasingDamage,
    WeaponAffinity {
        advantage: Weapon,
        disadvantage: Weapon,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttackCode {
    pub range: AttackRange,
    pub fixed_damage: bool,
    pub modifier: AttackModifier,
}

impl AttackCode {
    fn parse(code: &str) -> Option<Self> {
        let (fixed_damage, code) = match code.strip_prefix("FLAT_") {
            Some(rest) => (true, rest),
            None => (false, code),
        };
        let (base, modifier) = if let Some(base) = code.strip_suffix("_CHEST_BONUS") {
            (base, AttackModifier::ChestPriority)
        } else if let Some(base) = code.strip_suffix("_RAMP") {
            (base, AttackModifier::IncreasingDamage)
        } else if let Some((base, affinity)) = code.split_once("_ADV_") {
            let (advantage, disadvantage) = affinity.split_once("_DIS_")?;
            (
                base,
                AttackModifier::WeaponAffinity {
                    advantage: Weapon::parse(advantage)?,
                    disadvantage: Weapon::parse(disadvantage)?,
                },
            )
        } else {
            (code, AttackModifier::None)
        };
        let parsed = Self {
            range: AttackRange::parse(base)?,
            fixed_damage,
            modifier,
        };
        parsed.supported().then_some(parsed)
    }

    fn supported(self) -> bool {
        use AttackModifier::*;
        use AttackRange::*;
        if self.fixed_damage {
            return self.modifier == None
                && match self.range {
                    Random { minimum, maximum } => minimum == maximum && (3..=5).contains(&minimum),
                    _ => true,
                };
        }
        match self.modifier {
            None => true,
            ChestPriority => matches!(self.range, OneEnemy | Vertical),
            IncreasingDamage => {
                self.range
                    == Random {
                        minimum: 2,
                        maximum: 5,
                    }
            }
            WeaponAffinity {
                advantage,
                disadvantage,
            } => {
                if advantage.disadvantage() != disadvantage {
                    return false;
                }
                match self.range {
                    Horizontal | Vertical => true,
                    Cross => advantage == Weapon::Pierce,
                    DiagonalCross => advantage == Weapon::Ranged,
                    _ => false,
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stats {
    Attack,
    Defense,
    AttackAndDefense,
}

impl Stats {
    fn parse(code: &str) -> Option<Self> {
        match code {
            "ATK" => Some(Self::Attack),
            "DEF" => Some(Self::Defense),
            "ATK_DEF" => Some(Self::AttackAndDefense),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatTarget {
    SelfOnly,
    AllFriends,
    AllEnemies,
    OneEnemy,
    FriendWeapon(Weapon),
    EnemyWeapon(Weapon),
}

impl StatTarget {
    fn parse(code: &str) -> Option<Self> {
        match code {
            "SELF" => Some(Self::SelfOnly),
            "ALL_FRIEND" => Some(Self::AllFriends),
            "ALL_ENEMY" => Some(Self::AllEnemies),
            "ENEMY_ONE" => Some(Self::OneEnemy),
            _ => {
                let (side, weapon) = code.split_once('_')?;
                let weapon = Weapon::parse(weapon)?;
                match side {
                    "FRIEND" => Some(Self::FriendWeapon(weapon)),
                    "ENEMY" => Some(Self::EnemyWeapon(weapon)),
                    _ => None,
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatCode {
    pub target: StatTarget,
    pub stats: Stats,
    pub increase: bool,
}

impl StatCode {
    fn parse(code: &str) -> Option<Self> {
        let (target, stats, increase) = match code.split_once("_BUFF_") {
            Some((target, stats)) => (target, stats, true),
            None => {
                let (target, stats) = code.split_once("_DEBUFF_")?;
                (target, stats, false)
            }
        };
        let target = StatTarget::parse(target)?;
        let stats = Stats::parse(stats)?;
        let allowed = match (target, increase) {
            (StatTarget::SelfOnly | StatTarget::AllFriends | StatTarget::FriendWeapon(_), true)
            | (StatTarget::AllEnemies | StatTarget::OneEnemy | StatTarget::EnemyWeapon(_), false) => {
                true
            }
            (StatTarget::SelfOnly, false) => stats == Stats::Defense,
            _ => false,
        };
        allowed.then_some(Self {
            target,
            stats,
            increase,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusCode {
    Blind,
    DisableAreaAttack,
    Poison,
    Silence,
    Sleep,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MainEffect {
    Attack(AttackCode),
    Stat(StatCode),
    Status(StatusCode),
    HealAllFriends,
    HealMostDamagedFriend,
    ReviveFriend,
    NextNormalAttackDamage,
    Counter,
    Taunt,
    FollowUpFriend,
}

impl MainEffect {
    pub fn parse(code: &str) -> Option<Self> {
        let special = match code {
            "ALL_FRIEND_HEAL_HP" => Some(Self::HealAllFriends),
            "FRIEND_MOST_DAMAGED_HEAL_HP" => Some(Self::HealMostDamagedFriend),
            "FRIEND_ONE_REVIVE" => Some(Self::ReviveFriend),
            "SELF_BUFF_NEXT_DAMAGE" => Some(Self::NextNormalAttackDamage),
            "SELF_COUNTER" => Some(Self::Counter),
            "SELF_TAUNT" => Some(Self::Taunt),
            "FOLLOW_UP_FRIEND_ATTACK" => Some(Self::FollowUpFriend),
            _ => None,
        };
        if special.is_some() {
            return special;
        }
        if let Some(status) = code.strip_prefix("ENEMY_STATUS_") {
            return Some(Self::Status(match status {
                "BLIND" => StatusCode::Blind,
                "DISABLE_AOE" => StatusCode::DisableAreaAttack,
                "POISON" => StatusCode::Poison,
                "SILENCE" => StatusCode::Silence,
                "SLEEP" => StatusCode::Sleep,
                _ => return None,
            }));
        }
        AttackCode::parse(code)
            .map(Self::Attack)
            .or_else(|| StatCode::parse(code).map(Self::Stat))
    }

    pub fn requires_level(self) -> bool {
        !matches!(
            self,
            Self::Status(_) | Self::Counter | Self::Taunt | Self::FollowUpFriend
        )
    }

    pub fn maximum_level(self) -> u8 {
        if self == Self::ReviveFriend {
            MAX_REVIVE_LEVEL
        } else {
            MAX_EFFECT_LEVEL
        }
    }

    pub fn requires_probability(self) -> bool {
        matches!(self, Self::Status(_))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubEffect {
    DoubleDamage,
    CancelEnemyBuff,
    CancelFriendAbnormality,
    CancelFriendDebuff,
    SelfBuff(Stats),
    HealSelf,
}

impl SubEffect {
    pub fn parse(code: &str) -> Option<Self> {
        match code {
            "DAMAGE_X2" => Some(Self::DoubleDamage),
            "ENEMY_CANCEL_BUFF" => Some(Self::CancelEnemyBuff),
            "FRIEND_CANCEL_ABNORMAL" => Some(Self::CancelFriendAbnormality),
            "FRIEND_CANCEL_DEBUFF" => Some(Self::CancelFriendDebuff),
            "SELF_HEAL_HP" => Some(Self::HealSelf),
            _ => match Stats::parse(code.strip_prefix("SELF_BUFF_")?)? {
                Stats::Attack => Some(Self::SelfBuff(Stats::Attack)),
                Stats::Defense => Some(Self::SelfBuff(Stats::Defense)),
                Stats::AttackAndDefense => None,
            },
        }
    }

    pub fn requires_level(self) -> bool {
        matches!(self, Self::SelfBuff(_) | Self::HealSelf)
    }

    pub fn requires_probability(self) -> bool {
        self == Self::DoubleDamage
    }
}
