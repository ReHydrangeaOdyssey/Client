//! Streaming PCM decoding. Key scoring follows the pinned vgmstream source, not the crate's 7-frame probe.
use cridecoder::hca::{ClHca, HcaDecoder, HcaInfo};
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const SAMPLE_RATE: u32 = 22_050;
const MAX_PROBE_FRAMES: usize = 10;
const MAX_BLANK_FRAMES: usize = 1200;
const MAX_FRAME_SCORE: i32 = 600;
const SCORE_SCALE: i32 = 10;
const MAX_TOTAL_SCORE: i32 = MAX_PROBE_FRAMES as i32 * 50 * SCORE_SCALE;

fn combined_key(key: u64, subkey: u16) -> u64 {
    // CRI key = base * ((subkey << 16) | ((u16)~subkey + 2)), modulo 2^64.
    if subkey == 0 {
        key
    } else {
        key.wrapping_mul(((subkey as u64) << 16) | ((!subkey as u64) + 2))
    }
}
fn score(
    handle: &mut ClHca,
    bytes: &[u8],
    info: &HcaInfo,
    key: u64,
    subkey: u16,
    start: &mut usize,
) -> i32 {
    handle.set_key(combined_key(key, subkey));
    let mut offset = if *start == 0 {
        info.header_size as usize
    } else {
        *start
    };
    let (mut tested, mut current, mut blanks, mut total) = (0, 0, 0, 0);
    while tested < MAX_PROBE_FRAMES && current < info.block_count {
        let Some(end) = offset.checked_add(info.block_size as usize) else {
            break;
        };
        let Some(block) = bytes.get(offset..end) else {
            break;
        };
        let value = handle.test_block(&mut block.to_vec());
        if *start == 0 && value != 0 {
            *start = offset;
        }
        offset = end;
        if !(0..=MAX_FRAME_SCORE).contains(&value) {
            total = -1;
            break;
        }
        current += 1;
        if value == 0 && blanks < MAX_BLANK_FRAMES {
            blanks += 1;
            continue;
        }
        tested += 1;
        // Perfect frames score 1, interior blanks score 30, all other scores are multiplied by 10.
        total += match value {
            1 => 1,
            0 => 3 * SCORE_SCALE,
            _ => value * SCORE_SCALE,
        };
        if total > MAX_TOTAL_SCORE {
            break;
        }
    }
    if tested > 3 && total > 0 && total <= tested as i32 {
        total = 1;
    }
    handle.decode_reset();
    total
}
fn validate_decode(bytes: &[u8], key: u64, subkey: u16) -> Result<(), String> {
    let mut decoder =
        HcaDecoder::from_reader(Cursor::new(bytes)).map_err(|_| "Invalid HCA header")?;
    let blocks = decoder.info().block_count;
    let channels = decoder.info().channel_count as usize;
    decoder.set_encryption_key(key, subkey as u64);
    for _ in 0..blocks {
        let (pcm, count) = decoder
            .decode_frame()
            .map_err(|_| "HCA frame decode failed")?;
        if pcm.len() < count * channels
            || pcm[..count * channels]
                .iter()
                .any(|sample| !sample.is_finite())
        {
            return Err("Invalid HCA PCM".into());
        }
    }
    Ok(())
}
fn find_key(bytes: &[u8], info: &HcaInfo, cached: &str, subkey: u16) -> Result<u64, String> {
    let mut handle = Box::new(ClHca::new());
    handle
        .decode_header(&bytes[..info.header_size as usize])
        .map_err(|_| "Invalid HCA header")?;
    if let Ok(key) = cached.parse::<u64>()
        && key.to_string() == cached
        && score(&mut handle, bytes, info, key, subkey, &mut 0) > 0
        && validate_decode(bytes, key, subkey).is_ok()
    {
        return Ok(key);
    }
    let (mut start, mut best_score, mut best_key) = (0, 0, 0);
    for &key in crate::hca_keys::KEYS {
        let value = score(&mut handle, bytes, info, key, subkey, &mut start);
        if value >= 0 && (best_score <= 0 || (value < best_score && value > 0)) {
            best_score = value;
            best_key = key;
        }
        if best_score == 1 {
            break;
        }
    }
    if best_score <= 0 {
        return Err("HCA key verification failed".into());
    }
    validate_decode(bytes, best_key, subkey)?;
    Ok(best_key)
}

#[wasm_bindgen]
pub struct HcaStream {
    decoder: HcaDecoder<Cursor<Vec<u8>>>,
    blocks_left: u32,
    key: Option<u64>,
}
#[wasm_bindgen]
impl HcaStream {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Vec<u8>, cached_key: &str, subkey: u16) -> Result<HcaStream, JsValue> {
        let probe = HcaDecoder::from_reader(Cursor::new(bytes.as_slice()))
            .map_err(|_| JsValue::from_str("Invalid HCA header"))?;
        let info = probe.info().clone();
        if info.sampling_rate != SAMPLE_RATE
            || !(1..=2).contains(&info.channel_count)
            || info.block_count == 0
        {
            return Err(JsValue::from_str(
                "HCA requires 22050 Hz and one or two channels",
            ));
        }
        let end = (info.header_size as u64) + (info.block_size as u64) * (info.block_count as u64);
        if end > bytes.len() as u64 {
            return Err(JsValue::from_str("Truncated HCA"));
        }
        drop(probe);
        let key = if info.encryption_enabled {
            Some(find_key(&bytes, &info, cached_key, subkey).map_err(|e| JsValue::from_str(&e))?)
        } else {
            None
        };
        let mut decoder = HcaDecoder::from_reader(Cursor::new(bytes))
            .map_err(|_| JsValue::from_str("HCA initialization failed"))?;
        if let Some(key) = key {
            decoder.set_encryption_key(key, subkey as u64);
        }
        Ok(Self {
            decoder,
            blocks_left: info.block_count,
            key,
        })
    }
    pub fn verified_key(&self) -> String {
        self.key.map(|key| key.to_string()).unwrap_or_default()
    }
    pub fn sample_rate(&self) -> u32 {
        self.decoder.info().sampling_rate
    }
    pub fn reset(&mut self) {
        self.decoder.reset();
        self.blocks_left = self.decoder.info().block_count;
    }
    pub fn finished(&self) -> bool {
        self.blocks_left == 0
    }
    pub fn next_pcm(&mut self) -> Result<Vec<f32>, JsValue> {
        if self.blocks_left == 0 {
            return Ok(Vec::new());
        }
        let channels = self.decoder.info().channel_count as usize;
        let (samples, count) = self
            .decoder
            .decode_frame()
            .map_err(|_| JsValue::from_str("HCA frame decode failed"))?;
        self.blocks_left -= 1;
        let mut stereo = Vec::with_capacity(count * 2);
        for sample in samples[..count * channels].chunks_exact(channels) {
            if sample.iter().any(|value| !value.is_finite()) {
                return Err(JsValue::from_str("Invalid HCA PCM"));
            }
            stereo.extend_from_slice(&[sample[0], sample[channels - 1]]);
        }
        Ok(stereo)
    }
}
