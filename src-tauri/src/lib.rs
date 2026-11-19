#![recursion_limit = "512"]
// Separate platform entry points keep desktop-only APIs out of the Android build.
#[cfg(not(target_os = "android"))]
include!("desktop.rs");
#[cfg(target_os = "android")]
include!("android.rs");
