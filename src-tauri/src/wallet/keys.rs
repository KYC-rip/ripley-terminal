//! Monero key derivation from mnemonic seed.
//!
//! Standard Monero key derivation:
//!   seed (25 words) → entropy (32 bytes) → spend_key (Scalar) → view_key (keccak256(spend_key))
//! Polyseed (16 words, Feather ≥2.0 / Cake):
//!   seed → PBKDF2 key (32 bytes) → sc_reduce32 → spend_key → view_key as above

use tiny_keccak::{Hasher, Keccak};
use zeroize::Zeroizing;

use monero_oxide::ed25519::Scalar;
use monero_seed::{Language, Seed};

/// The wordlist languages we try when restoring a seed, in priority order. English first
/// (by far the most common); `DeprecatedEnglish` (the old buggy wordlist) last so a modern
/// English seed is never misread as it.
const RESTORE_LANGUAGES: [Language; 13] = [
    Language::English,
    Language::Spanish,
    Language::Portuguese,
    Language::Japanese,
    Language::Italian,
    Language::French,
    Language::German,
    Language::Russian,
    Language::Chinese,
    Language::Dutch,
    Language::Esperanto,
    Language::Lojban,
    Language::DeprecatedEnglish,
];

/// Polyseed wordlists, tried in turn (`from_string` needs the language; the checksum makes a
/// cross-language false match astronomically unlikely).
const POLYSEED_LANGUAGES: [polyseed::Language; 10] = [
    polyseed::Language::English,
    polyseed::Language::Spanish,
    polyseed::Language::French,
    polyseed::Language::Italian,
    polyseed::Language::Japanese,
    polyseed::Language::Korean,
    polyseed::Language::Czech,
    polyseed::Language::Portuguese,
    polyseed::Language::ChineseSimplified,
    polyseed::Language::ChineseTraditional,
];

/// What a pasted phrase is, judged by its word count first (each format has its own).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedFormat {
    /// 25-word Monero seed (GUI, CLI, Monerujo, Feather/Cake "25-word" export).
    Legacy25,
    /// 24-word Monero seed (the 25-word seed without its checksum word).
    Legacy24,
    /// 16-word Polyseed (Feather ≥2.0, Cake) — carries the wallet's birthday.
    Polyseed,
    /// 12/15/18/21 words, or 24 that are not Monero words: a BIP39 phrase.
    Bip39Like,
    /// 14 words: Feather < 2.0 (tevador's monero-seed). Recognised, not importable yet.
    Feather14,
    /// 13 words: MyMonero. Derives keys differently; recognised, not importable yet.
    Mymonero13,
    Unknown,
}

pub fn seed_format_by_count(words: usize) -> SeedFormat {
    match words {
        25 => SeedFormat::Legacy25,
        24 => SeedFormat::Legacy24,
        16 => SeedFormat::Polyseed,
        14 => SeedFormat::Feather14,
        13 => SeedFormat::Mymonero13,
        12 | 15 | 18 | 21 => SeedFormat::Bip39Like,
        _ => SeedFormat::Unknown,
    }
}

/// A phrase that parsed into Monero keys.
pub struct ParsedSeed {
    pub spend: Zeroizing<Scalar>,
    pub view: Zeroizing<Scalar>,
    pub format: SeedFormat,
    /// Polyseed only: the wallet's creation time (Unix seconds, floored to the format's ~1-month step).
    pub birthday_unix: Option<u64>,
    /// The wordlist it parsed with, for display ("English").
    pub language: String,
}

