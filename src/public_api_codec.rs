use prost::Message;
use serde::{Serialize, de::DeserializeOwned};

pub mod wire {
    include!(concat!(env!("OUT_DIR"), "/game.publicapi.rs"));
}

fn encode_message<T: Message + DeserializeOwned>(
    input: &str,
    validate: impl FnOnce(&T) -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    let value: T = crate::json::parse(input)?;
    validate(&value)?;
    Ok(value.encode_to_vec())
}

fn decode_message<T: Message + Default + Serialize>(
    bytes: &[u8],
) -> Result<serde_json::Value, String> {
    let value = T::decode(bytes).map_err(|_| "invalid_protobuf".to_string())?;
    serde_json::to_value(value).map_err(|_| "invalid_protobuf_value".to_string())
}

fn parse_decimal(value: &str) -> Result<u64, &'static str> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("uint64 requires a canonical decimal string");
    }
    value.parse().map_err(|_| "uint64 out of range")
}

mod uint64 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        super::parse_decimal(&value).map_err(D::Error::custom)
    }
}

mod optional_uint64 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|value| super::parse_decimal(&value).map_err(D::Error::custom))
            .transpose()
    }
}

include!(concat!(env!("OUT_DIR"), "/api_dispatch.rs"));
