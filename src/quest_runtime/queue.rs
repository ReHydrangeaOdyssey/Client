use super::{PANEL_COUNT, Panel};
use game_logic::{Error, pseudorandom::Random};
use std::collections::VecDeque;

pub const NORMAL_CAPACITY: usize = 5;
pub const SKILL_ONE_GAUGE: u16 = 100;
pub const SKILL_TWO_GAUGE: u16 = 200;
pub const HIT_GAUGE: u16 = 10;
pub const PANEL_GAUGE: u16 = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Ally,
    Enemy,
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub instance_id: u32,
    pub side: Side,
    pub slot: u8,
    pub ready: bool,
    pub actable: bool,
    pub manually_requested: bool,
}

#[derive(Clone, Debug)]
pub struct Queues {
    normal: VecDeque<(u32, Side)>,
    skill: VecDeque<u32>,
    active_skill: Option<u32>,
    panels: [Panel; PANEL_COUNT],
}

impl Queues {
    pub fn new(panels: [Panel; PANEL_COUNT]) -> Self {
        Self {
            normal: VecDeque::new(),
            skill: VecDeque::new(),
            active_skill: None,
            panels,
        }
    }
    pub fn normal(&self) -> &VecDeque<(u32, Side)> {
        &self.normal
    }
    pub fn skills(&self) -> &VecDeque<u32> {
        &self.skill
    }
    pub fn panels(&self) -> &[Panel; PANEL_COUNT] {
        &self.panels
    }
    pub fn enqueue_ready(&mut self, candidates: &[Candidate], auto: bool) -> Result<(), Error> {
        for (index, candidate) in candidates.iter().enumerate() {
            if candidate.instance_id == 0
                || !(1..=super::placement::BOARD_SIZE).contains(&candidate.slot)
                || candidates[..index].iter().any(|prior| {
                    prior.instance_id == candidate.instance_id
                        || (prior.side == candidate.side && prior.slot == candidate.slot)
                })
            {
                return Err(Error::InvalidFormation);
            }
        }
        let mut eligible: Vec<_> = candidates
            .iter()
            .filter(|c| {
                c.ready
                    && c.actable
                    && (c.side == Side::Enemy || auto || c.manually_requested)
                    && !self.normal.iter().any(|(id, _)| *id == c.instance_id)
            })
            .collect();
        while self.normal.len() < NORMAL_CAPACITY && !eligible.is_empty() {
            let preferred = match self.normal.back() {
                Some((_, Side::Ally)) => Side::Enemy,
                _ => Side::Ally,
            };
            eligible.sort_by_key(|c| (c.side != preferred, c.slot));
            let selected = eligible.remove(0);
            self.normal.push_back((selected.instance_id, selected.side));
        }
        Ok(())
    }
    pub fn request_skill(
        &mut self,
        instance: u32,
        ally: bool,
        actable: bool,
        silenced: bool,
        gauge: u16,
    ) -> Result<(), Error> {
        if instance == 0
            || !ally
            || !actable
            || silenced
            || !(SKILL_ONE_GAUGE..=SKILL_TWO_GAUGE).contains(&gauge)
            || self.skill.contains(&instance)
            || self.active_skill == Some(instance)
        {
            return Err(Error::InvalidValue("skill reservation"));
        }
        self.skill.push_back(instance);
        Ok(())
    }
    // The caller revalidates silence/actable before committing the returned reservation.
    pub fn next_skill(&self) -> Option<u32> {
        self.skill.front().copied()
    }
    pub fn start_skill(&mut self, allowed: bool) -> Result<Option<u32>, Error> {
        if self.active_skill.is_some() {
            return Err(Error::InvalidValue("active skill"));
        }
        let next = self.skill.pop_front();
        if !allowed {
            return Ok(None);
        }
        self.active_skill = next;
        Ok(next)
    }
    pub fn finish_skill(&mut self) {
        self.active_skill = None;
    }
    pub fn pop_normal(&mut self, random: &mut Random) -> Result<Option<(u32, Panel)>, Error> {
        if self.active_skill.is_some() || !self.skill.is_empty() {
            return Err(Error::InvalidValue("skill queue takes priority"));
        }
        let Some((instance, _)) = self.normal.pop_front() else {
            return Ok(None);
        };
        let panel = self.consume_panel(0, random)?;
        Ok(Some((instance, panel)))
    }
    pub fn remove_incapacitated(
        &mut self,
        instance: u32,
        random: &mut Random,
    ) -> Result<(), Error> {
        if let Some(index) = self.normal.iter().position(|(id, _)| *id == instance) {
            self.consume_panel(index, random)?;
            self.normal.remove(index);
        }
        self.skill.retain(|id| *id != instance);
        Ok(())
    }
    fn consume_panel(&mut self, index: usize, random: &mut Random) -> Result<Panel, Error> {
        let panel = *self
            .panels
            .get(index)
            .ok_or(Error::InvalidValue("panel index"))?;
        self.panels[index..].rotate_left(1);
        if let Some(last) = self.panels.last_mut() {
            *last = Panel::draw(random);
        }
        Ok(panel)
    }
    pub fn next_wave(&mut self) {
        self.normal.clear();
        self.skill.clear();
        self.active_skill = None;
    }
}

pub fn advance_wait(remaining: f32, elapsed_seconds: f32, speed: u8) -> Result<f32, Error> {
    super::nonnegative(remaining, "remaining wait")?;
    super::nonnegative(elapsed_seconds, "elapsed time")?;
    if !matches!(speed, 1 | 2 | 4) {
        return Err(Error::InvalidValue("quest speed"));
    }
    // remaining' = max(0, remaining - foreground elapsed seconds * speed).
    let elapsed = elapsed_seconds * f32::from(speed);
    if !elapsed.is_finite() {
        return Err(Error::ArithmeticOverflow);
    }
    Ok((remaining - elapsed).max(0.0))
}