/// Parse any importable Monero phrase — a 24/25-word legacy seed (any of 13 wordlists) or a
/// 16-word Polyseed (any of 10) — into keys. Formats Ripley recognises but cannot import yet
/// (Feather 14-word, MyMonero 13-word, BIP39) get an error that says so and what to do.
pub fn parse_seed(mnemonic: &str) -> Result<ParsedSeed, String> {
    let normalized = Zeroizing::new(mnemonic.split_whitespace().collect::<Vec<_>>().join(" "));
    let word_count = normalized.split(' ').filter(|w| !w.is_empty()).count();
    match seed_format_by_count(word_count) {
        // `Seed::from_string` PANICS (not errors) on a wrong word count — only 24/25 reach it.
        SeedFormat::Legacy25 | SeedFormat::Legacy24 => {
            let mut last_err = String::from("Invalid mnemonic");
            for lang in RESTORE_LANGUAGES {
                match Seed::from_string(lang, normalized.clone()) {
                    Ok(seed) => {
                        let entropy = seed.entropy();
                        let (spend, view) = keys_from_entropy(&entropy)?;
                        return Ok(ParsedSeed {
                            spend,
                            view,
                            format: seed_format_by_count(word_count),
                            birthday_unix: None,
                            language: format!("{:?}", lang),
                        });
                    }
                    Err(e) => last_err = format!("Invalid mnemonic: {:?}", e),
                }
            }
            // wallet2 compatibility: valid words + checksum whose bytes are NOT a canonical
            // scalar. wallet2 reduces them (sc_reduce32); so do we. This is what Cake's 25-word
            // export of a Polyseed wallet looks like (it encodes the unreduced Polyseed key).
            for lang in RESTORE_LANGUAGES {
                if let Ok(raw) = Seed::raw_entropy_from_string(lang, normalized.clone()) {
                    let reduced = curve25519_dalek::Scalar::from_bytes_mod_order(*raw);
                    let (spend, view) = keys_from_entropy(&reduced.to_bytes())?;
                    return Ok(ParsedSeed {
                        spend,
                        view,
                        format: seed_format_by_count(word_count),
                        birthday_unix: None,
                        language: format!("{:?}", lang),
                    });
                }
            }
            if word_count == 24 {
                return Err("These 24 words are not a Monero seed — check for a typo, or, if it is a 24-word BIP39 phrase (Cake, MetaMask, Ledger…), that is a different format".into());
            }
            Err(last_err)
        }
        SeedFormat::Polyseed => parse_polyseed(&normalized),
        SeedFormat::Feather14 => Err("A 14-word seed is from Feather before 2.0 — not supported yet. Open it in Feather 2.x and write down its 25-word seed instead.".into()),
        SeedFormat::Mymonero13 => Err("A 13-word seed is from MyMonero, which derives keys differently — not supported yet.".into()),
        SeedFormat::Bip39Like => Err(format!("{word_count} words is a BIP39 phrase, not a Monero seed. In Cake or Feather, show the wallet's 25-word (legacy) seed instead.")),
        SeedFormat::Unknown => Err(format!("Invalid mnemonic: {word_count} words is not a Monero seed (25, 24 or 16 words)")),
    }
}

/// Any feature bit (bit 4 = encrypted with a passphrase; bits 0–2 = user features) means the
/// words alone do not give the wallet's key. Refuse rather than open a different, empty wallet.
fn refuse_polyseed_features(features: u8) -> Option<String> {
    (features != 0).then(|| "This Polyseed is protected by a passphrase (or uses a feature) Ripley doesn't support yet. In your old wallet, show its 25-word seed instead.".to_string())
}

fn parse_polyseed(normalized: &str) -> Result<ParsedSeed, String> {
    let mut checksum_failed = false;
    for lang in POLYSEED_LANGUAGES {
        match polyseed::Polyseed::from_string(lang, Zeroizing::new(normalized.to_string())) {
            Ok(seed) => {
                // The crate accepts the ENCRYPTED bit (a Feather/Cake passphrase) and the user
                // feature bits without complaint; decoding such a seed as plain would open a
                // different, empty wallet. Refuse anything with a feature set.
                if let Some(err) = refuse_polyseed_features(seed.features()) {
                    return Err(err);
                }
                // sc_reduce32 of the PBKDF2 key IS the spend key (tevador spec; Feather/Cake).
                // Explicit here rather than left to keys_from_entropy's canonical-bytes fallback.
                let key = seed.key();
                let spend = curve25519_dalek::Scalar::from_bytes_mod_order(*key);
                let (spend, view) = keys_from_entropy(&spend.to_bytes())?;
                return Ok(ParsedSeed {
                    spend,
                    view,
                    format: SeedFormat::Polyseed,
                    birthday_unix: Some(seed.birthday()),
                    language: format!("{:?}", lang),
                });
            }
            Err(polyseed::PolyseedError::InvalidChecksum) => checksum_failed = true,
            Err(polyseed::PolyseedError::UnsupportedFeatures) => {
                return Err("This Polyseed uses features Ripley doesn't support yet. In your old wallet, show its 25-word seed instead.".into())
            }
            Err(_) => {}
        }
    }
    Err(if checksum_failed {
        "This looks like a Polyseed but its checksum fails — check the words for a typo.".into()
    } else {
        "Invalid mnemonic: 16 words that are not a Polyseed".into()
    })
}

