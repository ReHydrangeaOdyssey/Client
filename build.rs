use std::{env, error::Error, fs, path::PathBuf};

fn configure_uint64(config: &mut prost_build::Config, path: &str, optional: bool) {
    let adapter = if optional {
        "crate::public_api_codec::optional_uint64"
    } else {
        "crate::public_api_codec::uint64"
    };
    config.field_attribute(path, format!("#[serde(with = \"{adapter}\")]"));
}

fn enum_validation(member: &str, optional: bool, values: impl Iterator<Item = i32>) -> String {
    let allowed = values
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let invalid = if optional {
        format!("_value.{member}.is_some_and(|item| ![{allowed}].contains(&item))")
    } else {
        format!("![{allowed}].contains(&_value.{member})")
    };
    format!("if {invalid} {{ return Err(\"invalid_enum\".into()); }}\n")
}

fn presence_validation(message: &str, member: &str) -> String {
    let required = matches!(
        (message, member),
        (
            "CreateGuildRequest",
            "daytime_start_time" | "nighttime_start_time"
        ) | ("RespondFriendRequestRequest", "approve")
    );
    if required {
        format!(
            "if _value.{member}.is_none() {{ return Err(\"missing_required_field\".into()); }}\n"
        )
    } else {
        String::new()
    }
}

fn write_dispatch(encode: &str, decode: &str) -> Result<(), Box<dyn Error>> {
    let dispatch = format!(
        "pub fn encode(name: &str, input: &str) -> Result<Vec<u8>, String> {{ match name {{ {encode} _ => Err(\"unknown_request_type\".into()) }} }}\n         pub fn decode(name: &str, bytes: &[u8]) -> Result<serde_json::Value, String> {{ match name {{ {decode} _ => Err(\"unknown_response_type\".into()) }} }}"
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("api_dispatch.rs"),
        dispatch,
    )?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=protocol/public_api.proto");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    config.type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]");
    config.message_attribute(".", "#[serde(default, deny_unknown_fields)]");
    let descriptors = config.load_fds(&["protocol/public_api.proto"], &["protocol"])?;
    let mut encode = String::new();
    let mut decode = String::new();
    for file in &descriptors.file {
        for message in &file.message_type {
            let name = message.name();
            let path = format!(".{}.{}", file.package(), name);
            for field in &message.field {
                // The descriptor enum avoids keeping a second list of uint64 fields.
                if field.r#type().as_str_name() == "TYPE_UINT64" {
                    configure_uint64(
                        &mut config,
                        &format!("{path}.{}", field.name()),
                        field.proto3_optional(),
                    );
                }
            }
            if name.ends_with("Request") {
                let mut validation = String::new();
                for field in &message.field {
                    if field.r#type().as_str_name() == "TYPE_ENUM" {
                        let enumeration = file
                            .enum_type
                            .iter()
                            .find(|item| {
                                format!(".{}.{}", file.package(), item.name()) == field.type_name()
                            })
                            .ok_or("request enum definition missing")?;
                        validation.push_str(&enum_validation(
                            field.name(),
                            field.proto3_optional(),
                            enumeration.value.iter().map(|item| item.number()),
                        ));
                    }
                    validation.push_str(&presence_validation(name, field.name()));
                }
                encode.push_str(&format!(
                    "\"{name}\" => encode_message::<wire::{name}>(input, |_value| {{ {validation} Ok(()) }}),\n"
                ));
            }
            if name.ends_with("Response") || name == "GuildBattleScoreUpdate" {
                decode.push_str(&format!(
                    "\"{name}\" => decode_message::<wire::{name}>(bytes),\n"
                ));
            }
        }
    }
    config.compile_fds(descriptors)?;
    write_dispatch(&encode, &decode)
}
