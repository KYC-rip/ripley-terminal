//! Standalone CLI for sovereign Mac ↔ Pixel Ripley migration.
//!
//! Usage:
//!   ripley-migrate serve [--dir <path>]
//!   ripley-migrate export <out.ripley-migrate> [--dir <path>] [--passphrase <p>]
//!   ripley-migrate inspect <in.ripley-migrate> [--passphrase <p>]
//!   ripley-migrate import <in.ripley-migrate> [--dir <path>] [--passphrase <p>]

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use qrcode::QrCode;
use ripley_terminal_lib::migration;

fn default_app_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME") {
        let mac = PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("run.ripley.terminal");
        if mac.exists() {
            return mac;
        }
    }
    if let Some(base) = directories::BaseDirs::new() {
        return base.data_dir().join("run.ripley.terminal");
    }
    PathBuf::from(".")
}

fn read_secret(prompt: &str) -> Result<String, String> {
    print!("{prompt}");
    let _ = io::stdout().flush();
    // Disable terminal echo on Unix for passphrase input
    let _ = Command::new("stty").arg("-echo").status();
    let mut line = String::new();
    let res = io::stdin().read_line(&mut line);
    let _ = Command::new("stty").arg("echo").status();
    println!();
    res.map_err(|e| format!("read stdin: {e}"))?;
    Ok(line.trim_end_matches(&['\r', '\n'][..]).to_string())
}

fn print_preview(p: &migration::MigrationPreview) {
    println!("  Source OS:       {}", p.source_os);
    if p.monero_vault_count > 0 {
        println!(
            "  Monero wallets:  {} ({}) · {} synced caches",
            p.monero_vault_count,
            p.monero_wallets.join(", "),
            p.synced_cache_count
        );
    } else {
        println!("  Monero wallets:  0");
    }
    let mut chains = Vec::new();
    if p.has_unified_seed {
        chains.push("Unified 24-word seed");
    }
    if p.has_bitcoin {
        chains.push("Bitcoin");
    }
    if p.has_solana {
        chains.push("Solana");
    }
    if p.has_evm_burners {
        chains.push("EVM Burners");
    }
    if p.has_nostr {
        chains.push("Nostr");
    }
    if p.has_mail {
        chains.push("Mail");
    }
    println!(
        "  Included apps:   {}",
        if chains.is_empty() {
            "none".to_string()
        } else {
            chains.join(", ")
        }
    );
    println!("  App KV records:  {}", p.kv_count);
    if p.bundle_bytes > 0 {
        println!("  Encrypted size:  {:.1} KB", p.bundle_bytes as f64 / 1024.0);
    }
}

/// Render a high-contrast Unicode half-block QR code (2 rows per terminal line).
fn render_terminal_qr(data: &str) -> Result<String, String> {
    let code = QrCode::new(data.as_bytes()).map_err(|e| format!("QR encode error: {e}"))?;
    let w = code.width();
    let border = 2usize;
    let total = w + border * 2;
    let is_dark = |x: usize, y: usize| -> bool {
        if x < border || y < border || x >= w + border || y >= w + border {
            return false;
        }
        code[(x - border, y - border)] == qrcode::Color::Dark
    };
    let mut out = String::new();
    let mut y = 0;
    while y < total {
        for x in 0..total {
            let top = is_dark(x, y);
            let bot = if y + 1 < total { is_dark(x, y + 1) } else { false };
            // White background (quiet zone) = full block; dark module = space (inverted for dark terminals
            // using ANSI black-on-white so BOTH dark & light terminals scan effortlessly!)
            let ch = match (top, bot) {
                (true, true) => ' ',
                (true, false) => '▄',
                (false, true) => '▀',
                (false, false) => '█',
            };
            out.push(ch);
        }
        out.push('\n');
        y += 2;
    }
    // Wrap in crisp black-on-white ANSI so camera autofocus locks immediately
    Ok(format!("\x1b[37;40m{out}\x1b[0m"))
}

