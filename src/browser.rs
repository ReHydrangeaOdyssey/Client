use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

fn response(result: Result<Value, String>) -> String {
    match result {
        Ok(value) => json!({"ok": true, "value": value}).to_string(),
        Err(message) => json!({"ok": false, "error": message}).to_string(),
    }
}

#[wasm_bindgen]
pub fn validate_scene(text: &str, name: &str) -> String {
    response(
        crate::scene::Scene::parse(text, name)
            .and_then(|scene| serde_json::to_value(scene).map_err(|e| e.to_string())),
    )
}

#[wasm_bindgen]
pub fn resolve_transition(text: &str, condition_values: &str) -> String {
    response((|| {
        let transition: crate::scene::Transition = crate::json::parse(text)?;
        let conditions: BTreeMap<String, bool> = crate::json::parse(condition_values)?;
        Ok(json!(transition.resolve(&conditions)?))
    })())
}

#[wasm_bindgen]
pub fn validate_quest(text: &str, enemy_ids: &str, item_ids: &str) -> String {
    response((|| {
        let enemies: BTreeSet<u32> = crate::json::parse(enemy_ids)?;
        let items: BTreeSet<u32> = crate::json::parse(item_ids)?;
        let waves = crate::quest::definition(text, &enemies, &items)?;
        Ok(json!({"wave_count": waves.len()}))
    })())
}
