fn main() {
    // tauri-build does NOT emit rerun-if-changed for the app icon, so cargo
    // reuses the cached Windows icon resource (exe icon stays stale) unless
    // we declare it here.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}