fn print_usage() {
    eprintln!(
        "ripley-migrate — Sovereign Mac <-> Pixel migration tool\n\n\
         USAGE:\n\
           ripley-migrate serve [--dir <app_data_dir>]\n\
               Serve your complete Ripley state over local Wi-Fi/hotspot with a scannable QR.\n\
               Zero internet. Zero cloud. Ephemeral ChaCha20-Poly1305 key.\n\n\
           ripley-migrate export <out.ripley-migrate> [--dir <app_data_dir>] [--passphrase <p>]\n\
               Create an offline Argon2id + ChaCha20-Poly1305 encrypted migration file.\n\n\
           ripley-migrate inspect <in.ripley-migrate> [--passphrase <p>]\n\
               Decrypt and preview a .ripley-migrate archive without modifying disk.\n\n\
           ripley-migrate import <in.ripley-migrate> [--dir <app_data_dir>] [--passphrase <p>]\n\
               Import a .ripley-migrate archive into the local Ripley data directory.\n"
    );
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        print_usage();
        return;
    }

    let sub = args[0].as_str();
    let mut dir_opt: Option<PathBuf> = None;
    let mut pass_opt: Option<String> = None;
    let mut positional: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                i += 1;
                if i < args.len() {
                    dir_opt = Some(PathBuf::from(&args[i]));
                }
            }
            "--passphrase" => {
                i += 1;
                if i < args.len() {
                    pass_opt = Some(args[i].clone());
                }
            }
            a => positional.push(a.to_string()),
        }
        i += 1;
    }

    let data_dir = dir_opt.unwrap_or_else(default_app_data_dir);

    let result: Result<(), String> = match sub {
        "serve" => run_serve(&data_dir).await,
        "export" => {
            let out = positional
                .first()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("ripley-backup.ripley-migrate"));
            run_export(&data_dir, &out, pass_opt)
        }
        "inspect" => {
            let Some(inp) = positional.first() else {
                print_usage();
                std::process::exit(2);
            };
            run_inspect(Path::new(inp), pass_opt)
        }
        "import" => {
            let Some(inp) = positional.first() else {
                print_usage();
                std::process::exit(2);
            };
            run_import(&data_dir, Path::new(inp), pass_opt)
        }
        _ => {
            print_usage();
            std::process::exit(2);
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

async fn run_serve(data_dir: &Path) -> Result<(), String> {
    if !data_dir.exists() {
        return Err(format!(
            "Ripley data directory not found: {}",
            data_dir.display()
        ));
    }
    println!("Packing Ripley state from {} ...", data_dir.display());
    let mut srv = migration::start_lan_server(data_dir, None).await?;
    println!("\n=== Ripley Sovereign LAN Migration ===");
    print_preview(&srv.info.preview);
    println!("  LAN endpoint:    http://{}:{}", srv.info.ip, srv.info.port);
    println!("  Verify SAS code: \x1b[1;33m{}\x1b[0m", srv.info.sas);
    println!(
        "\nOn your Pixel: Open RipleyOS -> Settings -> Privacy -> Full Device Migration -> Scan LAN QR\n"
    );
    match render_terminal_qr(&srv.info.uri) {
        Ok(qr) => print!("{qr}"),
        Err(e) => eprintln!("(Could not render terminal QR: {e})"),
    }
    println!("\nManual URI (if needed): {}", srv.info.uri);
    println!(
        "\nListening on local Wi-Fi for {} seconds. Press Ctrl+C when your Pixel finishes importing.",
        srv.info.expires_in_secs
    );

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            println!("\nStopping LAN server...");
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(srv.info.expires_in_secs)) => {
            println!("\nSession expired (5 minutes). Run `ripley-migrate serve` again if needed.");
        }
    }
    srv.stop();
    Ok(())
}

fn run_export(data_dir: &Path, out: &Path, pass_opt: Option<String>) -> Result<(), String> {
    if !data_dir.exists() {
        return Err(format!(
            "Ripley data directory not found: {}",
            data_dir.display()
        ));
    }
    let pass = match pass_opt {
        Some(p) => p,
        None => {
            let p1 = read_secret("Enter archive passphrase (min 8 chars): ")?;
            let p2 = read_secret("Confirm archive passphrase: ")?;
            if p1 != p2 {
                return Err("Passphrases do not match".into());
            }
            p1
        }
    };
    let bundle = migration::pack_bundle(data_dir)?;
    let encrypted = migration::encrypt_with_passphrase(&bundle, &pass)?;
    fs::write(out, &encrypted).map_err(|e| format!("write {}: {e}", out.display()))?;
    let preview = migration::preview_bundle(&bundle, encrypted.len());
    println!("\nExported sovereign migration archive -> {}", out.display());
    print_preview(&preview);
    Ok(())
}

fn run_inspect(inp: &Path, pass_opt: Option<String>) -> Result<(), String> {
    let raw = fs::read(inp).map_err(|e| format!("read {}: {e}", inp.display()))?;
    let pass = match pass_opt {
        Some(p) => p,
        None => read_secret("Enter archive passphrase: ")?,
    };
    let bundle = migration::decrypt_with_passphrase(&raw, &pass)?;
    let preview = migration::preview_bundle(&bundle, raw.len());
    println!("\nVerified archive: {}", inp.display());
    print_preview(&preview);
    Ok(())
}

fn run_import(data_dir: &Path, inp: &Path, pass_opt: Option<String>) -> Result<(), String> {
    let raw = fs::read(inp).map_err(|e| format!("read {}: {e}", inp.display()))?;
    let pass = match pass_opt {
        Some(p) => p,
        None => read_secret("Enter archive passphrase: ")?,
    };
    let bundle = migration::decrypt_with_passphrase(&raw, &pass)?;
    let preview = migration::preview_bundle(&bundle, raw.len());
    println!("\nArchive verified:");
    print_preview(&preview);
    print!("\nImport into {} ? [y/N] ", data_dir.display());
    let _ = io::stdout().flush();
    let mut ans = String::new();
    io::stdin()
        .read_line(&mut ans)
        .map_err(|e| format!("read stdin: {e}"))?;
    if !matches!(ans.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        println!("Cancelled.");
        return Ok(());
    }
    migration::apply_bundle(data_dir, &bundle)?;
    println!("Imported successfully into {}", data_dir.display());
    Ok(())
}
