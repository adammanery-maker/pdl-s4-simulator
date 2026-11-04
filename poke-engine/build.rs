use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn collect(directory: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            collect(&path, files)?;
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let mut files = vec![root.join("Cargo.toml"), root.join("Cargo.lock"), root.join("build.rs"), root.join("poke-engine-py/Cargo.toml")];
    collect(&root.join("src"), &mut files)?;
    collect(&root.join("poke-engine-py/src"), &mut files)?;
    files.sort();

    let mut hasher = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Canonical macOS runtime requires /usr/bin/shasum to attest poke-engine source");
    {
        let stdin = hasher.stdin.as_mut().expect("sha256 stdin");
        for path in &files {
            let relative = path.strip_prefix(&root).expect("source inside engine root");
            println!("cargo:rerun-if-changed={}", relative.display());
            stdin.write_all(relative.to_string_lossy().as_bytes())?;
            stdin.write_all(&[0])?;
            stdin.write_all(&fs::read(path)?)?;
            stdin.write_all(&[0])?;
        }
    }
    let output = hasher.wait_with_output()?;
    assert!(output.status.success(), "shasum failed while attesting poke-engine source");
    let digest = String::from_utf8(output.stdout).expect("sha256 output");
    let digest = digest.split_whitespace().next().expect("sha256 digest");
    let generated = PathBuf::from(std::env::var("OUT_DIR").expect("Cargo output directory")).join("pdl_engine_fingerprint.rs");
    File::create(generated)?.write_all(format!("pub const PDL_ENGINE_SOURCE_SHA256: &str = \"{digest}\";\n").as_bytes())?;
    Ok(())
}