/// Derive spend and view keys from any importable phrase (see `parse_seed`).
pub fn keys_from_mnemonic(
    mnemonic: &str,
) -> Result<(Zeroizing<Scalar>, Zeroizing<Scalar>), String> {
    parse_seed(mnemonic).map(|p| (p.spend, p.view))
}

/// Derive spend and view keys from 32-byte entropy.
pub fn keys_from_entropy(
    entropy: &[u8; 32],
) -> Result<(Zeroizing<Scalar>, Zeroizing<Scalar>), String> {
    // For legacy Monero seeds, entropy IS the spend key (already a valid scalar).
    // Use from_canonical_bytes to match wallet2 behavior.
    // Fall back to from_bytes_mod_order for non-canonical entropy (shouldn't happen with valid seeds).
    let dalek_spend = Option::<curve25519_dalek::Scalar>::from(
        curve25519_dalek::Scalar::from_canonical_bytes(*entropy),
    )
    .unwrap_or_else(|| curve25519_dalek::Scalar::from_bytes_mod_order(*entropy));
    let spend_key = Scalar::from(dalek_spend);

    // view_key = keccak256(spend_key_bytes) reduced mod l
    // Use the canonical spend key bytes (not the original entropy) for the hash
    let spend_bytes: [u8; 32] = dalek_spend.to_bytes();
    let view_bytes = keccak256(&spend_bytes);
    let dalek_view = curve25519_dalek::Scalar::from_bytes_mod_order(view_bytes);
    let view_key = Scalar::from(dalek_view);

    log::info!(
        "Key derivation: spend={}, view={}",
        hex::encode(spend_bytes),
        hex::encode(view_bytes)
    );

    Ok((Zeroizing::new(spend_key), Zeroizing::new(view_key)))
}

