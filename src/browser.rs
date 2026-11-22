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

#[wasm_bindgen]
pub fn validate_skill_sources(text: &str) -> String {
    response((|| {
        let records: Vec<crate::master_source::SkillSource> = crate::json::parse(text)?;
        crate::master_source::validate_skills(&records)?;
        Ok(json!({"record_count": records.len()}))
    })())
}

#[wasm_bindgen]
pub fn encode_public_request(name: &str, input: &str) -> String {
    response(
        crate::public_api_codec::encode(name, input)
            .map(|bytes| json!(bytes))
            .map_err(|_| "invalid_api_request".to_string()),
    )
}

#[wasm_bindgen]
pub fn decode_public_response(name: &str, bytes: &[u8]) -> String {
    response(crate::public_api_codec::decode(name, bytes))
}

#[wasm_bindgen]
pub async fn fetch_public_rpc(
    origin: &str,
    method: &str,
    bytes: &[u8],
    token: Option<String>,
    signal: web_sys::AbortSignal,
) -> Result<web_sys::Response, JsValue> {
    use wasm_bindgen_futures::JsFuture;
    use web_sys::{
        Request, RequestCache, RequestCredentials, RequestInit, RequestMode, RequestRedirect,
    };

    let options = RequestInit::new();
    options.set_method("POST");
    options.set_mode(RequestMode::Cors);
    options.set_credentials(RequestCredentials::Omit);
    options.set_cache(RequestCache::NoStore);
    options.set_redirect(RequestRedirect::Error);
    options.set_signal(Some(&signal));
    options.set_body(&js_sys::Uint8Array::from(bytes));
    let request =
        Request::new_with_str_and_init(&format!("{origin}/v1/public/{method}"), &options)?;
    request
        .headers()
        .set("Content-Type", "application/x-protobuf")?;
    if let Some(token) = token {
        request
            .headers()
            .set("Authorization", &format!("Bearer {token}"))?;
    }
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("window_unavailable"))?;
    JsFuture::from(window.fetch_with_request(&request))
        .await?
        .dyn_into()
}
