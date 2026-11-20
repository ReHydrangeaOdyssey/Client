use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Number, Value};
use std::fmt;

pub const MAX_JSON_BYTES: usize = 8_000_000;

struct Unique(Value);
struct UniqueVisitor;

impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(UniqueVisitor)
    }
}
impl<'de> Visitor<'de> for UniqueVisitor {
    type Value = Unique;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON without duplicate object keys")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Unique, M::Error> {
        let mut result = Map::new();
        while let Some((key, value)) = map.next_entry::<String, Unique>()? {
            if result.insert(key, value.0).is_some() {
                return Err(de::Error::custom("duplicate JSON key"));
            }
        }
        Ok(Unique(Value::Object(result)))
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<Unique, S::Error> {
        let mut result = Vec::new();
        while let Some(value) = seq.next_element::<Unique>()? {
            result.push(value.0);
        }
        Ok(Unique(Value::Array(result)))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Unique, E> {
        Ok(Unique(Value::String(value.to_owned())))
    }
    fn visit_string<E: de::Error>(self, value: String) -> Result<Unique, E> {
        Ok(Unique(Value::String(value)))
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Unique, E> {
        Ok(Unique(Value::Bool(value)))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Unique, E> {
        Ok(Unique(Value::Number(value.into())))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Unique, E> {
        Ok(Unique(Value::Number(value.into())))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Unique, E> {
        Number::from_f64(value)
            .map(|n| Unique(Value::Number(n)))
            .ok_or_else(|| de::Error::custom("non-finite JSON number"))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
        Ok(Unique(Value::Null))
    }
    fn visit_none<E: de::Error>(self) -> Result<Unique, E> {
        Ok(Unique(Value::Null))
    }
}

pub fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    if text.len() > MAX_JSON_BYTES {
        return Err("JSON size limit exceeded".into());
    }
    let value: Unique = serde_json::from_str(text).map_err(|e| e.to_string())?;
    serde_json::from_value(value.0).map_err(|e| e.to_string())
}

pub fn canonical_u32(text: &str) -> Result<u32, String> {
    let value: u32 = text.parse().map_err(|_| "invalid u32 ID")?;
    if value.to_string() != text {
        return Err("non-canonical ID".into());
    }
    Ok(value)
}
