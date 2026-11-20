#![forbid(unsafe_code)]
#[cfg(target_arch = "wasm32")]
mod browser;
pub mod json;
pub mod quest;
pub mod quest_data;
pub mod scene;

pub mod checkpoint;
pub mod quest_runtime;
