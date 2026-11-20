use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const SCENE_VERSION: u32 = 2;
pub const MAX_SCENE_ID: u64 = (1_u64 << 48) - 1;
const MAX_ASSETS: usize = 1000;
const MAX_SCENE_NAME_BYTES: usize = 120;

pub fn valid_name(name: &str) -> bool {
    name.len() <= MAX_SCENE_NAME_BYTES
        && name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    pub version: u32,
    pub scene: String,
    pub assets: Assets,
    pub asset_order: Vec<String>,
    pub critical: Vec<String>,
    pub prefetch: Vec<String>,
    #[serde(default)]
    pub scroll_groups: BTreeMap<String, Value>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Assets {
    pub bgm: BTreeMap<String, Value>,
    pub se: BTreeMap<String, Value>,
    pub background: BTreeMap<String, Value>,
    pub ui: Ui,
    pub animation: BTreeMap<String, Value>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Ui {
    pub image: BTreeMap<String, Value>,
    pub button: BTreeMap<String, Value>,
    #[serde(rename = "toggle button")]
    pub toggle: BTreeMap<String, Value>,
    pub window: BTreeMap<String, Value>,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum Transition {
    Normal { scene: String },
    Conditional { routes: Vec<Route> },
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub condition: String,
    pub scene: String,
}

impl Scene {
    pub fn parse(text: &str, expected_name: &str) -> Result<Self, String> {
        let scene: Self = crate::json::parse(text)?;
        if scene.version != SCENE_VERSION
            || !valid_name(&scene.scene)
            || scene.scene != expected_name
        {
            return Err("scene version or name mismatch".into());
        }
        scene.validate_references()?;
        Ok(scene)
    }
    pub fn entries(&self) -> BTreeMap<String, &Value> {
        let mut entries = BTreeMap::new();
        for (prefix, map) in [
            ("ui.image", &self.assets.ui.image),
            ("ui.button", &self.assets.ui.button),
            ("ui.toggle button", &self.assets.ui.toggle),
            ("ui.window", &self.assets.ui.window),
            ("animation", &self.assets.animation),
        ] {
            for (name, value) in map {
                entries.insert(format!("{prefix}.{name}"), value);
            }
        }
        entries
    }
    fn validate_references(&self) -> Result<(), String> {
        let entries = self.entries();
        let order: BTreeSet<_> = self.asset_order.iter().collect();
        if entries.len() > MAX_ASSETS
            || order.len() != self.asset_order.len()
            || order.len() != entries.len()
            || order.iter().any(|key| !entries.contains_key(*key))
        {
            return Err("asset_order must contain each normal asset exactly once".into());
        }
        for list in [&self.critical, &self.prefetch] {
            let mut all_entries = entries.clone();
            for (prefix, map) in [
                ("bgm", &self.assets.bgm),
                ("se", &self.assets.se),
                ("background", &self.assets.background),
            ] {
                for (name, value) in map {
                    all_entries.insert(format!("{prefix}.{name}"), value);
                }
            }
            let unique: BTreeSet<_> = list.iter().collect();
            if unique.len() != list.len() || list.iter().any(|key| !all_entries.contains_key(key)) {
                return Err("invalid critical/prefetch reference".into());
            }
        }
        for button in self.assets.ui.button.values() {
            if button.get("action").is_some() {
                return Err("Scene v52 has no action key".into());
            }
            if let Some(value) = button.get("transition") {
                let transition: Transition =
                    serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                transition.validate()?;
            }
        }
        Ok(())
    }
}

impl Transition {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Normal { scene } if valid_name(scene) => Ok(()),
            Self::Conditional { routes } => {
                const MAX_ROUTES: usize = 64;
                const MAX_CONDITION_BYTES: usize = 128;
                let mut names = BTreeSet::new();
                if routes.is_empty() || routes.len() > MAX_ROUTES {
                    return Err("invalid routes".into());
                }
                for route in routes {
                    if !valid_name(&route.scene)
                        || route.condition.is_empty()
                        || route.condition.len() > MAX_CONDITION_BYTES
                        || !route
                            .condition
                            .bytes()
                            .all(|c| c.is_ascii_alphabetic() || c == b'_')
                        || !names.insert(&route.condition)
                    {
                        return Err("invalid conditional route".into());
                    }
                }
                Ok(())
            }
            _ => Err("invalid scene destination".into()),
        }
    }
    pub fn resolve(&self, conditions: &BTreeMap<String, bool>) -> Result<Option<String>, String> {
        self.validate()?;
        match self {
            Self::Normal { scene } => Ok(Some(scene.clone())),
            Self::Conditional { routes } => {
                let mut selected = None;
                for route in routes {
                    let active = *conditions
                        .get(&route.condition)
                        .ok_or_else(|| format!("unbound condition: {}", route.condition))?;
                    if active {
                        if selected.is_some() {
                            return Err("multiple transition conditions are true".into());
                        }
                        selected = Some(route.scene.clone());
                    }
                }
                Ok(selected)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Ticket {
    pub request: u64,
    pub version: String,
    pub generation: u64,
    pub scene: String,
}

#[derive(Default)]
pub struct SceneController {
    serial: u64,
    active: Option<Scene>,
    pending: Option<Ticket>,
}
impl SceneController {
    pub fn active(&self) -> Option<&Scene> {
        self.active.as_ref()
    }
    pub fn pending(&self) -> Option<&Ticket> {
        self.pending.as_ref()
    }
    pub fn begin(
        &mut self,
        scene: String,
        version: String,
        generation: u64,
    ) -> Result<Ticket, String> {
        if self.pending.is_some() {
            return Err("scene transition already pending".into());
        }
        if !valid_name(&scene) || version.is_empty() {
            return Err("invalid transition identity".into());
        }
        self.serial = self
            .serial
            .checked_add(1)
            .ok_or("transition serial overflow")?;
        let ticket = Ticket {
            request: self.serial,
            version,
            generation,
            scene,
        };
        self.pending = Some(ticket.clone());
        Ok(ticket)
    }
    pub fn commit(
        &mut self,
        ticket: &Ticket,
        prepared: Scene,
        ready: &BTreeSet<String>,
    ) -> Result<(), String> {
        if self.pending.as_ref() != Some(ticket) {
            return Err("stale scene completion".into());
        }
        if prepared.scene != ticket.scene
            || prepared.critical.iter().any(|key| !ready.contains(key))
        {
            return Err("SceneReady is false".into());
        }
        self.active = Some(prepared);
        self.pending = None;
        Ok(())
    }
    pub fn fail(&mut self, ticket: &Ticket) -> bool {
        if self.pending.as_ref() == Some(ticket) {
            self.pending = None;
            true
        } else {
            false
        }
    }
}
