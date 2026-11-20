//! Quest rules independent of browser storage, rendering and wall clocks.
pub mod drops;
pub mod placement;
pub mod queue;

pub const ALLY_PLAYER_ID: u32 = 0;
pub const ENEMY_PLAYER_ID: u32 = u32::MAX;
pub const INITIAL_SEED: u64 = 20_150_422;
pub const PANEL_COUNT: usize = 5;
pub const COMBO_LIMIT: u8 = 30;
const COMBO_INCREMENT: f32 = 0.1;

use game_logic::pseudorandom::Random;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Panel {
    None,
    SkillGaugeUp,
    DamageOneAndHalf,
    DamageDouble,
}

impl Panel {
    pub fn draw(random: &mut Random) -> Self {
        const EFFECT_COUNT: u32 = 4;
        match random.next_bounded(EFFECT_COUNT) {
            0 => Self::None,
            1 => Self::SkillGaugeUp,
            2 => Self::DamageOneAndHalf,
            _ => Self::DamageDouble,
        }
    }
}

pub fn initial_seed(epoch_microseconds: u64) -> u64 {
    // Quest seed = 20150422 XOR UNIX epoch microseconds; no clock is read here.
    INITIAL_SEED ^ epoch_microseconds
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Combo(u8);

impl Combo {
    pub fn value(self) -> u8 {
        self.0
    }
    pub fn multiplier(self) -> f32 {
        // Applied after damage randomness and before the shared final damage cap.
        // multiplier = 1 + combo * 0.1.
        1.0 + f32::from(self.0) * COMBO_INCREMENT
    }
    pub fn normal_ally_hit(&mut self) {
        // Confirmed ally normal HIT: combo' = min(30, combo + 1).
        self.0 = self.0.saturating_add(1).min(COMBO_LIMIT);
    }
    pub fn enemy_action_started(&mut self) {
        self.0 = 0;
    }
    pub fn next_wave(&mut self) {
        self.0 = 0;
    }
}

fn nonnegative(value: f32, name: &'static str) -> Result<(), game_logic::Error> {
    if value.is_finite() && value >= 0.0 {
        Ok(())
    } else {
        Err(game_logic::Error::InvalidValue(name))
    }
}

fn rate(value: f32) -> Result<(), game_logic::Error> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(game_logic::Error::InvalidValue("probability"))
    }
}