/// Generate a new random mnemonic seed.
pub fn generate_mnemonic() -> (String, Zeroizing<Scalar>, Zeroizing<Scalar>) {
    let mut rng = rand::thread_rng();
    let seed = Seed::new(&mut rng, Language::English);

    let entropy = seed.entropy();
    let (spend_key, view_key) = keys_from_entropy(&entropy)
        .expect("freshly generated seed should always produce valid keys");

    let mnemonic = seed.to_string();
    ((*mnemonic).clone(), spend_key, view_key)
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    let mut output = [0u8; 32];
    hasher.update(data);
    hasher.finalize(&mut output);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    // PUBLISHED VECTOR, independent implementation: Cake Wallet's Dart `polyseed` package
    // (pub.dev polyseed 0.0.7, test/polyseed_test.dart). A Polyseed, the key it derives, and
    // the 25-word legacy seed Cake converts it to. Our Polyseed path must reproduce the key,
    // and open the SAME wallet as that legacy seed through our (separately pinned) legacy path.
    const CAKE_POLYSEED: &str = "unaware yard donate shallow slot sing oil oxygen loyal bench near hill surround forum execute lamp";
    const CAKE_KEY_HEX: &str = "cbbd142d38347773d44aa830f5f01442aa6d0d3bb48571884479531248e6fa1c";
    const CAKE_LEGACY: &str = "avidly chlorine gave yeti ramped certain hybrid comb governing amply hinder pamphlet offend geometry narrate unopened robot epoxy annoyed glide ingested ascend were austere unopened";

    #[test]
    fn polyseed_matches_cakes_published_vector() {
        let seed = polyseed::Polyseed::from_string(polyseed::Language::English, Zeroizing::new(CAKE_POLYSEED.into())).unwrap();
        assert_eq!(hex::encode(*seed.key()), CAKE_KEY_HEX);
        assert_eq!(seed.features(), 0);

        let poly = parse_seed(CAKE_POLYSEED).unwrap();
        let legacy = parse_seed(CAKE_LEGACY).unwrap();
        assert_eq!(poly.format, SeedFormat::Polyseed);
        assert_eq!(legacy.format, SeedFormat::Legacy25);
        // Same spend + view key → same wallet, same primary address.
        assert_eq!(<[u8; 32]>::from(*poly.spend), <[u8; 32]>::from(*legacy.spend));
        assert_eq!(<[u8; 32]>::from(*poly.view), <[u8; 32]>::from(*legacy.view));
        // The spend key is the REDUCED key (sc_reduce32), not the raw PBKDF2 bytes.
        let reduced = curve25519_dalek::Scalar::from_bytes_mod_order(hex::decode(CAKE_KEY_HEX).unwrap().try_into().unwrap());
        assert_eq!(<[u8; 32]>::from(*poly.spend), reduced.to_bytes());
        // Birthday decodes (Cake: 1693622412 — early Sept 2023; floored to the ~1-month step).
        let b = poly.birthday_unix.unwrap();
        assert!(b <= 1_693_622_412 && 1_693_622_412 - b < 2_629_746, "birthday {b}");
        // Extra spaces / line breaks from a paste don't matter.
        assert!(parse_seed(&CAKE_POLYSEED.replace(' ', "  \n ")).is_ok());
    }

    #[test]
    fn a_polyseed_with_a_feature_bit_is_refused_not_misread() {
        // The crate PARSES the encrypted bit (16) without complaint — this gate is the only
        // thing between a passphrase-protected Polyseed and a wrong, empty wallet. (The crate
        // itself rejects the reserved user bits, so 16 is the case that reaches us.)
        assert!(refuse_polyseed_features(16).unwrap().contains("passphrase"));
        assert!(refuse_polyseed_features(16 | 1).is_some());
        assert!(refuse_polyseed_features(0).is_none());
        assert_eq!(parse_polyseed(CAKE_POLYSEED).unwrap().format, SeedFormat::Polyseed);
    }

    #[test]
    fn a_polyseed_typo_says_checksum() {
        let typo = CAKE_POLYSEED.replace("unaware", "unable");
        let err = parse_seed(&typo).err().unwrap();
        assert!(err.contains("checksum") || err.contains("not a Polyseed"), "{err}");
    }

    #[test]
    fn unsupported_formats_say_what_they_are() {
        let words = |n: usize| vec!["abandon"; n].join(" ");
        assert!(parse_seed(&words(14)).err().unwrap().contains("Feather"));
        assert!(parse_seed(&words(13)).err().unwrap().contains("MyMonero"));
        assert!(parse_seed(&words(12)).err().unwrap().contains("BIP39"));
        assert!(parse_seed(&vec!["zzzz"; 24].join(" ")).err().unwrap().contains("BIP39"));
        assert!(parse_seed(&words(7)).err().unwrap().contains("not a Monero seed"));
        assert_eq!(seed_format_by_count(16), SeedFormat::Polyseed);
    }

    // The bug this fixes: seeds in any supported language must restore, not just English.
    #[test]
    fn restores_seed_in_any_supported_language() {
        let mut rng = rand::thread_rng();
        for lang in [
            Language::Spanish,
            Language::Japanese,
            Language::Russian,
            Language::French,
            Language::Chinese,
        ] {
            let seed = Seed::new(&mut rng, lang);
            let phrase = seed.to_string();
            assert!(
                keys_from_mnemonic(phrase.as_str()).is_ok(),
                "{:?} seed failed to restore",
                lang
            );
        }
    }

    // Malformed input must return a clean Err, never panic (the library panics on a bad
    // word count, which the guard in keys_from_mnemonic converts to an error).
    #[test]
    fn rejects_invalid_seed_without_panicking() {
        // Wrong word count.
        assert!(keys_from_mnemonic("clearly not a valid monero mnemonic phrase").is_err());
        // Right count (25 words) but not real wordlist entries.
        let fake_25 = vec!["zzzzzz"; 25].join(" ");
        assert!(keys_from_mnemonic(&fake_25).is_err());
    }
}
